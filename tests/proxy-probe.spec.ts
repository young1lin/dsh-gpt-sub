import { describe, expect, it } from 'vitest'
import type { Dispatcher } from 'undici'
import { fetch as undiciFetch } from 'undici'
import { probeProxy } from '../src/proxy-probe.ts'

/** A fetch double answering one canned usage reply and recording its inputs. */
function usageStub(reply: () => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>) {
  const seen: { dispatcher?: unknown; signal?: AbortSignal }[] = []
  const fetchImpl = (async (_url: string, init: { dispatcher?: unknown; signal?: AbortSignal }) => {
    seen.push({
      ...(init.dispatcher === undefined ? {} : { dispatcher: init.dispatcher }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    })
    return reply()
  }) as unknown as typeof undiciFetch
  return { fetchImpl, seen }
}

const OK_REPLY = {
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ plan_type: 'plus', rate_limit: null }),
}

describe('probeProxy', () => {
  it('reports latency and plan when the usage endpoint answers', async () => {
    const { fetchImpl } = usageStub(async () => OK_REPLY)
    const result = await probeProxy({
      proxyUrl: 'http://127.0.0.1:7890',
      accessToken: 'token',
      fetchImpl,
      now: () => 1_000,
    })
    expect(result).toEqual({ ok: true, latencyMs: 0, plan: 'plus' })
  })

  it('routes a non-empty candidate through a fresh ProxyAgent with a timeout signal', async () => {
    const { fetchImpl, seen } = usageStub(async () => OK_REPLY)
    await probeProxy({ proxyUrl: 'http://127.0.0.1:7890', accessToken: 'token', fetchImpl })
    expect(seen[0]?.dispatcher).toBeDefined()
    expect((seen[0]?.dispatcher as Dispatcher).constructor.name).toBe('ProxyAgent')
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('probes direct when the candidate is empty', async () => {
    const { fetchImpl, seen } = usageStub(async () => OK_REPLY)
    await probeProxy({ proxyUrl: '', accessToken: 'token', fetchImpl })
    expect(seen[0]?.dispatcher).toBeUndefined()
  })

  it('answers ok:false with the failure message instead of rejecting', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof undiciFetch
    const result = await probeProxy({ proxyUrl: '', accessToken: 'token', fetchImpl: failing })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('fetch failed')
  })
})
