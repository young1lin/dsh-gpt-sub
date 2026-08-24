/**
 * Connectivity probe for a candidate proxy: one real usage read through a
 * throwaway ProxyAgent, timed, answering ok/latency or the failure text.
 *
 * This is the host half of the panel's "test connection" button. It exercises
 * the exact path production traffic takes -- same host, same endpoint, same
 * dispatcher kind -- so a green result means model calls will connect, not
 * merely that the proxy's TCP port answers.
 *
 * @module dsh-gpt-sub/proxy-probe
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { fetchUsage } from './usage.ts'

/** Default ceiling on one probe; a proxy that cannot answer this is broken. */
const DEFAULT_TIMEOUT_MS = 15_000

/** What the probe answers. */
export interface ProxyProbeResult {
  /** True when the usage endpoint answered through the candidate. */
  ok: boolean
  /** Round-trip milliseconds; present on success. */
  latencyMs?: number
  /** Subscription plan reported upstream; present on success when known. */
  plan?: string
  /** Failure text; present when ok is false. */
  message?: string
}

/** Construction options; the injectable seams exist for tests. */
export interface ProxyProbeOptions {
  /** Candidate proxy URL; empty string probes a direct connection. */
  readonly proxyUrl: string
  /** A live access token for the usage call. */
  readonly accessToken: string
  /** Per-probe timeout; defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Injectable fetch, defaulting to undici's. */
  readonly fetchImpl?: typeof undiciFetch
  /** Injectable clock, defaulting to Date.now. */
  readonly now?: () => number
}

/**
 * Probe one candidate proxy with a single usage read.
 *
 * The probe's ProxyAgent is private: it is created here and closed here, so a
 * probe can never leak dispatcher state into the live routing.
 *
 * @param options - the candidate and the credentials to read with.
 * @returns the probe outcome, never a rejection.
 */
export async function probeProxy(options: ProxyProbeOptions): Promise<ProxyProbeResult> {
  const { proxyUrl, accessToken } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? (() => Date.now())
  const agent = proxyUrl === '' ? undefined : new ProxyAgent(proxyUrl)
  const started = now()
  try {
    const usage = await fetchUsage(
      accessToken,
      agent,
      options.fetchImpl,
      AbortSignal.timeout(timeoutMs),
    )
    const latencyMs = now() - started
    return {
      ok: true,
      latencyMs,
      ...(usage.plan_type === undefined ? {} : { plan: usage.plan_type }),
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (agent !== undefined) await agent.close().catch(() => undefined)
  }
}
