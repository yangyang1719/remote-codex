# Telegram 账号服务

Telegram 接入基于 Telethon 1.45.0，在远程服务器运行独立 Python worker，通过现有消息网关与 Mac 通信。当前完成本地实现、离线验证和隔离环境的二维码生成测试；尚未完成真实账号扫码确认、收发及正式部署验收。

## 部署准备

在服务器上的独立虚拟环境安装 `telegram/requirements.txt`。在现有网关配置的 `providers` 数组中增加一个 Telegram 项，不替换 WhatsApp 配置：

```json
{
  "id": "telegram-main",
  "platform": "telegram",
  "command": ["/absolute/path/to/venv/bin/python", "-u", "/absolute/path/to/remote-codex/telegram/worker.py"],
  "ignoredConversationIds": [],
  "environment": {
    "TELEGRAM_API_ID": "YOUR_OFFICIAL_API_ID",
    "TELEGRAM_API_HASH": "YOUR_OFFICIAL_API_HASH",
    "TELEGRAM_DATA_DIR": "/private/account/data/telegram-main"
  }
}
```

路径与占位值必须换成实际配置。应用凭据在 https://my.telegram.org 的 API development tools 获取；不要复用其他客户端的凭据。当前桌面登录入口仅支持一个 Telegram provider；网关整体仍可同时运行 WhatsApp。每个 Telegram session 只启动一个 worker，可用 `flock` 保护。

网关配置、账号目录应限制为当前服务用户可访问，目录 0700、文件 0600。worker 使用私有 umask 创建 session、名单及媒体。不要把 `.session` 或配置文件放入公开仓库。session 包含登录密钥，默认 SQLite 不额外加密；Mac 不接收 session。

## 登录

消息栏的“Telegram 登录与忽略名单”入口支持生成二维码、手机号获取验证码、提交验证码，以及必要时输入两步验证密码。二维码过期后手动重新生成。设置 `TELEGRAM_AUTH_ONLY=1` 可仅测试登录，关闭消息发布和历史同步。验证码由 Telegram 决定投递渠道，不保证短信。

验证码、密码只随本次请求通过 SSH 传输，不存为本地草稿或服务日志。登录 session 保留远程；关闭窗口不会退出账号。需要撤销授权时，可在手机 Telegram 的设备列表终止该会话。UI 当前没有退出账号或多账号切换操作。

`GET /telegram/auth` 返回状态与忽略名单；`POST /telegram/auth` 接收 `method` 和 `params`，仅允许桌面来源，MCP 无权操作登录或名单。此来源限制沿用现有网关的单用户信任边界，不是独立身份认证。

## 同步与忽略

- 正常聊天后台接收新消息和编辑；启动时每个聊天最多拉取最近 50 条历史，不下载媒体。断线更新使用 Telethon 补更新机制，不能保证补齐任意时长的离线历史。
- 在桌面输入聊天 ID（每行一个）保存名单，立即生效并保存在远程 `ignored.json`；窗口列出已知聊天的名称与 ID。
- 未设置持久名单时，使用 provider 的 `ignoredConversationIds` 作为初始值。保存之后以 `ignored.json` 为准，重启不会被初始配置覆盖。
- worker 在正文发布、历史拉取和媒体下载前检查名单，网关再次过滤。已有消息及已缓存媒体保留；已缓存媒体仍可查看，手动发送仍允许。
- 移出名单时保存恢复时间，过滤忽略期间的旧消息，恢复后续同步。不是“打开时同步”，切换界面不改变订阅。
- 忽略不表示取消 Telegram 底层更新、实体缓存或网络流量。聊天 ID、名称等仍可能存在 Telethon session 的实体缓存中。

## 媒体、删除与限制

收取图片、视频、音频和文件时只保存描述，用户打开时再下载，单个媒体上限 25 MB。发送附件目前统一按文件发送，不做相册或原生语音录制。

有聊天定位信息的删除事件更新已存消息；Telegram 的部分私聊删除事件缺少聊天 ID，worker 不跨聊天猜测，因而不能保证所有删除状态完整同步。暂不支持秘密聊天、话题线程专用界面、反应、投票等完整客户端功能。

发送仍使用网关幂等键，文字发送把同一键映射到 Telegram `random_id`。发送结果未知不会由网关自动重发。附件走 Telethon 文件发送接口，断线后的结果仍需人工核查。

## 离线检查

```sh
python -m unittest discover -s telegram
python -m unittest discover -s gateway
swift build
```

Telegram 测试需要上述依赖；所有账号请求均使用替身，不申请验证码、不扫码登录、不发送真实消息。真实网络、登录及收发须另外验收。
