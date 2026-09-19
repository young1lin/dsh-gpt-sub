/*
 * dsh-gpt-sub — client bundle (browser half). Registers a Codex subscription
 * quota panel as a Settings section. The panel is a renderer only: it polls the
 * host half's GET /gpt-sub/quota and /gpt-sub/status endpoints, and every
 * semantic (which windows count, the upstream throttle, proxy validation, what
 * a stale reading means) lives host-side.
 *
 * Controls use the app's dsh-client-ui-primitives (Button, Input, Pill) so the
 * panel matches the theme in both light and dark; a local fallback keeps the
 * panel usable when the primitives module is absent.
 *
 * Bundle format: a single window.__ModuleLoader__.load handoff; every
 * cross-package value arrives through the injected require (the loader module
 * table).
 */

window.__ModuleLoader__.load({
  id: 'dsh-gpt-sub',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const { useEffect, useState } = React

    // The app design system, when the frontend ships it in the module table.
    let Button, Input, Pill
    try {
      ;({ Button, Input, Pill } = require('@deepseek-ai/dsh-client-ui-primitives'))
    } catch {
      Button = Pill = undefined
    }

    const ENDPOINT = '/gpt-sub/quota'
    const STATUS_ENDPOINT = '/gpt-sub/status'
    const PROXY_ENDPOINT = '/gpt-sub/proxy'
    const PROXY_TEST_ENDPOINT = '/gpt-sub/proxy/test'
    const AUTH_ENDPOINT = '/gpt-sub/auth'
    const AUTH_BROWSE_ENDPOINT = '/gpt-sub/auth/browse'
    const RESET_CREDITS_ENDPOINT = '/gpt-sub/reset-credits'
    const RESET_CREDITS_CONSUME_ENDPOINT = '/gpt-sub/reset-credits/consume'
    const POLL_MS = 60_000

    const css = [
      '.dshGptSub{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.dshGptSubHead{display:flex;align-items:center;gap:8px;margin:0 0 10px}',
      '.dshGptSubPlan{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dshGptSubTrack{position:relative;height:8px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}',
      '.dshGptSubFill{position:absolute;left:0;top:0;bottom:0;border-radius:4px;transition:width .3s}',
      '.dshGptSubMeta{display:flex;justify-content:space-between;margin-top:6px;font-size:12px}',
      // One block per rate-limit window (5-hour rolling, weekly), each with
      // its own label, track, and reset countdown.
      '.dshGptSubWin{margin-top:10px}',
      '.dshGptSubWin+.dshGptSubWin{margin-top:16px}',
      '.dshGptSubWinLabel{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px}',
      '.dshGptSubNote{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dshGptSubBtn{margin-left:auto}',
      '.dshGptSubDiag{margin-top:16px;padding-top:12px;border-top:1px solid var(--dsw-alias-interactive-bg-hover);display:grid;grid-template-columns:max-content 1fr;gap:8px 16px;align-items:center}',
      '.dshGptSubDiagLabel{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-size:12px}',
      '.dshGptSubDiagValue{min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}',
      '.dshGptSubProxyRow{display:flex;gap:8px;align-items:center;min-width:0}',
      '.dshGptSubProxyField{flex:1;min-width:0;display:flex}',
      '.dshGptSubProxyField>span{flex:1}',
      '.dshGptSubProxyMeta{display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      // The credential-file picker: a small host-backed directory browser.
      '.dshGptSubBrowseMask{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}',
      '.dshGptSubBrowse{width:min(560px,92vw);max-height:72vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-interactive-bg-hover);border-radius:12px;color:var(--dsw-alias-label-secondary);box-shadow:0 12px 40px rgba(0,0,0,.25)}',
      '.dshGptSubBrowseHead{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-interactive-bg-hover);font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dshGptSubBrowsePath{padding:8px 16px;font-size:12px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;border-bottom:1px solid var(--dsw-alias-interactive-bg-hover)}',
      '.dshGptSubBrowseList{flex:1;overflow:auto;margin:0;padding:4px 0;list-style:none}',
      '.dshGptSubBrowseRow{display:flex;gap:8px;padding:5px 16px;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary)}',
      '.dshGptSubBrowseRow:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshGptSubBrowseMark{width:1em;text-align:center;flex:none}',
      '.dshGptSubBrowseFoot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-interactive-bg-hover)}',
      // Fallback styling, applied only when the primitives module is absent.
      '.dshGptSubFallbackButton{font-size:12px;background:none;border:1px solid var(--dsw-alias-interactive-bg-hover);border-radius:14px;cursor:pointer;color:var(--dsw-alias-label-secondary);padding:4px 12px;white-space:nowrap}',
      '.dshGptSubFallbackButton:hover{color:var(--dsw-alias-label-primary)}',
      '.dshGptSubFallbackInput{flex:1;min-width:0;font-size:13px;padding:4px 10px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-interactive-bg-hover);border-radius:8px;outline:none}',
      '.dshGptSubFallbackPill{font-size:11px;line-height:18px;padding:0 8px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
    ].join('')

    let styled = false
    /** Inject the panel stylesheet once per page. */
    const ensureStyle = () => {
      if (styled) return
      styled = true
      const tag = document.createElement('style')
      tag.textContent = css
      document.head.appendChild(tag)
    }

    /**
     * Render a small button through the primitives, or a styled native one.
     * @param props - variant, children, and native button attributes.
     * @returns the button element.
     */
    const SmallButton = (props) =>
      Button !== undefined
        ? React.createElement(Button, { size: 'sm', ...props })
        : React.createElement('button', {
            type: 'button',
            className: 'dshGptSubFallbackButton',
            ...props,
          })

    /**
     * Render a pill badge through the primitives, or a styled native span.
     * @param props - children.
     * @returns the badge element.
     */
    const Badge = (props) =>
      Pill !== undefined
        ? React.createElement(Pill, props)
        : React.createElement('span', { className: 'dshGptSubFallbackPill' }, props.children)

    /**
     * Bar colour by remaining share, mirroring the five tiers the sibling
     * quota panel uses so the two read the same way. The bar drains as the
     * window is consumed, so the colour follows what is left: green while
     * plenty remains, red as it runs out.
     * @param percent - percent remaining.
     * @returns a CSS colour.
     */
    const tierColor = (percent) => {
      if (percent >= 80) return '#22c55e'
      if (percent >= 60) return '#16a34a'
      if (percent >= 40) return '#06b6d4'
      if (percent >= 20) return '#eab308'
      return '#ef4444'
    }

    /**
     * Render a remaining duration in compact units, keeping two adjacent
     * components and dropping a trailing zero: days+hours past a day,
     * hours+minutes past an hour, minutes+seconds under one -- '4h22m',
     * '10m22s', '2d5h', '45s', never '4h0m'. Seconds only appear under an
     * hour, where they still change fast enough to read.
     * @param seconds - whole remaining seconds; negative clamps to zero.
     * @returns the compact duration.
     */
    const compactDuration = (seconds) => {
      const safe = Math.max(0, seconds)
      const days = Math.floor(safe / 86400)
      const hours = Math.floor((safe % 86400) / 3600)
      const minutes = Math.floor((safe % 3600) / 60)
      const rest = safe % 60
      if (days > 0) return days + 'd' + (hours > 0 ? hours + 'h' : '')
      if (hours > 0) return hours + 'h' + (minutes > 0 ? minutes + 'm' : '')
      if (minutes > 0) return minutes + 'm' + (rest > 0 ? rest + 's' : '')
      return rest + 's'
    }

    /**
     * Render an epoch-ms timestamp as an exact countdown.
     * @param at - epoch milliseconds.
     * @param now - epoch milliseconds.
     * @returns '4h22m后'-style, '即将' when due, or '' when unknown.
     */
    const countdownFrom = (at, now) => {
      if (!at) return ''
      const seconds = Math.max(0, Math.round((at - now) / 1000))
      if (seconds === 0) return '即将'
      return compactDuration(seconds) + '后'
    }

    /**
     * Name what a countdown counts down to: '4h22m后' + '重置' reads
     * '4h22m后重置', and '即将' becomes '即将重置'.
     * @param base - a countdownFrom result.
     * @param noun - what happens when the countdown ends.
     * @returns the named string, or '' untouched.
     */
    const withNoun = (base, noun) =>
      base === '' ? '' : base === '即将' ? '即将' + noun : base.replace(/后$/, '后' + noun)

    /**
     * Render a reset time as an exact countdown.
     * @param resetAt - epoch seconds.
     * @param now - epoch milliseconds.
     * @returns '4h22m后重置', or an empty string when unknown.
     */
    const countdown = (resetAt, now) => withNoun(countdownFrom(resetAt * 1000, now), '重置')

    // The latest quota reading, plus the subscribers waiting on it.
    let state = { phase: 'loading' }
    const listeners = new Set()
    let polling

    /** The latest status reading, plus its subscribers. */
    let status = undefined
    const statusListeners = new Set()
    let statusPolling

    /**
     * Publish a new quota reading to every mounted panel.
     * @param next - the reading.
     */
    const publish = (next) => {
      state = next
      for (const listener of listeners) listener(next)
    }

    /**
     * Publish a new status reading to every mounted panel.
     * @param next - the status.
     */
    const publishStatus = (next) => {
      status = next
      for (const listener of statusListeners) listener(next)
    }

    /**
     * Poll the quota endpoint.
     * @param force - ask the host to bypass its throttle.
     * @returns the in-flight poll.
     */
    const poll = (force) => {
      polling ??= (async () => {
        try {
          const response = await fetch(ENDPOINT + (force ? '?refresh=1' : ''), { cache: 'no-store' })
          if (!response.ok) throw new Error('endpoint answered ' + response.status)
          publish(await response.json())
        } catch (error) {
          publish({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
        }
      })().finally(() => {
        polling = undefined
      })
      return polling
    }

    /**
     * Poll the status endpoint.
     * @returns the in-flight poll.
     */
    const pollStatus = () => {
      statusPolling ??= (async () => {
        try {
          const response = await fetch(STATUS_ENDPOINT, { cache: 'no-store' })
          if (!response.ok) throw new Error('endpoint answered ' + response.status)
          publishStatus(await response.json())
        } catch (error) {
          publishStatus({ error: error instanceof Error ? error.message : String(error) })
        }
      })().finally(() => {
        statusPolling = undefined
      })
      return statusPolling
    }

    /**
     * POST JSON to a host endpoint.
     * @param url - the endpoint.
     * @param body - the JSON body.
     * @returns the parsed reply.
     */
    const postJson = async (url, body) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.message || 'endpoint answered ' + response.status)
      return payload
    }

    /** Short fixed strings, kept out of the render body. */
    const STR = {
      authSource: 'Auth 来源',
      nextRefresh: '自动刷新',
      proxy: 'HTTP 代理',
      direct: '直连',
      test: '测试连接',
      save: '保存',
      saved: '已保存并生效，重启后仍使用该代理',
      testing: '测试中…',
      saving: '保存中…',
      marginNote: (margin, sync) => 'Token 剩余不足 ' + margin + ' 分钟时自动刷新；每 ' + sync + ' 分钟定期同步',
      unknown: '未知（Token 无有效 exp）',
      configOnly: '来自配置',
      overridden: '页面设置',
      ok: (ms) => '连接正常 · ' + ms + 'ms',
      fail: '连接失败',
      authFileLabel: 'Auth 文件',
      authPlaceholder: '~/.codex/auth.json',
      authSaved: '已保存并生效，重启后仍使用该路径',
      authResetHint: '清空并保存恢复配置默认',
      authUnpublished: '已切换，但 Token 发布失败，将在下个同步周期自动重试',
      browse: '浏览…',
      browseTitle: '选择 auth 文件',
      cancel: '取消',
      upLabel: '..',
      truncatedNote: '条目过多，仅显示部分',
      browseFail: '无法读取目录',
      noFiveHour: '当前账号无 5 小时限额，仅按周限额计',
      noWindows: '上游未报告任何限额窗口',
      resetsLeft: (count) => '还有 ' + count + ' 次重置',
      resetCredits: '重置次数',
      rcLoad: '查询重置次数',
      rcLoading: '查询中…',
      rcAvailable: (n) => '可用 ' + n + ' 次',
      rcEmpty: '当前没有可用的重置次数',
      rcUse: '使用并重置',
      rcUsing: '使用中…',
      rcConfirm: (title) => '确定使用这个重置次数吗？将立即重置配额窗口：' + (title || '未命名'),
      rcConsumeFail: '使用失败',
      rcOutcomes: {
        reset: (n) => '✓ 已重置（' + n + ' 个窗口）',
        nothing_to_reset: '✗ 当前没有可重置的窗口',
        no_credit: '✗ 没有可用的重置次数',
        already_redeemed: '✗ 该次数已被使用过',
      },
      rcStatus: { available: '可用', redeeming: '兑换中', redeemed: '已使用', unknown: '未知' },
      rcExpires: (text) => '（' + text + ' 前有效）',
    }

    /**
     * The proxy control block: current URL, editable, with test and save.
     * @returns the rendered block.
     */
    const ProxyControl = () => {
      const current = status && status.proxyUrl !== undefined ? status.proxyUrl : ''
      const [draft, setDraft] = useState(current)
      const [dirty, setDirty] = useState(false)
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      const [result, setResult] = useState(undefined)

      // Follow host-side changes (poll) until the user edits the field.
      useEffect(() => {
        if (!dirty) setDraft(current)
      }, [current, dirty])

      /**
       * Probe the candidate URL currently in the input.
       * @returns nothing.
       */
      const onTest = async () => {
        setBusy('test')
        setNote('')
        setResult(undefined)
        try {
          const probed = await postJson(PROXY_TEST_ENDPOINT, { proxyUrl: draft.trim() })
          setResult(probed)
          if (!probed.ok) setNote('✗ ' + (probed.message || STR.fail))
        } catch (error) {
          setNote('✗ ' + (error instanceof Error ? error.message : String(error)))
        } finally {
          setBusy('')
        }
      }

      /**
       * Persist and apply the candidate URL currently in the input.
       * @returns nothing.
       */
      const onSave = async () => {
        setBusy('save')
        setNote('')
        setResult(undefined)
        try {
          await postJson(PROXY_ENDPOINT, { proxyUrl: draft.trim() })
          setDirty(false)
          setNote(STR.saved)
          await Promise.all([pollStatus(), poll(false)])
        } catch (error) {
          setNote('✗ ' + (error instanceof Error ? error.message : String(error)))
        } finally {
          setBusy('')
        }
      }

      const okPill =
        result && result.ok
          ? React.createElement(Badge, null, '✓ ' + STR.ok(result.latencyMs))
          : null
      const failPill =
        result && !result.ok
          ? React.createElement(Badge, null, '✗ ' + STR.fail)
          : null

      const inputProps = {
        value: draft,
        placeholder: 'http://127.0.0.1:7890，留空表示直连',
        spellCheck: false,
        disabled: busy !== '',
        onChange: (event) => {
          setDirty(true)
          setDraft(event.target.value)
        },
      }

      return React.createElement(
        'div',
        null,
        React.createElement(
          'div',
          { className: 'dshGptSubProxyRow' },
          React.createElement(
            'div',
            { className: 'dshGptSubProxyField' },
            Input !== undefined
              ? React.createElement(Input, inputProps)
              : React.createElement('input', { className: 'dshGptSubFallbackInput', ...inputProps }),
          ),
          React.createElement(
            SmallButton,
            { variant: 'outline', disabled: busy !== '', onClick: onTest },
            busy === 'test' ? STR.testing : STR.test,
          ),
          React.createElement(
            SmallButton,
            { variant: 'primary', disabled: busy !== '', onClick: onSave },
            busy === 'save' ? STR.saving : STR.save,
          ),
        ),
        React.createElement(
          'div',
          { className: 'dshGptSubProxyMeta' },
          React.createElement(Badge, null, current === '' ? STR.direct : current),
          React.createElement(Badge, null, status && status.overridden ? STR.overridden : STR.configOnly),
          okPill,
          failPill,
        ),
        note ? React.createElement('div', { className: 'dshGptSubNote' }, note) : null,
      )
    }

    /**
     * The credential-file control block: an editable path, a browse dialog
     * backed by the host's read-only directory listing, and save. The host
     * validates a candidate against the real file before anything is
     * persisted or applied; saving the empty string restores the configured
     * default. A browser cannot hand back absolute paths from its native
     * picker, which is why browsing runs through the host instead.
     * @returns the rendered block.
     */
    const AuthControl = () => {
      const current = status && status.authFile !== undefined ? status.authFile : ''
      const [draft, setDraft] = useState(current)
      const [dirty, setDirty] = useState(false)
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      const [browse, setBrowse] = useState(undefined)

      // Follow host-side changes (poll) until the user edits the field.
      useEffect(() => {
        if (!dirty) setDraft(current)
      }, [current, dirty])

      /**
       * Validate, persist, and apply the path currently in the input.
       * @returns nothing.
       */
      const onSave = async () => {
        setBusy(true)
        setNote('')
        try {
          const payload = await postJson(AUTH_ENDPOINT, { authFile: draft.trim() })
          setDirty(false)
          setNote(payload.published === false ? STR.authUnpublished : STR.authSaved)
          await pollStatus()
        } catch (error) {
          setNote('✗ ' + (error instanceof Error ? error.message : String(error)))
        } finally {
          setBusy(false)
        }
      }

      /**
       * List one directory through the host, defaulting to the home directory.
       * @param path - the directory to list; empty means home.
       * @returns nothing; failures surface as the note under the input.
       */
      const openBrowserAt = async (path) => {
        setNote('')
        try {
          const query = path ? '?path=' + encodeURIComponent(path) : ''
          const response = await fetch(AUTH_BROWSE_ENDPOINT + query, { cache: 'no-store' })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || !payload.ok) throw new Error(payload.message || STR.browseFail)
          setBrowse(payload)
        } catch (error) {
          setNote('✗ ' + (error instanceof Error ? error.message : String(error)))
        }
      }

      /**
       * Put a picked file's path into the input without saving yet.
       * @param path - the picked file's absolute path.
       * @returns nothing.
       */
      const pick = (path) => {
        setDirty(true)
        setDraft(path)
        setBrowse(undefined)
      }

      const inputProps = {
        value: draft,
        placeholder: STR.authPlaceholder,
        spellCheck: false,
        disabled: busy,
        onChange: (event) => {
          setDirty(true)
          setDraft(event.target.value)
        },
      }

      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'div',
          null,
          React.createElement(
            'div',
            { className: 'dshGptSubProxyRow' },
            React.createElement(
              'div',
              { className: 'dshGptSubProxyField' },
              Input !== undefined
                ? React.createElement(Input, inputProps)
                : React.createElement('input', { className: 'dshGptSubFallbackInput', ...inputProps }),
            ),
            React.createElement(
              SmallButton,
              { variant: 'outline', disabled: busy, onClick: () => void openBrowserAt('') },
              STR.browse,
            ),
            React.createElement(
              SmallButton,
              { variant: 'primary', disabled: busy, onClick: onSave },
              busy ? STR.saving : STR.save,
            ),
          ),
          React.createElement(
            'div',
            { className: 'dshGptSubProxyMeta' },
            React.createElement(Badge, null, status && status.authOverridden ? STR.overridden : STR.configOnly),
            React.createElement('span', null, STR.authResetHint),
          ),
          note ? React.createElement('div', { className: 'dshGptSubNote' }, note) : null,
        ),
        browse === undefined
          ? null
          : React.createElement(
              'div',
              { className: 'dshGptSubBrowseMask', onClick: () => setBrowse(undefined) },
              React.createElement(
                'div',
                { className: 'dshGptSubBrowse', onClick: (event) => event.stopPropagation() },
                React.createElement('div', { className: 'dshGptSubBrowseHead' }, STR.browseTitle),
                React.createElement('div', { className: 'dshGptSubBrowsePath' }, browse.dir),
                React.createElement(
                  'ul',
                  { className: 'dshGptSubBrowseList' },
                  browse.parent
                    ? React.createElement(
                        'li',
                        {
                          key: '..',
                          className: 'dshGptSubBrowseRow',
                          onClick: () => void openBrowserAt(browse.parent),
                        },
                        React.createElement('span', { className: 'dshGptSubBrowseMark' }, '↰'),
                        STR.upLabel,
                      )
                    : null,
                  browse.entries.map((entry) =>
                    React.createElement(
                      'li',
                      {
                        key: entry.path,
                        className: 'dshGptSubBrowseRow',
                        title: entry.path,
                        onClick: () => (entry.dir ? void openBrowserAt(entry.path) : pick(entry.path)),
                      },
                      React.createElement('span', { className: 'dshGptSubBrowseMark' }, entry.dir ? '▸' : '·'),
                      entry.name,
                    ),
                  ),
                ),
                React.createElement(
                  'div',
                  { className: 'dshGptSubBrowseFoot' },
                  browse.truncated
                    ? React.createElement('span', { className: 'dshGptSubNote' }, STR.truncatedNote)
                    : null,
                  React.createElement(
                    SmallButton,
                    { variant: 'outline', onClick: () => setBrowse(undefined) },
                    STR.cancel,
                  ),
                ),
              ),
            ),
      )
    }

    /**
     * The rate-limit reset credits block: lists the account's redeemable
     * credits on demand, and consumes one after an explicit confirmation.
     * Consuming is destructive, so nothing here fires without a click.
     * @returns the rendered block.
     */
    const ResetCreditsControl = () => {
      const [details, setDetails] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [consumingId, setConsumingId] = useState('')
      const [note, setNote] = useState('')

      /**
       * Fetch the credit list from the host.
       * @returns nothing; failures surface as the note.
       */
      const load = async () => {
        setBusy(true)
        setNote('')
        try {
          const response = await fetch(RESET_CREDITS_ENDPOINT, { cache: 'no-store' })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || !payload.ok) throw new Error(payload.message || 'endpoint answered ' + response.status)
          setDetails(payload)
        } catch (error) {
          setNote('✗ ' + (error instanceof Error ? error.message : String(error)))
        } finally {
          setBusy(false)
        }
      }

      // Load once on mount; later reads happen through the visible button.
      useEffect(() => {
        void load()
      }, [])

      /**
       * Consume one credit after a confirmation dialog, then refresh both the
       * credit list and the quota reading.
       * @param credit - the credit to consume; null means "any available".
       * @returns nothing.
       */
      const consume = async (credit) => {
        const title = credit ? credit.title || credit.id : ''
        if (!window.confirm(STR.rcConfirm(title))) return
        setConsumingId(credit ? credit.id : '*')
        setNote('')
        try {
          const payload = await postJson(RESET_CREDITS_CONSUME_ENDPOINT, {
            ...(credit ? { creditId: credit.id } : {}),
          })
          const outcome = STR.rcOutcomes[payload.code]
          setNote(outcome ? outcome(payload.windows_reset || 0) : payload.code)
          await Promise.all([load(), poll(false)])
        } catch (error) {
          setNote('✗ ' + STR.rcConsumeFail + '：' + (error instanceof Error ? error.message : String(error)))
        } finally {
          setConsumingId('')
        }
      }

      if (details === undefined) {
        return React.createElement(
          'div',
          { className: 'dshGptSubProxyMeta' },
          React.createElement(
            SmallButton,
            { variant: 'outline', disabled: busy, onClick: () => void load() },
            busy ? STR.rcLoading : STR.rcLoad,
          ),
          note ? React.createElement('span', null, note) : null,
        )
      }

      const available = details.credits.filter((credit) => credit.status === 'available')
      return React.createElement(
        'div',
        null,
        React.createElement(
          'div',
          { className: 'dshGptSubProxyMeta' },
          React.createElement(Badge, null, STR.rcAvailable(details.available_count)),
          React.createElement(
            SmallButton,
            { variant: 'ghost', disabled: busy, onClick: () => void load() },
            busy ? STR.rcLoading : '刷新',
          ),
        ),
        available.length === 0
          ? React.createElement('div', { className: 'dshGptSubNote' }, STR.rcEmpty)
          : React.createElement(
              'div',
              null,
              available.map((credit) =>
                React.createElement(
                  'div',
                  { key: credit.id, className: 'dshGptSubProxyMeta' },
                  React.createElement(
                    'span',
                    null,
                    (credit.title || credit.id) +
                      ' · ' +
                      (STR.rcStatus[credit.status] || credit.status) +
                      (credit.expires_at
                        ? STR.rcExpires(new Date(credit.expires_at).toLocaleString())
                        : ''),
                  ),
                  React.createElement(
                    SmallButton,
                    {
                      variant: 'outline',
                      disabled: busy || consumingId !== '',
                      onClick: () => void consume(credit),
                    },
                    consumingId === credit.id ? STR.rcUsing : STR.rcUse,
                  ),
                ),
              ),
            ),
        note ? React.createElement('div', { className: 'dshGptSubNote' }, note) : null,
      )
    }

    /**
     * The Settings section body.
     * @returns the rendered panel.
     */
    const QuotaSection = () => {
      ensureStyle()
      const [reading, setReading] = useState(state)
      const [stat, setStat] = useState(status)
      const [now, setNow] = useState(() => Date.now())

      useEffect(() => {
        listeners.add(setReading)
        statusListeners.add(setStat)
        const clock = setInterval(() => { setNow(Date.now()) }, 30_000)
        return () => {
          listeners.delete(setReading)
          statusListeners.delete(setStat)
          clearInterval(clock)
        }
      }, [])

      if (reading.phase === 'loading') {
        return React.createElement('div', { className: 'dshGptSub' }, '读取中…')
      }
      if (reading.phase === 'error') {
        return React.createElement(
          'div',
          { className: 'dshGptSub' },
          React.createElement('div', { className: 'dshGptSubNote' }, '无法读取配额：' + (reading.message || '未知错误')),
          React.createElement(
            'div',
            { className: 'dshGptSubBtn' },
            React.createElement(SmallButton, { variant: 'outline', onClick: () => poll(true) }, '重试'),
          ),
        )
      }

      /**
       * Label a window by its length: '5 小时窗口', '7 天窗口'.
       * @param hours - the window's length in hours.
       * @returns the label.
       */
      const windowLabel = (hours) => (hours >= 24 ? Math.round(hours / 24) + ' 天窗口' : hours + ' 小时窗口')

      /**
       * One window's block: label, a track of the percent REMAINING, and the
       * reset countdown. Codex-style -- the bar starts full at 100% and drains
       * toward 0% as the allowance is spent, so its length is what is left.
       * @param label - the window label.
       * @param window - the window reading from the host.
       * @returns the rendered block.
       */
      const WindowBlock = (label, window) => {
        const used = typeof window.usedPercent === 'number' ? window.usedPercent : 0
        const remaining = Math.min(100, Math.max(0, 100 - used))
        return React.createElement(
          'div',
          { className: 'dshGptSubWin' },
          React.createElement('div', { className: 'dshGptSubWinLabel' }, label),
          React.createElement(
            'div',
            { className: 'dshGptSubTrack' },
            React.createElement('div', {
              className: 'dshGptSubFill',
              style: { width: remaining + '%', background: tierColor(remaining) },
            }),
          ),
          React.createElement(
            'div',
            { className: 'dshGptSubMeta' },
            React.createElement('span', null, '剩余 ' + remaining + '%'),
            React.createElement('span', null, countdown(window.resetAt, now)),
          ),
        )
      }

      const refreshLabel = stat
        ? stat.refreshAt
          ? countdownFrom(stat.refreshAt, now) + '（' + STR.marginNote(stat.refreshMarginMinutes, stat.syncIntervalMinutes) + '）'
          : STR.unknown
        : ''
      const authLabel = stat ? stat.authFile || '' : ''
      const tokenExpiryLabel = stat && stat.tokenExpiresAt ? withNoun(countdownFrom(stat.tokenExpiresAt, now), '过期') : ''

      return React.createElement(
        'div',
        { className: 'dshGptSub' },
        React.createElement(
          'div',
          { className: 'dshGptSubHead' },
          React.createElement('span', { className: 'dshGptSubPlan' }, 'ChatGPT ' + (reading.plan || '')),
          // The on-demand usage resets the account can still spend to clear
          // a capped window without waiting out its timer.
          reading.resetsRemaining !== undefined
            ? React.createElement(Badge, null, STR.resetsLeft(reading.resetsRemaining))
            : null,
          React.createElement(
            'span',
            { className: 'dshGptSubBtn' },
            React.createElement(SmallButton, { variant: 'ghost', onClick: () => poll(true) }, '刷新'),
          ),
        ),
        // The 5-hour rolling window first -- it is the one that bites first --
        // then the weekly one. An account without a 5-hour limit (pro
        // currently) gets a note where its bar would be, not an empty bar.
        reading.fiveHour !== undefined
          ? WindowBlock(windowLabel(reading.fiveHour.windowHours), reading.fiveHour)
          : reading.weekly !== undefined
            ? React.createElement('div', { className: 'dshGptSubNote' }, STR.noFiveHour)
            : null,
        reading.weekly !== undefined ? WindowBlock(windowLabel(reading.weekly.windowHours), reading.weekly) : null,
        reading.fiveHour === undefined && reading.weekly === undefined
          ? React.createElement('div', { className: 'dshGptSubNote' }, STR.noWindows)
          : null,
        reading.stale
          ? React.createElement('div', { className: 'dshGptSubNote' }, '数据可能已过期：' + (reading.message || ''))
          : null,
        React.createElement(
          'div',
          { className: 'dshGptSubDiag' },
          React.createElement('span', { className: 'dshGptSubDiagLabel' }, STR.authSource),
          React.createElement(
            'span',
            { className: 'dshGptSubDiagValue' },
            authLabel + (tokenExpiryLabel ? ' · Access Token ' + tokenExpiryLabel : ''),
          ),
          React.createElement('span', { className: 'dshGptSubDiagLabel' }, STR.authFileLabel),
          React.createElement(
            'span',
            { className: 'dshGptSubDiagValue' },
            React.createElement(AuthControl, null),
          ),
          React.createElement('span', { className: 'dshGptSubDiagLabel' }, STR.nextRefresh),
          React.createElement('span', { className: 'dshGptSubDiagValue' }, refreshLabel),
          React.createElement('span', { className: 'dshGptSubDiagLabel' }, STR.proxy),
          React.createElement('span', { className: 'dshGptSubDiagValue' }, React.createElement(ProxyControl, null)),
          React.createElement('span', { className: 'dshGptSubDiagLabel' }, STR.resetCredits),
          React.createElement('span', { className: 'dshGptSubDiagValue' }, React.createElement(ResetCreditsControl, null)),
        ),
      )
    }

    /** Required services: the slot registry the panel registers into. */
    exports.inject = ['slots']

    /**
     * Client plugin body: poll while the page is visible, and register the
     * panel as a Settings section.
     * @param ctx - client root context.
     */
    exports.apply = function apply(ctx) {
      ctx.effect(() => {
        void poll(false)
        void pollStatus()
        const timer = setInterval(() => {
          if (document.visibilityState !== 'hidden') {
            void poll(false)
            void pollStatus()
          }
        }, POLL_MS)
        const onVisibility = () => {
          if (document.visibilityState === 'visible') {
            void poll(false)
            void pollStatus()
          }
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, 'gpt-sub: quota poll')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'gpt-sub-quota',
        order: 20,
        label: () => 'Codex 配额',
        inject: () => ({}),
      }, QuotaSection))
    }

    return module.exports
  },
})
