# WhatsApp 独立消息服务

网关和 WhatsApp worker 运行于远端。网关负责消息目录、SQLite、媒体和路由，worker 独占账号连接。Mac 通过 SSH 隧道访问，Codex 通过 stdio MCP 按需操作同一服务。

## 部署配置

需要 Linux、Python 3.12+、Node.js 20+ 和 `flock`。先在 `whatsapp/` 执行 `npm ci` 安装锁定依赖，再按实际环境设置网关配置文件和服务管理器。当前没有通用一键安装器。

网关入口支持显式指定数据目录、配置文件和端口：

```sh
python3 gateway/server.py --state "$HOME/.local/state/remote-codex" --config /path/to/whatsapp-service.json --port 18765
```

`/path/to/whatsapp-service.json` 是需要自行创建的配置文件，不是仓库自带配置。`providers` 为账号列表，每项包含 `id`、`platform`、`command` 和可选 `environment`。`command` 为实际 worker 的参数数组，不经 Shell 展开；路径需是有效绝对路径。

| 配置 | 用途 |
| --- | --- |
| `WHATSAPP_PR_NOTIFIER_DATA_DIR` | 账号数据根目录，其下 `auth/` 保存凭据 |
| `WHATSAPP_MEDIA_DIR` | 媒体缓存目录 |
| `WHATSAPP_SERVICE_AUTOCONNECT` | 是否在启动时连接已有 session |
| `REMOTE_CODEX_GATEWAY_URL` | MCP 访问的网关 URL，默认回环端口 18765 |
| `REMOTE_CODEX_MCP_SCRIPT` | 可选的 MCP 脚本绝对路径 |

为 worker 使用 `flock` 或等价单实例保护，确保旧插件和新服务不同时打开同一 session。新账号从桌面扫码或电话号码关联；迁移已有 session 前须自行备份并协调旧连接退出。凭据、数据库和媒体应位于源码目录之外，目录权限 0700，文件权限 0600。

用自己选择的服务管理器托管网关。启动、停止及回退应只针对该消息服务，不重启 Codex 或其他业务服务。不要用旧数据库或凭据备份覆盖运行中的新数据。

## API

服务监听 `127.0.0.1`，客户端通过 SSH 转发。请求头 `X-Remote-Codex: desktop` 或 `mcp` 用于请求来源限制，并不构成独立用户认证；同机访问者仍在信任边界内。

| 接口 | 用途 |
| --- | --- |
| `GET /health` | 网关和 provider 状态 |
| `GET /conversations` | 联系人和群聊 |
| `GET /messages?conversation_id=...` | 最近消息 |
| `GET /messages?conversation_id=...&before=...` | 向前分页 |
| `WS /events` | 消息与连接状态更新，必要时触发重读 |
| `POST /messages/send` | 向指定对话发送文字，使用幂等键 |
| `POST /drafts` | 保存草稿，不发送 |
| `GET /whatsapp/status` | 关联和连接状态 |
| `POST /whatsapp/call` | 白名单账号操作 |

媒体接口和关联流程见 [媒体说明](WHATSAPP_MEDIA.md)，MCP 路由见 [消息工具](MESSAGE_ROUTING.md)。

## 恢复与边界

只处理平台实际推送的历史和目录事件，不保证补齐所有旧聊天或断线消息。WebSocket 是状态通知通道，重连后需要重读持久化状态；慢消费者需要重新同步。

平台 ID 用于去重，编辑和撤回更新已存在消息。当前不保证完整同步消失消息及手机端删除状态。发送结果未知时先核查状态和记录，不自动重发。
