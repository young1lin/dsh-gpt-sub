/**
 * Direct ChatGPT/Codex subscription access for DeepSeek Harness.
 *
 * This plugin owns no transport. pi-ai already ships an `openai-codex`
 * provider that knows the Codex wire format -- it sets `store`, derives
 * `chatgpt-account-id` from the access token's own JWT claim, and speaks the
 * codex-responses protocol -- but it authenticates only through OAuth, and
 * `dsh-llm-pi-ai` runs no login flow and holds no OAuth store. Naming a
 * credential on the route grafts an api-key method beside the provider's own,
 * which is the seam this plugin fills: it keeps a live Codex access token in
 * the harness credential store, refreshing it from `~/.codex/auth.json` before
 * it expires.
 *
 * The result needs no loopback port, no shared local key, and no external
 * proxy binary. The `codex` CLI still owns the login.
 *
 * @module dsh-gpt-sub
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
// Type-only: loads the module augmentation that puts `webServer` on Context.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { Dispatcher } from 'undici'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  crossOrigin,
  loadStateOverride,
  readJsonObject,
  redactProxyUrl,
  saveStateOverride,
  validateProxyUrl,
  type StateOverride,
} from './proxy-config.ts'
import { probeProxy } from './proxy-probe.ts'
import { installProxyRouting, type ProxyRouting } from './proxy-routing.ts'
import { QuotaSource } from './quota-route.ts'
import { TokenStore } from './token-store.ts'
import type { Config as ConfigShape } from './types.ts'
import { activeWindow, fetchUsage } from './usage.ts'

// A type-only re-export of the same name as the `Config` value below would
// collide (TS2323); a local alias merges with the value export instead.
export type Config = ConfigShape

/** Cordis plugin name. */
export const name = 'gpt-sub'

/**
 * Required services. Without this declaration cordis's context proxy throws
 * `cannot get property "credentials" without inject` the moment the plugin
 * reads `ctx.credentials`, and the plugin sits dead with no retry.
 */
export const inject = ['credentials', 'webServer']

/** Where the browser half polls for the quota reading. */
const QUOTA_ROUTE = '/gpt-sub/quota'

/** Where the browser half reads auth/proxy status the panel renders. */
const STATUS_ROUTE = '/gpt-sub/status'

/** Where the browser half switches the live proxy at runtime. */
const PROXY_ROUTE = '/gpt-sub/proxy'

/** Where the browser half probes a candidate proxy before saving it. */
const PROXY_TEST_ROUTE = '/gpt-sub/proxy/test'

/** Where the browser half switches the credential file at runtime. */
const AUTH_ROUTE = '/gpt-sub/auth'

/** Where the browser half lists a directory to pick a credential file. */
const AUTH_BROWSE_ROUTE = '/gpt-sub/auth/browse'

/** Ceiling on one directory listing, so a huge folder cannot flood the page. */
const BROWSE_LIMIT = 500

/** Ceiling on one connectivity probe. */
const PROBE_TIMEOUT_MS = 15_000

/**
 * How a proxy URL appears in logs: credentials masked, direct named as such.
 *
 * @param url - the proxy URL as configured or saved.
 * @returns the log-safe rendering.
 */
const displayProxy = (url: string): string => (url === '' ? 'direct' : redactProxyUrl(url))

/**
 * Plugin config schema.
 *
 * Typed input-then-output: every field has a default, so a config document may
 * supply any subset, and what comes back out is a fully resolved `ConfigShape`.
 */
