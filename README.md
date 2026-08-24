# dsh-gpt-sub

Direct ChatGPT/Codex subscription access for DeepSeek Harness (DSH).

This plugin replaces the external CLIProxyAPI binary. Instead of running a separate `.exe`
with its own config, PID file, and upgrade path, it starts an in-process loopback shim that
speaks DSH's native `openai-responses` protocol and forwards to the Codex backend with the
right credentials, headers, and proxy.

```
DSH --openai-responses--> shim (in-process, 127.0.0.1:8318)
                              | + "store": false
                              | + Authorization: Bearer <fresh access_token>
                              | + chatgpt-account-id / originator
                              | + undici ProxyAgent
                              | + retry before the first byte
                              v
                    chatgpt.com/backend-api/codex/responses
```

Tokens come from `~/.codex/auth.json` — the same file the `codex` CLI uses. Refreshed
tokens are written back atomically (temp file + rename), so the CLI keeps working and never
observes a partial file.

## Setup

### 1. Mount the plugin

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

The bundle ships its own `cordis.patch.yml`, which inserts the `gpt-sub` row with its
default config. You do not need to add anything to `~/.dsh/cordis.patch.yml`.

To override a setting, patch the row by id from a later layer — note that a patch
**replaces the whole `config` block**, so restate every field you want to keep:

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

A patch row with **no** `insert:` key edits an existing row. If you write one for an id that
does not exist yet, the loader warns and skips it — the plugin then silently never mounts.
Creating a row requires the `- insert:` form, which is what the shipped bundle patch uses.

### 2. Store the local shared key

`GPT_SUB_LOCAL_KEY` is a shared secret between DSH and the shim, unrelated to any upstream
credential. It exists because loopback binding alone is not access control on a shared
machine — without it, any local process could borrow your ChatGPT subscription.

```yaml
# ~/.dsh/.credentials.yaml
GPT_SUB_LOCAL_KEY: dsh-gpt-sub-local-<any random string>
```

If the reference is unset, the plugin fails at start naming it rather than serving an
unauthenticated port.

### 3. Declare the provider

```yaml
# ~/.dsh/settings.yaml
llm-pi-ai:
  providers:
    gpt-sub:
      displayName: CodexSubscription (direct)
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

`baseURL` **must** keep the `/v1` segment. DSH treats it as a literal prefix and appends the
route, so dropping it produces a bodyless 404 that is easy to misdiagnose.

`port` in the plugin config and the port in `baseURL` must match. The port is fixed rather
than ephemeral precisely because `settings.yaml` carries a static `baseURL`.

## Configuration reference

| Option | Default | Meaning |
|---|---|---|
| `port` | `8318` | Loopback port for the shim. Must match `baseURL`. |
| `proxyUrl` | `http://127.0.0.1:7890` | Proxy for reaching `chatgpt.com`. Empty string means direct. |
| `authFile` | `~/.codex/auth.json` | Codex CLI credential file, shared with the `codex` command. |
| `bootstrapRetries` | `3` | Attempts allowed while nothing has reached the client yet. |
| `refreshMarginMinutes` | `30` | Refresh the access token when less than this many minutes remain. |
| `syncIntervalMinutes` | `10` | How often to re-read auth.json and republish the token. |
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

`bootstrapRetries` retries the upstream call **before the first byte reaches DSH**, so the
drop never surfaces. Once the first upstream byte has been forwarded, retrying is
forbidden — it would duplicate content in the stream. A drop after that point terminates the
stream and lets DSH's own retry layer decide.

If your network is reliable, this setting costs nothing.

## Operations

**Rotating the local key.** Change `GPT_SUB_LOCAL_KEY` in `~/.dsh/.credentials.yaml`. The
plugin resolves the credential per request, so no restart is needed — DSH and the shim always
read the same reference and therefore always agree.

**`refresh_token` rejected.** The refresh token is single-use and rotates on every refresh.
If it is rejected, the plugin fails with guidance to re-authenticate: run `codex` and sign in
again. That rewrites `~/.codex/auth.json`, which the plugin picks up.

**Upstream errors are never rewrapped.** A non-401 `4xx`/`5xx` is forwarded with its status
and body unaltered. This is deliberate: a generic `500` hiding the real cause once sent
debugging down the wrong path for hours.

## Settings panel diagnostics

The `Codex 配额` settings section does more than render the usage bar. Below it the
panel shows:

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

Host endpoints behind the panel: `GET /gpt-sub/status`, `POST /gpt-sub/proxy`
(`{ "proxyUrl": "..." }`), `POST /gpt-sub/proxy/test` (same body; probes the
value without applying it), `POST /gpt-sub/auth`
(`{ "authFile": "..." }`; empty clears the page override), and the read-only
`GET /gpt-sub/auth/browse?path=...` directory listing behind the file picker
(empty path means the home directory).

## Known limitations

- **No model listing.** The shim serves exactly one route, `POST /v1/responses`; everything
  else returns 404, including `GET /v1/models`. Model discovery from upstream is out of
  scope — declare models statically in `settings.yaml` as shown above. Normal chat never
  touches the listing endpoint, but the Models page's "discover models" probe will report a
  failure for this provider.
- **Single account.** No multi-account routing, usage/quota accounting, or management UI.
  CLIProxyAPI has these; nothing here needs them.

## Development

```bash
pnpm build       # tsc -> lib/ (src only)
pnpm typecheck   # tsc -p tsconfig.test.json (src + tests, noEmit)
pnpm test        # vitest
```

`Forwarder` requires an injected `requestImpl` rather than defaulting to undici's `request`,
so unit tests never touch the network; the plugin supplies the real one at startup.

## Future direction

The shim is approach **B**. Approach **A** replaces it with a class extending `LlmAdapter`
registered through `ctx.llm.registerAdapter(routes, adapter)`, removing the loopback hop.
`TokenStore` and `Forwarder` carry over unchanged, and the `settings.yaml` provider block
does not change — so that migration is invisible to user configuration.