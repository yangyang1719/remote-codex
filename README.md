# Remote Codex

通过 SSH 在 Mac 上使用远端 Codex，并在同一个窗口中处理 WhatsApp 消息。

客户端采用 Swift、AppKit 和 WebKit，界面参考 Codex 桌面端：左侧管理项目和会话，中间与 Codex 聊天，右侧消息栏可收起、调整宽度。Codex 和消息账号的登录凭据留在远端；Mac 使用已有的 SSH 配置连接。

这是独立开发的客户端，与 OpenAI 无隶属关系。项目仍在持续开发，Telegram 服务尚未接入。

## 功能

- **远端编程**：查看会话历史、实时回复、命令输出、文件引用和已查看图片。
- **项目与会话**：登记多个远端项目，切换会话，重命名、置顶、本地归档及分叉。
- **运行交互**：回答 Codex 的问题和审批请求，在子代理面板中查看进展与消息。
- **模型与用量**：读取远端可用模型、思考等级、Fast 模式和账号用量，修改会话设置。
- **附件**：选择、拖入或粘贴图片与文件，引用远端项目文件，支持 Quick Look 预览。
- **目标与计划**：创建、暂停、继续目标，查看计划步骤和离线期间的进度。
- **WhatsApp**：切换联系人与群聊，收发文字、图片、文件、视频和音频，扫码或按电话号码关联设备。
- **单条引用与 MCP**：将一条消息放入 Codex 输入框，通过远端工具操作本次绑定的平台和聊天。
- **断线恢复**：自动重连、保存草稿、恢复目标与计划；发送结果不明时不自动重发。
- **阅读体验**：Markdown 表格与代码块、默认收起的命令卡片、运行状态、可见思考摘要和字体设置。

## 工作方式

```text
macOS 客户端
  ├─ SSH ────────── 远端官方 Codex App Server
  │                              │
  │                             MCP
  │                              │
  └─ SSH 端口转发 ── 远端消息网关 ── WhatsApp
```

客户端优先复用远端已有的官方常驻实例，没有可用实例时创建官方 App Server。打开历史先只读查看；点击“继续此会话”或发送时，才加入实时会话。同一官方服务支持多个客户端订阅同一会话。

退出客户端只断开本客户端连接。远端服务运行期间，目标仍可继续执行；共享服务和其他客户端的任务不会因退出而被主动关闭。实时显示取决于远端提供的事件与持久化记录，断线期间的进展在重连后恢复。

## 环境要求

| 环境 | 要求 |
| --- | --- |
| Mac | macOS 14 或更新版本 |
| 开发工具 | 提供 Swift 5.9 或更新版本的 Xcode / Command Line Tools |
| SSH | 已配置主机别名，能够非交互连接远端 |
| 远端 Codex | 支持官方 App Server daemon / proxy 的 CLI；当前适配以 0.165.0 为基准 |
| 远端 Python | Python 3.12 或更新版本 |
| 可选消息服务 | Linux、Node.js 20+、Python 3.12+、`flock` |

旧版 CLI 可能缺少目标、账号授权、模型设置或事件接口，具体能力以远端版本为准。

## 构建与启动

在仓库根目录执行：

```sh
zsh scripts/build-app.sh
open build/RemoteCodex.app
```

构建脚本会同步界面资源、生成图标、编译并以本地 ad-hoc 签名生成应用，输出到 `build/RemoteCodex.app`。这不是经过公证的发行安装包。

之后可从 Finder 双击应用，或保留在 Dock；需要桌面快捷入口时，可在 Finder 中为应用制作替身。重新构建会保留一个回退版本和仍在运行的旧版本，清理其他旧应用包。

另开一个实例：

```sh
open -n build/RemoteCodex.app
```

仅查看演示界面：

```sh
open -n build/RemoteCodex.app --args --demo
```

## 连接远端

1. 在 Mac 的 `~/.ssh/config` 中配置自己的主机别名。
2. 验证非交互连接：`ssh -o BatchMode=yes your-host true`。
3. 在远端安装并配置 Codex CLI，确认其绝对路径及项目目录。
4. 打开“连接设置”，填写 SSH 主机、远端项目目录、Codex 可执行文件路径和消息服务端口。
5. 在左侧“添加远端项目”中登记其他项目。

示例配置，请换成自己的服务器和路径：

```sshconfig
Host my-dev-server
    HostName server.example.com
    User developer
    IdentityFile ~/.ssh/id_ed25519
```

| 连接设置 | 示例 |
| --- | --- |
| SSH 主机 | `my-dev-server` |
| 远端项目目录 | `/srv/projects/my-project` |
| Codex 绝对路径 | `/home/developer/.local/bin/codex` |
| 消息服务端口 | `18765`，需与远端部署一致 |

首次使用请检查并修改连接设置的预设值。构建应用不会替你部署消息服务，也不会自动登录账号。

“远端账号”支持官方设备码授权。切换按“退出 → 确认已登出 → 申请设备码 → 官方网页授权”的顺序执行，会影响共用远端登录环境的客户端，需先让相关任务空闲。取消新授权不会自动恢复旧账号。详见[账号说明](docs/REMOTE_ACCOUNT.md)。

## 日常使用

**输入**：回车发送，Control + 回车换行；中文输入法确认候选词时不会发送。任务运行中，有输入内容时发送补充消息，输入为空时显示停止操作。

