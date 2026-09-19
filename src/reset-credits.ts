/**
 * Rate-limit reset credits: list the redeemable credits on the account and
 * consume one, against the same wham host the usage endpoint lives on.
 *
 * Mirrors the codex CLI's backend-client contract
 * (codex-rs/backend-client/src/client/rate_limit_resets.rs): GET
 * .../rate-limit-reset-credits lists credits, POST .../consume redeems one
 * with a caller-chosen idempotency key (`redeem_request_id`) and an optional
 * `credit_id`. Same Bearer auth as every other wham call.
 *
 * @module dsh-gpt-sub/reset-credits
 */

import { fetch as undiciFetch, type Dispatcher } from 'undici'

/** One redeemable credit as the list endpoint reports it. */
export interface ResetCredit {
  id: string
  reset_type: string
  status: string
  granted_at: string
  expires_at?: string
  title?: string
  description?: string
}

/** The list endpoint's reply. */
export interface ResetCreditsDetails {
  credits: ResetCredit[]
  available_count: number
}

/** The consume endpoint's machine-readable outcomes. */
export type ConsumeCode = 'reset' | 'nothing_to_reset' | 'no_credit' | 'already_redeemed'

/** The consume endpoint's reply. */
export interface ConsumeReply {
  code: ConsumeCode
  windows_reset?: number
}

/** The list endpoint, on the same host as the model calls. */
const CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'

/** The consume endpoint, beside the list one. */
const CONSUME_URL = CREDITS_URL + '/consume'

/**
 * Decode a wham JSON reply or throw with the status attached.
 *
 * @param response - the undici response.
 * @param what - names the endpoint in error messages.
 * @returns the parsed body.
 */
async function decode<T>(response: Response, what: string): Promise<T> {
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`${what} answered ${String(response.status)}: ${body.slice(0, 200)}`)
  }
  try {
    return JSON.parse(body) as T
  } catch {
    throw new Error(`${what} did not answer with JSON`)
  }
}

/**
 * List the account's rate-limit reset credits.
 *
 * @param accessToken - a live Codex access token.
 * @param dispatcher - undici dispatcher; omit to use the global one.
 * @param fetchImpl - injectable fetch, for tests.
 * @param signal - abort signal bounding the call.
 * @returns the parsed credit list.
 */
export async function listResetCredits(
  accessToken: string,
  dispatcher?: Dispatcher,
  fetchImpl: typeof undiciFetch = undiciFetch,
  signal?: AbortSignal,
): Promise<ResetCreditsDetails> {
  const response = await fetchImpl(CREDITS_URL, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    ...(dispatcher === undefined ? {} : { dispatcher }),
    ...(signal === undefined ? {} : { signal }),
  })
  return decode<ResetCreditsDetails>(response, 'reset credits list')
}

/**
 * Consume one rate-limit reset credit, resetting the eligible window.
 *
 * @param accessToken - a live Codex access token.
 * @param redeemRequestId - caller-chosen idempotency key; retries with the same
 *   key cannot double-redeem.
 * @param creditId - consume this specific credit; omit for any available one.
 * @param dispatcher - undici dispatcher; omit to use the global one.
 * @param fetchImpl - injectable fetch, for tests.
 * @param signal - abort signal bounding the call.
 * @returns the outcome and how many windows were reset.
 */
export async function consumeResetCredit(
  accessToken: string,
  redeemRequestId: string,
  options: {
    creditId?: string
    dispatcher?: Dispatcher
    fetchImpl?: typeof undiciFetch
    signal?: AbortSignal
  } = {},
): Promise<ConsumeReply> {
  const { creditId, dispatcher, fetchImpl = undiciFetch, signal } = options
  const response = await fetchImpl(CONSUME_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      redeem_request_id: redeemRequestId,
      ...(creditId === undefined ? {} : { credit_id: creditId }),
    }),
    ...(dispatcher === undefined ? {} : { dispatcher }),
    ...(signal === undefined ? {} : { signal }),
  })
  return decode<ConsumeReply>(response, 'reset credit consume')
}
