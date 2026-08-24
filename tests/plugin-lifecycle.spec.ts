import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as gptSub from '../src/index.ts'

// apply() builds its ProxyAgent internally, so the real instance is
// unreachable from a test. Stand in for the class to record construction and
// close. Everything else in undici stays real: token-store imports `fetch`
// from the same module and must keep the genuine one.
const proxyAgent = vi.hoisted(() => ({ built: [] as string[], closed: 0, failClose: false }))

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>()
  // Extends the real Dispatcher so it inherits `compose`, which apply() uses
  // to graft the retry interceptor onto the agent.
  class FakeProxyAgent extends actual.Dispatcher {
    constructor(url: string) {
      super()
      proxyAgent.built.push(url)
    }

    async close(): Promise<void> {
      proxyAgent.closed += 1
      if (proxyAgent.failClose) throw new Error('proxy agent refused to close')
    }
  }
  return {
    ...actual,
    // The startup reachability probe would otherwise reach the real network,
    // and direct chatgpt.com hangs for tens of seconds where the proxy is
    // down. Refuse fast instead: apply() logs the failure and starts anyway.
    fetch: async () => {
      throw new Error('network disabled in lifecycle tests')
    },
    ProxyAgent: FakeProxyAgent,
  }
})

const PROXY_URL = 'http://127.0.0.1:7890'

let dir: string
let authFile: string
let stateFile: string
const started: { fiber: { dispose: () => Promise<void> } }[] = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gpt-sub-lifecycle-'))
  authFile = join(dir, 'auth.json')
  stateFile = join(dir, 'state.json')
  await writeAuth()
  proxyAgent.built.length = 0
  proxyAgent.closed = 0
  proxyAgent.failClose = false
})

