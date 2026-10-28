# 运行中的问题、子代理与模型设置

## 入口与交互

- Codex 的 `request_user_input` 在聊天里显示问题卡片：单选及说明、“其他回答”、自由输入、私密输入。提交前检查所有问题；不会替用户自动选择或回答。异步正文问题的选项只填入输入框，由用户发送。
- 卡片按真实服务器请求去重，流式回复和页面刷新复用原 DOM，保留尚未提交的选择和文字。服务器的 resolved 通知移除卡片；过期回答不再发送。断开后等待官方 pending request 在显式继续会话时重放；私密回答不写本地磁盘。
- 子代理列表在聊天顶部，可展开/收起。显示昵称、真实状态和最新回复预览，嵌套代理有缩进；数量较多时可按全部/进行中/已完成筛选。点子代理在原面板内展开消息，父会话和草稿留在原位；面板内显示角色/模型/等级、任务、消息与简短工具活动。另有“打开完整聊天”入口。
- 输入框下方的模型和思考等级从远端读取。模型能力以 `model/list` 返回值为准；不同模型切换到各自默认等级。已有会话更改通过 `thread/settings/update`，再 `thread/read` 确认；界面提示“后续回合生效”。新对话选择随首次发送应用，不创建空会话来保存偏好。

## 跨会话与后台问题提醒（2026-10-22）

- 在其他会话中阅读时，聊天顶部显示待回答/审批的会话入口；左侧待回答徽标继续保留。通知与列表均按请求 token 去重，多道题属于同一次请求时只提醒一次。
- 客户端处于后台、窗口最小化或正在查看其他会话时，使用 macOS UserNotifications 发系统通知，并在 Dock 标出待处理数量。正在前台查看对应会话时只显示问题卡片。首次实际启动请求系统通知权限；拒绝时问题区提供“通知设置”，菜单也有入口，回到应用会刷新权限状态。
- 点击系统通知恢复并激活窗口，再经 native 保存的 token 打开对应会话并滚动、聚焦到准确卡片。窗口内入口走相同的验证路由；子代理问题按已验证的写入祖先显示在父会话，未持有写入权则打开来源会话的只读问题。切换保留原草稿，点击本身不 resume、不答复、不发送。
- 答复、serverRequest/resolved、断线、换连接或退出清除相关系统通知、路由与 Dock 标记。过期点击提示已处理，不自动跳进其他连接。锁屏通知只含通用提示，不含问题正文、选项、私密输入或答案。
- 该功能接收本客户端连接实际收到的服务器请求。Mac 客户端须保持运行并已连接；退出后无本地通知进程，也不会为了发现其他 writer 的问题去接管会话。系统是否展示横幅/声音仍服从 macOS 权限与专注模式。
- 实现：`QuestionNotifications.swift` 将请求路由/去重和系统通知适配分开；DesktopDelegate 负责窗口激活；`Coordinator` 核验 token，`app.js` 保留草稿并聚焦稳定问题 DOM。
- 00:42:31 全部本地回归 64 项：48 通过、16 个远端可选测试跳过、0 失败。新增原生请求→提醒→点击→只读卡片的联动、子代理父会话定位、滚动历史中的强制定位、过期清理与拒绝权限入口，以及去重/后台判断测试。证据：`question-notification-unit.log`、`question-notification-ui.log`、`question-notification-regression.log`。系统实际横幅与人工点击未自动验收，需用户允许通知；未触发真实模型提问或联系人消息。

系统接口参考：[Apple 通知权限](https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications)与[通知交互回调](https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate)。

## 会话保护

浏览和子代理同步只用 `thread/read`、`thread/list`、`thread/turns/list`、`thread/items/list`。不自动 resume、interrupt、spawn 或抢占子代理。模型修改需要准确会话的写入权，占用时拒绝并保留远端原值；不因改模型停止当前任务。目标继续和计划模式使用同一个用户所选模型/等级。

问题答复先核验本连接持有原会话或其真实祖先会话的写入权。子代理的请求可显示在父会话；祖先关系由远端 metadata 核验，不能由 WebView 提供。浏览其他连接的会话不能批准或答复其请求。

## 同步实现

`SessionFeatures.swift` 提供请求去重/输入校验、模型能力校验、父子关系解析、子代理同步器。子代理每约 4 秒分页读取后代关系，重复 ID 合并；切换/关闭取消，迟到响应丢弃。最新回合状态用只读 summary 确认，每轮至多补读 8 个。对其他 app-server 持有的会话，notLoaded 不等于停止；最新回合仍 inProgress 时持续重读，直到真实结束，界面注明来自远端记录。每次列表遍历最多 40 页，每页 50 个；超出时 `hasMore` 标记提示列表不完整。

`Resources/session.js` 负责卡片、列表、两个选择器与按会话状态。原型生成脚本仅添加功能样式和资源引用，不修改已确认的 `Design/approved-prototype.html`。

官方文档：<https://learn.chatgpt.com/docs/app-server>。接口以远端 0.163.0 `generate-json-schema --experimental` 校验，包含请求 isBlocking、问题 isOther/isSecret、subAgentActivity/collabAgentToolCall、thread/settings/update.effort。

## 面板内消息同步（2026-10-22）

- 用户确认默认在子代理面板内展开。列表预览来自真实 agentMessage，任务描述单独标明；空消息不以任务冒充回复。
- `SubagentMessages.swift` 复用只读游标跟进器。展开时先记录尾游标，再读最近 30 个原始条目，避免初始化读取期间漏消息。只同步当前展开的一个代理；收起、换代理、换会话、断开时取消。更早消息按页读取。没有 resume/subscribe/interrupt 或向代理发送消息。
- `Resources/subagents.js` 保留列表、行与消息 DOM，状态/预览变化不重建阅读区。读底部时自动跟进，往上翻时保留锚点并提供“有新消息”按钮。已有直接流式通知立即更新，持久记录短于最新流式内容时不回退。
- 列表预览每轮至多读取 8 个代理并轮换；已结束代理按状态和更新时间缓存。32 个同时运行的代理预览分批跟进，已展开代理约 2 秒增量读取；不创建 32 条永久轮询。
- 内联只显示任务输入、代理回复及命令/文件/工具活动摘要，不传 reasoning 或整块工具日志；超长消息注明并提供完整只读聊天入口。
- 参考了官方说明及本机已安装 ChatGPT/Codex 的子代理面板组件结构（活动/完成分组、状态与回复预览）；实现仍在本项目原生客户端中，不引入其他客户端代码。
- 00:17:52 隔离真实验收：独立 writer 启动一个真实子代理，只读 viewer 在父会话面板内自动依次读到开始、处理中和完成消息。父草稿/选中会话保持，viewer writer=0，原 writer 持有权不变；重开恢复所有消息。证据 `build/evidence/subagent-inline-live.json` / `.log`。32 代理、分页、关闭后丢弃迟到结果、保留 DOM/滚动与流式防回退有自动回归覆盖。
