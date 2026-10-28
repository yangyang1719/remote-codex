# 官方常驻：先复用，缺失才创建

更新：2026-10-27。Mac 不登录 Codex，只通过 SSH 使用远端官方 app-server。

## 连接与归属

1. 优先探测 `CODEX_HOME/app-server-control/app-server-control.sock`（通常为 `~/.codex/app-server-control/app-server-control.sock`）。
2. 标准入口不存在时，兼容复用原 `~/.local/state/remote-codex-runtime/official.sock`。自定义隔离 CODEX_HOME 不探测生产旧入口。
3. 两个入口都不存在才启动官方 `codex app-server --listen unix://`，以独立会话运行，标准输入关闭，输出写私有日志。启动结束后只保留官方二进制，Python 助手退出。
4. 连接握手与 `server/diagnostics` 核对 CODEX_HOME、官方二进制和进程身份。服务存在但无响应则报错，不另起实例；长 socket 路径先解析官方符号链接。
5. 并发首次连接使用文件锁串行创建并再次检查，避免本客户端重复启动。启动记录包含 PID、Linux startTicks、socket 和归属；遇到其他官方启动者抢先就复用它，只清理自己刚启动的空候选进程。
6. 显式设置 officialSocket 的连接仅使用指定入口，不自动创建，供隔离验证和准确会话路由使用。默认逻辑 socketIdentity 保留，已有草稿/计划配置的本地键不变。

```text
Mac → SSH → 短时发现助手
             ├─ 已有标准官方常驻 → 复用
             ├─ 已有旧私有官方常驻 → 兼容复用
             └─ 都不存在 → 启动官方 app-server
          → exec 官方 app-server proxy --sock 已确认入口
```

代码：`OfficialRuntime.swift`、`Resources/official_runtime.py`、`Connection.swift`、`RuntimeControl.swift`。启动助手随客户端资源发送，无需在远端安装或升级 admin.py。新流程不调用旧部署器，不新增 systemd 单元，不修改官方配置/认证，不开放公网 TCP，不启用云端 remote-control。

## 退出和开关

- 退出 App、休眠或断开 SSH，只关闭本客户端的连接。官方常驻继续运行，其目标和回合不因客户端离线而停止。
- 设置显示真实归属和已加载会话/运行回合数量；“连接现有常驻”或“创建并连接”按实际状态显示。
- 复用的外部实例或有已加载会话/活动回合的实例，只提供“断开本客户端”，停止本客户端自动重连，其他连接和任务继续。
- 本客户端创建且空闲时才显示“关闭空闲常驻…”。先保存草稿、断开自己的连接，远端再检查归属、PID/startTicks、已加载会话、活动回合及所有其他连接；有任一占用则只断开客户端，不暂停目标、不 interrupt、不杀其他进程。
- 关闭仅对准确的自建空闲 PID 发 SIGTERM，不使用 SIGKILL；成功后记录 disabled。普通重连不自动创建被手动关闭的实例，须显式“创建并连接”。
- 原 `remote-codex-runtime.service` 和其 release 原样保留，不能为切换连接而 stop/restart。旧任务继续运行，不迁移。若原会话在另一个已知实例中，主动继续时确认准确 thread ID 已加载后路由加入。

不承诺服务器/进程崩溃后目标自动恢复，也没有新建开机自启单元。服务器重启后，下次连接可在缺失时创建官方进程；重新打开客户端只读恢复历史/进度，不自动重放发送或恢复目标。计划和问答功能沿用官方服务及现有快照实现。
