import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { TokenStore } from '../src/token-store.ts'

/** Build a JWT-shaped token whose exp sits a given number of ms from `from`. */
function tokenExpiringIn(ms: number, from = Date.now()): string {
  const part = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'none' })}.${part({ exp: Math.floor((from + ms) / 1000) })}.sig`
}

let dir: string
let authFile: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gpt-sub-'))
  authFile = join(dir, 'auth.json')
})

/** Write an auth.json with the given access token and an extra field to protect. */
async function writeAuth(accessToken: string): Promise<void> {
  await writeFile(
    authFile,
    JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: tokenExpiringIn(-86_400_000),
        access_token: accessToken,
        refresh_token: 'refresh-abc',
        account_id: 'acct-123',
      },
      last_refresh: '2026-08-17T01:00:52.121605600Z',
    }),
    'utf8',
  )
}

describe('TokenStore.getTokens', () => {
  it('returns the stored token when it is comfortably valid', async () => {
    const token = tokenExpiringIn(10 * 24 * 3_600_000)
    await writeAuth(token)
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000 })
    const tokens = await store.getTokens()
    expect(tokens.accessToken).toBe(token)
    expect(tokens.accountId).toBe('acct-123')
    expect(tokens.refreshToken).toBe('refresh-abc')
  })

  it('does not refresh merely because the id_token expired', async () => {
    // This is the exact state of the target machine: id_token long expired,
    // access_token valid for days. Refreshing here would fire on every request.
    await writeAuth(tokenExpiringIn(10 * 24 * 3_600_000))
    let called = 0
    const store = new TokenStore({
      authFile,
      refreshMarginMs: 1_800_000,
      fetchImpl: (async () => {
        called += 1
        throw new Error('refresh must not be attempted')
      }),
    })
    await store.getTokens()
    expect(called).toBe(0)
  })

  it('fails with the path named when auth.json is missing', async () => {
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000 })
    await expect(store.getTokens()).rejects.toThrow(authFile)
  })

  it('fails with the path named when auth.json is unparseable', async () => {
    await writeFile(authFile, '{ not json', 'utf8')
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000 })
    await expect(store.getTokens()).rejects.toThrow(authFile)
  })
})

describe('TokenStore.inspect', () => {
  it('reports the access token expiry without touching the network', async () => {
    const from = Date.now()
    await writeAuth(tokenExpiringIn(3_600_000, from))
    const store = new TokenStore({
      authFile,
      refreshMarginMs: 1_800_000,
      fetchImpl: async () => {
        throw new Error('inspect must not reach the network')
      },
    })
    const inspection = await store.inspect()
    expect(inspection.accessTokenExpiresAt).toBe(Math.floor((from + 3_600_000) / 1000) * 1000)
  })

  it('reports no expiry when the access token carries no decodable exp', async () => {
    await writeAuth('opaque-not-a-jwt')
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000 })
    expect(await store.inspect()).toEqual({})
  })

  it('does not refresh even when the token is inside the margin', async () => {
    await writeAuth(tokenExpiringIn(60_000))
    const store = new TokenStore({
      authFile,
      refreshMarginMs: 1_800_000,
      fetchImpl: async () => {
        throw new Error('inspect must not refresh')
      },
    })
    await store.inspect()
  })
})

describe('TokenStore.setAuthFile', () => {
  it('reads from the new path once switched', async () => {
    await writeAuth(tokenExpiringIn(10 * 24 * 3_600_000))
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000 })
    await expect(store.getTokens()).resolves.toMatchObject({ accountId: 'acct-123' })

    const second = join(dir, 'second-auth.json')
    const rotated = tokenExpiringIn(10 * 24 * 3_600_000 + 60_000)
    await writeFile(
      second,
      JSON.stringify({
        tokens: { access_token: rotated, refresh_token: 'refresh-2', account_id: 'acct-2' },
      }),
      'utf8',
    )
    store.setAuthFile(second)
    await expect(store.getTokens()).resolves.toMatchObject({ accessToken: rotated, accountId: 'acct-2' })
  })
})
