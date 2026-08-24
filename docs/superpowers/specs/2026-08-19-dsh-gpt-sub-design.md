# dsh-gpt-sub — Design

**Date:** 2026-08-19
**Status:** Approved, ready for implementation planning

## Purpose

Let DeepSeek Harness (DSH) talk to a ChatGPT/Codex subscription account directly, replacing the external CLIProxyAPI binary (`D:\soft\CLIProxyAPI`, v7.2.71).

Two concrete problems motivate this:

1. **An external process to babysit.** CLIProxyAPI is a separate `.exe` with its own config, PID file, start/stop scripts, and upgrade path.
2. **Link flakiness surfaces as hard failures.** The machine reaches `chatgpt.com` only through a Clash proxy at `http://127.0.0.1:7890`, and that link drops connections intermittently. DSH sees `500 ... stream error: stream ID 1; PROTOCOL_ERROR; received from peer` or `EOF`, most visibly on a session's first request.

### Measurement that shaped this design

The failure is **not** payload size and **not** protocol. Measured direct to `chatgpt.com`, bypassing CLIProxyAPI entirely, through the same proxy:

| payload | run 1 | run 2 |
|---|---|---|
| 32KB | fail | fail |
| 64KB | fail | 200 |
| 96KB | 200 | 200 |
| 128KB | 200 | 200 |

Non-monotonic, so it is random TLS/connection failure, not a threshold. An earlier reading of this data as "64KB = the HTTP/2 flow-control window" was a coincidence and is explicitly rejected here.

The corresponding mitigation is proven: setting `streaming.bootstrap-retries: 3` in CLIProxyAPI took an 80KB payload from intermittent failure to 6/6 passes. **This plugin must carry that behavior over** — it is a hard requirement for this environment, not a nicety.

## Scope

**In scope:** a cordis plugin at `D:\dev\dsh-gpt-sub` that authenticates with the user's Codex OAuth credentials, injects the fields the Codex backend requires, routes through the configured proxy, retries transient connection failures before any bytes reach DSH, and serves DSH's native `openai-responses` requests.

**Out of scope:** other providers, model catalog discovery from upstream, usage/quota accounting, a management UI, multi-account routing. CLIProxyAPI has these; nothing here needs them.

## Architecture

Approach **B** (in-process shim) was chosen over **A** (full `LlmAdapter`), with an agreed evolution path from B to A.

```
DSH ──openai-responses──> shim (in-process, 127.0.0.1:8318)
                              │ + "store": false
                              │ + Authorization: Bearer <fresh access_token>
                              │ + chatgpt-account-id / originator
                              │ + undici ProxyAgent(127.0.0.1:7890)
                              │ + retry before first byte
                              ▼
                    chatgpt.com/backend-api/codex/responses
```

**Why B first.** DSH already implements the `openai-responses` protocol. B reuses that implementation wholesale — message construction, SSE parsing, tool calls, and reasoning blocks are all DSH's existing, exercised code. A would require reimplementing every one of those. B's cost is one loopback HTTP hop inside the same process.

**Evolution to A.** Replace the shim with a class extending `LlmAdapter` (exported from `@deepseek-ai/dsh-llm`) registered via `ctx.llm.registerAdapter(routes, adapter)` — the same seam `dsh-llm-pi-ai` uses. `TokenStore` and `Forwarder` carry over unchanged. **The `settings.yaml` provider block does not change**, so the migration is invisible to the user's configuration.

## Components

Each is separately testable and depends only on what its row names.

| Component | Responsibility | Depends on |
|---|---|---|
| `TokenStore` | Read `~/.codex/auth.json`; cache `access_token`; refresh via `refresh_token` before expiry; write back atomically | filesystem |
| `Forwarder` | Inject headers and `store: false`; dispatch through `ProxyAgent`; stream SSE back unaltered; retry before first byte | undici, `TokenStore` |
| `Server` | Loopback-only HTTP listener; accept `POST /v1/responses`; authorize the local caller | node:http, `Forwarder` |
| `Plugin` | cordis entry point; validate config; wire the three together; own lifecycle | cordis |

### TokenStore

Facts established from the live credential file, not assumed:

- `client_id` = `app_EMoamEEZ73f0CkXaXp7hrann`, read from the `aud` claim of `id_token`.
- Issuer = `https://auth.openai.com`, so the refresh endpoint is `https://auth.openai.com/oauth/token`.
- `access_token` is a JWT with a **240-hour (10-day)** lifetime; its `exp` claim is the authority on expiry.
- `id_token` has a 1-hour lifetime and is **already expired** on this machine while `access_token` remains valid. It carries identity claims only. **`id_token` expiry must never be treated as a reason to refresh** — doing so would trigger a refresh on essentially every request.
- `refresh_token` is an opaque 211-character string.
- `account_id` supplies the `chatgpt-account-id` header.

Rules:

- Decode `access_token`'s `exp`; refresh when less than a configurable margin remains (default 30 minutes).
- Refresh is also triggered reactively by a `401` from upstream (see Error handling).
- Write refreshed tokens back to `~/.codex/auth.json` so the Codex CLI shares them, using **write-temp-then-rename** so a concurrent Codex CLI read never observes a partial file.
- Preserve every field of `auth.json` that the plugin does not own; rewrite only the token fields and `last_refresh`.
- Never log token values. Log only expiry timestamps and refresh outcomes.

### Forwarder