**附件**：点击输入框的 `+`，或拖入文件、粘贴图片。输入 `@文件名` 搜索并引用远端项目文件。本地附件在发送时通过 SSH 上传，发送失败保留草稿。

**会话**：通过会话旁的 `⋯` 或右键菜单操作。置顶、归档和移除项目用于整理本客户端列表，不删除远端项目文件或聊天记录。

**布局**：左右侧栏可收起；拖动聊天区与消息栏之间的分隔线调整宽度，双击恢复默认。字体支持 `⌘+`、`⌘−`、`⌘0`，也可从“显示”菜单调整。

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `/plan` | 切换计划模式 |
| `/plan 任务内容` | 在计划模式中发送任务 |
| `/goal` | 查看或创建当前目标 |
| `/goal 目标内容` | 设置目标并开始远端持续工作 |
| `/goal edit` | 编辑目标与可选 Token 预算 |
| `/goal pause` | 暂停目标 |
| `/goal resume` | 继续目标 |
| `/goal clear` | 清除目标，保留聊天记录 |
| `/usage`、`/status` | 查看远端用量与重置时间 |
| `/fast`、`/fast on`、`/fast off` | 切换、开启或关闭 Fast 模式，取决于远端模型能力 |
| `! ls` | 在当前远端会话直接执行 Shell 命令 |

未支持的斜杠命令会提示，不会静默作为普通消息发给模型。

## WhatsApp 与 MCP

消息能力需要另外部署远端网关和 WhatsApp worker。仓库包含服务源码与部署参考，桌面端通过 SSH 隧道访问服务。

公开版本提供服务源码和接口说明，尚无通用一键安装器。部署时自行设置代码目录、服务用户及账号数据目录；同一个 session 只能由一个 WhatsApp 连接持有。原环境的部署、迁移和远端验收脚本保留本地，不随源码发布。

侧栏支持扫码和电话号码关联。选择联系人或群聊后可直接回复，也可将单条消息引用到 Codex。需要 Codex 代发时，请明确下达发送指令；路由在该次请求发送时绑定，之后切换侧栏不会改投其他联系人。

插件位于 `plugins/desktop-messages/`，MCP 入口为 `gateway/routed_mcp_server.py`。工具核对真实会话与回合，准备发送后固定收件人和内容，结果未知时不自动重发。Telegram 尚无账号服务，不会通过其他平台代发。

- [消息服务](docs/WHATSAPP_SERVICE.md)
- [媒体与设备关联](docs/WHATSAPP_MEDIA.md)
- [MCP 消息路由](docs/MESSAGE_ROUTING.md)
- [问题回答与直接发送](docs/ASYNC_QUESTIONS.md)

## 数据与安全边界

SSH 加密 Mac 与服务器之间的传输。消息网关默认只监听远端回环地址，通过 SSH 转发访问。请求头检查不能代替用户认证，能够访问远端同一运行环境的进程仍处于信任边界内。

Codex 和 WhatsApp 登录凭据留在远端。Mac 会保存连接偏好、草稿、平台选择及附件或媒体缓存，因此本地应用数据也可能包含私人内容。

侧栏收件不会自动把整个聊天交给 Codex。主动引用、工具读取或下载会把相应内容带入 Codex 工作流程；外部消息和附件应作为来源材料，不能作为发送或执行操作的授权。当前普通请求可能附带内部消息路由标记，原始 Codex 历史中可以看到该元数据。

只恢复平台实际提供的历史和事件，不保证补齐所有旧消息，或完整同步手机端的消失消息、删除状态。媒体和附件暂未提供统一的自动清理策略。

## 源码结构

```text
Sources/RemoteCodex/   Swift 客户端及 WebKit 界面资源
gateway/              Python 消息网关、存储与 MCP 工具
whatsapp/             WhatsApp worker、媒体与关联逻辑
plugins/              Codex 消息插件
runtime/              远端运行辅助与兼容实现
scripts/              构建与离线检查脚本
Design/               界面原型
packaging/            应用信息与图标
docs/                 功能和架构说明
```

公开源码不包含项目记忆、内部桌面测试、生产验收记录或构建产物。没有内部 `Tests/` 时，Swift 包只注册应用目标。

服务端离线测试使用模拟消息与临时目录：

```sh
python3 -m unittest discover -s gateway -p 'test_*.py' -v
cd whatsapp
npm ci
npm test
```

依赖真实 SSH、账号或模型请求的内部验收工具不随源码发布。以上离线测试不连接真实账号。

## 更多说明

- [架构](ARCHITECTURE.md)
- [远端常驻与生命周期](docs/RUNTIME_SERVICE.md)
- [项目和会话管理](docs/WORKSPACE_MANAGEMENT.md)
- [自动重连与草稿恢复](docs/RECOVERY_DRAFTS.md)
- [目标与计划进度](docs/PLAN_PROGRESS.md)
- [问题卡片、子代理与模型](docs/SESSION_FEATURES.md)
- [命令与 Markdown 展示](docs/COMMAND_TRANSCRIPT.md)
- [运行状态与可见思考摘要](docs/RUN_PRESENTATION.md)
- [用量](docs/USAGE.md)

## 许可证

本项目原创代码采用 [MIT License](LICENSE)。第三方依赖和复用代码遵循各自的许可证，不因根目录 MIT 声明而改变授权。

WhatsApp 连接代码的来源见 [whatsapp/VENDOR.md](whatsapp/VENDOR.md)，依赖版本及许可证元数据见 `whatsapp/package-lock.json`。