export const Config: z<Partial<ConfigShape>, ConfigShape> = z.object({
  // Empty means a direct connection. The token endpoint is as unreachable as
  // the model endpoint on a machine that needs a proxy, so this covers both.
  proxyUrl: z.string().default(''),
  authFile: z.string().default('~/.codex/auth.json'),
  refreshMarginMinutes: z.number().default(30),
  // The credential the provider route names in settings.yaml. Both sides must
  // agree, so it is configurable rather than hard-coded.
  tokenRef: z.string().role('credential-ref').default('CODEX_NATIVE_TOKEN'),
  // How often to re-read auth.json and republish. Well under the refresh
  // margin, so a token nearing expiry is always renewed before a request needs
  // it. Each tick is a file read; it reaches the network only to refresh.
  syncIntervalMinutes: z.number().default(10),
  // How many times a single request may be re-attempted after the connection
  // drops. The link to the proxy fails at random, and each failure otherwise
  // reaches the user as a bare `fetch failed` mid-conversation.
  bootstrapRetries: z.number().default(3),
  // Where the settings panel's proxy edits are persisted. When this file
  // exists, its proxyUrl wins over the config's -- a page edit survives
  // restarts without touching cordis config layers.
  stateFile: z.string().default('~/.dsh/gpt-sub.json'),
})

/** Expand a leading `~` against the current user's home directory. */
function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/**
 * Publish the current Codex access token into the credential store, and keep
 * publishing it for as long as the plugin is loaded.
 *
 * Async on purpose: cordis awaits a thenable returned from plugin startup and
 * collects the function it resolves to as the fiber's disposer. A missing or
 * unreadable `auth.json` therefore fails the fiber visibly at start instead of
 * leaving a route configured against a credential nothing maintains.
 *
 * @param ctx - the cordis context.
 * @param config - validated plugin configuration.
 * @returns the teardown that stops the sync timer and closes the dispatcher.
 */
