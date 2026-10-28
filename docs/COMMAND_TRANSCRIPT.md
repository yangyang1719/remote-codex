# 消息排版与实时命令

更新：2026-10-28。

## 排版

- Markdown 表格以真实 table/thead/tbody 显示：浅色表头、细边框、单元格顶部对齐和长文字换行；支持列对齐标记、可选外侧竖线和截图中的空行分隔写法。窄容器在表格内部横向滚动；不撑宽聊天面板。
- 表格先于 12000 字符分页识别，表头/分隔行不会被页面边界切断。大表每次最多追加 80 行或约 12000 字符，可点击“显示更多行”；代码块中的表格语法保持代码。转义竖线与行内代码中的竖线不拆列，单元格复用已有安全行内排版与文件引用预览。
- 用户消息与助手回复统一渲染代码块和行内代码。支持标准多行围栏，以及用户截图中的紧凑写法（例如三个反引号、语言、空格、代码、三个反引号）。语言标签、复制、等宽字体、横向滚动和原换行保留。
- 先识别围栏再分页，大段代码不会因 12000 字符边界变成普通正文；长内容按需追加。渲染用 DOM/textContent，来源 HTML/脚本均是文本，不执行。
- 文件引用、单条消息引用、附件、异步问答的既有行为保留。

## 命令卡片

- `transcript.js` 渲染“命令运行中 / 已完成 / 失败 / 未获批准 / 已中断”，带 Shell 区域、命令、输出、退出状态和服务器实际耗时。
- 命令卡片默认收起，包括正在运行的命令；状态和耗时保持单行，命令预览仅占剩余宽度并省略，悬停可看完整预览，箭头始终在右侧。手动展开后再显示完整命令和输出。
- `item/started` 立即显示，`item/commandExecution/outputDelta` 更新已有卡片，`item/completed` 为最终状态。卡片 DOM、展开状态和日志滚动位置复用；从未展开的已完成大日志不创建输出 DOM。
- 开始事件提供 startedAtMs 时按真实时间计时；晚加入且服务器没有命令起始时间时只显示“已观察”，不把整个回合的起始时间冒充该命令耗时。断线显示“状态待同步”。
- 历史刷新保留刚收到但尚未落盘的实时条目，避免正在运行的命令闪退或消失。

## 已加载会话的只读观察

隔离实测证实：0.164.0 的普通 thread/turns/list、thread/items/list 在命令运行中不含未完成项。单纯缩短轮询周期不能解决。

- 浏览已加载会话时，先核对准确 ID 在已知官方实例的 thread/loaded/list 中，再用没有任何配置覆盖的 thread/resume 订阅，并请求有界 initialTurnsPage（1 回合、full）。该初始页含运行中命令，随后接收实时事件。
- 观察集合 observations 与用户主动继续后的 subscriptions 分开；观察不进入 controlledThreads，不允许因此发送、中断或回答审批。未知的原客户端请求不代为拒绝。切换视图解除仅观察订阅，保留已主动继续的会话。
- 未加载或未知独立实例仍只读历史，不为观看创建另一执行器、不删除锁、不强抢。该观察更新替代此前“所有浏览都绝不 thread/resume”的实现约定；共享实例不提供原子 requireLoaded 参数，loaded 检查和订阅之间仍有短暂竞态，但不发执行/设置/目标修改请求。
- 订阅前已输出的内容以官方快照和最终输出为准；不声称补回服务器未提供的中间输出。原任务的执行由原官方实例持有。

## ! 直接执行

- 输入 ! ls、! git status --short 等，回车或按钮执行；Ctrl+Enter 换行、IME 选词规则不变。
- native 再校验显式 ! 前缀、非空、长度/NUL、项目与会话归属；Shell 语法原样交官方 thread/shellCommand，不在 Mac 拼接或执行。
- 沿用远端线程配置的 Shell 与工作目录。此官方接口为用户直接命令，具有完整远端访问权限，不继承线程 sandbox；只对用户主动发送的 ! 调用。助手/引用/历史中的命令文本不自动执行。
- 有活动回合时按官方语义作为附加动作运行；不调用 turn/start、turn/steer 或 turn/interrupt，不发送模型请求。空会话先建立真实远端线程。带引用或附件时保留草稿并提示移除后执行。
- RPC 确认后才清除相应输入；失败/不明结果保留，自动重连不重放命令。

实现入口：ShellCommand.swift、Coordinator.swift、Connection.swift、Resources/transcript.js、Resources/app.js、scripts/sync-prototype.py。

协议依据：[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)，thread/shellCommand、thread/resume.initialTurnsPage、item 生命周期与 commandExecution。
