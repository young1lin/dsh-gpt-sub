# 更新日志

记录用户可感知的变化；格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。
版本号见 `package.json`。

## [0.1.0] - 2026-09-20

### 新增

- 首个发布：ChatGPT/Codex 订阅直连 DeepSeek Harness（DSH），替代 CLIProxyAPI —— 无回环端口、无共享本地密钥、无外部代理二进制；`codex` CLI 仍持有登录态。
- 从 `~/.codex/auth.json` 读取 access token，到期前自动刷新（单次 refresh_token 随每次刷新轮换、原子写回，`codex` CLI 不受影响）；refresh_token 被拒绝时给出重新 `codex` 登录的明确指引。
- 以 `CODEX_NATIVE_TOKEN` 凭据引用持续发布令牌（默认每 10 分钟同步一次），pi-ai 的 `openai-codex` 路由始终读到活令牌。
- 自带 `cordis.patch.yml` 双行补丁：插入 `gpt-sub` 插件行 + 编辑 dsh-base 的 `llm-pi-ai` 行播种 `openai-codex` 路由（随 pi-ai 目录走 `gpt-5.6-sol/terra/luna`），安装即用、零用户配置。
- 进程级 undici dispatcher 按主机名分流：`chatgpt.com` / `auth.openai.com` / `api.openai.com` 走配置代理（默认 `http://127.0.0.1:7890`，可空为直连），其余流量不受影响；仅对连接级失败重试（`bootstrapRetries`，默认 3），上游 HTTP 错误原样透传、绝不重放。
- 「Codex 配额」设置面板：5 小时 / 周窗口的剩余量进度条与精确重置倒计时（`4h22m后重置` 式）、按需用量重置次数徽章与消费入口（先确认后消费）、Auth 文件与 HTTP 代理在线切换（候选先验证再应用、持久化到 `stateFile`、测试连接探测、宿主只读目录选择器）。
- 宿主端点：`GET /gpt-sub/quota`、`GET /gpt-sub/status`、`GET /gpt-sub/reset-credits`、`POST /gpt-sub/reset-credits/consume`、`POST /gpt-sub/proxy`、`POST /gpt-sub/proxy/test`、`POST /gpt-sub/auth`、`GET /gpt-sub/auth/browse`。
