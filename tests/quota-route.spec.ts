import { beforeEach, describe, expect, it, vi } from 'vitest'

// The upstream reply the mocked fetch serves next, plus how many calls it took
// and whether it refuses. QuotaSource reaches the network only through
// undici's fetch (via fetchUsage), so mocking that one export pins it down.
const upstream = vi.hoisted(() => ({
  body: '{}',
  fail: false,
  calls: 0,
}))

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>()
  return {
    ...actual,
    fetch: async () => {
      upstream.calls += 1
      if (upstream.fail) throw new Error('upstream down')
      return { ok: true, status: 200, text: async () => upstream.body }
    },
  }
})

import { QuotaSource } from '../src/quota-route.ts'

/**
 * A plan that still has the 5-hour rolling limit: primary carries it, and the
 * weekly allowance sits on the secondary.
 */
const FIVE_HOUR_AND_WEEKLY = JSON.stringify({
  plan_type: 'pro',
  rate_limit: {
    primary_window: { used_percent: 73, limit_window_seconds: 18000, reset_at: 1800000000 },
    secondary_window: { used_percent: 31, limit_window_seconds: 604800, reset_at: 1800400000 },
  },
  rate_limit_reset_credits: { available_count: 2 },
})

/**
 * A plan with no 5-hour limit -- what pro accounts currently report: the
 * weekly allowance on the primary and `secondary_window: null`.
 */
const WEEKLY_ONLY = JSON.stringify({
  plan_type: 'pro',
  rate_limit: { primary_window: { used_percent: 31, limit_window_seconds: 604800 }, secondary_window: null },
})

/** A controllable clock, so the throttle tests never wait real time. */
let clock = 0

/** A source reading from the mocked upstream on a movable clock. */
function source(): QuotaSource {
  clock = 0
  return new QuotaSource({ accessToken: async () => 'token', minIntervalMs: 60_000, now: () => clock })
}

beforeEach(() => {
  upstream.body = '{}'
  upstream.fail = false
  upstream.calls = 0
})

describe('QuotaSource', () => {
  it('serves the 5-hour window beside the weekly one', async () => {
    upstream.body = FIVE_HOUR_AND_WEEKLY
    const state = await source().read()
    expect(state.phase).toBe('ready')
    expect(state.plan).toBe('pro')
    expect(state.fiveHour).toEqual({ usedPercent: 73, windowHours: 5, resetAt: 1800000000 })
    expect(state.weekly).toEqual({ usedPercent: 31, windowHours: 168, resetAt: 1800400000 })
    expect(state.resetsRemaining).toBe(2)
  })

  it('omits resetsRemaining when the reply carries no reset credits', async () => {
    upstream.body = WEEKLY_ONLY
    const state = await source().read()
    expect(state.resetsRemaining).toBeUndefined()
  })

  it('omits the 5-hour window when the plan has none, keeping the weekly one', async () => {
    // The panel renders a note where the 5-hour bar would be, not an empty bar.
    upstream.body = WEEKLY_ONLY
    const state = await source().read()
    expect(state.phase).toBe('ready')
    expect(state.fiveHour).toBeUndefined()
    expect(state.weekly).toEqual({ usedPercent: 31, windowHours: 168 })
  })

  it('serves a windowless reply as ready with neither window', async () => {
    upstream.body = JSON.stringify({ plan_type: 'free' })
    const state = await source().read()
    expect(state.phase).toBe('ready')
    expect(state.fiveHour).toBeUndefined()
    expect(state.weekly).toBeUndefined()
  })

  it('omits resetAt when the reply carries none', async () => {
    upstream.body = JSON.stringify({
      rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 18000 } },
    })
    const state = await source().read()
    expect(state.fiveHour).toEqual({ usedPercent: 5, windowHours: 5 })
  })

  it('keeps the last good windows, marked stale, when a refresh fails', async () => {
    upstream.body = FIVE_HOUR_AND_WEEKLY
    const quota = source()
    const good = await quota.read()

    clock += 120_000
    upstream.fail = true
    const stale = await quota.read()
    expect(stale.stale).toBe(true)
    expect(stale.fiveHour).toEqual(good.fiveHour)
    expect(stale.weekly).toEqual(good.weekly)
    expect(stale.message).toContain('upstream down')
  })

  it('serves a cached reading inside the throttle window, refreshing past it', async () => {
    upstream.body = FIVE_HOUR_AND_WEEKLY
    const quota = source()
    await quota.read()

    clock += 10_000
    await quota.read()
    expect(upstream.calls).toBe(1)

    clock += 60_000
    await quota.read()
    expect(upstream.calls).toBe(2)
  })

  it('refetches inside the throttle window when forced', async () => {
    upstream.body = FIVE_HOUR_AND_WEEKLY
    const quota = source()
    await quota.read()

    await quota.read(true)
    expect(upstream.calls).toBe(2)
  })
})
