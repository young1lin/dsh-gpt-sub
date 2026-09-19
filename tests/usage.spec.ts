import { describe, expect, it } from 'vitest'
import { fetchUsage, reportedWindows, resetsRemaining, reportWindows, UsageError, type Usage } from '../src/usage.ts'

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

describe('reportedWindows', () => {
  it('lists both windows, primary first, when the plan has a 5h and a weekly one', () => {
    const usage: Usage = {
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 60, limit_window_seconds: 604800 },
      },
    }
    expect(reportedWindows(usage).map((window) => window.used_percent)).toEqual([10, 60])
  })

  it('reports the primary alone when secondary is null', () => {
    // A plus account reports exactly this, so reading only `secondary` shows nothing.
    const usage: Usage = {
      rate_limit: { primary_window: { used_percent: 60, limit_window_seconds: 604800 }, secondary_window: null },
    }
    expect(reportedWindows(usage).map((window) => window.used_percent)).toEqual([60])
  })

  it('is empty when the reply carries no window at all', () => {
    expect(reportedWindows({})).toEqual([])
  })
})

describe('resetsRemaining', () => {
  it('counts the on-demand resets the reply carries', () => {
    const usage: Usage = { rate_limit_reset_credits: { available_count: 1 } }
    expect(resetsRemaining(usage)).toBe(1)
  })

  it('keeps a reported zero, so a spent allowance still reads as one', () => {
    const usage: Usage = { rate_limit_reset_credits: { available_count: 0 } }
    expect(resetsRemaining(usage)).toBe(0)
  })

  it('is undefined when the reply carries no reset credits', () => {
    expect(resetsRemaining({})).toBeUndefined()
    expect(resetsRemaining({ rate_limit_reset_credits: null })).toBeUndefined()
    expect(resetsRemaining({ rate_limit_reset_credits: {} })).toBeUndefined()
  })
})

describe('reportWindows', () => {
  it('lists every reported window, primary first, with hours and reset time', () => {
    const usage: Usage = {
      rate_limit: {
        primary_window: { used_percent: 11, limit_window_seconds: 18000, reset_at: 1234 },
        secondary_window: { used_percent: 2, limit_window_seconds: 604800 },
      },
    }
    expect(reportWindows(usage)).toEqual([
      { usedPercent: 11, windowHours: 5, resetAt: 1234 },
      { usedPercent: 2, windowHours: 168 },
    ])
  })

  it('skips a null secondary window', () => {
    // A plus account reports exactly this: one window, on the primary slot.
    const usage: Usage = {
      rate_limit: { primary_window: { used_percent: 60, limit_window_seconds: 604800 }, secondary_window: null },
    }
    expect(reportWindows(usage)).toEqual([{ usedPercent: 60, windowHours: 168 }])
  })

  it('is empty when the reply carries no window at all', () => {
    expect(reportWindows({})).toEqual([])
  })
})