export async function apply(ctx: Context, config: ConfigShape): Promise<() => Promise<void>> {
  const stateFile = expandHome(config.stateFile)

  // A panel-saved override wins over the config value; a corrupt file falls
  // back to the config rather than failing the plugin over a status file.
  // One state file carries both page-side choices; a field present in it wins
  // over the config value, and a differing choice is logged at start.
  const savedState = await loadStateOverride(stateFile)
  const savedProxy = savedState?.proxyUrl
  if (savedProxy !== undefined && savedProxy !== config.proxyUrl) {
    ctx.logger.info(
      'gpt-sub: proxy override %s from %s replaces config proxyUrl %s',
      displayProxy(savedProxy),
      stateFile,
      displayProxy(config.proxyUrl),
    )
  }
  let proxyUrl = savedProxy ?? config.proxyUrl
  let overridden = savedProxy !== undefined

  const savedAuthFile = savedState?.authFile
  if (savedAuthFile !== undefined && savedAuthFile !== config.authFile) {
    ctx.logger.info(
      'gpt-sub: credential file %s from %s replaces config authFile %s',
      savedAuthFile,
      stateFile,
      config.authFile,
    )
  }
  let authFileDisplay = savedAuthFile ?? config.authFile
  let authOverridden = savedAuthFile !== undefined

  // Mirror of what the state file currently holds. Every save rewrites the
  // whole object, so recording one choice never erases the other.
  const persisted: StateOverride = {}
  if (overridden) persisted.proxyUrl = proxyUrl
  if (authOverridden) persisted.authFile = authFileDisplay

  // pi-ai issues model calls through the global fetch, so the proxy has to be
  // installed there rather than handed to a component. Scoped by hostname, so
  // no other provider's traffic changes route.
  let routing: ProxyRouting | undefined =
    proxyUrl === ''
      ? undefined
      : installProxyRouting(proxyUrl, { maxRetries: config.bootstrapRetries })
  let dispatcher: Dispatcher | undefined = routing?.dispatcher
  if (routing !== undefined) {
    ctx.logger.info(
      'gpt-sub: routing chatgpt.com and auth.openai.com through %s, retrying dropped connections %d times',
      displayProxy(proxyUrl),
      config.bootstrapRetries,
    )
  }

  const tokens = new TokenStore({
    authFile: expandHome(authFileDisplay),
    refreshMarginMs: config.refreshMarginMinutes * 60_000,
    ...(dispatcher === undefined ? {} : { dispatcher }),
  })

  const ref = credentialRef(config.tokenRef)

  /** When the last successful sync finished; 0 before the first. */
  let lastSyncAt = 0

  /**
   * Read the current token -- refreshing first when it is inside the margin --
   * and write it to the credential the provider route reads.
   *
   * @returns nothing; failures propagate to the caller.
   */
  const sync = async (): Promise<void> => {
    const current = await tokens.getTokens()
    await ctx.credentials.set(ref, current.accessToken)
    lastSyncAt = Date.now()
  }

  // Fail here, naming the path, rather than leaving the route pointed at a
  // credential that will never be populated.
  await tokens.verify()
  await sync()
  ctx.logger.info('gpt-sub: published Codex access token to %s', config.tokenRef)

  // Reachability probe. An unproxied egress answers 403 with a Cloudflare
  // block page, and that failure is otherwise invisible until the first model
  // call, where it surfaces as unreadable HTML. Log it loudly here instead.
  // A probe failure must not fail the plugin: the network may simply be down,
  // and the credential is published either way.
  try {
    const current = await tokens.getTokens()
    // Bounded like the panel's own probe: a black-holed route must delay
    // startup by seconds, not by the operating system's connect timeout.
    const usage = await fetchUsage(current.accessToken, dispatcher, undefined, AbortSignal.timeout(PROBE_TIMEOUT_MS))
    const window = activeWindow(usage)
    if (window === undefined) {
      ctx.logger.info('gpt-sub: reachable; plan %s, no rate-limit window reported', usage.plan_type ?? 'unknown')
    } else {
      ctx.logger.info(
        'gpt-sub: reachable; plan %s, %d%% of the %dh window used',
        usage.plan_type ?? 'unknown',
        window.used_percent,
        Math.round(window.limit_window_seconds / 3600),
      )
    }
  } catch (error) {
    ctx.logger.warn('gpt-sub: reachability probe failed: %s', String(error))
  }

  // The quota panel's data source. Reads the same token the model calls use,
  // through the same proxy routing, and throttles so one open settings page
  // cannot turn into a stream of upstream requests.
  const quota = new QuotaSource({
    accessToken: async () => (await tokens.getTokens()).accessToken,
    ...(dispatcher === undefined ? {} : { dispatcher }),
  })

  /**
   * Swap the live proxy routing, serializing concurrent switches.
   *
   * Restores the pre-plugin global dispatcher before installing the next
   * routing, so no request ever dispatches into a closing agent, and points
   * the token store and quota source at the new dispatcher.
   *
   * @param nextUrl - the proxy URL to route through; empty string for direct.
   * @returns nothing; failures propagate to the caller.
   */
  let switching: Promise<void> = Promise.resolve()
  const switchProxy = (nextUrl: string): Promise<void> => {
    const run = async (): Promise<void> => {
      const previous = routing
      routing = undefined
      await previous?.uninstall()
      routing =
        nextUrl === '' ? undefined : installProxyRouting(nextUrl, { maxRetries: config.bootstrapRetries })
      dispatcher = routing?.dispatcher
      tokens.setDispatcher(dispatcher)
      quota.setDispatcher(dispatcher)
      proxyUrl = nextUrl
    }
    switching = switching.then(run, run)
    return switching
  }

  /**
   * Swap the live credential file, serializing concurrent switches the way
   * {@link switchProxy} does.
   *
   * The caller validates a non-empty candidate before calling; this persists,
   * points the token store at the new file, and republishes immediately, so a
   * model call cannot race the next sync tick with the previous file's token.
   *
   * @param rawPath - the path as typed on the page; empty restores the config.
   * @returns the display path now in force, and whether the token republished.
   */
  let switchingAuth: Promise<{ display: string; published: boolean }> = Promise.resolve({
    display: '',
    published: true,
  })
  const switchAuthFile = (rawPath: string): Promise<{ display: string; published: boolean }> => {
    const run = async (): Promise<{ display: string; published: boolean }> => {
      if (rawPath === '') {
        delete persisted.authFile
        await saveStateOverride(stateFile, persisted)
        authOverridden = false
        authFileDisplay = config.authFile
      } else {
        persisted.authFile = rawPath
        await saveStateOverride(stateFile, persisted)
        authOverridden = true
        authFileDisplay = rawPath
      }
      tokens.setAuthFile(expandHome(authFileDisplay))
      try {
        await sync()
        return { display: authFileDisplay, published: true }
      } catch (error) {
        // The switch itself succeeded; only the publish failed, and the sync
        // timer retries it. Say so rather than failing a choice already made.
        ctx.logger.warn(
          'gpt-sub: token sync failed after switching to %s, retrying next tick: %s',
          authFileDisplay,
          String(error),
        )
        return { display: authFileDisplay, published: false }
      }
    }
    switchingAuth = switchingAuth.then(run, run)
    return switchingAuth
  }

  /** Reply with JSON, never cached. */
  const replyJson = (response: import('node:http').ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(body))
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: QUOTA_ROUTE,
        handler: async (request, response) => {
          const force = new URL(request.url ?? '/', 'http://x').searchParams.get('refresh') === '1'
          const state = await quota.read(force)
          replyJson(response, 200, state)
        },
      }),
    `gpt-sub: GET ${QUOTA_ROUTE}`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: STATUS_ROUTE,
        handler: async (request, response) => {
          if (request.method !== 'GET') {
            replyJson(response, 405, { message: 'method not allowed' })
            return
          }
          // inspect() is file-only, so a status poll never refreshes a token
          // and never reaches the network.
          const inspection = await tokens.inspect().then(
            (value) => value,
            () => undefined,
          )
          const expiry = inspection?.accessTokenExpiresAt
          const syncIntervalMs = config.syncIntervalMinutes * 60_000
          replyJson(response, 200, {
            authFile: authFileDisplay,
            configAuthFile: config.authFile,
            authOverridden,
            proxyUrl,
            configProxyUrl: config.proxyUrl,
            overridden,
            refreshMarginMinutes: config.refreshMarginMinutes,
            syncIntervalMinutes: config.syncIntervalMinutes,
            ...(lastSyncAt === 0 ? {} : { lastSyncAt, nextSyncAt: lastSyncAt + syncIntervalMs }),
            ...(expiry === undefined
              ? {}
              : { tokenExpiresAt: expiry, refreshAt: expiry - config.refreshMarginMinutes * 60_000 }),
          })
        },
      }),
    `gpt-sub: GET ${STATUS_ROUTE}`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PROXY_ROUTE,
        handler: async (request, response) => {
          if (request.method !== 'POST') {
            replyJson(response, 405, { message: 'method not allowed' })
            return
          }
          if (crossOrigin(request)) {
            replyJson(response, 403, { ok: false, message: 'cross-origin request refused' })
            return
          }
          let nextUrl: string
          try {
            nextUrl = validateProxyUrl((await readJsonObject(request))['proxyUrl'])
          } catch (error) {
            replyJson(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
            return
          }
          try {
            persisted.proxyUrl = nextUrl
            await saveStateOverride(stateFile, persisted)
            overridden = true
            await switchProxy(nextUrl)
            ctx.logger.info('gpt-sub: proxy switched to %s', displayProxy(nextUrl))
            replyJson(response, 200, { ok: true, proxyUrl: nextUrl })
          } catch (error) {
            replyJson(response, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    `gpt-sub: POST ${PROXY_ROUTE}`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: PROXY_TEST_ROUTE,
        handler: async (request, response) => {
          if (request.method !== 'POST') {
            replyJson(response, 405, { message: 'method not allowed' })
            return
          }
          if (crossOrigin(request)) {
            replyJson(response, 403, { ok: false, message: 'cross-origin request refused' })
            return
          }
          let candidate = proxyUrl
          try {
            const body = await readJsonObject(request)
            if (body['proxyUrl'] !== undefined) candidate = validateProxyUrl(body['proxyUrl'])
          } catch (error) {
            replyJson(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
            return
          }
          try {
            const accessToken = (await tokens.getTokens()).accessToken
            const result = await probeProxy({
              proxyUrl: candidate,
              accessToken,
              timeoutMs: PROBE_TIMEOUT_MS,
            })
            replyJson(response, 200, result)
          } catch (error) {
            replyJson(response, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    `gpt-sub: POST ${PROXY_TEST_ROUTE}`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: AUTH_ROUTE,
        handler: async (request, response) => {
          if (request.method !== 'POST') {
            replyJson(response, 405, { message: 'method not allowed' })
            return
          }
          if (crossOrigin(request)) {
            replyJson(response, 403, { ok: false, message: 'cross-origin request refused' })
            return
          }
          // Absent or empty means "back to the configured default"; otherwise
          // the trimmed string is the candidate path.
          let candidate: string | undefined
          try {
            const body = await readJsonObject(request)
            const value = body['authFile']
            if (value !== undefined && value !== null) {
              if (typeof value !== 'string') throw new Error('authFile must be a string')
              candidate = value.trim()
            }
          } catch (error) {
            replyJson(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
            return
          }
          // Validate BEFORE persisting or switching: a path that cannot serve
          // credentials must never become the live source, here or after a
          // restart. verify() is file-only -- the check spends no refresh.
          if (candidate !== undefined && candidate !== '') {
            try {
              await new TokenStore({
                authFile: expandHome(candidate),
                refreshMarginMs: config.refreshMarginMinutes * 60_000,
              }).verify()
            } catch (error) {
              replyJson(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
              return
            }
          }
          try {
            const result = await switchAuthFile(candidate ?? '')
            ctx.logger.info(
              'gpt-sub: credential file %s',
              candidate === undefined || candidate === ''
                ? `restored to configured ${result.display}`
                : `switched to ${result.display}`,
            )
            replyJson(response, 200, { ok: true, authFile: result.display, published: result.published })
          } catch (error) {
            replyJson(response, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    `gpt-sub: POST ${AUTH_ROUTE}`,
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: AUTH_BROWSE_ROUTE,
        handler: async (request, response) => {
          if (request.method !== 'GET') {
            replyJson(response, 405, { message: 'method not allowed' })
            return
          }
          const requested = new URL(request.url ?? '/', 'http://x').searchParams.get('path') ?? ''
          // Empty means start from the home directory, where ~/.codex lives.
          // A listing carries names and paths only -- never file contents.
          const target = requested.trim() === '' ? homedir() : expandHome(requested.trim())
          try {
            if (!(await stat(target)).isDirectory()) throw new Error('not a directory')
          } catch {
            replyJson(response, 400, { ok: false, message: `not a readable directory: ${target}` })
            return
          }
          try {
            const dirents = await readdir(target, { withFileTypes: true })
            const entries = dirents
              .slice(0, BROWSE_LIMIT)
              .map((entry) => ({
                name: entry.name,
                path: join(target, entry.name),
                dir: entry.isDirectory(),
              }))
              .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
            // The root's parent is itself, so the panel hides the up-row
            // rather than offering a dead link.
            const parent = dirname(target)
            replyJson(response, 200, {
              ok: true,
              dir: target,
              ...(parent !== target ? { parent } : {}),
              truncated: dirents.length > BROWSE_LIMIT,
              entries,
            })
          } catch (error) {
            replyJson(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    `gpt-sub: GET ${AUTH_BROWSE_ROUTE}`,
  )

  const timer = setInterval(() => {
    // A rejected timer callback would be an unhandled rejection, and DSH's
    // handler exits the process. A transient refresh failure must cost a log
    // line, not the harness: the next tick tries again, and the token in the
    // store stays valid until its own expiry regardless.
    void sync().catch((error: unknown) => {
      ctx.logger.warn('gpt-sub: token sync failed, retrying next tick: %s', String(error))
    })
  }, config.syncIntervalMinutes * 60_000)
  // Never let this timer be the reason the process stays alive.
  timer.unref?.()

  return async () => {
    clearInterval(timer)
    // Restores the previous global dispatcher before closing the agent, so a
    // fiber restart never leaves the host dispatching into a closing proxy.
    await switching.catch(() => undefined)
    await routing?.uninstall()
  }
}