- Injects `store: false`. The Codex backend rejects requests without it — verified: `{"detail":"Store must be set to false"}` with HTTP 400. DSH's `openai-responses` path does not send this field, and the provider config's `compat` block cannot add it, so injection here is mandatory rather than a preference.
- Injects `Authorization: Bearer <access_token>`, `chatgpt-account-id`, `originator: codex_cli_rs`, and a per-request `session_id`.
- Dispatches via undici `ProxyAgent` built from `proxyUrl`.
- **Retries before the first byte.** Up to `bootstrapRetries` attempts while nothing has yet been written to the DSH-facing response. Once the first upstream byte has been forwarded, retrying is forbidden — it would duplicate content in the stream. This is the single most important behavior in the plugin for this environment.
- Streams SSE chunks through without buffering the whole body, so time-to-first-token is unaffected.

### Server

- Binds `127.0.0.1` only, never `0.0.0.0`.
- Serves exactly one route, `POST /v1/responses`; everything else returns 404.
- Requires the bearer named by `apiKeyEnv` in the provider profile, so another local process cannot borrow the user's ChatGPT subscription. Loopback binding alone is not access control on a shared machine.

## Configuration

The port is fixed and configurable rather than ephemeral, because `settings.yaml` carries a static `baseURL` that must match it.

```yaml
# ~/.dsh/cordis.patch.yml
- id: gpt-sub
  name: dsh-gpt-sub
  config:
    port: 8318
    proxyUrl: http://127.0.0.1:7890
    authFile: ~/.codex/auth.json
    bootstrapRetries: 3
    refreshMarginMinutes: 30
```

```yaml
# ~/.dsh/settings.yaml
    gpt-sub:
      displayName: CodexSubscription
      api: openai-responses
      baseURL: http://127.0.0.1:8318/v1
      apiKeyEnv: GPT_SUB_LOCAL_KEY
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

`baseURL` includes `/v1` because DSH treats it as a **literal prefix** and appends the route; omitting the segment yields a bodyless 404.

`GPT_SUB_LOCAL_KEY` is a local shared secret between DSH and the shim, unrelated to any upstream credential. The user stores any random string under that name via DSH's credentials service (the web Models page writes it, matching how `CODEX_SUB_API_KEY` is stored today), and the plugin reads the same reference through `ctx.credentials` so the two sides always agree. If the reference is unset, the plugin fails at start naming it rather than serving an unauthenticated port.

## Data flow

1. DSH resolves `GPT_SUB_LOCAL_KEY` through its credential seam (resolved per request, so rotation needs no restart) and POSTs an `openai-responses` body to `http://127.0.0.1:8318/v1/responses`.
2. `Server` authorizes the bearer and hands the parsed body to `Forwarder`.
3. `Forwarder` asks `TokenStore` for a valid `access_token`, refreshing first if inside the margin.
4. `Forwarder` sets `store: false`, adds the auth headers, and dispatches through `ProxyAgent`.
5. On a connection failure with no byte yet forwarded, it retries up to `bootstrapRetries`.
6. Upstream SSE chunks stream back to DSH unaltered.

## Error handling

| Condition | Behavior |
|---|---|
| Connection drop / TLS failure, no byte forwarded | Retry up to `bootstrapRetries`, then surface the last error |
| Connection drop after first byte | Do **not** retry; terminate the stream and let DSH's own retry layer decide |
| Upstream `401` | Force one refresh, retry once, then surface verbatim |
| Upstream `4xx`/`5xx` (non-401) | Forward status and body **unaltered** |
| `auth.json` missing or unparseable | Fail at plugin start with a message naming the path |
| `refresh_token` rejected | Fail with a message telling the user to run `codex` to re-authenticate |
| Configured port busy | Fail at start naming the port |

Upstream errors are never rewrapped. The CLIProxyAPI experience showed a generic `500` hiding the real cause and sending debugging down the wrong path for hours; that failure mode is designed out here.

## Testing

vitest, mirroring the layout of the user's `dsh-agents-rules` plugin.

**Unit**
- `TokenStore`: refresh inside margin; no refresh outside it; **an expired `id_token` alongside a valid `access_token` does not trigger refresh** (the exact state of this machine); atomic write preserves unrelated `auth.json` fields; token values never appear in logs.
- `Forwarder`: `store: false` injected, and overwritten if a caller sent `true`; all four headers present; body otherwise byte-identical.
- `Server`: non-`/v1/responses` routes 404; missing or wrong bearer rejected; bound to loopback.

**Integration** (fake upstream, no network)
- Fails the first N connections, then succeeds → response still arrives, retry invisible to the caller.
- Fails *after* the first byte → no retry, stream terminates.
- `401` then success → exactly one refresh, one retry.
- SSE chunks arrive incrementally, not buffered to completion.

**End-to-end** (real network, run manually)
- One `gpt-5.6-sol` call returning 200.
- One ~80KB payload, repeated, to confirm the flakiness mitigation holds — the same shape of check that validated `bootstrap-retries`.

## Risks

| Risk | Mitigation |
|---|---|
| `refresh_token` is single-use and rotates | Persist the returned `refresh_token` alongside the access token in the same atomic write |
| Codex CLI writes `auth.json` concurrently | Atomic temp+rename; re-read on `401` rather than trusting the cache |
| Upstream changes required headers | Headers live in one module with a test asserting the exact set |
| Proxy remains flaky beyond retry budget | `bootstrapRetries` is configurable; failures surface verbatim rather than silently |

## Success criteria

1. DSH reaches `gpt-5.6-sol`/`terra`/`luna` with CLIProxyAPI stopped.
2. An ~80KB first request succeeds repeatedly, with no `PROTOCOL_ERROR` reaching DSH.
3. Token refresh happens without user action, and a rotated `refresh_token` is persisted.
4. `codex` CLI still works against the same `auth.json` afterward.
5. Moving to approach A later requires no change to `settings.yaml`.
