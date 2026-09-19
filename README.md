# dsh-gpt-sub

Direct ChatGPT/Codex subscription access for DeepSeek Harness (DSH).

This plugin owns no transport. pi-ai already ships an `openai-codex` provider
that speaks the Codex wire format — it sets `store`, derives
`chatgpt-account-id` from the access token's own JWT claim, and speaks the
codex-responses protocol — but it authenticates only through OAuth, and
`dsh-llm-pi-ai` runs no login flow and holds no OAuth store. Naming a
credential on the route grafts an api-key method beside the provider's own,
and that credential is the seam this plugin fills: it keeps a live Codex
access token in the harness credential store, refreshing it from
`~/.codex/auth.json` before it expires.

The result needs no loopback port, no shared local key, and no external proxy
binary. The `codex` CLI still owns the login.

```
~/.codex/auth.json ──(refresh + atomic write-back)──> gpt-sub ──> CODEX_NATIVE_TOKEN credential
                                                                                        │
DSH ──pi-ai openai-codex provider── Bearer <that token> ──> chatgpt.com/backend-api/codex/responses
                                      through the process-global undici dispatcher, which
                                      gpt-sub has scoped: chatgpt.com / auth.openai.com /
                                      api.openai.com egress through the proxy with dropped-
                                      connection retries; every other host is untouched
```

Tokens come from `~/.codex/auth.json` — the same file the `codex` CLI uses. Refreshed
tokens are written back atomically (temp file + rename), so the CLI keeps working and never
observes a partial file.

## Setup

### 1. Mount the bundle

It is a profile bundle. Link it into the profile and list it in `dsh.profile.bundles`:

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-gpt-sub"]
    }
  },
  "dependencies": {
    "dsh-gpt-sub": "link:D:/dev/dsh-gpt-sub"
  }
}
```

The bundle ships its own `cordis.patch.yml` with two rows:

- an **insert** for the `gpt-sub` plugin itself (token sync, proxy routing, quota panel), and
- an **edit** (no `insert:`) of the dormant `llm-pi-ai` row `@deepseek-ai/dsh-base` mounts,
  seeding the provider route:

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    proxyUrl: http://127.0.0.1:7890
    authFile: ~/.codex/auth.json
    refreshMarginMinutes: 30
    tokenRef: CODEX_NATIVE_TOKEN
    syncIntervalMinutes: 10
    bootstrapRetries: 3
```

Naming `apiKeyEnv` on the route grafts an api-key auth method beside the catalog provider's
OAuth one — pi-ai's `openai-codex` would otherwise refuse an explicit key with
`Provider is not configured`. That credential reference is the token this plugin republishes,
so the two rows meet in the middle.

The edit row requires `@deepseek-ai/dsh-base` to come **earlier** in `dsh.profile.bundles`
(every standard profile does). A patch row for an id that does not exist is warned and
skipped, not an error.

The cordis layer applies at profile load, so a freshly installed bundle needs one restart of
`dsh web`; after that, user-settings changes hot-reload per request.

### 2. Sign in with the `codex` CLI

Run `codex` and complete the sign-in; that writes `~/.codex/auth.json`. This is the only
credential step — the plugin fails at start naming the path when the file is missing or
cannot serve tokens (`tokens.access_token`, `tokens.refresh_token`,
`tokens.account_id`), rather than leaving a route pointed at a credential nothing
maintains.

| Model | Context | Max output | Input | Thinking levels |
|---|---|---|---|---|
| `gpt-5.6-sol` | 272,000 | 128,000 | text, image | `minimal` (wire: `low`), `xhigh`, `max` |
| `gpt-5.6-terra` | 272,000 | 128,000 | text, image | `minimal` (wire: `low`), `xhigh`, `max` |
| `gpt-5.6-luna` | 272,000 | 128,000 | text, image | `minimal` (wire: `low`), `xhigh`, `max` |

The thinking level is per session, chosen in the model picker alongside the model.

To narrow or correct the catalog, write a user `llm-pi-ai:` settings section — it merges
per provider on top of the seeded route, so other providers declared there are additive:

