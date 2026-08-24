# dsh-gpt-sub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a cordis plugin that lets DSH reach a ChatGPT/Codex subscription directly, replacing the external CLIProxyAPI binary.

**Architecture:** An in-process HTTP shim on `127.0.0.1:8318` accepts DSH's native `openai-responses` requests, injects `store: false` plus Codex OAuth headers, dispatches through an undici `ProxyAgent`, and retries transient connection failures before any byte reaches DSH. DSH's own protocol implementation is reused wholesale, so no message translation, SSE parsing, or tool-call assembly is written here.

**Tech Stack:** TypeScript (ESM, strict), cordis, schemastery, undici, vitest, Node >= 20.

**Spec:** `docs/superpowers/specs/2026-08-19-dsh-gpt-sub-design.md`

## Global Constraints

- **All code comments in English.** This is a standing user rule across every project.
- Node `>=20`; ESM only (`"type": "module"`).
- TypeScript strict, mirroring `D:\dev\dsh-agents-rules\tsconfig.json` exactly (including `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `allowImportingTsExtensions`, `rewriteRelativeImportExtensions`).
- Relative imports use the `.ts` extension (required by `rewriteRelativeImportExtensions`).
- **npm installs must use the mirror:** `--registry https://registry.npmmirror.com`. `registry.npmjs.org` is unreachable on this machine.
- **Never log token values.** Log expiry timestamps and outcomes only.
- Upstream errors are forwarded verbatim — never rewrapped into a generic 500.
- `client_id` is `app_EMoamEEZ73f0CkXaXp7hrann`; refresh endpoint is `https://auth.openai.com/oauth/token`.
- Authority on expiry is the **`access_token`** `exp` claim. `id_token` expiry is irrelevant and must never trigger a refresh.

---

### Task 1: Project scaffolding and JWT expiry helper

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/types.ts`
- Create: `src/jwt.ts`
- Test: `tests/jwt.spec.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `jwtExpiryMs(token: string): number | undefined` — epoch milliseconds of the `exp` claim, or `undefined` when the token is not a decodable JWT.
  - `interface Config` in `src/types.ts` with fields `port: number`, `proxyUrl: string`, `authFile: string`, `bootstrapRetries: number`, `refreshMarginMinutes: number`, `localKeyRef: string`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "dsh-gpt-sub",
  "version": "0.1.0",
  "description": "Direct ChatGPT/Codex subscription access for DeepSeek Harness, replacing CLIProxyAPI.",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "src", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
  "engines": { "node": ">=20" },
  "license": "MIT",
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.1",
    "undici": "^7.10.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1-rc.1",
    "@deepseek-ai/dsh-credentials": "^0.1.0-rc.2"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.1-rc.1",
    "@deepseek-ai/dsh-credentials": "^0.1.0-rc.2",
    "@types/node": "^22.10.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- [ ] **Step 2: Copy `tsconfig.json` verbatim from the sibling plugin**

Run: `cp D:/dev/dsh-agents-rules/tsconfig.json D:/dev/dsh-gpt-sub/tsconfig.json`

Then confirm it contains `"rootDir": "src"` and `"outDir": "lib"`.

- [ ] **Step 3: Install dependencies through the mirror**

Run: `cd D:/dev/dsh-gpt-sub && pnpm install --registry https://registry.npmmirror.com`
Expected: completes without reaching `registry.npmjs.org`.

- [ ] **Step 4: Write `src/types.ts`**

```ts
/** Plugin configuration shape, validated by the schemastery schema in index.ts. */
export interface Config {
  /** Loopback port the shim listens on; must match settings.yaml baseURL. */
  port: number
  /** Proxy URL for reaching the upstream, e.g. http://127.0.0.1:7890. */
  proxyUrl: string
  /** Path to the Codex CLI credential file. */
  authFile: string
  /** Attempts allowed while no byte has reached the client yet. */
  bootstrapRetries: number
  /** Refresh the access token when less than this many minutes remain. */
  refreshMarginMinutes: number
  /** Credential reference shared between DSH and this shim. */
  localKeyRef: string
}
```

- [ ] **Step 5: Write the failing test `tests/jwt.spec.ts`**

```ts
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
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd D:/dev/dsh-gpt-sub && pnpm vitest run tests/jwt.spec.ts`
Expected: FAIL — cannot resolve `../src/jwt.ts`.

- [ ] **Step 7: Write `src/jwt.ts`**

```ts
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
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd D:/dev/dsh-gpt-sub && pnpm vitest run tests/jwt.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 9: Commit**

```bash
cd D:/dev/dsh-gpt-sub
git add package.json tsconfig.json .gitignore src/types.ts src/jwt.ts tests/jwt.spec.ts
git commit -m "feat: scaffold plugin and add JWT expiry helper"
```

---

### Task 2: TokenStore — read and expiry decision

**Files:**
- Create: `src/token-store.ts`
- Test: `tests/token-store.spec.ts`

**Interfaces:**
- Consumes: `jwtExpiryMs` from `src/jwt.ts`
- Produces:
  - `interface CodexTokens { accessToken: string; refreshToken: string; accountId: string }`
  - `class TokenStore` with constructor `(options: TokenStoreOptions)` and method `getTokens(): Promise<CodexTokens>`
  - `interface TokenStoreOptions { authFile: string; refreshMarginMs: number; fetchImpl?: typeof fetch; now?: () => number }`

- [ ] **Step 1: Write the failing test `tests/token-store.spec.ts`**

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { TokenStore } from '../src/token-store.ts'

/** Build a JWT-shaped token whose exp sits a given number of ms from `from`. */
function tokenExpiringIn(ms: number, from = Date.now()): string {
  const part = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'none' })}.${part({ exp: Math.floor((from + ms) / 1000) })}.sig`
}

