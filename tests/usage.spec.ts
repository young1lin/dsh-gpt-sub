import { describe, expect, it } from 'vitest'
import { activeWindow, fetchUsage, UsageError, type Usage } from '../src/usage.ts'

/** A fetch double answering one canned reply. */
function reply(status: number, body: string): typeof globalThis.fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async (): Promise<string> => body,
  })) as unknown as typeof globalThis.fetch
}

const BLOCK_PAGE = '<html><body><div class="blocked-icon"></div><p>Unable to load site</p></body></html>'

describe('fetchUsage', () => {
  it('parses a usage reply', async () => {
    const usage = await fetchUsage(
      'token',
      undefined,
      reply(200, JSON.stringify({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 60, limit_window_seconds: 604800 } } })) as never,
    )
    expect(usage.plan_type).toBe('plus')
    expect(usage.rate_limit?.primary_window?.used_percent).toBe(60)
  })

  it('names the proxy when the reply is a Cloudflare block page', async () => {
    // This is the exact failure an unproxied egress produces, and the message
    // must say so: the raw 403 body is HTML and reads as nothing at all.
    await expect(fetchUsage('token', undefined, reply(403, BLOCK_PAGE) as never)).rejects.toThrow(/proxy/)
    await expect(fetchUsage('token', undefined, reply(403, BLOCK_PAGE) as never)).rejects.toBeInstanceOf(UsageError)
  })

  it('reports an ordinary refusal by status', async () => {
    await expect(fetchUsage('token', undefined, reply(401, '{"detail":"nope"}') as never)).rejects.toThrow('401')
  })

  it('rejects a non-JSON success body', async () => {
    await expect(fetchUsage('token', undefined, reply(200, 'not json') as never)).rejects.toThrow(/JSON/)
  })
})

describe('activeWindow', () => {
  it('prefers the secondary window when the account has one', () => {
    const usage: Usage = {
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 60, limit_window_seconds: 604800 },
      },
    }
    expect(activeWindow(usage)?.used_percent).toBe(60)
  })

  it('falls back to the primary when secondary is null', () => {
    // A plus account reports exactly this, so reading only `secondary` shows nothing.
    const usage: Usage = {
      rate_limit: { primary_window: { used_percent: 60, limit_window_seconds: 604800 }, secondary_window: null },
    }
    expect(activeWindow(usage)?.used_percent).toBe(60)
  })

  it('is undefined when the reply carries no window at all', () => {
    expect(activeWindow({})).toBeUndefined()
  })
})