```yaml
# ~/.dsh/settings.yaml — keeps the credential, narrows the route to one model
llm-pi-ai:
  providers:
    gpt-sub:
      displayName: CodexSubscription (direct)
      api: openai-codex
      apiKeyEnv: CODEX_NATIVE_TOKEN
      models:
        - id: gpt-5.6-sol
```

`apiKeyEnv` **must equal the plugin's `tokenRef`** (default `CODEX_NATIVE_TOKEN`); both
sides name the same credential reference, so they always agree. You never store a value
under it yourself — this plugin is what keeps the reference populated, refreshing and
republishing the token on its own schedule. No `baseURL` is needed: the `openai-codex`
provider knows the Codex backend itself.

## Configuration reference

| Option | Default | Meaning |
|---|---|---|
| `proxyUrl` | `''` (direct) | Proxy for reaching the Codex hosts. The shipped `cordis.patch.yml` sets `http://127.0.0.1:7890`. Empty string means direct. |
| `authFile` | `~/.codex/auth.json` | Codex CLI credential file, shared with the `codex` command. |
| `tokenRef` | `CODEX_NATIVE_TOKEN` | Credential the seeded `openai-codex` route reads (`apiKeyEnv`). Must match the llm-pi-ai row. |
| `refreshMarginMinutes` | `30` | Refresh the access token when less than this many minutes remain. |
| `tokenRef` | `CODEX_NATIVE_TOKEN` | Credential the provider route names in `settings.yaml`; this plugin keeps it populated. |
| `syncIntervalMinutes` | `10` | How often to re-read auth.json and republish the token. |
| `bootstrapRetries` | `3` | Connection-level retries per request when the link to the proxy drops. |
| `stateFile` | `~/.dsh/gpt-sub.json` | Persisted panel overrides (`proxyUrl`, `authFile`); a field present in the file wins over the config's. |

## Why `bootstrapRetries` exists

This is not a generic retry knob, and it is not a nicety.

The machine this was written for reaches `chatgpt.com` only through a Clash proxy, and that
link drops connections at random. Measured direct to `chatgpt.com` through the same proxy,
bypassing any harness: 32KB failed twice, 64KB failed then succeeded, 96KB and 128KB
succeeded twice. Non-monotonic — so it is random TLS/connection failure, not a payload-size
threshold and not a protocol problem. DSH saw it as
`stream error: stream ID 1; PROTOCOL_ERROR; received from peer`, most visibly on a session's
first request.

The retry lives in undici's retry interceptor, composed onto the proxy agent and scoped to
the three Codex hosts, so no other provider's traffic changes behavior. It retries
connection-level failures only — `statusCodes` is deliberately empty, because an upstream
`429` or `500` carries a body DSH knows how to read and surface, and replaying it here
would swallow it. `POST` is listed even though undici omits it by default: a connection
error arrives before any response, and undici itself refuses to replay a request whose body
was already consumed, so a partially streamed response is never silently concatenated.
Model calls are POSTs, so without this the retry would never fire at all.

If your network is reliable, this setting costs nothing.

## Operations

**`refresh_token` rejected.** The refresh token is single-use and rotates on every refresh.
If it is rejected, the plugin fails with guidance to re-authenticate: run `codex` and sign in
again. That rewrites `~/.codex/auth.json`, which the plugin picks up.

**Upstream errors are never rewrapped.** An upstream `4xx`/`5xx` passes through with its
status and body unaltered — the routing layer retries no HTTP status, and nothing between
DSH and the backend rewrites an error. This is deliberate: a generic `500` hiding the real
cause once sent debugging down the wrong path for hours.

**Token publication.** The access token is republished to the credential on every sync tick
(default every 10 minutes) and immediately after a panel-side credential-file switch, so the
provider route never reads a stale token.

## Settings panel diagnostics

