/**
 * The host half of the quota panel: one cached JSON endpoint the browser polls.
 *
 * Every quota semantic lives here rather than in the client bundle -- which
 * window counts, how often upstream may be asked, what a failure looks like --
 * so the browser half stays a renderer.
 *
 * @module dsh-gpt-sub/quota-route
 */

import type { Dispatcher } from 'undici'
import { activeWindow, fetchUsage } from './usage.ts'

/** What the endpoint serves. */
export interface QuotaState {
  /** 'ready' once a reading has been taken, 'error' when none ever succeeded. */
  phase: 'ready' | 'error'
  /** Subscription plan, when upstream reported one. */
  plan?: string
  /** Percent of the active window consumed. */
  usedPercent?: number
  /** Length of the active window, in hours. */
  windowHours?: number
  /** Epoch seconds at which the window resets. */
  resetAt?: number
  /** Epoch milliseconds this reading was taken. */
  fetchedAt?: number
  /** True when the reading is older than the refresh interval and a retry failed. */
  stale?: boolean
  /** Human-readable failure note; present on error, or beside a stale reading. */
  message?: string
}

/** Construction options. */
export interface QuotaSourceOptions {
  /** Returns a live access token. */
  readonly accessToken: () => Promise<string>
  /** Dispatcher for the upstream call. */
  readonly dispatcher?: Dispatcher
  /** Minimum gap between upstream reads; a poll inside it is served from cache. */
  readonly minIntervalMs?: number
  /** Injectable clock, defaulting to Date.now. */
  readonly now?: () => number
}

/**
 * A throttled quota reader.
 *
 * The browser polls far more often than the account's usage changes, so an
 * unthrottled endpoint would turn one open settings page into a steady stream
 * of upstream requests.
 */
export class QuotaSource {
  readonly #accessToken: () => Promise<string>
  #dispatcher: Dispatcher | undefined
  readonly #minIntervalMs: number
  readonly #now: () => number
  #state: QuotaState = { phase: 'error', message: 'not read yet' }
  #lastAttempt = 0
  /** The in-flight read, shared by every caller that arrives during it. */
  #inFlight: Promise<QuotaState> | undefined

  constructor(options: QuotaSourceOptions) {
    this.#accessToken = options.accessToken
    this.#dispatcher = options.dispatcher
    this.#minIntervalMs = options.minIntervalMs ?? 60_000
    this.#now = options.now ?? (() => Date.now())
  }

  /**
   * Point later upstream reads at a different dispatcher, as a proxy switch does.
   *
   * @param dispatcher - the dispatcher future reads use; undefined for the global.
   */
  setDispatcher(dispatcher: Dispatcher | undefined): void {
    this.#dispatcher = dispatcher
  }

  /**
   * Return the current reading, refreshing when the throttle allows.
   *
   * @param force - ignore the throttle, as the panel's refresh button does.
   * @returns the reading to serve.
   */
  async read(force = false): Promise<QuotaState> {
    const elapsed = this.#now() - this.#lastAttempt
    if (!force && this.#state.phase === 'ready' && elapsed < this.#minIntervalMs) return this.#state
    this.#inFlight ??= this.#refresh().finally(() => {
      this.#inFlight = undefined
    })
    return this.#inFlight
  }

  /**
   * Take one upstream reading and fold it into the cached state.
   *
   * A failure never discards a previous good reading: the panel shows the last
   * known figure marked stale, which is more useful than an empty panel.
   *
   * @returns the new state.
   */
  async #refresh(): Promise<QuotaState> {
    this.#lastAttempt = this.#now()
    try {
      const usage = await fetchUsage(await this.#accessToken(), this.#dispatcher)
      const window = activeWindow(usage)
      this.#state = {
        phase: 'ready',
        ...(usage.plan_type === undefined ? {} : { plan: usage.plan_type }),
        ...(window === undefined
          ? {}
          : {
              usedPercent: window.used_percent,
              windowHours: Math.round(window.limit_window_seconds / 3600),
              ...(window.reset_at === undefined ? {} : { resetAt: window.reset_at }),
            }),
        fetchedAt: this.#now(),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#state =
        this.#state.phase === 'ready'
          ? { ...this.#state, stale: true, message }
          : { phase: 'error', message }
    }
    return this.#state
  }
}
