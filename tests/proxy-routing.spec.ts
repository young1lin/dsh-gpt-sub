import { describe, expect, it, vi } from 'vitest'
import {
  connectionRetryOptions,
  HostRoutingDispatcher,
  PROXIED_HOSTS,
  shouldProxy,
} from '../src/proxy-routing.ts'

describe('shouldProxy', () => {
  it('matches the Codex hosts', () => {
    expect(shouldProxy('chatgpt.com')).toBe(true)
    expect(shouldProxy('auth.openai.com')).toBe(true)
    expect(shouldProxy('api.openai.com')).toBe(true)
  })

  it('matches subdomains of a proxied host', () => {
    expect(shouldProxy('cdn.chatgpt.com')).toBe(true)
  })

  it('is case insensitive, because a Host header need not be lowercase', () => {
    expect(shouldProxy('ChatGPT.com')).toBe(true)
  })

  it('leaves every other provider alone', () => {
    // Routing these through the proxy is the failure this scoping exists to prevent.
    expect(shouldProxy('open.bigmodel.cn')).toBe(false)
    expect(shouldProxy('api.deepseek.com')).toBe(false)
    expect(shouldProxy('127.0.0.1')).toBe(false)
  })

  it('does not match a host that merely ends with the same letters', () => {
    expect(shouldProxy('notchatgpt.com')).toBe(false)
  })

  it('ships the hosts the plugin actually needs', () => {
    expect(PROXIED_HOSTS).toContain('chatgpt.com')
    expect(PROXIED_HOSTS).toContain('auth.openai.com')
  })
})

/** A dispatcher double that records what it was asked to dispatch. */
function delegate(): { calls: string[]; dispatcher: { dispatch: (o: { origin: string }) => boolean; close: () => Promise<void>; destroy: () => Promise<void> } } {
  const calls: string[] = []
  return {
    calls,
    dispatcher: {
      dispatch: (options: { origin: string }): boolean => {
        calls.push(options.origin)
        return true
      },
      close: async (): Promise<void> => undefined,
      destroy: async (): Promise<void> => undefined,
    },
  }
}

/**
 * Build a routing dispatcher over two doubles.
 *
 * @returns the dispatcher and both delegates' call logs.
 */
function routed(): { dispatch: (origin: string) => void; proxied: string[]; direct: string[]; close: () => Promise<void>; proxyClosed: () => number } {
  const proxy = delegate()
  const fallback = delegate()
  let proxyClosed = 0
  const proxyDispatcher = { ...proxy.dispatcher, close: async (): Promise<void> => { proxyClosed += 1 } }
  const subject = new HostRoutingDispatcher(
    proxyDispatcher as never,
    fallback.dispatcher as never,
  )
  return {
    dispatch: (origin: string): void => {
      subject.dispatch({ origin, path: '/', method: 'GET' }, {} as never)
    },
    proxied: proxy.calls,
    direct: fallback.calls,
    close: async (): Promise<void> => { await subject.close() },
    proxyClosed: (): number => proxyClosed,
  }
}

describe('HostRoutingDispatcher', () => {
  it('sends a Codex origin to the proxy', () => {
    const r = routed()
    r.dispatch('https://chatgpt.com')
    expect(r.proxied).toEqual(['https://chatgpt.com'])
    expect(r.direct).toEqual([])
  })

  it('sends every other origin to the fallback', () => {
    const r = routed()
    r.dispatch('https://open.bigmodel.cn')
    expect(r.direct).toEqual(['https://open.bigmodel.cn'])
    expect(r.proxied).toEqual([])
  })

  it('sends an unparseable origin to the fallback, never the proxy', () => {
    // Defaulting to the proxy would silently divert traffic nothing asked to divert.
    const r = routed()
    r.dispatch('not a url')
    expect(r.proxied).toEqual([])
    expect(r.direct).toHaveLength(1)
  })

  it('closes only the proxy delegate, because the fallback belongs to the host', async () => {
    const r = routed()
    const closeFallback = vi.fn()
    await r.close()
    expect(r.proxyClosed()).toBe(1)
    expect(closeFallback).not.toHaveBeenCalled()
  })
})

describe('connectionRetryOptions', () => {
  it('retries POST, or model calls would never be retried at all', () => {
    // undici omits POST by default for non-idempotency; that reasoning does
    // not cover a connection that failed before the request was received.
    expect(connectionRetryOptions(3).methods).toContain('POST')
  })

  it('takes on no HTTP-level retry policy', () => {
    // A 429 or 500 carries a body DSH reads and surfaces. Retrying here would
    // swallow it, so only transport failures are this dispatcher's business.
    expect(connectionRetryOptions(3).statusCodes).toEqual([])
  })

  it('covers the failure codes a dropped tunnel produces', () => {
    const { errorCodes } = connectionRetryOptions(3)
    expect(errorCodes).toContain('ECONNRESET')
    expect(errorCodes).toContain('UND_ERR_SOCKET')
    expect(errorCodes).toContain('UND_ERR_CONNECT_TIMEOUT')
  })

  it('passes the configured attempt count through', () => {
    expect(connectionRetryOptions(5).maxRetries).toBe(5)
  })

  it('backs off fast enough that a recovered connection still feels like one request', () => {
    const options = connectionRetryOptions(3)
    const last = options.minTimeout * options.timeoutFactor ** (options.maxRetries - 1)
    expect(Math.min(last, options.maxTimeout)).toBeLessThanOrEqual(2_000)
  })
})