The `Codex 配额` settings section does more than render the usage bars. It shows
one bar per rate-limit window the account reports — the 5-hour rolling window
and the weekly window — each drawn Codex-style as the percent **remaining**: a
full bar at 100% that drains toward 0% as the allowance is spent, with its own
reset countdown. The countdown is exact, not rounded to one unit: `4h22m后重置`,
`10m22s后重置` under an hour (seconds only appear there, where they still change
fast enough to read), `2d5h后重置` past a day, and a zero component is dropped
rather than padded — `4h`, never `4h0m`. An account with no 5-hour limit (pro
accounts currently report only a weekly window) shows a note where that bar
would be, so the absence reads as a fact about the plan rather than a broken
panel. Beside the plan name the header carries the account's remaining
on-demand usage resets (upstream's `rate_limit_reset_credits.available_count`)
as a badge — `还有 2 次重置` — whenever the plan reports them; each reset clears
a capped window without waiting out its timer. Below the bars the panel shows:

- **Auth 来源** — the `authFile` the credentials come from, plus the access token's
  remaining lifetime.
- **自动刷新** — when the next automatic refresh happens: the moment the token's
  remaining life drops below `refreshMarginMinutes`, refreshed on the next read
  (the `syncIntervalMinutes` timer or a model call, whichever comes first).
- **Auth 文件** — the credential file itself, editable inline. The host validates
  a candidate before anything is persisted or applied (readable, parseable, and
  carrying the three required token fields — the check spends no refresh);
  **保存** then swaps the live token source immediately, republishes the access
  token to the credential store, and persists the choice to `stateFile`. Saving
  an empty value restores the cordis-configured default. **浏览** opens a small
  folder picker backed by a read-only host listing — a browser's native dialog
  cannot hand back absolute paths, so browsing runs through the host instead
  (names and paths only, never file contents).
- **HTTP 代理** — the proxy currently routing `chatgpt.com` / `auth.openai.com` /
  `api.openai.com`, editable inline. **测试连接** probes the candidate through a
  one-off agent (one real usage read, 15s timeout) before you commit; **保存**
  swaps the live routing immediately and persists the choice to `stateFile`, so
  it survives restarts without touching cordis config layers. An empty value
  means direct. The line under the input notes whether the current value comes
  from cordis config or a page override.

Rate-limit reset credits (the codex CLI's `rate-limit-reset-credits` wham API): `GET /gpt-sub/reset-credits` lists the account's redeemable credits, `POST /gpt-sub/reset-credits/consume` (body `{ "creditId": "..." }`, optional) consumes one. The host mints a fresh `redeem_request_id` per click, and the panel asks for confirmation first because consuming is destructive.

Host endpoints behind the panel: `GET /gpt-sub/quota` (the bars), `GET /gpt-sub/status`,
`POST /gpt-sub/proxy` (`{ "proxyUrl": "..." }`), `POST /gpt-sub/proxy/test` (same body;
probes the value without applying it), `POST /gpt-sub/auth` (`{ "authFile": "..." }`; empty
clears the page override), and the read-only `GET /gpt-sub/auth/browse?path=...` directory
listing behind the file picker (empty path means the home directory).

## Known limitations

- **No model discovery.** Models are declared statically in `settings.yaml`; there is no
  upstream catalog lookup in this plugin.
- **Single account.** No multi-account routing, usage/quota accounting, or management UI.
  CLIProxyAPI has these; nothing here needs them.
- **The proxy routing is process-global.** pi-ai issues model calls through the global
  `fetch`, so the plugin wraps the process-wide undici dispatcher — scoped by hostname, so
  only the three Codex hosts change route. If the host or another plugin later installs its
  own global dispatcher over this one, the routing here is silently bypassed: `chatgpt.com`
  then goes direct and answers with a Cloudflare block page instead of an API error.

- **Composition order.** The seeded `llm-pi-ai` route edits dsh-base's row, so
  `@deepseek-ai/dsh-base` must precede this bundle in `dsh.profile.bundles`.

## Development

```bash
pnpm build       # tsc -> lib/ (src only)
pnpm typecheck   # tsc -p tsconfig.test.json (src + tests, noEmit)
pnpm test        # vitest
```

`TokenStore`, `QuotaSource`, and `probeProxy` take injectable `fetchImpl` / `now` seams
and an injected dispatcher, so unit tests never touch the network; the plugin supplies the
real ones at startup.

## History

The first design ran an in-process loopback shim speaking `openai-responses`
(`docs/superpowers/specs/`); the credential-grafting design above replaced it, keeping
`TokenStore`'s refresh semantics unchanged. No user-visible configuration carried over
except the fields in the table above.

`tests/cordis-patch.spec.ts` holds the bundle patch and the plugin's `tokenRef`
default together, so the seeded route cannot drift from the credential it reads.
