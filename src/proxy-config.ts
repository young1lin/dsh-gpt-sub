/**
 * Runtime proxy configuration: request-body reading, URL validation, and the
 * persisted override the settings panel writes.
 *
 * The override file exists because cordis config layers are the loader's
 * property -- a panel edit cannot rewrite them. The file holds the panel's
 * last saved choice; when present, it wins over the config's proxyUrl so a
 * page edit survives restarts.
 *
 * @module dsh-gpt-sub/proxy-config
 */

import type { IncomingMessage } from 'node:http'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'

/** Bodies larger than this are refused rather than buffered. */
const BODY_LIMIT_BYTES = 65_536

/** Read one header, tolerating the array form node uses for repeated headers. */
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers?.[name]
  if (Array.isArray(value)) return value[0]
  return value
}

/**
 * Validate a caller-supplied proxy URL.
 *
 * @param value - the candidate value from a request body.
 * @returns the trimmed URL, or the empty string for a direct connection.
 * @throws Error when the value is not a string or not an http(s) URL.
 */
export function validateProxyUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('proxyUrl must be a string')
  const trimmed = value.trim()
  if (trimmed === '') return ''
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`proxyUrl is not a valid URL: ${trimmed}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`proxyUrl must be http or https, got ${parsed.protocol}`)
  }
  return trimmed
}

/**
 * Mask any userinfo credentials in a proxy URL, for logging.
 *
 * The URL itself is worth logging; the password inside it is not. A URL
 * without credentials is returned exactly as given.
 *
 * @param url - the proxy URL as configured.
 * @returns the URL with its userinfo, if any, replaced by `***`.
 */
export function redactProxyUrl(url: string): string {
  if (url === '') return ''
  const scheme = /^https?:\/\//.exec(url)
  if (scheme === null) return url
  const rest = url.slice(scheme[0].length)
  const credentialsEnd = rest.indexOf('@')
  if (credentialsEnd === -1) return url
  // Replace the userinfo by string surgery rather than URL re-serialisation,
  // so everything after the `@` stays byte-identical to what was configured.
  return `${scheme[0]}***@${rest.slice(credentialsEnd + 1)}`
}

/**
 * Whether a request's Origin header names an origin other than the host the
 * request was addressed to.
 *
 * The mutating routes must refuse such requests: a page on another origin can
 * otherwise make the harness reroute its credentials through a proxy of the
 * page's choosing. An absent Origin passes -- browsers always set one on a
 * POST, so absence means a non-browser client such as curl.
 *
 * @param request - the incoming request.
 * @returns true when Origin is present and names another host.
 */
export function crossOrigin(request: IncomingMessage): boolean {
  const origin = header(request, 'origin')
  if (origin === undefined || origin === '') return false
  const host = header(request, 'host')
  if (host === undefined || host === '') return true
  try {
    // Comparing through URL normalises default ports away on both sides.
    return new URL(origin).host !== new URL(`http://${host}`).host
  } catch {
    // An unparsable Origin (including the literal "null") vouches for nothing.
    return true
  }
}

/**
 * Read one JSON object request body.
 *
 * A body that declares a content-type must declare JSON: browsers refuse to
 * send `application/json` cross-origin without a preflight, so the check
 * turns every form a forged cross-site POST can take into a refusal. An
 * absent content-type passes for non-browser clients that send none.
 *
 * @param request - the incoming request whose body to consume.
 * @param limitBytes - the maximum body size accepted.
 * @returns the parsed object.
 * @throws Error when the body is oversized, unparseable, not an object, or
 *   not JSON-content-typed.
 */
export async function readJsonObject(
  request: IncomingMessage,
  limitBytes = BODY_LIMIT_BYTES,
): Promise<Record<string, unknown>> {
  const contentType = header(request, 'content-type')
  if (contentType !== undefined) {
    const mediaType = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
    if (mediaType !== 'application/json') {
      throw new Error(`request body content-type must be application/json, got "${mediaType}"`)
    }
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const piece = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    size += piece.length
    if (size > limitBytes) throw new Error('request body too large')
    chunks.push(piece)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** The state file's on-disk shape; each field stands alone. */
export interface StateOverride {
  /** The saved proxy URL; empty string means direct. */
  proxyUrl?: string
  /** The saved credential-file path, exactly as typed on the page. */
  authFile?: string
}

/**
 * Load the persisted panel overrides.
 *
 * An absent file simply means "no override". A corrupt file is ignored too:
 * the panel that wrote it may have died mid-write, and failing the whole
 * plugin over a status file would trade working settings for a stale byte.
 *
 * Each known field validates on its own, so one invalid value drops without
 * discarding the other choice the panel made.
 *
 * @param path - the state file's path.
 * @returns the saved choices, or undefined when there is no readable file.
 */
export async function loadStateOverride(path: string): Promise<StateOverride | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>

  const state: StateOverride = {}
  const proxyUrl = document['proxyUrl']
  if (typeof proxyUrl === 'string') {
    try {
      state.proxyUrl = validateProxyUrl(proxyUrl)
    } catch {
      // A stale invalid proxy falls back to the config rather than
      // invalidating the whole file.
    }
  }
  const authFile = document['authFile']
  if (typeof authFile === 'string' && authFile.trim() !== '') {
    state.authFile = authFile.trim()
  }
  return state
}

/**
 * Persist the panel's choices atomically, so a crash never leaves a half write.
 *
 * The object is written exactly as given; callers read-modify-write so saving
 * one choice never erases the other.
 *
 * @param path - the state file's path.
 * @param state - the choices to persist; absent fields mean "use the config".
 * @returns nothing; failures propagate to the caller.
 */
export async function saveStateOverride(path: string, state: StateOverride): Promise<void> {
  const temporary = `${path}.tmp-${String(process.pid)}`
  // The file can hold a proxy URL with embedded credentials and a private
  // filesystem layout, so create it private to the user, the same way
  // token-store writes auth.json.
  await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}