afterEach(async () => {
  for (const entry of started.splice(0)) await entry.fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

/**
 * Build a JWT whose `exp` sits far beyond any refresh margin, so `getTokens()`
 * returns it without reaching for the network.
 *
 * @param expSeconds - the `exp` claim, in seconds since the epoch.
 * @returns a three-part token string.
 */
function jwt(expSeconds: number): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ exp: expSeconds })}.signature`
}

const LIVE_TOKEN = jwt(Math.floor(Date.now() / 1000) + 240 * 60 * 60)

/** Write a credential file at an arbitrary path whose access token is valid for days. */
async function writeAuthAt(path: string, accessToken = LIVE_TOKEN): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      tokens: {
        id_token: 'stale',
        access_token: accessToken,
        refresh_token: 'refresh-abc',
        account_id: 'acct-123',
      },
    }),
    'utf8',
  )
}

/** Write the default credential file whose access token is valid for days. */
function writeAuth(accessToken = LIVE_TOKEN): Promise<void> {
  return writeAuthAt(authFile, accessToken)
}

/** A credentials service double recording every write. */
function credentials(): { service: unknown; writes: { ref: unknown; value: string }[] } {
  const writes: { ref: unknown; value: string }[] = []
  return {
    writes,
    service: {
      resolve: async (): Promise<undefined> => undefined,
      set: async (ref: unknown, value: string): Promise<void> => {
        writes.push({ ref, value })
      },
    },
  }
}

/** Build the plugin config with the fields a test does not care about filled in. */
function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { proxyUrl: '', authFile, refreshMarginMinutes: 30, syncIntervalMinutes: 10, stateFile, ...overrides }
}

/** One recorded route: the registry double keeps handlers callable. */
interface RecordedRoute {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** A webServer double recording the routes the plugin registers. */
function webServer(): { service: unknown; registrations: RecordedRoute[]; routes: string[] } {
  const registrations: RecordedRoute[] = []
  return {
    registrations,
    get routes(): string[] {
      return registrations.map((route) => route.path)
    },
    service: {
      register: (route: RecordedRoute): (() => void) => {
        registrations.push(route)
        return () => undefined
      },
    },
  }
}

/** A request double carrying a method, an optional JSON body, and headers. */
function fakeRequest(
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
  url?: string,
): IncomingMessage {
  const stream = Readable.from([body === undefined ? '' : JSON.stringify(body)])
  return Object.assign(stream, { method, ...(url === undefined ? {} : { url }), headers }) as unknown as IncomingMessage
}

/**
 * Invoke one registered route handler and capture its reply.
 *
 * @param server - the webServer double carrying the routes.
 * @param method - the HTTP method to send.
 * @param path - the route path.
 * @param body - the JSON body for POST.
 * @param headers - request headers, such as Origin and Host.
 * @returns the status code and parsed reply.
 */
async function callRoute(
  server: { registrations: RecordedRoute[] },
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; reply: Record<string, unknown> }> {
  const route = server.registrations.find((entry) => entry.path === path.split('?')[0])
  if (route === undefined) throw new Error('no route registered at ' + path)
  let status = 0
  let payload = ''
  const res = {
    writeHead: (code: number): void => {
      status = code
    },
    end: (text?: string): void => {
      payload = text ?? ''
    },
  } as unknown as ServerResponse
  await route.handler(fakeRequest(method, body, headers, path), res)
  return { status, reply: JSON.parse(payload) as Record<string, unknown> }
}

/** Headers a same-origin browser POST carries, addressed to the panel's host. */
const SAME_ORIGIN = {
  origin: 'http://127.0.0.1:8318',
  host: '127.0.0.1:8318',
  'content-type': 'application/json',
}

/** Headers a page on another origin sends -- the CSRF shape to refuse. */
const CROSS_ORIGIN = {
  ...SAME_ORIGIN,
  origin: 'http://evil.example',
}

/**
 * Build a context carrying both services the plugin injects.
 *
 * @param creds - the credentials double to provide.
 * @returns the context and the webServer double.
 */
function contextWith(creds: { service: unknown }): { ctx: Context; server: { registrations: RecordedRoute[]; routes: string[] } } {
  const ctx = new Context()
  const server = webServer()
  ctx.provide('credentials', creds.service)
  ctx.provide('webServer', server.service)
  return { ctx, server }
}

describe('plugin lifecycle', () => {
  it('declares the credentials service it writes through', () => {
    expect(gptSub.inject).toContain('credentials')
    expect(gptSub.inject).toContain('webServer')
  })

  it('publishes the access token to the configured credential at start', async () => {
    const creds = credentials()
    const { ctx } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })
    await fiber.await()

    expect(creds.writes).toHaveLength(1)
    expect(creds.writes[0]?.value).toBe(LIVE_TOKEN)
  })

  it('registers the quota endpoint the settings panel polls', async () => {
    const creds = credentials()
    const { ctx, server } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })
    await fiber.await()

    expect(server.routes).toContain('/gpt-sub/quota')
  })

  it('registers the status and proxy endpoints the settings panel drives', async () => {
    const creds = credentials()
    const { ctx, server } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })
    await fiber.await()

    expect(server.routes).toContain('/gpt-sub/status')
    expect(server.routes).toContain('/gpt-sub/proxy')
    expect(server.routes).toContain('/gpt-sub/proxy/test')
    expect(server.routes).toContain('/gpt-sub/auth')
  })

  it('status reports the auth file, the proxy, and the next automatic refresh', async () => {
    const creds = credentials()
    const { ctx, server } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config({ proxyUrl: PROXY_URL }))
    started.push({ fiber })
    await fiber.await()

    const { status, reply } = await callRoute(server, 'GET', '/gpt-sub/status')
    expect(status).toBe(200)
    expect(reply['authFile']).toBe(authFile)
    expect(reply['proxyUrl']).toBe(PROXY_URL)
    expect(reply['overridden']).toBe(false)
    expect(typeof reply['tokenExpiresAt']).toBe('number')
    expect(reply['refreshAt']).toBe(
      (reply['tokenExpiresAt'] as number) - 30 * 60_000,
    )
    expect(typeof reply['lastSyncAt']).toBe('number')
    expect(reply['nextSyncAt']).toBe((reply['lastSyncAt'] as number) + 10 * 60_000)
  })

  it('switches the proxy at runtime, rebuilding routing and persisting the choice', async () => {
    const creds = credentials()
    const { ctx, server } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })
    await fiber.await()
    expect(proxyAgent.built).toEqual([])

    const next = 'http://127.0.0.1:9999'
    const applied = await callRoute(server, 'POST', '/gpt-sub/proxy', { proxyUrl: next })
    expect(applied.status).toBe(200)
    expect(applied.reply['ok']).toBe(true)
    expect(proxyAgent.built).toEqual([next])
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({ proxyUrl: next })

    // Saving the empty string is a real choice (direct) and must persist too.
    const direct = await callRoute(server, 'POST', '/gpt-sub/proxy', { proxyUrl: '' })
    expect(direct.status).toBe(200)
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({ proxyUrl: '' })
    const after = await callRoute(server, 'GET', '/gpt-sub/status')
    expect(after.reply['proxyUrl']).toBe('')
    expect(after.reply['overridden']).toBe(true)
  })

  it('rejects an invalid proxy URL with 400 and keeps the current routing', async () => {
    const creds = credentials()
    const { ctx, server } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })
    await fiber.await()

    const bad = await callRoute(server, 'POST', '/gpt-sub/proxy', { proxyUrl: 'ftp://x' })
    expect(bad.status).toBe(400)
    expect(bad.reply['ok']).toBe(false)
    expect(proxyAgent.built).toEqual([])
  })

  it('refuses a cross-origin proxy switch without persisting or rerouting', async () => {
    const creds = credentials()
    const { ctx, server } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })
    await fiber.await()

    const cross = await callRoute(
      server,
      'POST',
      '/gpt-sub/proxy',
      { proxyUrl: 'http://127.0.0.1:9999' },
      CROSS_ORIGIN,
    )
    expect(cross.status).toBe(403)
    expect(cross.reply['ok']).toBe(false)
    expect(proxyAgent.built).toEqual([])
    // The override file must not appear: the choice was never made.
    await expect(readFile(stateFile, 'utf8')).rejects.toThrow()
  })

  it('refuses a cross-origin probe, so the token cannot be sent through a stranger proxy', async () => {
    const creds = credentials()
    const { ctx, server } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })
    await fiber.await()

    const cross = await callRoute(
      server,
      'POST',
      '/gpt-sub/proxy/test',
      { proxyUrl: 'http://evil.example:8080' },
      CROSS_ORIGIN,
    )
    expect(cross.status).toBe(403)
    expect(proxyAgent.built).toEqual([])
  })

  it('refuses a proxy switch whose body carries a non-JSON content-type', async () => {
    const creds = credentials()
    const { ctx, server } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })
    await fiber.await()

    const plain = await callRoute(
      server,
      'POST',
      '/gpt-sub/proxy',
      { proxyUrl: 'http://127.0.0.1:9999' },
      { host: '127.0.0.1:8318', 'content-type': 'text/plain' },
    )
    expect(plain.status).toBe(400)
    expect(proxyAgent.built).toEqual([])
  })

  it('allows a same-origin proxy switch and one with no Origin header at all', async () => {
    const creds = credentials()
    const { ctx, server } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })
    await fiber.await()

    const same = await callRoute(
      server,
      'POST',
      '/gpt-sub/proxy',
      { proxyUrl: 'http://127.0.0.1:9999' },
      SAME_ORIGIN,
    )
    expect(same.status).toBe(200)
    expect(proxyAgent.built).toEqual(['http://127.0.0.1:9999'])

    // A non-browser client (curl, the tests themselves) sends no Origin.
    const bare = await callRoute(server, 'POST', '/gpt-sub/proxy', { proxyUrl: '' })
    expect(bare.status).toBe(200)
  })

  it('logs a credentialed proxy URL with the password masked', async () => {
    const creds = credentials()
    const { ctx } = contextWith(creds)
    const lines: string[] = []
    const info = vi.spyOn(ctx.logger, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    })
    const fiber = ctx.plugin(gptSub, config({ proxyUrl: 'http://user:hunter2@127.0.0.1:7890' }))
    started.push({ fiber })
    await fiber.await()
    info.mockRestore()

    expect(lines.some((line) => line.includes('***@'))).toBe(true)
    expect(lines.some((line) => line.includes('hunter2'))).toBe(false)
  })

  it('a saved override replaces the configured proxy at start', async () => {
    await writeFile(stateFile, JSON.stringify({ proxyUrl: 'http://127.0.0.1:7111' }), 'utf8')
    const creds = credentials()
    const { ctx } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config({ proxyUrl: PROXY_URL }))
    started.push({ fiber })
    await fiber.await()

    expect(proxyAgent.built).toEqual(['http://127.0.0.1:7111'])
  })

  it('honours a non-default credential reference', async () => {
    const creds = credentials()
    const { ctx } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config({ tokenRef: 'SOMETHING_ELSE' }))
    started.push({ fiber })
    await fiber.await()

    expect(String(JSON.stringify(creds.writes[0]?.ref))).toContain('SOMETHING_ELSE')
  })

  it('raises a missing auth.json at start, naming the path', async () => {
    await rm(authFile)
    const creds = credentials()
    const { ctx } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })

    await expect(fiber.await()).rejects.toThrow(authFile)
    // Nothing may be published when the credential file cannot be read.
    expect(creds.writes).toHaveLength(0)
  })

  it('closes the proxy dispatcher when the fiber is disposed', async () => {
    const creds = credentials()
    const { ctx } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config({ proxyUrl: PROXY_URL }))
    await fiber.await()

    expect(proxyAgent.built).toEqual([PROXY_URL])
    expect(proxyAgent.closed).toBe(0)
    await fiber.dispose()
    expect(proxyAgent.closed).toBe(1)
  })

  it('has no dispatcher to close when proxyUrl is empty', async () => {
    const creds = credentials()
    const { ctx } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config({ proxyUrl: '' }))
    await fiber.await()

    await fiber.dispose()
    expect(proxyAgent.built).toEqual([])
    expect(proxyAgent.closed).toBe(0)
  })

  it('disposes cleanly when closing the dispatcher fails', async () => {
    proxyAgent.failClose = true
    const creds = credentials()
    const { ctx } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config({ proxyUrl: PROXY_URL }))
    await fiber.await()

    // A rejected teardown would stall the fiber's unload.
    await expect(fiber.dispose()).resolves.not.toThrow()
    expect(proxyAgent.closed).toBe(1)
  })

  it('republishes on the sync interval, so a rotated token reaches the store', async () => {
    // A real timer on a sub-second interval, not a faked clock: the plugin
    // starts through cordis's own scheduling, and driving that with fake timers
    // proved unreliable. 0.005 minutes is 300ms.
    const creds = credentials()
    const { ctx } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config({ syncIntervalMinutes: 0.005 }))
    started.push({ fiber })
    await fiber.await()
    expect(creds.writes).toHaveLength(1)

    const rotated = jwt(Math.floor(Date.now() / 1000) + 240 * 60 * 60 + 1)
    await writeAuth(rotated)
    await vi.waitFor(
      () => {
        expect(creds.writes.at(-1)?.value).toBe(rotated)
      },
      { timeout: 4_000, interval: 50 },
    )
    expect(creds.writes.length).toBeGreaterThan(1)
  })

  it('switches the credential file at runtime, republishing and persisting', async () => {
    const creds = credentials()
    const { ctx, server } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })
    await fiber.await()

    const second = join(dir, 'auth-second.json')
    const SECOND_TOKEN = jwt(Math.floor(Date.now() / 1000) + 240 * 60 * 60 + 7)
    await writeAuthAt(second, SECOND_TOKEN)

    const applied = await callRoute(server, 'POST', '/gpt-sub/auth', { authFile: second })
    expect(applied.status).toBe(200)
    expect(applied.reply['ok']).toBe(true)
    expect(applied.reply['published']).toBe(true)
    expect(applied.reply['authFile']).toBe(second)

    // The new file's token reached the credential store immediately, not on
    // the next sync tick.
    expect(creds.writes.at(-1)?.value).toBe(SECOND_TOKEN)
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({ authFile: second })

    const after = await callRoute(server, 'GET', '/gpt-sub/status')
    expect(after.reply['authFile']).toBe(second)
    expect(after.reply['configAuthFile']).toBe(authFile)
    expect(after.reply['authOverridden']).toBe(true)
  })

  it('rejects a credential file that cannot serve tokens with 400, keeping the current one', async () => {
    const creds = credentials()
    const { ctx, server } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })
    await fiber.await()

    const missing = join(dir, 'no-such-auth.json')
    const bad = await callRoute(server, 'POST', '/gpt-sub/auth', { authFile: missing })
    expect(bad.status).toBe(400)
    expect(bad.reply['ok']).toBe(false)
    expect(String(bad.reply['message'])).toContain(missing)

    // The choice was never made: nothing persisted, nothing republished.
    await expect(readFile(stateFile, 'utf8')).rejects.toThrow()
    expect(creds.writes).toHaveLength(1)
  })

  it('refuses a cross-origin credential-file switch without persisting', async () => {
    const creds = credentials()
    const { ctx, server } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })
    await fiber.await()

    const cross = await callRoute(server, 'POST', '/gpt-sub/auth', { authFile: authFile }, CROSS_ORIGIN)
    expect(cross.status).toBe(403)
    expect(cross.reply['ok']).toBe(false)
    await expect(readFile(stateFile, 'utf8')).rejects.toThrow()
  })

  it('restores the configured default when the page saves an empty path', async () => {
    const creds = credentials()
    const { ctx, server } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })
    await fiber.await()

    const second = join(dir, 'auth-second.json')
    await writeAuthAt(second)
    await callRoute(server, 'POST', '/gpt-sub/auth', { authFile: second })

    const cleared = await callRoute(server, 'POST', '/gpt-sub/auth', { authFile: '' })
    expect(cleared.status).toBe(200)
    expect(cleared.reply['authFile']).toBe(authFile)

    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({})
    const after = await callRoute(server, 'GET', '/gpt-sub/status')
    expect(after.reply['authOverridden']).toBe(false)
    expect(creds.writes.at(-1)?.value).toBe(LIVE_TOKEN)
  })

  it('a proxy save keeps the credential-file choice in the same state file', async () => {
    const creds = credentials()
    const { ctx, server } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })
    await fiber.await()

    const second = join(dir, 'auth-second.json')
    await writeAuthAt(second)
    await callRoute(server, 'POST', '/gpt-sub/auth', { authFile: second })
    await callRoute(server, 'POST', '/gpt-sub/proxy', { proxyUrl: 'http://127.0.0.1:9999' })

    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({
      proxyUrl: 'http://127.0.0.1:9999',
      authFile: second,
    })
    expect(proxyAgent.built).toEqual(['http://127.0.0.1:9999'])
  })

  it('a saved authFile override replaces the configured file at start', async () => {
    const second = join(dir, 'auth-second.json')
    const SECOND_TOKEN = jwt(Math.floor(Date.now() / 1000) + 240 * 60 * 60 + 9)
    await writeAuthAt(second, SECOND_TOKEN)
    await writeFile(stateFile, JSON.stringify({ authFile: second }), 'utf8')

    const creds = credentials()
    const { ctx } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })
    await fiber.await()

    expect(creds.writes[0]?.value).toBe(SECOND_TOKEN)
  })

  it('lists a directory read-only for the file picker', async () => {
    const creds = credentials()
    const { ctx, server } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })
    await fiber.await()

    const nested = join(dir, 'nested')
    await mkdir(nested, { recursive: true })
    await writeAuthAt(join(nested, 'auth.json'))

    const listed = await callRoute(server, 'GET', '/gpt-sub/auth/browse?path=' + encodeURIComponent(nested))
    expect(listed.status).toBe(200)
    expect(listed.reply['ok']).toBe(true)
    expect(listed.reply['dir']).toBe(nested)
    const entries = listed.reply['entries'] as { name: string; path: string; dir: boolean }[]
    const file = entries.find((entry) => entry.name === 'auth.json')
    expect(file?.dir).toBe(false)
    expect(file?.path).toBe(join(nested, 'auth.json'))

    // A non-directory is refused rather than listed.
    const bad = await callRoute(server, 'GET', '/gpt-sub/auth/browse?path=' + encodeURIComponent(join(nested, 'gone')))
    expect(bad.status).toBe(400)

    // An empty path defaults to the user's home directory.
    const home = await callRoute(server, 'GET', '/gpt-sub/auth/browse')
    expect(home.status).toBe(200)
    expect(typeof home.reply['dir']).toBe('string')
  })

  it('raises a rotten saved authFile override at start, naming the path', async () => {
    const missing = join(dir, 'gone-auth.json')
    await writeFile(stateFile, JSON.stringify({ authFile: missing }), 'utf8')

    const creds = credentials()
    const { ctx } = contextWith(creds)
    const fiber = ctx.plugin(gptSub, config())
    started.push({ fiber })

    await expect(fiber.await()).rejects.toThrow(missing)
    expect(creds.writes).toHaveLength(0)
  })
})