let dir: string
let authFile: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gpt-sub-'))
  authFile = join(dir, 'auth.json')
})

/** Write an auth.json with the given access token and an extra field to protect. */
async function writeAuth(accessToken: string): Promise<void> {
  await writeFile(
    authFile,
    JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: tokenExpiringIn(-86_400_000),
        access_token: accessToken,
        refresh_token: 'refresh-abc',
        account_id: 'acct-123',
      },
      last_refresh: '2026-08-17T01:00:52.121605600Z',
    }),
    'utf8',
  )
}

describe('TokenStore.getTokens', () => {
  it('returns the stored token when it is comfortably valid', async () => {
    const token = tokenExpiringIn(10 * 24 * 3_600_000)
    await writeAuth(token)
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000 })
    const tokens = await store.getTokens()
    expect(tokens.accessToken).toBe(token)
    expect(tokens.accountId).toBe('acct-123')
    expect(tokens.refreshToken).toBe('refresh-abc')
  })

  it('does not refresh merely because the id_token expired', async () => {
    // This is the exact state of the target machine: id_token long expired,
    // access_token valid for days. Refreshing here would fire on every request.
    await writeAuth(tokenExpiringIn(10 * 24 * 3_600_000))
    let called = 0
    const store = new TokenStore({
      authFile,
      refreshMarginMs: 1_800_000,
      fetchImpl: (async () => {
        called += 1
        throw new Error('refresh must not be attempted')
      }) as unknown as typeof fetch,
    })
    await store.getTokens()
    expect(called).toBe(0)
  })

  it('fails with the path named when auth.json is missing', async () => {
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000 })
    await expect(store.getTokens()).rejects.toThrow(authFile)
  })

  it('fails with the path named when auth.json is unparseable', async () => {
    await writeFile(authFile, '{ not json', 'utf8')
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000 })
    await expect(store.getTokens()).rejects.toThrow(authFile)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd D:/dev/dsh-gpt-sub && pnpm vitest run tests/token-store.spec.ts`
Expected: FAIL — cannot resolve `../src/token-store.ts`.

- [ ] **Step 3: Write `src/token-store.ts` (read path only)**

```ts
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

import { readFile } from 'node:fs/promises'
import { jwtExpiryMs } from './jwt.ts'

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
  /** Injectable fetch, defaulting to the global. */
  fetchImpl?: typeof fetch
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
  readonly #authFile: string
  readonly #refreshMarginMs: number
  readonly #now: () => number

  constructor(options: TokenStoreOptions) {
    this.#authFile = options.authFile
    this.#refreshMarginMs = options.refreshMarginMs
    this.#now = options.now ?? (() => Date.now())
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
      // Refresh arrives in Task 3; until then a near-expiry token is still returned.
      return tokens
    }
    return tokens
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
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd D:/dev/dsh-gpt-sub && pnpm vitest run tests/token-store.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd D:/dev/dsh-gpt-sub
git add src/token-store.ts tests/token-store.spec.ts
git commit -m "feat: read Codex credentials with access-token expiry logic"
```

---

### Task 3: TokenStore — refresh and atomic write-back

**Files:**
- Modify: `src/token-store.ts`
- Test: `tests/token-store-refresh.spec.ts`

**Interfaces:**
- Consumes: `TokenStore`, `CodexTokens` from Task 2
- Produces: `TokenStore.forceRefresh(): Promise<CodexTokens>`, plus automatic refresh inside `getTokens()`

- [ ] **Step 1: Write the failing test `tests/token-store-refresh.spec.ts`**

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { TokenStore } from '../src/token-store.ts'

function tokenExpiringIn(ms: number, from = Date.now()): string {
  const part = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${part({ alg: 'none' })}.${part({ exp: Math.floor((from + ms) / 1000) })}.sig`
}

let dir: string
let authFile: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gpt-sub-refresh-'))
  authFile = join(dir, 'auth.json')
})

async function writeAuth(accessToken: string): Promise<void> {
  await writeFile(
    authFile,
    JSON.stringify({
      auth_mode: 'chatgpt',
      keep_me: 'untouched',
      tokens: {
        id_token: 'stale',
        access_token: accessToken,
        refresh_token: 'refresh-old',
        account_id: 'acct-123',
      },
      last_refresh: 'old',
    }),
    'utf8',
  )
}

/** A fetch stub returning one OAuth token response and recording its request. */
function refreshStub(fresh: string): { fetchImpl: typeof fetch; seen: { body: unknown }[] } {
  const seen: { body: unknown }[] = []
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    seen.push({ body: JSON.parse(init.body) as unknown })
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: fresh, refresh_token: 'refresh-new', id_token: 'id-new' }),
      text: async () => '',
    }
  }) as unknown as typeof fetch
  return { fetchImpl, seen }
}

