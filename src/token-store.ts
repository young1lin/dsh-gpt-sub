/**
 * Codex OAuth credential access. Reads the Codex CLI's own auth.json so both
 * tools share one login, and refreshes the access token before it expires.
 *
 * Expiry is judged solely from the access_token's exp claim. The id_token
 * carries identity claims, lives one hour, and is routinely expired while the
 * access token remains valid for days -- treating it as an expiry signal would
 * trigger a refresh on nearly every request.
 *
 * @module dsh-gpt-sub/token-store
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { fetch as undiciFetch } from 'undici'
import { jwtExpiryMs } from './jwt.ts'

/** Codex CLI's public OAuth client, read from the aud claim of a real id_token. */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** Issuer-derived token endpoint. */
const TOKEN_URL = 'https://auth.openai.com/oauth/token'

/** The subset of a token-endpoint response the refresh path reads. */
export interface RefreshResponse {
  ok: boolean
  status: number
  text: () => Promise<string>
  json: () => Promise<unknown>
}

/**
 * The injectable token-endpoint call; undici's `fetch` satisfies this shape.
 *
 * The global `fetch` is deliberately not used: it has no `dispatcher` option,
 * so a refresh through it ignores the proxy and cannot connect on a machine
 * that reaches OpenAI only through one.
 */
export type RefreshFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; dispatcher?: unknown },
) => Promise<RefreshResponse>

/** What {@link TokenStore.inspect} reports: file-only facts, no network. */
export interface TokenInspection {
  /** Access-token expiry in epoch ms, when the JWT carries a decodable exp. */
  accessTokenExpiresAt?: number
}

/** The credential fields the shim needs for one upstream request. */
export interface CodexTokens {
  accessToken: string
  refreshToken: string
  accountId: string
}

/** Construction options; the injectable seams exist for tests. */
export interface TokenStoreOptions {
  /** Path to the Codex CLI credential file. */
  authFile: string
  /** Refresh once the access token has less than this many ms of life left. */
  refreshMarginMs: number
  /** undici Dispatcher (the same ProxyAgent the plugin's routing uses, in production). */
  dispatcher?: unknown
  /** Injectable token-endpoint call, defaulting to undici's fetch. */
  fetchImpl?: RefreshFetch
  /** Injectable clock, defaulting to Date.now. */
  now?: () => number
}

/** The subset of auth.json this module reads and rewrites. */
interface AuthFileShape {
  tokens?: {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string
  }
  last_refresh?: string
  [key: string]: unknown
}

export class TokenStore {
  #authFile: string
  readonly #refreshMarginMs: number
  readonly #now: () => number
  #dispatcher: unknown
  readonly #fetch: RefreshFetch
  /** The in-flight exchange, shared by every caller that arrives during it. */
  #inFlight: Promise<CodexTokens> | undefined

  constructor(options: TokenStoreOptions) {
    this.#authFile = options.authFile
    this.#refreshMarginMs = options.refreshMarginMs
    this.#now = options.now ?? (() => Date.now())
    this.#dispatcher = options.dispatcher
    // The same cast index.ts uses for undici's `request`: the real signature is
    // wider than the seam, and the seam is what the tests stub.
    this.#fetch = options.fetchImpl ?? (undiciFetch as unknown as RefreshFetch)
  }

  /**
   * Return usable credentials, refreshing first when the access token is
   * inside the configured margin.
   *
   * @returns credentials valid at the moment of the call.
   */
  async getTokens(): Promise<CodexTokens> {
    const file = await this.#read()
    const tokens = this.#extract(file)
    const expiry = jwtExpiryMs(tokens.accessToken)
    if (expiry !== undefined && expiry - this.#now() < this.#refreshMarginMs) {
      return await this.#refresh(file, tokens)
    }
    return tokens
  }

  /**
   * Report the current access token's expiry without touching the network.
   *
   * Reads and parses the file only -- no refresh, no matter how close to the
   * margin the token is -- so the status endpoint can show when the next
   * automatic refresh will happen without triggering it.
   *
   * @returns file-derived facts about the stored credentials.
   */
  async inspect(): Promise<TokenInspection> {
    const tokens = this.#extract(await this.#read())
    const expiry = jwtExpiryMs(tokens.accessToken)
    return expiry === undefined ? {} : { accessTokenExpiresAt: expiry }
  }

  /**
   * Point later reads at a different credential file, as a page-side switch
   * does. The caller validates the new path before switching.
   *
   * @param authFile - the replacement credential file's path.
   */
  setAuthFile(authFile: string): void {
    this.#authFile = authFile
  }

  /**
   * Point later refreshes at a different dispatcher, as a proxy switch does.
   *
   * @param dispatcher - the dispatcher future refresh calls use; undefined for the global.
   */
  setDispatcher(dispatcher: unknown): void {
    this.#dispatcher = dispatcher
  }

  /**
   * Check that the credential file is readable and carries the fields the shim
   * needs, without spending a refresh on it.
   *
   * Called at plugin start so a missing or unparseable auth.json fails there
   * naming the path, as the spec's error table requires, instead of surfacing
   * on the first request. Deliberately does not call getTokens(): that would
   * put a network refresh on the startup path.
   */
  async verify(): Promise<void> {
    this.#extract(await this.#read())
  }

