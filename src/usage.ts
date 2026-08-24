/**
 * Subscription usage lookup for the Codex account.
 *
 * One GET against the same host the model calls use, authorized with the same
 * access token. Used at startup as a reachability probe -- an unproxied egress
 * answers 403 with a Cloudflare block page rather than an API error, and that
 * failure is otherwise invisible until the first model call.
 *
 * @module dsh-gpt-sub/usage
 */

import { fetch as undiciFetch, type Dispatcher } from 'undici'

/** One rate-limit window as the usage endpoint reports it. */
export interface UsageWindow {
  used_percent: number
  limit_window_seconds: number
  reset_after_seconds?: number
  reset_at?: number
}

/** The subset of the usage reply this plugin reads. */
export interface Usage {
  plan_type?: string
  rate_limit?: {
    primary_window?: UsageWindow | null
    secondary_window?: UsageWindow | null
  }
}

/** Thrown when the usage endpoint answers with something other than JSON usage. */
export class UsageError extends Error {}

/** The usage endpoint, on the same host as the model calls. */
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

/**
 * Read the account's current usage.
 *
 * @param accessToken - a live Codex access token.
 * @param dispatcher - undici dispatcher; omit to use the global one.
 * @returns the parsed usage reply.
 * @throws UsageError when the endpoint refuses, or answers with a non-JSON
 *   body -- which is what an unproxied egress produces, and the message says so.
 */
export async function fetchUsage(
  accessToken: string,
  dispatcher?: Dispatcher,
  fetchImpl: typeof undiciFetch = undiciFetch,
  signal?: AbortSignal,
): Promise<Usage> {
  const response = await fetchImpl(USAGE_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    ...(dispatcher === undefined ? {} : { dispatcher }),
    ...(signal === undefined ? {} : { signal }),
  })

  const body = await response.text()
  if (!response.ok) {
    const blocked = body.includes('Unable to load site') || body.includes('blocked-icon')
    throw new UsageError(
      blocked
        ? `usage endpoint answered ${String(response.status)} with a Cloudflare block page; this address cannot reach chatgpt.com, so the request did not egress through the proxy`
        : `usage endpoint answered ${String(response.status)}`,
    )
  }

  try {
    return JSON.parse(body) as Usage
  } catch {
    throw new UsageError('usage endpoint did not answer with JSON')
  }
}

/**
 * Pick the window worth showing: the secondary when the account has one, else
 * the primary.
 *
 * Accounts differ here -- a plus account reports `secondary_window: null` and
 * carries its weekly allowance on the primary -- so reading only one of them
 * shows nothing on half the accounts.
 *
 * @param usage - a usage reply.
 * @returns the window to report, or undefined when neither is present.
 */
export function activeWindow(usage: Usage): UsageWindow | undefined {
  return usage.rate_limit?.secondary_window ?? usage.rate_limit?.primary_window ?? undefined
}
