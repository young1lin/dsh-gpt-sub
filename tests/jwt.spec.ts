import { describe, expect, it } from 'vitest'
import { jwtExpiryMs } from '../src/jwt.ts'

/** Build a JWT-shaped string carrying only the claims a test needs. */
function makeJwt(claims: Record<string, unknown>): string {
  const part = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'none' })}.${part(claims)}.signature`
}

describe('jwtExpiryMs', () => {
  it('returns the exp claim in milliseconds', () => {
    expect(jwtExpiryMs(makeJwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000)
  })

  it('returns undefined when the token has no exp claim', () => {
    expect(jwtExpiryMs(makeJwt({ sub: 'user' }))).toBeUndefined()
  })

  it('returns undefined for an opaque non-JWT token', () => {
    expect(jwtExpiryMs('not-a-jwt-at-all')).toBeUndefined()
  })

  it('returns undefined when the payload is not valid base64url JSON', () => {
    expect(jwtExpiryMs('aaa.!!!not-base64!!!.ccc')).toBeUndefined()
  })
})