describe('TokenStore refresh', () => {
  it('refreshes when the access token is inside the margin', async () => {
    await writeAuth(tokenExpiringIn(60_000))
    const fresh = tokenExpiringIn(10 * 24 * 3_600_000)
    const { fetchImpl, seen } = refreshStub(fresh)
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl })
    const tokens = await store.getTokens()
    expect(tokens.accessToken).toBe(fresh)
    expect(seen).toHaveLength(1)
  })

  it('sends the Codex client_id and the stored refresh token', async () => {
    await writeAuth(tokenExpiringIn(60_000))
    const { fetchImpl, seen } = refreshStub(tokenExpiringIn(3_600_000))
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl })
    await store.getTokens()
    expect(seen[0]?.body).toMatchObject({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-old',
    })
  })

  it('persists the rotated refresh token and preserves unrelated fields', async () => {
    await writeAuth(tokenExpiringIn(60_000))
    const { fetchImpl } = refreshStub(tokenExpiringIn(3_600_000))
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl })
    await store.getTokens()
    const saved = JSON.parse(await readFile(authFile, 'utf8')) as Record<string, unknown>
    expect((saved['tokens'] as Record<string, unknown>)['refresh_token']).toBe('refresh-new')
    expect(saved['keep_me']).toBe('untouched')
    expect(saved['auth_mode']).toBe('chatgpt')
    expect(saved['last_refresh']).not.toBe('old')
  })

  it('forceRefresh refreshes even when the token is far from expiry', async () => {
    await writeAuth(tokenExpiringIn(10 * 24 * 3_600_000))
    const fresh = tokenExpiringIn(10 * 24 * 3_600_000)
    const { fetchImpl, seen } = refreshStub(fresh)
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl })
    await store.forceRefresh()
    expect(seen).toHaveLength(1)
  })

  it('reports a rejected refresh token with re-login guidance', async () => {
    await writeAuth(tokenExpiringIn(60_000))
    const fetchImpl = (async () => ({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => 'invalid_grant',
    })) as unknown as typeof fetch
    const store = new TokenStore({ authFile, refreshMarginMs: 1_800_000, fetchImpl })
    await expect(store.getTokens()).rejects.toThrow(/codex/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd D:/dev/dsh-gpt-sub && pnpm vitest run tests/token-store-refresh.spec.ts`
Expected: FAIL — `store.forceRefresh is not a function`, and the refresh tests see no fetch call.

- [ ] **Step 3: Add refresh and atomic write to `src/token-store.ts`**

Add these imports at the top of the file:

```ts
import { rename, writeFile } from 'node:fs/promises'
```

Add these module constants below the imports:

```ts
/** Codex CLI's public OAuth client, read from the aud claim of a real id_token. */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

/** Issuer-derived token endpoint. */
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
```

Add the `#fetch` field and initialize it in the constructor:

```ts
  readonly #fetch: typeof fetch
```

```ts
    this.#fetch = options.fetchImpl ?? globalThis.fetch
```

Replace the placeholder branch inside `getTokens()` with a real refresh:

```ts
    if (expiry !== undefined && expiry - this.#now() < this.#refreshMarginMs) {
      return await this.#refresh(file, tokens)
    }
```

Add these methods to the class:

```ts
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
   * Exchange the refresh token and persist the result.
   *
   * @param file - the parsed auth.json, whose unrelated fields are preserved.
   * @param tokens - the credentials whose refresh token is being spent.
   * @returns the newly issued credentials.
   */
  async #refresh(file: AuthFileShape, tokens: CodexTokens): Promise<CodexTokens> {
    const response = await this.#fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
      }),
    })
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
    await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8')
    await rename(temporary, this.#authFile)
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd D:/dev/dsh-gpt-sub && pnpm vitest run tests/token-store-refresh.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run the whole suite to confirm Task 2 still passes**

Run: `cd D:/dev/dsh-gpt-sub && pnpm test`
Expected: PASS, 13 tests across 3 files.

- [ ] **Step 6: Commit**

```bash
cd D:/dev/dsh-gpt-sub
git add src/token-store.ts tests/token-store-refresh.spec.ts
git commit -m "feat: refresh Codex tokens and persist them atomically"
```

---

### Task 4: Request shaping — body and headers

**Files:**
- Create: `src/shape.ts`
- Test: `tests/shape.spec.ts`

**Interfaces:**
- Consumes: `CodexTokens` from `src/token-store.ts`
- Produces:
  - `buildUpstreamBody(clientBody: Record<string, unknown>): Record<string, unknown>`
  - `buildUpstreamHeaders(tokens: CodexTokens, sessionId: string): Record<string, string>`

- [ ] **Step 1: Write the failing test `tests/shape.spec.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { buildUpstreamBody, buildUpstreamHeaders } from '../src/shape.ts'

const tokens = { accessToken: 'access-xyz', refreshToken: 'r', accountId: 'acct-123' }

describe('buildUpstreamBody', () => {
  it('injects store:false', () => {
    expect(buildUpstreamBody({ model: 'gpt-5.6-sol' })['store']).toBe(false)
  })

  it('overrides a caller-supplied store:true', () => {
    // The upstream rejects anything but false: {"detail":"Store must be set to false"}.
    expect(buildUpstreamBody({ store: true })['store']).toBe(false)
  })

  it('leaves every other field untouched', () => {
    const input = { model: 'gpt-5.6-sol', stream: true, input: [{ role: 'user' }] }
    const output = buildUpstreamBody(input)
    expect(output['model']).toBe('gpt-5.6-sol')
    expect(output['stream']).toBe(true)
    expect(output['input']).toEqual([{ role: 'user' }])
  })

  it('does not mutate the caller object', () => {
    const input: Record<string, unknown> = { model: 'gpt-5.6-sol' }
    buildUpstreamBody(input)
    expect('store' in input).toBe(false)
  })
})

describe('buildUpstreamHeaders', () => {
  it('carries the bearer token, account id, originator, and session id', () => {
    const headers = buildUpstreamHeaders(tokens, 'session-1')
    expect(headers['authorization']).toBe('Bearer access-xyz')
    expect(headers['chatgpt-account-id']).toBe('acct-123')
    expect(headers['originator']).toBe('codex_cli_rs')
    expect(headers['session_id']).toBe('session-1')
    expect(headers['content-type']).toBe('application/json')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd D:/dev/dsh-gpt-sub && pnpm vitest run tests/shape.spec.ts`
Expected: FAIL — cannot resolve `../src/shape.ts`.

- [ ] **Step 3: Write `src/shape.ts`**

```ts
/**
 * Request shaping for the Codex Responses backend: the two adjustments that
 * separate a DSH-native openai-responses request from one the backend accepts.
 *
 * @module dsh-gpt-sub/shape
 */

import type { CodexTokens } from './token-store.ts'

/**
 * Copy the client body with `store` forced to false.
 *
 * The backend rejects any other value with HTTP 400
 * `{"detail":"Store must be set to false"}`. DSH's openai-responses path does
 * not send the field, and the provider profile's `compat` block cannot add it,
 * so this is the only place it can be set.
 *
 * @param clientBody - the body DSH sent to the shim.
 * @returns a new object; the caller's object is never mutated.
 */
export function buildUpstreamBody(clientBody: Record<string, unknown>): Record<string, unknown> {
  return { ...clientBody, store: false }
}

/**
 * Build the upstream request headers.
 *
 * @param tokens - credentials for this request.
 * @param sessionId - a per-request identifier the backend expects.
 * @returns headers for the upstream fetch.
 */
export function buildUpstreamHeaders(tokens: CodexTokens, sessionId: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${tokens.accessToken}`,
    'chatgpt-account-id': tokens.accountId,
    'OpenAI-Beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    session_id: sessionId,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd D:/dev/dsh-gpt-sub && pnpm vitest run tests/shape.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd D:/dev/dsh-gpt-sub
git add src/shape.ts tests/shape.spec.ts
git commit -m "feat: shape upstream body and headers for the Codex backend"
```

---

### Task 5: Forwarder — proxy dispatch and retry before first byte

**Files:**
- Create: `src/forwarder.ts`
- Test: `tests/forwarder.spec.ts`

**Interfaces:**
- Consumes: `TokenStore`/`CodexTokens` (Task 2-3), `buildUpstreamBody`/`buildUpstreamHeaders` (Task 4)
- Produces:
  - `interface ForwardResult { status: number; headers: Record<string, string>; body: NodeJS.ReadableStream | null }`
  - `interface ForwarderOptions { tokens: TokenStore; upstreamUrl: string; bootstrapRetries: number; dispatcher?: unknown; requestImpl?: UpstreamRequest; newSessionId?: () => string }`
  - `type UpstreamRequest = (url: string, init: { method: string; headers: Record<string, string>; body: string; dispatcher?: unknown }) => Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: NodeJS.ReadableStream & { text(): Promise<string> } }>`
  - `class Forwarder` with `forward(clientBody: Record<string, unknown>): Promise<ForwardResult>`

**Retry rule:** retries apply only to failures of the upstream request call itself — that is, before any response has been returned to the caller. Once `forward` resolves, the body stream is the caller's to pipe and is never retried, because replaying it would duplicate content already sent.

- [ ] **Step 1: Write the failing test `tests/forwarder.spec.ts`**

```ts
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { Forwarder } from '../src/forwarder.ts'
import type { CodexTokens } from '../src/token-store.ts'
import type { TokenStore } from '../src/token-store.ts'

const tokens: CodexTokens = { accessToken: 'access-1', refreshToken: 'r', accountId: 'acct-1' }

/** A TokenStore double recording how often a forced refresh happened. */
function storeDouble(): TokenStore & { forced: number } {
  // getTokens is re-read at the top of every attempt, so a refresh must change
  // what it subsequently returns -- otherwise the retry would resend the token
  // the upstream just rejected.
  let current: CodexTokens = tokens
  const double = {
    forced: 0,
    getTokens: async (): Promise<CodexTokens> => current,
    forceRefresh: async (): Promise<CodexTokens> => {
      double.forced += 1
      current = { ...tokens, accessToken: 'access-2' }
      return current
    },
  }
  return double as unknown as TokenStore & { forced: number }
}

/** A successful upstream reply carrying one SSE chunk. */
function okReply(): { statusCode: number; headers: Record<string, string>; body: NodeJS.ReadableStream } {
  const body = Readable.from(['data: {"type":"response.output_text.delta"}\n\n'])
  return { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body }
}

describe('Forwarder.forward', () => {
  it('retries a connection failure and then succeeds', async () => {
    let attempts = 0
    const forwarder = new Forwarder({
      tokens: storeDouble(),
      upstreamUrl: 'https://upstream.test/responses',
      bootstrapRetries: 3,
      requestImpl: async () => {
        attempts += 1
        if (attempts < 3) throw new Error('socket hang up')
        return okReply() as never
      },
    })
    const result = await forwarder.forward({ model: 'gpt-5.6-sol' })
    expect(result.status).toBe(200)
    expect(attempts).toBe(3)
  })

  it('gives up after the configured attempts and surfaces the last error', async () => {
    let attempts = 0
    const forwarder = new Forwarder({
      tokens: storeDouble(),
      upstreamUrl: 'https://upstream.test/responses',
      bootstrapRetries: 2,
      requestImpl: async () => {
        attempts += 1
        throw new Error('socket hang up')
      },
    })
    await expect(forwarder.forward({ model: 'x' })).rejects.toThrow('socket hang up')
    expect(attempts).toBe(2)
  })

  it('refreshes once and retries once on a 401', async () => {
    const store = storeDouble()
    const seen: string[] = []
    let attempts = 0
    const forwarder = new Forwarder({
      tokens: store,
      upstreamUrl: 'https://upstream.test/responses',
      bootstrapRetries: 3,
      requestImpl: async (_url, init) => {
        attempts += 1
        seen.push(init.headers['authorization'] ?? '')
        if (attempts === 1) {
          return { statusCode: 401, headers: {}, body: Readable.from(['unauthorized']) } as never
        }
        return okReply() as never
      },
    })
    const result = await forwarder.forward({ model: 'x' })
    expect(result.status).toBe(200)
    expect(store.forced).toBe(1)
    expect(seen).toEqual(['Bearer access-1', 'Bearer access-2'])
  })

  it('forwards a non-401 upstream error verbatim without retrying', async () => {
    let attempts = 0
    const forwarder = new Forwarder({
      tokens: storeDouble(),
      upstreamUrl: 'https://upstream.test/responses',
      bootstrapRetries: 3,
      requestImpl: async () => {
        attempts += 1
        return { statusCode: 400, headers: {}, body: Readable.from(['{"detail":"bad"}']) } as never
      },
    })
    const result = await forwarder.forward({ model: 'x' })
    expect(result.status).toBe(400)
    expect(attempts).toBe(1)
  })

  it('sends store:false and the bearer header upstream', async () => {
    let sentBody = ''
    let sentHeaders: Record<string, string> = {}
    const forwarder = new Forwarder({
      tokens: storeDouble(),
      upstreamUrl: 'https://upstream.test/responses',
      bootstrapRetries: 1,
      requestImpl: async (_url, init) => {
        sentBody = init.body
        sentHeaders = init.headers
        return okReply() as never
      },
    })
    await forwarder.forward({ model: 'gpt-5.6-sol' })
    expect(JSON.parse(sentBody)['store']).toBe(false)
    expect(sentHeaders['authorization']).toBe('Bearer access-1')
    expect(sentHeaders['chatgpt-account-id']).toBe('acct-1')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd D:/dev/dsh-gpt-sub && pnpm vitest run tests/forwarder.spec.ts`
Expected: FAIL — cannot resolve `../src/forwarder.ts`.

- [ ] **Step 3: Write `src/forwarder.ts`**

```ts
/**
 * Upstream dispatch for the Codex Responses backend.
 *
 * Two behaviors matter here. First, the proxy link on this machine drops
 * connections at random, so a failed attempt is retried while nothing has
 * reached the caller yet. Second, retrying is forbidden once a response is
 * handed back: its body is streamed onward, and replaying it would duplicate
 * content the client already received.
 *
 * @module dsh-gpt-sub/forwarder
 */

import { randomUUID } from 'node:crypto'
import { buildUpstreamBody, buildUpstreamHeaders } from './shape.ts'
import type { TokenStore } from './token-store.ts'

/** The shape of one upstream reply, narrowed to what the shim forwards. */
export interface UpstreamReply {
  statusCode: number
  headers: Record<string, string | string[] | undefined>
  body: NodeJS.ReadableStream
}

/** The injectable upstream call; undici's `request` satisfies this shape. */
export type UpstreamRequest = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; dispatcher?: unknown },
) => Promise<UpstreamReply>

/** What the server needs in order to answer the client. */
export interface ForwardResult {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: NodeJS.ReadableStream
}

/** Construction options; the injectable seams exist for tests. */
export interface ForwarderOptions {
  tokens: TokenStore
  upstreamUrl: string
  /** Attempts allowed while nothing has reached the client. */
  bootstrapRetries: number
  /** undici Dispatcher (a ProxyAgent in production). */
  dispatcher?: unknown
  requestImpl?: UpstreamRequest
  newSessionId?: () => string
}

export class Forwarder {
  readonly #tokens: TokenStore
  readonly #upstreamUrl: string
  readonly #attempts: number
  readonly #dispatcher: unknown
  readonly #request: UpstreamRequest
  readonly #newSessionId: () => string

  constructor(options: ForwarderOptions) {
    this.#tokens = options.tokens
    this.#upstreamUrl = options.upstreamUrl
    this.#attempts = Math.max(1, options.bootstrapRetries)
    this.#dispatcher = options.dispatcher
    if (options.requestImpl === undefined) {
      throw new Error('dsh-gpt-sub: requestImpl is required; index.ts supplies undici request')
    }
    this.#request = options.requestImpl
    this.#newSessionId = options.newSessionId ?? ((): string => randomUUID())
  }

  /**
   * Send one request upstream, absorbing transient connection failures.
   *
   * @param clientBody - the body DSH sent to the shim.
   * @returns the upstream status, headers, and an unread body stream.
   */
  async forward(clientBody: Record<string, unknown>): Promise<ForwardResult> {
    const body = JSON.stringify(buildUpstreamBody(clientBody))
    const sessionId = this.#newSessionId()
    let refreshed = false
    let lastError: unknown

    for (let attempt = 0; attempt < this.#attempts; attempt += 1) {
      const tokens = await this.#tokens.getTokens()
      try {
        const reply = await this.#request(this.#upstreamUrl, {
          method: 'POST',
          headers: buildUpstreamHeaders(tokens, sessionId),
          body,
          ...(this.#dispatcher === undefined ? {} : { dispatcher: this.#dispatcher }),
        })
        // A 401 means local expiry math was wrong; refresh once, then retry once.
        if (reply.statusCode === 401 && !refreshed) {
          refreshed = true
          await this.#tokens.forceRefresh()
          continue
        }
        // Every other status, including errors, goes back untouched.
        return { status: reply.statusCode, headers: reply.headers, body: reply.body }
      } catch (error) {
        // No response was produced, so nothing has reached the client: retry.
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('dsh-gpt-sub: upstream request failed')
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd D:/dev/dsh-gpt-sub && pnpm vitest run tests/forwarder.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd D:/dev/dsh-gpt-sub
git add src/forwarder.ts tests/forwarder.spec.ts
git commit -m "feat: forward upstream with retry before first byte and 401 refresh"
```

---

### Task 6: Server — loopback listener and local authorization

**Files:**
- Create: `src/server.ts`
- Test: `tests/server.spec.ts`

**Interfaces:**
- Consumes: `Forwarder`, `ForwardResult` from Task 5
- Produces:
  - `interface ServerOptions { port: number; localKey: string; forwarder: Pick<Forwarder, 'forward'> }`
  - `createServer(options: ServerOptions): http.Server`
  - `listen(server: http.Server, port: number): Promise<void>`

- [ ] **Step 1: Write the failing test `tests/server.spec.ts`**

```ts
import type { Server } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, listen } from '../src/server.ts'

let server: Server | undefined

afterEach(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server?.close(() => { resolve() }))
  server = undefined
})

/** Start the shim on an ephemeral port and return its base URL. */
async function start(forward: (body: Record<string, unknown>) => Promise<unknown>): Promise<string> {
  server = createServer({
    port: 0,
    localKey: 'local-secret',
    forwarder: { forward } as never,
  })
  await listen(server, 0)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return `http://127.0.0.1:${String(address.port)}`
}

const okResult = {
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  body: Readable.from(['data: hello\n\n']),
}

describe('shim server', () => {
  it('forwards an authorized POST /v1/responses', async () => {
    const base = await start(async () => okResult)
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local-secret' },
      body: JSON.stringify({ model: 'gpt-5.6-sol' }),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('data: hello')
  })

  it('rejects a request with no bearer', async () => {
    const base = await start(async () => okResult)
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(401)
  })

  it('rejects a request with the wrong bearer', async () => {
    const base = await start(async () => okResult)
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: '{}',
    })
    expect(response.status).toBe(401)
  })

  it('404s any other route', async () => {
    const base = await start(async () => okResult)
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(404)
  })

  it('passes the upstream status through unaltered', async () => {
    const base = await start(async () => ({
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: Readable.from(['{"detail":"Store must be set to false"}']),
    }))
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer local-secret' },
      body: '{}',
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Store must be set to false')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd D:/dev/dsh-gpt-sub && pnpm vitest run tests/server.spec.ts`
Expected: FAIL — cannot resolve `../src/server.ts`.

- [ ] **Step 3: Write `src/server.ts`**

```ts
/**
 * The loopback HTTP shim DSH talks to.
 *
 * Binding to 127.0.0.1 is not access control on a shared machine, so the
 * listener also requires a local shared secret: without it any process on the
 * box could spend the user's ChatGPT subscription.
 *
 * @module dsh-gpt-sub/server
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Forwarder } from './forwarder.ts'

/** Construction options for the shim listener. */
export interface ServerOptions {
  port: number
  /** Shared secret DSH sends as a bearer token. */
  localKey: string
  forwarder: Pick<Forwarder, 'forward'>
}

/** The only route the shim serves. */
const ROUTE = '/v1/responses'

/** Compare two secrets without leaking length-independent timing. */
function secretsMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Read a whole request body as UTF-8. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Build the shim's HTTP server.
 *
 * @param options - port, local secret, and the forwarder to delegate to.
 * @returns an unstarted server.
 */
export function createServer(options: ServerOptions): Server {
  return createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response, options)
  })
}

/** Answer one request. */
async function handle(request: IncomingMessage, response: ServerResponse, options: ServerOptions): Promise<void> {
  const url = request.url ?? ''
  if (request.method !== 'POST' || url.split('?')[0] !== ROUTE) {
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: `dsh-gpt-sub: only POST ${ROUTE} is served` }))
    return
  }

  const header = request.headers.authorization ?? ''
  const supplied = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
  if (!secretsMatch(supplied, options.localKey)) {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'dsh-gpt-sub: missing or invalid local key' }))
    return
  }

  try {
    const raw = await readBody(request)
    const parsed = (raw === '' ? {} : JSON.parse(raw)) as Record<string, unknown>
    const result = await options.forwarder.forward(parsed)
    response.writeHead(result.status, result.headers)
    result.body.pipe(response)
  } catch (error) {
    // Nothing was written yet, so an error can still be reported cleanly.
    response.writeHead(502, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: `dsh-gpt-sub: ${String(error)}` }))
  }
}

/**
 * Start listening on loopback.
 *
 * @param server - a server from {@link createServer}.
 * @param port - the port to bind; 0 selects an ephemeral one.
 */
export async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd D:/dev/dsh-gpt-sub && pnpm vitest run tests/server.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
cd D:/dev/dsh-gpt-sub
git add src/server.ts tests/server.spec.ts
git commit -m "feat: serve the loopback shim with local-key authorization"
```

---

### Task 7: Plugin wiring

**Files:**
- Create: `src/index.ts`
- Create: `cordis.patch.yml`
- Test: `tests/config.spec.ts`

**Interfaces:**
- Consumes: `TokenStore` (Tasks 2-3), `Forwarder` (Task 5), `createServer`/`listen` (Task 6), `Config` (Task 1)
- Produces: `name`, `Config`, `apply(ctx: Context, config: Config): void`

- [ ] **Step 1: Write the failing test `tests/config.spec.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { Config, name } from '../src/index.ts'

describe('plugin config', () => {
  it('is named gpt-sub', () => {
    expect(name).toBe('gpt-sub')
  })

  it('applies the documented defaults', () => {
    const resolved = new Config({ proxyUrl: 'http://127.0.0.1:7890' })
    expect(resolved.port).toBe(8318)
    expect(resolved.bootstrapRetries).toBe(3)
    expect(resolved.refreshMarginMinutes).toBe(30)
    expect(resolved.localKeyRef).toBe('GPT_SUB_LOCAL_KEY')
    expect(resolved.authFile).toBe('~/.codex/auth.json')
  })

  it('keeps an explicit port', () => {
    expect(new Config({ proxyUrl: '', port: 9001 }).port).toBe(9001)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd D:/dev/dsh-gpt-sub && pnpm vitest run tests/config.spec.ts`
Expected: FAIL — cannot resolve `../src/index.ts`.

- [ ] **Step 3: Write `src/index.ts`**

```ts
/**
 * Direct ChatGPT/Codex subscription access for DeepSeek Harness.
 *
 * DSH speaks its native openai-responses protocol to a loopback shim this
 * plugin runs; the shim adds the two things the Codex backend requires but DSH
 * does not send -- `store: false` and OAuth headers -- routes through the
 * configured proxy, and absorbs the transient connection failures that
 * otherwise surface as PROTOCOL_ERROR on a session's first request.
 *
 * @module dsh-gpt-sub
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { request as undiciRequest, ProxyAgent } from 'undici'
import { Forwarder, type UpstreamRequest } from './forwarder.ts'
import { createServer, listen } from './server.ts'
import { TokenStore } from './token-store.ts'
import type { Config as ConfigShape } from './types.ts'

export type { Config } from './types.ts'

/** Cordis plugin name. */
export const name = 'gpt-sub'

/** The Codex Responses endpoint this shim fronts. */
const UPSTREAM_URL = 'https://chatgpt.com/backend-api/codex/responses'

/** Plugin config schema. */
export const Config: z<ConfigShape> = z.object({
  port: z.number().default(8318),
  proxyUrl: z.string().default(''),
  authFile: z.string().default('~/.codex/auth.json'),
  bootstrapRetries: z.number().default(3),
  refreshMarginMinutes: z.number().default(30),
  localKeyRef: z.string().role('credential-ref').default('GPT_SUB_LOCAL_KEY'),
})

/** Expand a leading `~` against the current user's home directory. */
function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/**
 * Start the shim and tear it down with the plugin.
 *
 * @param ctx - the cordis context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  let server: Server | undefined

  const start = async (): Promise<void> => {
    const localKey = await ctx.credentials.resolve(credentialRef(config.localKeyRef))
    if (localKey === undefined || localKey.value === '') {
      throw new Error(
        `dsh-gpt-sub: credential ${config.localKeyRef} is not set; store any random string under that name so DSH and this shim share one local key`,
      )
    }

    const tokens = new TokenStore({
      authFile: expandHome(config.authFile),
      refreshMarginMs: config.refreshMarginMinutes * 60_000,
    })

    const dispatcher = config.proxyUrl === '' ? undefined : new ProxyAgent(config.proxyUrl)
    const forwarder = new Forwarder({
      tokens,
      upstreamUrl: UPSTREAM_URL,
      bootstrapRetries: config.bootstrapRetries,
      ...(dispatcher === undefined ? {} : { dispatcher }),
      requestImpl: undiciRequest as unknown as UpstreamRequest,
    })

    server = createServer({ port: config.port, localKey: localKey.value, forwarder })
    await listen(server, config.port)
    ctx.logger.info('gpt-sub: listening on http://127.0.0.1:%d/v1/responses', config.port)
  }

  void start().catch((error: unknown) => {
    ctx.logger.error('gpt-sub: failed to start: %o', error)
  })

  ctx.on('dispose', () => {
    server?.close()
    server = undefined
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd D:/dev/dsh-gpt-sub && pnpm vitest run tests/config.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write `cordis.patch.yml`**

```yaml
# dsh-gpt-sub bundle patch: one insert over the profile root. Later user patch
# layers address this row by id and replace its whole config.
- insert:
    - id: gpt-sub
      name: 'dsh-gpt-sub'
      config:
        # Loopback port for the shim; must match settings.yaml baseURL.
        port: 8318
        # Proxy for reaching chatgpt.com. Empty string means direct.
        proxyUrl: 'http://127.0.0.1:7890'
        # Codex CLI credential file, shared with the codex command.
        authFile: '~/.codex/auth.json'
        # Attempts allowed while nothing has reached the client yet.
        bootstrapRetries: 3
        # Refresh the access token when less than this many minutes remain.
        refreshMarginMinutes: 30
```

- [ ] **Step 6: Typecheck and run the full suite**

Run: `cd D:/dev/dsh-gpt-sub && pnpm typecheck && pnpm test`
Expected: typecheck clean; PASS, 31 tests across 7 files (jwt 4, token-store 4, token-store-refresh 5, shape 5, forwarder 5, server 5, config 3).

- [ ] **Step 7: Commit**

```bash
cd D:/dev/dsh-gpt-sub
git add src/index.ts cordis.patch.yml tests/config.spec.ts
git commit -m "feat: wire the plugin, proxy dispatcher, and bundle patch"
```

---

### Task 8: Wire into DSH and verify end to end

**Files:**
- Create: `README.md`
- Modify: `C:\Users\Administrator\.dsh\settings.yaml`
- Modify: `C:\Users\Administrator\.dsh\cordis.patch.yml`

**Interfaces:**
- Consumes: the built plugin from Task 7
- Produces: a working `gpt-sub` provider in DSH

- [ ] **Step 1: Build and link the plugin**

```bash
cd D:/dev/dsh-gpt-sub
pnpm build
```

Then link it into the web profile:

```bash
cd C:/Users/Administrator/.dsh/profiles/web
pnpm add link:D:/dev/dsh-gpt-sub --registry https://registry.npmmirror.com
```

Verify the link resolves — a dangling link is the failure mode this environment has hit before:

```bash
node -e "console.log(require('C:/Users/Administrator/.dsh/profiles/web/node_modules/dsh-gpt-sub/package.json').name)"
```

Expected: `dsh-gpt-sub`.

- [ ] **Step 2: Store the local shared key**

Add `GPT_SUB_LOCAL_KEY` to `C:\Users\Administrator\.dsh\.credentials.yaml` with any random value, matching how `CODEX_SUB_API_KEY` is stored:

```yaml
GPT_SUB_LOCAL_KEY: dsh-gpt-sub-local-<random>
```

- [ ] **Step 3: Add the provider to `settings.yaml`**

Under `llm-pi-ai.providers`, add:

```yaml
    gpt-sub:
      displayName: CodexSubscription
      apiKeyEnv: GPT_SUB_LOCAL_KEY
      api: openai-responses
      baseURL: http://127.0.0.1:8318/v1
      models:
        - id: gpt-5.6-sol
          name: gpt-5.6-sol
          contextWindow: 258000
          maxTokens: 128000
        - id: gpt-5.6-terra
          name: gpt-5.6-terra
          contextWindow: 258000
          maxTokens: 128000
        - id: gpt-5.6-luna
          name: gpt-5.6-luna
          contextWindow: 258000
          maxTokens: 128000
```

`baseURL` must keep the `/v1` segment: DSH treats it as a literal prefix and appends `/responses`, so dropping it yields a bodyless 404.

- [ ] **Step 4: Confirm the plugin loads**

Run:

```bash
node "D:/dev-cache/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/lib/bin.js" web --dump-config | grep -A6 gpt-sub
```

Expected: a `- id: gpt-sub` row with the configured values.

- [ ] **Step 5: Verify the shim answers**

Start DSH, then with `GPT_SUB_LOCAL_KEY`'s value in `$KEY`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8318/v1/responses \
  -H "content-type: application/json" -H "authorization: Bearer $KEY" \
  -d '{"model":"gpt-5.6-sol","stream":true,"input":[{"role":"user","content":[{"type":"input_text","text":"Reply with exactly: OK"}]}]}'
```

Expected: `200`.

- [ ] **Step 6: Verify the flakiness mitigation with a large payload**

Repeat an ~80KB request six times, the same check that validated `bootstrap-retries`:

```bash
python -c "
import json
body={'model':'gpt-5.6-sol','stream':True,'input':[{'role':'user','content':[{'type':'input_text','text':'Ignore filler. '+('x'*(80*1024))+' Reply with exactly: OK'}]}]}
open('p.json','w').write(json.dumps(body))
"
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "run $i: %{http_code}\n" http://127.0.0.1:8318/v1/responses \
    -H "content-type: application/json" -H "authorization: Bearer $KEY" --data-binary @p.json
done
```

Expected: six `200`s. Any `PROTOCOL_ERROR` reaching the caller means the retry rule regressed.

- [ ] **Step 7: Confirm the Codex CLI still works**

Run: `codex --version` and one short `codex` prompt.
Expected: succeeds, proving the atomic write-back left `auth.json` usable.

- [ ] **Step 8: Stop CLIProxyAPI**

Run: `powershell -ExecutionPolicy Bypass -File D:/soft/CLIProxyAPI/stop.ps1`

Then repeat Step 5 to confirm DSH no longer depends on it.

- [ ] **Step 9: Write `README.md`**

Document: what the plugin replaces, the two config blocks from Steps 2-3, how to rotate the local key, what to do when `refresh_token` is rejected (`run codex`), and the fact that `bootstrapRetries` exists because this machine's proxy link drops connections at random.

- [ ] **Step 10: Commit**

```bash
cd D:/dev/dsh-gpt-sub
git add README.md
git commit -m "docs: document configuration and the proxy-retry rationale"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| TokenStore (read, expiry, refresh, atomic write) | 2, 3 |
| Forwarder (`store:false`, headers, proxy, retry) | 4, 5 |
| Server (loopback, single route, local key) | 6 |
| Plugin (cordis entry, config schema) | 7 |
| Configuration blocks | 7, 8 |
| Error handling table | 2, 3, 5, 6 |
| Unit / integration / end-to-end tests | 1-8 |
| Success criteria 1-4 | 8 |
| Success criterion 5 (A migration leaves settings.yaml unchanged) | Structural: `settings.yaml` names only `baseURL`/`api`, so replacing the shim with an `LlmAdapter` touches no user config. No task needed. |

**Placeholder scan:** none. Every step carries runnable code or an exact command.

**Type consistency:** `CodexTokens` (Task 2) is consumed unchanged by Tasks 4 and 5. `UpstreamRequest` and `ForwardResult` (Task 5) are consumed by Tasks 6 and 7. `Config` (Task 1) is the schema target in Task 7. `TokenStore.forceRefresh` is introduced in Task 3 and called in Task 5. `createServer`/`listen` (Task 6) are called in Task 7 with matching signatures.

**One known gap, deliberately left:** Task 5's `Forwarder` requires `requestImpl` rather than defaulting to undici's `request`, so the unit tests never touch the network. Task 7 supplies the real one. This is why `Forwarder`'s constructor throws when it is missing.