  /** Read and parse auth.json, naming the path in every failure. */
  async #read(): Promise<AuthFileShape> {
    let raw: string
    try {
      raw = await readFile(this.#authFile, 'utf8')
    } catch (error) {
      throw new Error(`dsh-gpt-sub: cannot read Codex credentials at ${this.#authFile}`, { cause: error })
    }
    try {
      return JSON.parse(raw) as AuthFileShape
    } catch (error) {
      throw new Error(`dsh-gpt-sub: cannot parse Codex credentials at ${this.#authFile}`, { cause: error })
    }
  }

  /** Pull the required fields, naming whichever one is absent. */
  #extract(file: AuthFileShape): CodexTokens {
    const accessToken = file.tokens?.access_token
    const refreshToken = file.tokens?.refresh_token
    const accountId = file.tokens?.account_id
    if (accessToken === undefined || refreshToken === undefined || accountId === undefined) {
      throw new Error(
        `dsh-gpt-sub: ${this.#authFile} is missing tokens.access_token, tokens.refresh_token, or tokens.account_id; run 'codex' to sign in again`,
      )
    }
    return { accessToken, refreshToken, accountId }
  }

  /**
   * Refresh regardless of remaining lifetime. Used when the upstream rejects a
   * token that local expiry math believed was still good.
   *
   * @returns freshly issued credentials.
   */
  async forceRefresh(): Promise<CodexTokens> {
    const file = await this.#read()
    return await this.#refresh(file, this.#extract(file))
  }

  /**
   * Exchange the refresh token, coalescing callers that arrive together.
   *
   * The refresh token is single-use and rotates, so two concurrent exchanges
   * would spend the same token: the loser gets `invalid_grant` and tells the
   * user to sign in again in the middle of entirely normal operation. DSH
   * issues parallel LLM calls, so that is reachable, not theoretical.
   *
   * Only concurrent callers share a result. Once the exchange settles the slot
   * is cleared, so a later refresh performs a new one.
   *
   * @param file - the parsed auth.json, whose unrelated fields are preserved.
   * @param tokens - the credentials whose refresh token is being spent.
   * @returns the newly issued credentials.
   */
  async #refresh(file: AuthFileShape, tokens: CodexTokens): Promise<CodexTokens> {
    this.#inFlight ??= this.#exchange(file, tokens).finally(() => {
      this.#inFlight = undefined
    })
    return await this.#inFlight
  }

  /**
   * Perform one token exchange and persist the result.
   *
   * @param file - the parsed auth.json, whose unrelated fields are preserved.
   * @param tokens - the credentials whose refresh token is being spent.
   * @returns the newly issued credentials.
   */
  async #exchange(file: AuthFileShape, tokens: CodexTokens): Promise<CodexTokens> {
    let response: RefreshResponse
    try {
      response = await this.#fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: tokens.refreshToken,
        }),
        ...(this.#dispatcher === undefined ? {} : { dispatcher: this.#dispatcher }),
      })
    } catch (error) {
      // A transport failure here is almost always the proxy, not the account.
      // Say so, and still name the recovery the spec asks for.
      throw new Error(
        `dsh-gpt-sub: cannot reach the Codex token endpoint at ${TOKEN_URL}; check the plugin's proxyUrl, then run 'codex' to sign in again`,
        { cause: error },
      )
    }
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(
        `dsh-gpt-sub: refreshing the Codex token failed (${response.status}: ${detail}); run 'codex' to sign in again`,
      )
    }
    const payload = (await response.json()) as {
      access_token?: string
      refresh_token?: string
      id_token?: string
    }
    if (payload.access_token === undefined) {
      throw new Error(`dsh-gpt-sub: the token endpoint returned no access_token; run 'codex' to sign in again`)
    }
    const refreshed: CodexTokens = {
      accessToken: payload.access_token,
      // A rotated refresh token must be kept; reusing a spent one fails next time.
      refreshToken: payload.refresh_token ?? tokens.refreshToken,
      accountId: tokens.accountId,
    }
    await this.#persist(file, refreshed, payload.id_token)
    return refreshed
  }

  /**
   * Write the credential file atomically so a concurrent Codex CLI read never
   * observes a partial file. Fields this plugin does not own are preserved.
   *
   * @param file - the previously parsed file contents.
   * @param tokens - the credentials to store.
   * @param idToken - a refreshed id_token when the endpoint returned one.
   */
  async #persist(file: AuthFileShape, tokens: CodexTokens, idToken: string | undefined): Promise<void> {
    const next: AuthFileShape = {
      ...file,
      tokens: {
        ...file.tokens,
        ...(idToken === undefined ? {} : { id_token: idToken }),
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        account_id: tokens.accountId,
      },
      last_refresh: new Date(this.#now()).toISOString(),
    }
    const temporary = `${this.#authFile}.tmp-${String(process.pid)}`
    // For as long as it exists this file holds live credentials, so create it
    // private to the user, and never leave one on disk if the rename that
    // should have consumed it fails.
    await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    try {
      await rename(temporary, this.#authFile)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }
}
