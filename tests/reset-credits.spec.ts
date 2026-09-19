import { describe, expect, it } from 'vitest'
import { fetch as undiciFetch } from 'undici'
import { consumeResetCredit, listResetCredits } from '../src/reset-credits.ts'

/** A fetch double recording method, url, headers and body, answering canned JSON. */
function fetchDouble(reply: () => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>) {
  const seen: {
    url?: string
    method?: string
    authorization?: string | undefined
    contentType?: string
    body?: Record<string, unknown>
  }[] = []
  const fetchImpl = (async (url: string, init: RequestInit & { method?: string; body?: string }) => {
    const headers = init.headers as Record<string, string>
    seen.push({
      ...(url === undefined ? {} : { url }),
      ...(init.method === undefined ? {} : { method: init.method }),
      authorization: headers['authorization'],
      ...(headers['content-type'] === undefined ? {} : { contentType: headers['content-type'] }),
      ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as Record<string, unknown> }),
    })
    return reply()
  }) as unknown as typeof undiciFetch
  return { fetchImpl, seen }
}

describe('listResetCredits', () => {
  it('GETs the credits endpoint with Bearer auth and parses the reply', async () => {
    const { fetchImpl, seen } = fetchDouble(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          available_count: 2,
          credits: [
            { id: 'c1', reset_type: 'codex_rate_limits', status: 'available', granted_at: '2025-01-01T00:00:00Z' },
          ],
        }),
    }))
    const details = await listResetCredits('token', undefined, fetchImpl)
    expect(details.available_count).toBe(2)
    expect(details.credits[0]?.id).toBe('c1')
    expect(seen[0]?.url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits')
    expect(seen[0]?.method).toBeUndefined()
    expect(seen[0]?.authorization).toBe('Bearer token')
  })

  it('throws with the status when the endpoint refuses', async () => {
    const { fetchImpl } = fetchDouble(async () => ({ ok: false, status: 403, text: async () => 'blocked' }))
    await expect(listResetCredits('token', undefined, fetchImpl)).rejects.toThrow('answered 403')
  })
})

describe('consumeResetCredit', () => {
  it('POSTs redeem_request_id and the chosen credit_id', async () => {
    const { fetchImpl, seen } = fetchDouble(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 'reset', windows_reset: 1 }),
    }))
    const reply = await consumeResetCredit('token', 'key-1', {
      creditId: 'c1',
      fetchImpl,
    })
    expect(reply).toEqual({ code: 'reset', windows_reset: 1 })
    expect(seen[0]?.url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume')
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.contentType).toBe('application/json')
    expect(seen[0]?.body).toEqual({ redeem_request_id: 'key-1', credit_id: 'c1' })
  })

  it('omits credit_id when no specific credit is chosen', async () => {
    const { fetchImpl, seen } = fetchDouble(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 'no_credit' }),
    }))
    await consumeResetCredit('token', 'key-2', { fetchImpl })
    expect(seen[0]?.body).toEqual({ redeem_request_id: 'key-2' })
  })
})
