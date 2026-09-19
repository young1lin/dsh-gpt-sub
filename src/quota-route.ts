/**
 * The host half of the quota panel: one cached JSON endpoint the browser polls.
 *
 * Every quota semantic lives here rather than in the client bundle -- which
 * windows count, how often upstream may be asked, what a failure looks like --
 * so the browser half stays a renderer.
 *
 * @module dsh-gpt-sub/quota-route
 */

import type { Dispatcher } from 'undici'
import { fetchUsage, reportWindows, reportedWindows, resetsRemaining, type ReportedWindow, type UsageWindow } from './usage.ts'

/** One rate-limit window as the endpoint serves it to the panel. */
export interface QuotaWindowState {
  /** Percent of the window consumed. */
  usedPercent: number
  /** Length of the window, in hours. */
  windowHours: number
  /** Epoch seconds at which the window resets. */
  resetAt?: number
}

/** What the endpoint serves. */
export interface QuotaState {
  /** 'ready' once a reading has been taken, 'error' when none ever succeeded. */
  phase: 'ready' | 'error'
  /** Subscription plan, when upstream reported one. */
  plan?: string
  /**
   * The short rolling window -- 5 hours on every plan that reports one. A
   * plan without it (pro currently) simply omits the field, and the panel
   * says so instead of drawing an empty bar.
   */
  fiveHour?: QuotaWindowState
  /** The weekly window, alone or beside the 5-hour one. */
  weekly?: QuotaWindowState
  /**
   * On-demand usage resets the account can still spend, when the plan
   * reports them -- each clears a capped window without waiting out its
   * timer.
   */
  resetsRemaining?: number
  /** Every reported window, primary first; one panel row each. */
  windows?: ReportedWindow[]
  /** Epoch milliseconds this reading was taken. */
  fetchedAt?: number
  /** True when the reading is older than the refresh interval and a retry failed. */
  stale?: boolean
  /** Human-readable failure note; present on error, or beside a stale reading. */
  message?: string
}

/** Windows shorter than a day are the 5-hour-style rolling limit. */
const DAY_SECONDS = 24 * 3600

/**
 * Fold one upstream window into the shape the panel renders.
 *
 * @param window - a window as the usage endpoint reported it.
 * @returns the same figures in the panel's vocabulary.
 */
const toWindowState = (window: UsageWindow): QuotaWindowState => ({
  usedPercent: window.used_percent,
  windowHours: Math.round(window.limit_window_seconds / 3600),
  ...(window.reset_at === undefined ? {} : { resetAt: window.reset_at }),
})

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
      const reported = reportedWindows(usage)
      const fiveHour = reported.find((window) => window.limit_window_seconds < DAY_SECONDS)
      const weekly = reported.find((window) => window.limit_window_seconds >= DAY_SECONDS)
      const resets = resetsRemaining(usage)
      const windows = reportWindows(usage)
      this.#state = {
        phase: 'ready',
        ...(usage.plan_type === undefined ? {} : { plan: usage.plan_type }),
        ...(fiveHour === undefined ? {} : { fiveHour: toWindowState(fiveHour) }),
        ...(weekly === undefined ? {} : { weekly: toWindowState(weekly) }),
        ...(resets === undefined ? {} : { resetsRemaining: resets }),
        ...(windows.length === 0 ? {} : { windows }),
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
