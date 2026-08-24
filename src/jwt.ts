/**
 * Minimal JWT claim reader. Only the `exp` claim is needed, and signature
 * verification is deliberately absent: these tokens are read from the user's
 * own credential file, never accepted from a remote party.
 *
 * @module dsh-gpt-sub/jwt
 */

/**
 * Read a JWT's expiry.
 *
 * @param token - a candidate JWT; opaque strings are tolerated.
 * @returns expiry in epoch milliseconds, or undefined when absent or undecodable.
 */
export function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined) return undefined
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof claims !== 'object' || claims === null) return undefined
    const exp = (claims as { exp?: unknown }).exp
    return typeof exp === 'number' ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}
