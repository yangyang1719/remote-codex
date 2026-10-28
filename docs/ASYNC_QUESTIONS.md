# 异步问题回答与消息直接发送

2026-10-26：截图中的异步提问此前只将“问题＋选项”填入普通输入框，缺少问题关联。当前使用独立问题卡片，支持选项、其他回答、提交中锁定、已回答状态；提交保留主输入框的文字、引用和附件。

## 异步回答协议

- 来源是 `agentMessage.questions`。问题标识沿用官方客户端格式 `JSON.stringify(["request_user_input_async", sourceItemId, questionIndex])`，保留问题原文及准确答案。
- Swift `AsyncQuestionReply.encode` 生成 `<send_user_message_question_reply>` 包裹的 JSON 数组；提交通过当前会话既有 start/steer 路径进入远端，不自行回答别的请求、不 interrupt 原回合。
- `answerAsyncQuestion` 是专门的 native bridge 操作，不修改主 composer 草稿。相同卡片提交中不可连点；失败保留选择，结果不明先刷新记录核对，不自动重发。
- 回复标记必须保持完整，以便官方客户端识别。消息收件人路由在服务器绑定真实 thread/turn，异步回答不追加可破坏官方识别的尾部路由 JSON。
- 历史里的结构化回复显示为“已回答 Codex 的问题”、问题、答案，不展示原始 tag、JSON 或 questionItemId。按身份匹配原卡片，跨窗口读取到已回答记录后标记已回答。
- 同步 `item/tool/requestUserInput` 仍使用专门的 RPC response；不能将两种提问混用。系统通知测试继续暂停。

## WhatsApp 直接发送

- 回复框点击箭头或 Enter 立即提交文字和可选附件，不再展开二次确认区域；Ctrl+Enter 换行，中文输入法确认候选词不提交。
- 点击瞬间固定聊天、正文、附件和幂等键；连点只提交一次。发送过程中可编辑下一条草稿，成功只清除本次发送的内容和附件，保留新草稿。
- 切换平台/聊天不会改变已提交目标；失败不清草稿，重试相同内容继续使用相同幂等键，不自动重发。不连 Telegram 账号、不代发真实联系人消息。
- 本地 102 项 Swift 回归：80 通过、22 可选跳过；覆盖结构化问题身份、JSON 特殊字符、卡片提交、历史格式化、主草稿保留，以及长回复/附件直接发送、IME、换行和连点。发送均使用隔离假网关；证据 `questions-direct-native.log`。

真实异步模型往返未验收：独立 ephemeral 测试回合在时限内未产出问题 item，已停止该测试回合，未回答任何原业务问题。记录 `async-question-live.json` 为 inconclusive，不能当作真实问答已通过。当前问答格式依据本机官方客户端的实际序列化格式与本地原生/UI 回归确认；原官方服务的新 MCP 无参数路由读取已单独真实通过。
