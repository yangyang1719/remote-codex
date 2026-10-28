# 连接逻辑来源

`vendor/runtime.mjs`、`vendor/paths.mjs` 和 `vendor/format-pr-message.mjs` 来自用户指定的远端已安装 `whatsapp-pr-notifier` 插件源码（2026-10-21 读取）。未复制任何认证文件。

保留原有 Baileys 7.0.0-rc14 锁定依赖、已验证的 WhatsApp 协议版本与原始固定群发送校验。

独立服务差异：
- `ServiceRuntime` 接入收信、联系人/群目录、平台提供的历史事件、消息编辑/撤回，以及断线恢复。
- 允许处理平台实际推送的近期历史（仍保留 `syncFullHistory: false`）。不保证补齐全部旧聊天。
- 不自动删除失效凭据，不自动退出账号；凭据始终留在远端。
- 服务以 `flock` 独占 session；旧插件在完成接管后使用 MCP 兼容代理，不再创建第二个 WhatsApp socket。
