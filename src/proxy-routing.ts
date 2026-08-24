/**
 * Host-scoped proxy routing for the process-wide undici dispatcher.
 *
 * pi-ai issues its own requests through the global `fetch`, so this plugin
 * cannot hand it a dispatcher the way it hands one to `TokenStore`. The only
 * seam is undici's global dispatcher -- but replacing that wholesale would
 * push every provider in the harness through the proxy, including endpoints
 * that must not go near it.
 *
 * So route by hostname: the Codex hosts go through the proxy, everything else
 * continues to whatever dispatcher was installed before. Reaching
 * `chatgpt.com` from an unproxied address here answers 403 with a Cloudflare
 * block page, which surfaces as an unreadable HTML body rather than an API
 * error, so this is the difference between working and not.
 *
 * @module dsh-gpt-sub/proxy-routing
 */

import { Dispatcher, ProxyAgent, getGlobalDispatcher, interceptors, setGlobalDispatcher } from 'undici'

/**
 * Transport failures worth retrying: the link to this proxy drops connections
 * at random, and each drop surfaces to DSH as a bare `fetch failed`.
 *
 * Measured direct to chatgpt.com through the same proxy, the failure is
 * non-monotonic in payload size, so it is a random connection failure rather
 * than a threshold -- which is exactly the shape a retry fixes.
 */
const RETRYABLE_ERROR_CODES = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ENETDOWN',
  'ENETUNREACH',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]

/**
 * Hosts that must egress through the proxy: the Codex API and the OAuth token
 * endpoint the refresh calls. Subdomains match too.
 */
export const PROXIED_HOSTS: readonly string[] = ['chatgpt.com', 'auth.openai.com', 'api.openai.com']

/**
 * Whether a hostname belongs to one of `hosts`, matching the host itself and
 * any subdomain of it.
 *
 * @param hostname - the hostname to test.
 * @param hosts - the suffixes to match against.
 * @returns true when the hostname should be proxied.
 */
export function shouldProxy(hostname: string, hosts: readonly string[] = PROXIED_HOSTS): boolean {
  const lower = hostname.toLowerCase()
  return hosts.some((host) => lower === host || lower.endsWith(`.${host}`))
}

/**
 * A dispatcher that sends matching hosts to one delegate and everything else
 * to another.
 *
 * Only the proxy delegate is owned: `close`/`destroy` never touch the
 * fallback, because that dispatcher belongs to the host and outlives this
 * plugin.
 */
export class HostRoutingDispatcher extends Dispatcher {
  readonly #proxy: Dispatcher
  readonly #fallback: Dispatcher
  readonly #hosts: readonly string[]

  constructor(proxy: Dispatcher, fallback: Dispatcher, hosts: readonly string[] = PROXIED_HOSTS) {
    super()
    this.#proxy = proxy
    this.#fallback = fallback
    this.#hosts = hosts
  }

  /**
   * Route one request by its origin's hostname.
   *
   * An origin that cannot be parsed is sent to the fallback: defaulting to the
   * proxy would silently divert unrelated traffic.
   *
   * @param options - undici dispatch options.
   * @param handler - undici dispatch handler.
   * @returns whatever the chosen delegate returns.
   */
  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    let hostname = ''
    try {
      const origin = options.origin
      hostname = new URL(typeof origin === 'string' ? origin : String(origin?.href ?? '')).hostname
    } catch {
      hostname = ''
    }
    const delegate = hostname !== '' && shouldProxy(hostname, this.#hosts) ? this.#proxy : this.#fallback
    return delegate.dispatch(options, handler)
  }

  /** Close only the proxy delegate; the fallback belongs to the host. */
  override async close(): Promise<void> {
    await this.#proxy.close()
  }

  /** Destroy only the proxy delegate; the fallback belongs to the host. */
  override async destroy(): Promise<void> {
    await this.#proxy.destroy()
  }
}

/**
 * Retry options that absorb a dropped connection without taking on any
 * HTTP-level retry policy.
 *
 * `statusCodes: []` is deliberate: an upstream 429 or 500 carries a body DSH
 * knows how to read and surface, and retrying here would swallow it. This
 * dispatcher's job is narrow -- make the flaky link look reliable -- and every
 * HTTP semantic stays with the harness.
 *
 * `POST` is listed even though undici omits it by default, because undici
 * omits it for non-idempotency: a POST that may have been received must not be
 * replayed. That does not apply to what is retried here. A connection error
 * arrives before any response, and undici refuses to replay a request whose
 * body was already consumed; a partially streamed response is caught by
 * undici's own range check rather than silently concatenated. Model calls are
 * POSTs, so without this the retry would never fire at all.
 *
 * @param maxRetries - how many extra attempts a single request may make.
 * @returns options for undici's retry interceptor.
 */
export function connectionRetryOptions(maxRetries: number): {
  maxRetries: number
  methods: string[]
  statusCodes: number[]
  errorCodes: string[]
  minTimeout: number
  maxTimeout: number
  timeoutFactor: number
} {
  return {
    maxRetries,
    methods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE', 'POST'],
    statusCodes: [],
    errorCodes: [...RETRYABLE_ERROR_CODES],
    // 0.5s, 1s, 2s -- fast enough that a recovered connection still feels like
    // one request, slow enough to let a flapping tunnel settle.
    minTimeout: 500,
    maxTimeout: 8_000,
    timeoutFactor: 2,
  }
}

/** What {@link installProxyRouting} returns, so the caller can undo it. */
export interface ProxyRouting {
  /** The proxy agent, for handing to components that take an explicit dispatcher. */
  readonly dispatcher: Dispatcher
  /** Restore the previous global dispatcher and close the proxy agent. */
  readonly uninstall: () => Promise<void>
}

/** Options for {@link installProxyRouting}. */
export interface ProxyRoutingOptions {
  /** Hostnames to proxy; defaults to {@link PROXIED_HOSTS}. */
  readonly hosts?: readonly string[]
  /** Extra attempts per request after a connection failure. 0 disables retry. */
  readonly maxRetries?: number
}

/**
 * Install host-scoped proxy routing as the global dispatcher.
 *
 * @param proxyUrl - the proxy to route the Codex hosts through.
 * @param options - hosts to proxy and how hard to retry a dropped connection.
 * @returns the proxy dispatcher and the function that restores the previous global.
 */
export function installProxyRouting(proxyUrl: string, options: ProxyRoutingOptions = {}): ProxyRouting {
  const hosts = options.hosts ?? PROXIED_HOSTS
  const maxRetries = options.maxRetries ?? 3
  const proxy = new ProxyAgent(proxyUrl)
  // `compose` returns a proxy over the same agent with only `dispatch`
  // replaced, so `close()` on the result still closes the agent underneath --
  // and only requests routed here are retried. Nothing else in the harness
  // changes behaviour.
  const dispatcher =
    maxRetries > 0 ? proxy.compose(interceptors.retry(connectionRetryOptions(maxRetries))) : proxy
  const previous = getGlobalDispatcher()
  setGlobalDispatcher(new HostRoutingDispatcher(dispatcher, previous, hosts))

  return {
    dispatcher,
    uninstall: async () => {
      // Restore first, so nothing dispatches into a closing agent.
      setGlobalDispatcher(previous)
      try {
        await proxy.close()
      } catch {
        // Disposal must not hinge on the agent shutting down cleanly.
      }
    },
  }
}
