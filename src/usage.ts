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
  /** On-demand rate-limit resets the plan grants, when it reports them. */
  rate_limit_reset_credits?: {
    /** Resets the account owns and can still spend. */
    available_count?: number
    /** Resets applicable to the current windows -- zero while none is capped. */
    applicable_available_count?: number
  } | null
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
 * List every window the reply carries, primary slot first.
 *
 * Accounts differ here -- a plus account reports `secondary_window: null` and
 * carries its weekly allowance on the primary, and a pro account currently
 * reports only a weekly window with no 5-hour rolling limit at all -- so
 * reading one chosen slot hides the 5-hour window on the accounts that have
 * one. The panel renders whichever windows exist.
 *
 * @param usage - a usage reply.
 * @returns the windows worth showing, primary slot first; empty when the reply
 *   carries none.
 */
export function reportedWindows(usage: Usage): UsageWindow[] {
  const primary = usage.rate_limit?.primary_window
  const secondary = usage.rate_limit?.secondary_window
  return [primary, secondary].filter((window): window is UsageWindow => window != null)
}

/**
 * Count the on-demand usage resets the account can still spend -- what the
 * usage endpoint reports as `rate_limit_reset_credits`, each one clearing a
 * capped window without waiting out its timer.
 *
 * @param usage - a usage reply.
 * @returns the resets remaining, or undefined when the reply carries none --
 *   which plans without the feature answer.
 */
export function resetsRemaining(usage: Usage): number | undefined {
  const count = usage.rate_limit_reset_credits?.available_count
  return typeof count === 'number' ? count : undefined
}

/** A rate-limit window normalized for per-window rendering. */
export interface ReportedWindow {
  /** Percent of this window consumed. */
  usedPercent: number
  /** Length of the window, in hours. */
  windowHours: number
  /** Epoch seconds at which the window resets. */
  resetAt?: number
}

/**
 * Normalize one raw window for the panel.
 *
 * @param window - the window as the usage endpoint reports it.
 * @returns the normalized window.
 */
const toReported = (window: UsageWindow): ReportedWindow => ({
  usedPercent: window.used_percent,
  windowHours: Math.round(window.limit_window_seconds / 3600),
  ...(window.reset_at === undefined ? {} : { resetAt: window.reset_at }),
})

/**
 * Every window the reply reports, primary first.
 *
 * The panel renders one row per window -- the 5-hour and the weekly allowance
 * on accounts that report both -- so it needs all of them, not the single one
 * {@link activeWindow} picks for the startup log. Window identity comes from
 * the reported length, because which slot an account uses differs.
 *
 * @param usage - a usage reply.
 * @returns the reported windows, primary before secondary.
 */
export function reportWindows(usage: Usage): ReportedWindow[] {
  const primary = usage.rate_limit?.primary_window
  const secondary = usage.rate_limit?.secondary_window
  return [primary, secondary]
    .filter((window): window is UsageWindow => window != null)
    .map(toReported)
}
