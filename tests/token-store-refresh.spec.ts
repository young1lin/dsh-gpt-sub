import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { TokenStore, type RefreshFetch } from '../src/token-store.ts'

function tokenExpiringIn(ms: number, from = Date.now()): string {
  const part = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'none' })}.${part({ exp: Math.floor((from + ms) / 1000) })}.sig`
}

let dir: string
let authFile: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gpt-sub-refresh-'))
  authFile = join(dir, 'auth.json')
})

async function writeAuth(accessToken: string): Promise<void> {
  await writeFile(
    authFile,
    JSON.stringify({
      auth_mode: 'chatgpt',
      keep_me: 'untouched',
      tokens: {
        id_token: 'stale',
        access_token: accessToken,
        refresh_token: 'refresh-old',
        account_id: 'acct-123',
      },
      last_refresh: 'old',
    }),
    'utf8',
  )
}

/** A fetch stub returning one OAuth token response and recording its request. */
function refreshStub(fresh: string): { fetchImpl: RefreshFetch; seen: { body: unknown }[] } {
  const seen: { body: unknown }[] = []
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    seen.push({ body: JSON.parse(init.body) as unknown })
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: fresh, refresh_token: 'refresh-new', id_token: 'id-new' }),
      text: async () => '',
    }
  })
  return { fetchImpl, seen }
}

describe('TokenStore refresh', () => {
  it('refreshes when the access token is inside the margin', async () => {
    await writeAuth(tokenExpiringIn(60_000))
    const fresh = tokenExpiringIn(10 * 24 * 3_600_000)
    const { fetchImpl, seen } = refreshStub(fresh)
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl })
    const tokens = await store.getTokens()
    expect(tokens.accessToken).toBe(fresh)
    expect(seen).toHaveLength(1)
  })

  it('sends the Codex client_id and the stored refresh token', async () => {
    await writeAuth(tokenExpiringIn(60_000))
    const { fetchImpl, seen } = refreshStub(tokenExpiringIn(3_600_000))
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl })
    await store.getTokens()
    expect(seen[0]?.body).toMatchObject({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-old',
    })
  })

  it('persists the rotated refresh token and preserves unrelated fields', async () => {
    await writeAuth(tokenExpiringIn(60_000))
    const { fetchImpl } = refreshStub(tokenExpiringIn(3_600_000))
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl })
    await store.getTokens()
    const saved = JSON.parse(await readFile(authFile, 'utf8')) as Record<string, unknown>
    expect((saved['tokens'] as Record<string, unknown>)['refresh_token']).toBe('refresh-new')
    expect(saved['keep_me']).toBe('untouched')
    expect(saved['auth_mode']).toBe('chatgpt')
    expect(saved['last_refresh']).not.toBe('old')
  })

  it('leaves no temporary credential file behind', async () => {
    // The temp file carries live credentials for the moment it exists.
    await writeAuth(tokenExpiringIn(60_000))
    const { fetchImpl } = refreshStub(tokenExpiringIn(3_600_000))
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl })
    await store.getTokens()
    expect(await readdir(dir)).toEqual(['auth.json'])
  })

  it('forceRefresh refreshes even when the token is far from expiry', async () => {
    await writeAuth(tokenExpiringIn(10 * 24 * 3_600_000))
    const fresh = tokenExpiringIn(10 * 24 * 3_600_000)
    const { fetchImpl, seen } = refreshStub(fresh)
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl })
    await store.forceRefresh()
    expect(seen).toHaveLength(1)
  })

  it('reports a rejected refresh token with re-login guidance', async () => {
    await writeAuth(tokenExpiringIn(60_000))
    const fetchImpl = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => 'invalid_grant',
    }))
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl })
    await expect(store.getTokens()).rejects.toThrow(/codex/i)
  })
})

describe('TokenStore refresh transport', () => {
  it('routes the refresh through the configured dispatcher', async () => {
    // On this machine OpenAI is reachable only through Clash. A refresh that
    // ignores the dispatcher cannot connect at all, so proactive and reactive
    // refresh both fail and spec success criterion 3 cannot hold.
    await writeAuth(tokenExpiringIn(60_000))
    const dispatcher = { marker: 'proxy-agent' }
    const seen: unknown[] = []
    const fetchImpl = (async (_url: string, init: { dispatcher?: unknown }) => {
      seen.push(init.dispatcher)
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: tokenExpiringIn(3_600_000) }),
        text: async () => '',
      }
    })
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl, dispatcher })
    await store.getTokens()
    expect(seen).toEqual([dispatcher])
  })

  it('reports an unreachable token endpoint with re-login guidance', async () => {
    // Without this the failure surfaces as a bare `TypeError: fetch failed`.
    await writeAuth(tokenExpiringIn(60_000))
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    })
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl })
    await expect(store.getTokens()).rejects.toThrow(/codex/i)
  })
})

describe('TokenStore concurrent refresh', () => {
  it('coalesces concurrent refreshes into one token exchange', async () => {
    // The refresh token is single-use and rotates. DSH issues parallel LLM
    // calls, so two callers inside the margin -- or two parallel 401s -- each
    // POSTed the same token; the loser got invalid_grant and told the user to
    // sign in again during entirely normal operation.
    await writeAuth(tokenExpiringIn(60_000))
    const fresh = tokenExpiringIn(10 * 24 * 3_600_000)
    let calls = 0
    const fetchImpl: RefreshFetch = async () => {
      calls += 1
      // Yield enough event-loop turns that a second, uncoalesced caller would
      // reach this counter before the exchange resolves.
      for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve))
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: fresh, refresh_token: 'refresh-new' }),
        text: async () => '',
      }
    }
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl })

    const [viaMargin, viaForce] = await Promise.all([store.getTokens(), store.forceRefresh()])
    expect(calls).toBe(1)
    expect(viaMargin.accessToken).toBe(fresh)
    expect(viaForce.accessToken).toBe(fresh)
  })

  it('still refreshes again once the in-flight exchange has settled', async () => {
    // Coalescing must cover only concurrent callers; memoizing beyond that
    // would hand back a token that is no longer the newest one on disk.
    await writeAuth(tokenExpiringIn(60_000))
    const { fetchImpl, seen } = refreshStub(tokenExpiringIn(3_600_000))
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl })
    await store.forceRefresh()
    await store.forceRefresh()
    expect(seen).toHaveLength(2)
  })
})

/** Flatten an error and its whole cause chain into searchable text. */
function errorText(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  while (current instanceof Error) {
    parts.push(current.message, current.stack ?? '')
    current = current.cause
  }
  return parts.join(' | ')
}

describe('TokenStore secrecy', () => {
  it('never puts token values in console output or error text', async () => {
    // Spec: "Never log token values. Log only expiry timestamps and refresh
    // outcomes." The rejected-refresh message quotes the endpoint's response
    // body verbatim, which is exactly where a credential could slip out.
    const oldAccess = tokenExpiringIn(60_000)
    await writeAuth(oldAccess)
    const secrets = [oldAccess, 'refresh-old']

    const captured: string[] = []
    const levels = ['log', 'info', 'warn', 'error', 'debug', 'trace']
    const saved = new Map<string, unknown>()
    for (const level of levels) {
      saved.set(level, Reflect.get(console, level))
      Reflect.set(console, level, (...args: unknown[]): void => {
        captured.push(args.map((value) => String(value)).join(' '))
      })
    }

    try {
      const rejecting: RefreshFetch = async () => ({
        ok: false,
        status: 400,
        json: async () => ({}),
        text: async () => 'invalid_grant',
      })
      const rejected = await new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl: rejecting })
        .getTokens()
        .then(() => undefined, (error: unknown) => error)
      expect(rejected).toBeInstanceOf(Error)
      for (const secret of secrets) expect(errorText(rejected)).not.toContain(secret)

      const failing: RefreshFetch = async () => {
        throw new TypeError('fetch failed')
      }
      const transport = await new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl: failing })
        .getTokens()
        .then(() => undefined, (error: unknown) => error)
      expect(transport).toBeInstanceOf(Error)
      for (const secret of secrets) expect(errorText(transport)).not.toContain(secret)
    } finally {
      for (const [level, original] of saved) Reflect.set(console, level, original)
    }

    expect(captured).toEqual([])
  })
})
