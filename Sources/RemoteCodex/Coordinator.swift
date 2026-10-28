import AppKit
import WebKit
import Quartz

@MainActor final class AppCoordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    weak var web: WKWebView?
    var settings = ConnectionSettings.load()
    var openSettings: (() -> Void)?
    var openNotificationSettings: (() -> Void)?
    let questionAttention = QuestionAttention()
    var notificationPermission = "unknown" {
        didSet { emit("notificationPermission", ["status": notificationPermission]) }
    }
    var attachmentPicker: ((WKOpenPanelParameters, @escaping ([URL]?) -> Void) -> Void)?
    let attachments = AttachmentStore()
    let messageMediaCache = MessageMediaCache()
    private var sendingMessages = Set<String>()
    private var messageUploads: [String: String] = [:]
    private let attachmentTransport = SSHAttachmentTransport()
    private let planReader = SSHPlanReader()
    private lazy var planFollower: PlanProgressFollower = {
        let value = PlanProgressFollower { [weak self] id, cursor in
            guard let self else { throw CancellationError() }
            let generation = self.epoch, settings = self.settings
            let metadata = try await self.rpc.request("thread/read", params: ["threadId": id, "includeTurns": false])
            try Task.checkCancellation()
            guard generation == self.epoch, self.selectedThread == id, let thread = metadata["thread"] as? [String: Any], thread["id"] as? String == id else { throw CancellationError() }
            guard let path = thread["path"] as? String else { return ["threadId": id, "plan": NSNull(), "turnId": NSNull(), "hasMore": false] }
            let turns = try await self.rpc.request("thread/turns/list", params: ["threadId": id, "limit": 1, "sortDirection": "desc", "itemsView": "summary"])
            try Task.checkCancellation()
            let latestTurn = (turns["data"] as? [[String: Any]])?.first?["id"] as? String
            return try await self.planReader.read(thread: id, path: path, cursor: cursor, latestTurn: latestTurn, settings: settings)
        }
        value.onSnapshot = { [weak self] id, plan in self?.emit("planSnapshot", ["threadId": id, "plan": plan as Any? ?? NSNull()]) }
        value.onStatus = { [weak self] id, status in self?.emit("planSync", ["threadId": id, "status": status]) }
        return value
    }()
    private var attachmentPaths: [String: String] = [:]
    let viewedImages = ViewedImageStore()
    private var sendingAttachments = Set<String>()
    private var sendInFlight = false
    private var commandInFlight = false
    private var threadModels: [String: String] = [:]
    private var threadEfforts: [String: String] = [:]
    private var threadServiceTiers: [String: String] = [:]
    private var runVersions: [String: Int] = [:]
    private var accountReady = false
    private var accountWatch: Task<Void, Never>?
    private lazy var remoteAccount: RemoteAccount = {
        let value = RemoteAccount(request: { [weak self] method, params in
            guard let self, self.accountReady else { throw ClientError.message("请先通过 SSH 连接远端 Codex。") }
            let current = self.epoch
            let result = try await self.rpc.request(method, params: params)
            guard current == self.epoch else { throw CancellationError() }
            return result
        }, diagnostics: { [weak self] in
            guard let self, self.accountReady else { throw ClientError.message("远端连接已断开。") }
            return try await self.rpc.accountDiagnostics()
        })
        value.changed = { [weak self] value in self?.emit("remoteAccountLogin", value) }
        return value
    }()
    private var modelCatalog: [[String: Any]] = []
    private var settingsDigests: [String: Data] = [:]
    private var settingsVersions: [String: Int] = [:]
    private var settingsInFlight = Set<String>()
    private var agentParents: [String: String] = [:]
    private var agentRoots: [String: String] = [:]
    private var agentRoot: String?
    private lazy var agentMessages: SubagentMessages = {
        let value = SubagentMessages { [weak self] method, params in
            guard let self else { throw CancellationError() }
            return try await self.rpc.request(method, params: params)
        }
        value.onPage = { [weak self] root, id, items, prepend, more in
            guard let self else { return }
            self.observeViewedImages(items, thread: id)
            self.emit("subagentMessages", ["rootThreadId": root, "agentId": id, "items": items, "prepend": prepend, "hasOlder": more])
        }
        value.onStatus = { [weak self] root, id, status in self?.emit("subagentMessageSync", ["rootThreadId": root, "agentId": id, "status": status]) }
        return value
    }()
    private lazy var agentFollower: SubagentFollower = {
        let value = SubagentFollower { [weak self] method, params in
            guard let self else { throw CancellationError() }
            return try await self.rpc.request(method, params: params)
        }
        value.onSnapshot = { [weak self] root, agents, more in
            guard let self else { return }
            for agent in agents { if let id = agent["id"] as? String, let parent = agent["parentThreadId"] as? String { self.agentParents[id] = parent; self.agentRoots[id] = root } }
            self.emit("subagents", ["rootThreadId": root, "agents": agents, "hasMore": more])
        }
        value.onStatus = { [weak self] root, status in self?.emit("subagentSync", ["rootThreadId": root, "status": status]) }
        return value
    }()
    private var modePresets: [[String: Any]] = []
    private var goalWatch: Task<Void, Never>?
    private var goalDigests: [String: Data] = [:]
    private var goalVersions: [String: Int] = [:]
    private var previewURL: URL?
    private var previewPanel: NSPanel?
    private struct ProjectReference { let draftKey: String, host: String, project: String, path: String, name: String; var isImage: Bool { ["png", "jpg", "jpeg", "webp"].contains(URL(fileURLWithPath: path).pathExtension.lowercased()) } }
    private var projectReferences: [String: ProjectReference] = [:]
    private var fileSearches: [String: [String: ProjectReference]] = [:]
    private let rpc: RPCConnection
    private lazy var follower: ReadOnlyFollower = {
        let value = ReadOnlyFollower { [weak self] method, params in
            guard let self else { throw CancellationError() }
            return try await self.rpc.request(method, params: params)
        }
        value.canRead = { [weak self] id in
            guard let self else { return false }
            return self.selectedThread == id && !self.writableThreads.contains(id) && !self.resumingThreads.contains(id) && !self.historyRequests.contains(id)
        }
        value.onItems = { [weak self] id, items in
            guard let self else { return }
            self.observeViewedImages(items, thread: id)
            let visible = items.compactMap(Self.displayItem)
            if !visible.isEmpty { self.emit("historyUpdate", ["threadId": id, "items": visible]) }
        }
        value.onStatus = { [weak self] id, status in self?.emit("threadSync", ["threadId": id, "status": status]) }
        return value
    }()
    private let connectMessages: Bool
    private let rememberSelection: Bool
    private var selectionKey: String { "remote-last-thread:" + settings.host + ":" + settings.project }
    private let gateway: MessageGateway
    private lazy var messageRouting = DesktopMessageRouting { [weak self] path, body in
        guard let self else { throw CancellationError() }
        return try await self.gateway.request(path, method: "POST", body: body, timeout: 7)
    }
    private var selectedThread: String?
    private var selectionEpoch = UUID()
    private var readOnlyLoads: [String: UUID] = [:]
    private var writableThreads = Set<String>()
    private var resumingThreads = Set<String>()
    private var historyRequests = Set<String>()
    private var questions = PendingQuestionStore()
    private var epoch = UUID()
    private var gatewayConnected = false
    private var activeTurns: [String: String] = [:]
    private var eventRefresh: Task<Void, Never>?
    private let draftStore: DraftStore
    private var draftContexts: [String: ConnectionSettings] = [:]
    private var loadedDraftScope: String?
    private var attachmentScopes: [String: String] = [:]
    private var reconnectAllowed = true
    private var messageReconnectAllowed = true
    private var connecting = false
    private var connected = false
    private var connectionSettings: ConnectionSettings?
    private var flushWaiters: [String: CheckedContinuation<Void, Never>] = [:]
    private let workspaceCatalog: WorkspaceCatalog
    private var workspace: WorkspaceState?
    private var projectActionInFlight = false
    private var projectSelections: [String: String] = [:]
    private var threadPages: [String: String] = [:]
    private var threadPageVersions: [String: UUID] = [:]
    private var knownProjectThreads: [String: [String: [String: Any]]] = [:]
    private lazy var recovery: ConnectionRecovery = {
        let value = ConnectionRecovery { [weak self] in guard let self, self.reconnectAllowed else { return true }; return await self.connectOnce() }
        value.onWaiting = { [weak self] delay in self?.emit("reconnecting", ["delay": delay]) }; return value
    }()
    private lazy var messageRecovery: ConnectionRecovery = {
        ConnectionRecovery { [weak self] in guard let self, self.messageReconnectAllowed else { return true }; return await self.connectGateway() }
    }()

    init(rpc: RPCConnection? = nil, connectMessages: Bool = true, rememberSelection: Bool = true, draftStore: DraftStore? = nil, workspaceCatalog: WorkspaceCatalog? = nil, gateway: MessageGateway? = nil) {
        self.gateway = gateway ?? MessageGateway()
        self.workspaceCatalog = workspaceCatalog ?? WorkspaceCatalog(root: rememberSelection ? nil : FileManager.default.temporaryDirectory.appendingPathComponent("RemoteCodexTestWorkspace-" + UUID().uuidString))
        self.draftStore = draftStore ?? DraftStore(root: rememberSelection ? nil : FileManager.default.temporaryDirectory.appendingPathComponent("RemoteCodexTestDrafts-" + UUID().uuidString))
        self.rpc = rpc ?? RPCConnection(); self.connectMessages = connectMessages; self.rememberSelection = rememberSelection; super.init()
        questionAttention.isVisible = { [weak self] thread in
            guard let self else { return false }
            return self.selectedThread == thread && NSApplication.shared.isActive && self.web?.window?.isKeyWindow == true && self.web?.window?.isMiniaturized == false
        }
        questionAttention.navigate = { [weak self] notice in
            self?.emit("focusQuestion", ["threadId": notice.thread, "token": notice.token])
        }
    }
    func openQuestion(_ token: String) {
        guard questionAttention.open(token) else { emit("questionUnavailable", ["message": "这个问题已处理或连接已变化，请查看会话的最新状态。"]); return }
    }
    private func initializeWorkspace() throws {
        guard workspace == nil else { return }
        workspace = try workspaceCatalog.load(seed: settings)
        if let active = workspace?.projects.first(where: { $0.id == workspace?.activeID }) { settings = active.settings }
    }
    private func publishWorkspace() {
        guard let workspace else { return }
        let projects: [[String: Any]] = workspace.projects.map { item in
            ["id": item.id, "name": item.name, "host": item.settings.host, "path": item.settings.project, "collapsed": item.collapsed,
             "pinned": Array(workspace.pinned[item.id] ?? []), "archived": Array(workspace.archived[item.id] ?? [])]
        }
        emit("workspace", ["projects": projects, "activeProjectId": workspace.activeID as Any? ?? NSNull(), "aliases": ConnectionSettings.aliases()])
    }
    func configureProject(_ value: ConnectionSettings) throws {
        guard !projectActionInFlight, !sendInFlight, sendingMessages.isEmpty, !commandInFlight else { throw ClientError.message("请等待当前操作完成后再修改连接。") }
        workspace = try workspaceCatalog.configure(value); settings = value; if rememberSelection { settings.save() }; publishWorkspace()
    }
    private func switchProject(_ id: String, requestedThread: String? = nil) async throws {
        guard let target = workspace?.projects.first(where: { $0.id == id }) else { throw ClientError.message("项目已不在列表中。") }
        if workspace?.activeID == id, settings == target.settings { publishWorkspace(); if let requestedThread { try await selectThread(requestedThread) } else if connected { try await listThreads() }; return }
        await flushDrafts()
        let reuse = connected && WorkspaceCatalog.sameServer(settings, target.settings)
        let changeMessages = settings.host != target.settings.host || settings.gatewayPort != target.settings.gatewayPort
        if changeMessages { messageRecovery.stop(); gateway.close(); gatewayConnected = false; emit("gateway", ["connected": false, "message": "正在切换消息连接…"]); emit("conversations", ["conversations": []]) }
        saveSelection(selectedThread); selectionEpoch = UUID(); follower.stop(); stopPlan(); stopAgents(); goalWatch?.cancel(); selectedThread = nil
        workspace = try workspaceCatalog.update(id, operation: "select"); settings = target.settings; if rememberSelection { settings.save() }
        if let requestedThread { saveSelection(requestedThread) }
        publishWorkspace(); await restoreDrafts(settings)
        if reuse {
            connectionSettings = settings
            if changeMessages, connectMessages { messageRecovery.start(immediate: true) }
            let generation = epoch, project = id, selection = selectionEpoch, restore = requestedThread ?? projectSelections[id] ?? (rememberSelection ? UserDefaults.standard.string(forKey: selectionKey) : nil)
            emit("projectOpened", ["host": settings.host, "project": settings.project])
            Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    try await self.listThreads(projectID: project)
                    guard generation == self.epoch, project == self.workspace?.activeID else { return }
                    if self.selectionEpoch == selection, self.selectedThread == nil, let restore { try await self.selectThread(restore) }
                    let config = try await self.rpc.request("config/read", params: ["cwd": self.settings.project, "includeLayers": false])["config"] as? [String: Any] ?? [:]
                    guard generation == self.epoch, project == self.workspace?.activeID else { return }
                    self.publishSettings("new", value: ["model": config["model"] ?? NSNull(), "effort": config["model_reasoning_effort"] ?? NSNull(), "serviceTier": config["service_tier"] ?? NSNull()])
                } catch { if project == self.workspace?.activeID { self.emit("error", ["message": error.localizedDescription]) } }
            }
        } else { Task { await self.connect() } }
    }
    private func projectAction(_ body: [String: Any]) async throws {
        guard !projectActionInFlight else { throw ClientError.message("正在处理项目操作，请稍候。") }
        projectActionInFlight = true; defer { projectActionInFlight = false }
        try initializeWorkspace()
        let operation = body["operation"] as? String ?? "", id = body["projectId"] as? String ?? ""
        if operation == "select" || (operation == "remove" && workspace?.activeID == id) {
            guard !connecting, !sendInFlight, sendingMessages.isEmpty, !commandInFlight, settingsInFlight.isEmpty else { throw ClientError.message("请等待连接或当前发送完成后再切换项目。") }
        }
        if operation == "add" {
            var value = settings; value.host = body["host"] as? String ?? ""; value.project = body["path"] as? String ?? ""
            let added = try workspaceCatalog.add(value, name: body["name"] as? String)
            workspace = try workspaceCatalog.load(seed: settings); publishWorkspace(); attachmentReply(body, value: ["projectId": added.id]); return
        }
        if operation == "select" { try await switchProject(id, requestedThread: body["threadId"] as? String) }
        else {
            let wasActive = workspace?.activeID == id
            if operation == "remove", wasActive { await flushDrafts() }
            workspace = try workspaceCatalog.update(id, operation: operation, name: body["name"] as? String, flag: body["collapsed"] as? Bool)
            publishWorkspace()
            if operation == "remove", wasActive {
                if let next = workspace?.activeID {
                    // Force the normal switch path after catalog selection changed.
                    workspace?.activeID = nil; try await switchProject(next)
                } else { selectedThread = nil; saveSelection(nil); selectionEpoch = UUID(); follower.stop(); stopPlan(); stopAgents(); goalWatch?.cancel(); emit("projectOpened", ["empty": true]) }
            }
        }
        attachmentReply(body)
    }
    private func threadAction(_ body: [String: Any]) async throws {
        guard !projectActionInFlight, let project = workspace?.projects.first(where: { $0.id == body["projectId"] as? String }),
              WorkspaceCatalog.sameServer(settings, project.settings), let id = body["threadId"] as? String,
              let operation = body["operation"] as? String else { throw ClientError.message("请先打开此项目，再管理会话。") }
        projectActionInFlight = true; defer { projectActionInFlight = false }
        let generation = epoch
        let management = ThreadManagement { [weak self] method, params in
            guard let self, self.epoch == generation else { throw CancellationError() }
            let result = try await self.rpc.request(method, params: params)
            guard self.epoch == generation else { throw CancellationError() }; return result
        }
        let thread: [String: Any]
        if ["pin", "archive"].contains(operation), let cached = knownProjectThreads[project.id]?[id], SessionSettings.parent(cached) == nil { thread = cached }
        else { thread = try await management.metadata(id, project: project.settings.project) }
        guard generation == epoch else { throw ClientError.message("连接已变化，请重试。") }
        switch operation {
        case "pin", "archive":
            workspace = try workspaceCatalog.update(project.id, operation: operation, flag: body["value"] as? Bool, thread: id)
            knownProjectThreads[project.id, default: [:]][id] = thread; publishWorkspace()
            emit("threadManaged", ["projectId": project.id, "thread": thread]); attachmentReply(body)
        case "rename":
            let renamed = try await management.rename(id, project: project.settings.project, name: body["name"] as? String ?? "")
            guard generation == epoch else { throw ClientError.message("连接已变化，重新打开后可查看名称。") }
            knownProjectThreads[project.id, default: [:]][id] = renamed
            emit("threadManaged", ["projectId": project.id, "thread": renamed]); attachmentReply(body)
        case "fork":
            guard !connecting, !sendInFlight, sendingMessages.isEmpty, !commandInFlight, settingsInFlight.isEmpty else { throw ClientError.message("请等待连接或当前发送处理完成后再分叉。") }
            guard workspace?.activeID == project.id else { throw ClientError.message("请先打开来源项目再分叉。") }
            await flushDrafts()
            let config = try await planReader.prepare(settings: settings)
            guard generation == epoch else { throw CancellationError() }
            let result = try await management.fork(id, project: project.settings.project, config: config)
            guard generation == epoch, let fork = result["thread"] as? [String: Any], let newID = fork["id"] as? String else { throw ClientError.message("连接已变化，请在会话列表中查看分叉。") }
            writableThreads.insert(newID); selectedThread = newID; saveSelection(newID)
            emit("thread", ["thread": fork]); emitAccess(newID, "writable"); publishSettings(newID, value: result)
            try await history(newID); watchGoal(newID); watchPlan(newID); await watchAgents(fork)
            attachmentReply(body, value: ["threadId": newID]); try? await listThreads()
        default: throw ClientError.message("会话操作无效。")
        }
    }
    func restoreDrafts(_ target: ConnectionSettings) async {
        let scope = DraftStore.scope(target)
        guard loadedDraftScope != scope else { return }
        draftContexts[scope] = target
        do {
            var records = try draftStore.load(scope), warnings: [String] = []
            for (recordKey, raw) in records where recordKey.hasPrefix("codex:") || recordKey.hasPrefix("reply:") {
                guard var value = raw as? [String: Any] else { continue }
                let rawKey = String(recordKey.dropFirst(6)), key = recordKey.hasPrefix("reply:") ? MessageMediaCache.replyKey(rawKey) : rawKey; var rows: [[String: Any]] = []
                for saved in value["attachments"] as? [[String: Any]] ?? [] {
                    guard let id = saved["id"] as? String, let name = saved["name"] as? String else { continue }
                    do {
                        if recordKey.hasPrefix("codex:"), let path = saved["path"] as? String, Self.projectPath(path, root: target.project) != nil, UUID(uuidString: id) != nil {
                            let reference = ProjectReference(draftKey: key, host: target.host, project: target.project, path: path, name: name)
                            projectReferences[id] = reference
                            rows.append(["id": id, "name": name, "path": path, "source": "project", "isImage": reference.isImage, "status": "ready"])
                        } else if let hash = saved["sha256"] as? String {
                            let file = try await attachments.restore(id: id, draftKey: key, name: name, url: draftStore.archivedURL(saved, scope: scope), sha256: hash)
                            attachmentScopes[id] = scope; rows.append(file.payload)
                        }
                    } catch {
                        rows.append(["id": id, "name": name, "status": "error", "message": "附件恢复失败，请移除后重新添加。"])
                        warnings.append(name)
                    }
                }
                value["attachments"] = rows; records[recordKey] = value
            }
            guard DraftStore.scope(settings) == scope else { return }
            loadedDraftScope = scope
            emit("draftSnapshot", ["scope": scope, "records": records, "warnings": warnings])
        } catch { emit("draftError", ["message": error.localizedDescription]); emit("draftSnapshot", ["scope": scope, "records": [:]]) }
    }
    private func saveDraft(_ body: [String: Any]) throws {
        guard let scope = body["draftScope"] as? String, let context = draftContexts[scope],
              let kind = body["kind"] as? String, let key = body["key"] as? String,
              let value = body["value"] as? [String: Any] else { throw ClientError.message("草稿所属连接已变化，暂未保存。") }
        var saved: [String: Any] = [:], localFiles: [ChatAttachment] = []
        if kind == "codex" || kind == "reply" {
            let attachmentKey = kind == "reply" ? MessageMediaCache.replyKey(key) : key
            saved["text"] = value["text"] as? String ?? ""
            saved["mode"] = value["mode"] as? String == "plan" ? "plan" : "default"
            if let quote = value["quote"] as? [String: Any] { saved["quote"] = quote.filter { ["id", "platform", "conversation", "author", "text", "timestamp"].contains($0.key) } }
            var files: [[String: Any]] = []
            let ids = value["attachmentIds"] as? [String] ?? []
            guard ids.count <= AttachmentStore.countLimit else { throw ClientError.message("草稿附件数量超限。") }
            for id in ids {
                if let ref = projectReferences[id], ref.host == context.host, ref.project == context.project, ref.draftKey == attachmentKey {
                    files.append(["id": id, "name": ref.name, "path": ref.path])
                } else {
                    guard attachmentScopes[id] == scope else { throw ClientError.message("附件属于其他连接，请重新添加。") }
                    let file = try attachments.resolve([id], draftKey: attachmentKey)[0]
                    localFiles.append(file); files.append(["id": file.id])
                }
            }
            saved["attachments"] = files
        } else if kind == "preferences" {
            saved["platform"] = value["platform"] as? String == "telegram" ? "telegram" : "whatsapp"
            saved["selected"] = (value["selected"] as? [String: Any] ?? [:]).filter { ["whatsapp", "telegram"].contains($0.key) && $0.value is String }
        } else { throw ClientError.message("草稿类型无效。") }
        try draftStore.save(scope, kind: kind, key: key, value: saved, localFiles: localFiles)
    }
    func flushDrafts() async {
        guard !CommandLine.arguments.contains("--demo"), let web else { return }
        let token = UUID().uuidString
        await withCheckedContinuation { continuation in
            flushWaiters[token] = continuation
            web.evaluateJavaScript("Promise.resolve(window.RemoteCodex?.flushDrafts?.()).finally(()=>window.webkit.messageHandlers.native.postMessage({action:'draftFlushComplete',token:'\(token)'}));void 0")
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                self?.flushWaiters.removeValue(forKey: token)?.resume()
            }
        }
    }
    private func saveSelection(_ id: String?) { if let project = workspace?.activeID { projectSelections[project] = id }; if rememberSelection { UserDefaults.standard.set(id, forKey: selectionKey) } }
    private func stopPlan() { planFollower.stop(); planReader.cancelAll() }
    private func stopAgents() { agentMessages.stop(); agentFollower.stop(); agentRoot = nil }
    private func watchPlan(_ id: String) { stopPlan(); if rpc.officialDaemon { planFollower.start(id) } }
    func runtimeStopped(message: String = "远端常驻已关闭。可在连接设置中重新开启。") { connecting = false; reconnectAllowed = false; recovery.stop(); connected = false; epoch = UUID(); questions.clear(); questionAttention.clear(); goalWatch?.cancel(); follower.stop(); stopPlan(); stopAgents(); writableThreads.removeAll(); activeTurns.removeAll(); rpc.close(); emit("connection", ["status": "error", "message": message] ) }

    func emit(_ type: String, _ payload: [String: Any] = [:]) {
        guard let web else { return }
        var event = payload; event["type"] = type
        guard let data = try? JSONSerialization.data(withJSONObject: event, options: [.fragmentsAllowed]), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.RemoteCodex && window.RemoteCodex.receive(\(json));", completionHandler: nil)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        do { try initializeWorkspace() } catch { emit("error", ["message": "项目列表读取失败：" + error.localizedDescription]); return }
        emit("bootstrap", ["settings": ["host": settings.host, "project": settings.project, "gatewayPort": settings.gatewayPort], "icons": Self.icons(), "demo": CommandLine.arguments.contains("--demo"), "draftScope": DraftStore.scope(settings), "showWhatsAppLink": CommandLine.arguments.contains("--whatsapp-link")])
        emit("messageVisibility", ["active": NSApplication.shared.isActive && webView.window?.isVisible == true && webView.window?.isMiniaturized != true])
        emit("notificationPermission", ["status": notificationPermission])
        if !CommandLine.arguments.contains("--demo") { publishWorkspace(); if workspace?.activeID != nil { Task { await connect() } } }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard frame.isMainFrame else { completionHandler(nil); return }
        if let attachmentPicker { attachmentPicker(parameters, completionHandler); return }
        let panel = NSOpenPanel(); panel.title = "添加图片或文件"; panel.canChooseFiles = true; panel.canChooseDirectories = false; panel.allowsMultipleSelection = true
        if let window = webView.window { panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) } }
        else { panel.begin { completionHandler($0 == .OK ? panel.urls : nil) } }
    }
    private func observeViewedImages(_ items: [[String: Any]], thread: String) {
        for item in items { viewedImages.observe(item, thread: thread, scope: DraftStore.scope(settings)) }
    }
    private func viewedImageAction(_ action: String, body: [String: Any]) async throws {
        guard let thread = body["threadId"] as? String, let item = body["itemId"] as? String,
              let context = selectedThread, body["contextThreadId"] as? String == context,
              thread == context || (thread == agentMessages.thread && agentRoots[thread] == agentRoot) else {
            throw ClientError.message("图片所属会话已切换，请在原记录中打开。")
        }
        let target = settings, scope = DraftStore.scope(target), generation = epoch
        guard body["draftScope"] as? String == scope || body["draftScope"] == nil else { throw ClientError.message("图片所属连接已变化。") }
        let path = try viewedImages.path(thread: thread, item: item, scope: scope)
        let result: (URL, String)
        if let cached = viewedImages.cached(thread: thread, item: item, scope: scope) { result = cached }
        else {
            let url = try await attachmentTransport.download(path, settings: target, recordedImage: true)
            guard generation == epoch, selectedThread == context else { throw CancellationError() }
            result = try await viewedImages.cache(url, thread: thread, item: item, scope: scope, path: path)
        }
        guard generation == epoch, selectedThread == context else { throw CancellationError() }
        if action == "viewedImagePreview" { preview(result.0) }
        attachmentReply(body, value: ["thumbnail": result.1, "name": URL(fileURLWithPath: path).lastPathComponent])
    }
    private func preview(_ url: URL) {
        previewPanel?.close(); previewURL = url
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 760, height: 580), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false; panel.title = url.lastPathComponent
        if let view = QLPreviewView(frame: NSRect(x: 0, y: 0, width: 760, height: 580), style: .normal) { view.previewItem = url as NSURL; view.autoresizingMask = [.width, .height]; panel.contentView = view }
        panel.center(); panel.makeKeyAndOrderFront(nil); previewPanel = panel
    }
    private func attachmentReply(_ body: [String: Any], value: [String: Any] = [:]) { emit("attachmentReply", ["bridgeId": body["bridgeId"] ?? "", "ok": true, "value": value]) }
    private func accountAction(_ body: [String: Any]) async throws {
        guard accountReady else { throw ClientError.message("请先通过 SSH 连接远端 Codex。") }
        let current = epoch
        switch body["operation"] as? String {
        case "read":
            var value = try await remoteAccount.read()
            guard epoch == current else { throw CancellationError() }
            value["host"] = settings.host; value["login"] = remoteAccount.login as Any? ?? NSNull()
            attachmentReply(body, value: value)
        case "start":
            guard !sendInFlight, !commandInFlight, !projectActionInFlight, settingsInFlight.isEmpty else { throw ClientError.message("请等待当前操作完成后再切换账号。") }
            let value = try await remoteAccount.start()
            guard epoch == current else { throw CancellationError() }
            attachmentReply(body, value: value)
            accountWatch?.cancel()
            accountWatch = Task { @MainActor [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
                    guard let self, self.epoch == current, self.remoteAccount.login != nil else { return }
                    do { try await self.remoteAccount.assertIdle() }
                    catch {
                        guard self.epoch == current, self.remoteAccount.login?["loginId"] == value["loginId"] else { return }
                        try? await self.remoteAccount.cancel()
                        self.emit("remoteAccountLogin", ["status": "failed", "message": "检测到远端任务启动或连接状态变化，已尝试取消本次授权。请等空闲后再切换。"])
                        return
                    }
                }
            }
        case "cancel":
            try await remoteAccount.cancel(); accountWatch?.cancel(); attachmentReply(body)
        case "openBrowser":
            guard let value = remoteAccount.login?["verificationUrl"], let url = RemoteAccount.verificationURL(value) else { throw ClientError.message("请先获取有效的设备授权码。") }
            guard NSWorkspace.shared.open(url) else { throw ClientError.message("无法打开默认浏览器，请复制页面地址后手动打开。") }
            attachmentReply(body)
        case "copyCode":
            guard let code = remoteAccount.login?["userCode"] else { throw ClientError.message("授权码已失效，请重新获取。") }
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(code, forType: .string); attachmentReply(body)
        default: throw ClientError.message("不支持的账号操作。")
        }
    }
    func cancelAccountLogin() async { try? await remoteAccount.cancel(); accountWatch?.cancel() }
    private func refreshAccountMetadata() async {
        let current = epoch
        guard let account = try? await remoteAccount.read(), current == epoch else { return }
        emit("remoteAccountSnapshot", account)
        guard connected else { return }
        if account["account"] is NSNull, account["requiresOpenaiAuth"] as? Bool == true {
            connected = false; reconnectAllowed = false
            emit("connection", ["status": "error", "message": "远端账号已退出，请打开“远端账号”重新授权。"])
            return
        }
        var models: [[String: Any]] = [], cursor: String?
        repeat {
            var params: [String: Any] = ["limit": 100, "includeHidden": true]
            if let cursor { params["cursor"] = cursor }
            guard let page = try? await rpc.request("model/list", params: params), current == epoch else { return }
            models += page["data"] as? [[String: Any]] ?? []
            let next = page["nextCursor"] as? String
            if next == cursor { break }; cursor = next
        } while cursor != nil
        modelCatalog = models; emit("models", ["data": models])
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.isFileURL && url.standardizedFileURL.deletingLastPathComponent() == AppResources.directory.standardizedFileURL { decisionHandler(.allow) }
        else { if ["https", "http"].contains(url.scheme?.lowercased() ?? ""), navigationAction.navigationType == .linkActivated { NSWorkspace.shared.open(url) }; decisionHandler(.cancel) }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        if CommandLine.arguments.contains("--demo"), action != "settings" { return }
        Task {
            do {
                if (remoteAccount.busy || remoteAccount.login != nil), ["send", "shellCommand", "newThread", "command", "continueThread", "updateThreadSettings", "threadAction"].contains(action) { throw ClientError.message("账号授权进行中，请先完成或取消授权。") }
                if workspace != nil, workspace?.activeID == nil, ["send", "shellCommand", "newThread", "command", "continueThread", "updateThreadSettings"].contains(action) { throw ClientError.message("请先添加或打开一个远端项目。") }
                if projectActionInFlight, ["send", "shellCommand", "newThread", "command", "continueThread", "updateThreadSettings", "interrupt"].contains(action) { throw ClientError.message("请等待项目操作完成。") }
                switch action {
                case "settings": openSettings?()
                case "remoteAccount": try await accountAction(body)
                case "projectAction":
                    if remoteAccount.busy { throw ClientError.message("正在获取授权信息，请稍后切换项目。") }
                    if remoteAccount.login != nil { try await remoteAccount.cancel(); accountWatch?.cancel() }
                    try await projectAction(body)
                case "threadAction": try await threadAction(body)
                case "loadThreadPage": try await listThreads(projectID: body["projectId"] as? String, more: true); attachmentReply(body)
                case "refreshProjectThreads": try await listThreads(projectID: body["projectId"] as? String); attachmentReply(body)
                case "draftSave": try saveDraft(body); attachmentReply(body)
                case "draftFlushComplete": if let token = body["token"] as? String { flushWaiters.removeValue(forKey: token)?.resume() }
                case "notificationSettings": openNotificationSettings?()
                case "openQuestion": if let token = body["token"] as? String { openQuestion(token) }
                case "reconnect": await connect()
                case "leaveThread": selectionEpoch = UUID(); selectedThread = nil; saveSelection(nil); follower.stop(); stopPlan(); stopAgents(); goalWatch?.cancel(); await rpc.stopObserving()
                case "newThread":
                    let generation = epoch, target = settings
                    let config = try await planReader.prepare(settings: target)
                    guard generation == epoch else { throw ClientError.message("连接已变化，请重试新建会话。") }
                    let result = try await rpc.request("thread/start", params: ["cwd": target.project, "approvalPolicy": "on-request", "sandbox": "workspace-write", "config": config])
                    if let thread = result["thread"] as? [String: Any], let id = thread["id"] as? String { follower.stop(); writableThreads.insert(id); selectedThread = id; publishSettings(id, value: result); emit("thread", ["thread": thread]); emitAccess(id, "writable"); emit("history", ["threadId": id, "items": []]); watchGoal(id); watchPlan(id); await watchAgents(thread); try await listThreads() }
                case "selectThread": if let id = body["id"] as? String { try await selectThread(id) }
                case "continueThread": if let id = body["threadId"] as? String, selectedThread == id { _ = try await acquireWriteAccess(id) }
                case "refreshThread": if let id = body["threadId"] as? String, selectedThread == id { if writableThreads.contains(id) { try await history(id) } else { try await readAndFollow(id) } }
                case "loadHistory": if let id = body["threadId"] as? String { try await history(id, cursor: body["cursor"]) }
                case "send": try await send(body)
                case "shellCommand": try await send(body, shell: true)
                case "copyText":
                    guard let text = body["text"] as? String, text.utf8.count <= 2_000_000 else { throw ClientError.message("复制内容过长。") }
                    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string); attachmentReply(body)
                case "answerAsyncQuestion":
                    guard let thread = body["threadId"] as? String, thread == selectedThread else { throw ClientError.message("会话已切换，请回到原问题后提交。") }
                    var reply = body
                    reply["text"] = try AsyncQuestionReply.encode(body)
                    reply["attachmentIds"] = [String]()
                    reply["requestId"] = UUID().uuidString
                    reply["asyncQuestionReply"] = true
                    guard try await send(reply) else { throw ClientError.message("尚未提交回答，请在当前会话可继续时重试。") }
                    attachmentReply(body, value: ["submitted": true])
                case "command": try await command(body)
                case "usageRead":
                    guard connected else { throw ClientError.message("请先连接远端 Codex。") }
                    let generation = epoch, context = DraftStore.scope(settings), id = body["threadId"] as? String
                    guard id == selectedThread, body["draftScope"] as? String == context else { throw ClientError.message("连接或会话已切换，请重新查看用量。") }
                    var reader = UsageReader { [weak self] method, params in
                        guard let self, self.epoch == generation else { throw CancellationError() }
                        let value = try await self.rpc.request(method, params: params)
                        guard self.epoch == generation else { throw CancellationError() }
                        return value
                    }
                    let target = settings
                    reader.recordUsage = { [weak self] threadID in
                        guard let self, self.epoch == generation else { throw CancellationError() }
                        let metadata = try await self.rpc.request("thread/read", params: ["threadId": threadID, "includeTurns": false])
                        guard self.epoch == generation, let thread = metadata["thread"] as? [String: Any], thread["id"] as? String == threadID, let path = thread["path"] as? String else { throw CancellationError() }
                        return try await self.planReader.usage(thread: threadID, path: path, settings: target)
                    }
                    var snapshot = await reader.snapshot(thread: id)
                    guard generation == epoch, context == DraftStore.scope(settings), id == selectedThread else { throw ClientError.message("连接或会话已变化，请重新查看用量。") }
                    snapshot["host"] = settings.host
                    attachmentReply(body, value: snapshot)
                case "updateThreadSettings": try await updateThreadSettings(body)
                case "watchSubagent":
                    guard let context = body["contextThreadId"] as? String, selectedThread == context else { break }
                    if let id = body["threadId"] as? String, let root = body["rootThreadId"] as? String, root == agentRoot, agentRoots[id] == root { agentMessages.start(root: root, thread: id) }
                    else if body["threadId"] is NSNull { agentMessages.stop() }
                case "subagentOlder":
                    guard body["contextThreadId"] as? String == selectedThread, body["threadId"] as? String == agentMessages.thread else { throw ClientError.message("子代理视图已切换。") }
                    try await agentMessages.loadOlder(); attachmentReply(body)
                case "attachmentBegin":
                    guard let id = body["id"] as? String, let draft = body["draftKey"] as? String, let name = body["name"] as? String, let size = body["size"] as? Int else { throw ClientError.message("附件信息不完整。") }
                    let actualDraft = (body["conversationId"] as? String).map(MessageMediaCache.replyKey) ?? draft
                    try attachments.begin(id: id, draftKey: actualDraft, name: name, size: size); attachmentScopes[id] = body["draftScope"] as? String ?? DraftStore.scope(settings); attachmentReply(body)
                case "attachmentChunk":
                    guard let id = body["id"] as? String, let offset = body["offset"] as? Int, let data = body["data"] as? String else { throw ClientError.message("附件数据不完整。") }
                    try attachments.append(id: id, offset: offset, base64: data); attachmentReply(body)
                case "attachmentFinish":
                    guard let id = body["id"] as? String else { throw ClientError.message("附件标识无效。") }
                    let file = try await attachments.finish(id: id); attachmentReply(body, value: file.payload)
                case "attachmentRemove":
                    if let id = body["id"] as? String, !sendingAttachments.contains(id) { if attachments.localURL(id) == previewURL { previewPanel?.close(); previewURL = nil }; attachments.remove(id); projectReferences.removeValue(forKey: id) }
                case "attachmentSearch":
                    guard let query = body["query"] as? String, query.count <= 256, let draft = body["draftKey"] as? String, let token = body["bridgeId"] as? String else { throw ClientError.message("文件搜索内容无效。") }
                    let target = settings, result = try await rpc.request("fuzzyFileSearch", params: ["query": query, "roots": [settings.project], "cancellationToken": "attachments-" + draft])
                    var allowed: [String: ProjectReference] = [:], rows: [[String: Any]] = []
                    for file in (result["files"] as? [[String: Any]] ?? []) where file["match_type"] as? String == "file" {
                        guard let path = file["path"] as? String, let full = Self.projectPath(path, root: target.project), let name = file["file_name"] as? String else { continue }
                        allowed[full] = ProjectReference(draftKey: draft, host: target.host, project: target.project, path: full, name: name)
                        rows.append(["path": full, "name": name, "relative": path]); if rows.count == 20 { break }
                    }
                    if fileSearches.count >= 8 { fileSearches.removeAll() }; fileSearches[token] = allowed
                    attachmentReply(body, value: ["files": rows, "token": token])
                case "attachmentReference":
                    guard let id = body["id"] as? String, UUID(uuidString: id) != nil, let token = body["token"] as? String, let path = body["path"] as? String,
                          let reference = fileSearches[token]?[path], reference.draftKey == body["draftKey"] as? String,
                          reference.host == settings.host, reference.project == settings.project else { throw ClientError.message("文件选择已失效，请重新搜索。") }
                    projectReferences[id] = reference
                    attachmentReply(body, value: ["id": id, "name": reference.name, "path": path, "source": "project", "isImage": reference.isImage, "status": "ready"])
                case "attachmentPreview":
                    if let id = body["id"] as? String, let url = attachments.localURL(id) { preview(url) }
                    else if let id = body["id"] as? String, let reference = projectReferences[id], reference.host == settings.host, reference.project == settings.project { preview(try await attachmentTransport.download(reference.path, settings: settings, projectRoot: reference.project)) }
                    else if let path = body["path"] as? String {
                        let saved = attachmentPaths.first { $0.key.hasPrefix(settings.host + ":") && $0.value == path }?.key.split(separator: ":").last.map(String.init)
                        if let saved, let local = attachments.localURL(saved) { preview(local) }
                        else { preview(try await attachmentTransport.download(path, settings: settings, projectRoot: Self.projectPath(path, root: settings.project) == nil ? nil : settings.project)) }
                    }
                    else { throw ClientError.message("附件尚未准备好。") }
                    attachmentReply(body)
                case "viewedImageLoad", "viewedImagePreview":
                    try await viewedImageAction(action, body: body)
                case "interrupt":
                    if let id = body["threadId"] as? String, writableThreads.contains(id), let turn = activeTurns[id] { _ = try await rpc.request("turn/interrupt", params: ["threadId": id, "turnId": turn]) }
                case "approval": try answerApproval(body); attachmentReply(body)
                case "listConversations": try await listConversations()
                case "getMessages":
                    if let id = body["conversationId"] as? String { let encoded = id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "+&=?#"))) ?? ""; var result = try await gateway.request("/messages?conversation_id=" + encoded); result["conversationId"] = id; emit("messages", result) }
                case "messageMediaLoad", "messageMediaPreview", "messageMediaSave", "messageMediaQuote":
                    try await messageMediaAction(action, body: body)
                case "whatsappLinkStatus", "whatsappLinkStart":
                    let host = settings.host, port = settings.gatewayPort
                    let result: [String: Any]
                    if action == "whatsappLinkStart" {
                        guard let mode = body["mode"] as? String, ["qr", "phone"].contains(mode) else { throw ClientError.message("请选择关联方式。") }
                        result = try await gateway.request("/whatsapp/auth", method: "POST", body: ["mode": mode, "phoneNumber": body["phoneNumber"] as? String ?? ""], timeout: 90)
                    } else { result = try await gateway.request("/whatsapp/auth", timeout: 15) }
                    guard settings.host == host, settings.gatewayPort == port else { throw CancellationError() }
                    attachmentReply(body, value: result)
                case "sendMessage":
                    try await sendMessage(body)
                default: break
                }
            } catch {
                if let bridge = body["bridgeId"] { emit("attachmentReply", ["bridgeId": bridge, "ok": false, "message": error.localizedDescription]) }
                else { emit("error", ["action": action, "message": error.localizedDescription, "threadId": body["threadId"] ?? body["id"] ?? "", "requestId": body["requestId"] ?? body["idempotencyKey"] ?? "", "conversationId": body["conversationId"] ?? ""]) }
            }
        }
    }
    private var sleeping = false
    func connect() async {
        do { try initializeWorkspace() } catch { emit("error", ["message": error.localizedDescription]); return }
        guard workspace?.activeID != nil else { publishWorkspace(); return }
        reconnectAllowed = true; messageReconnectAllowed = true
        if connecting, connectionSettings == settings { return }
        recovery.stop()
        if connecting {
            if connectionSettings == settings { return }
            epoch = UUID(); rpc.close(); connecting = false
        }
        if !(await connectOnce()), reconnectAllowed, !sleeping { recovery.start() }
    }
    private func connectionLost(_ reason: String) {
        accountReady = false; accountWatch?.cancel(); remoteAccount.disconnected()
        if !connecting { epoch = UUID() }
        connected = false; rpc.close(); questions.clear(); questionAttention.clear()
        goalWatch?.cancel(); attachmentTransport.cancelAll(); follower.stop(); stopPlan(); stopAgents()
        writableThreads.removeAll(); resumingThreads.removeAll(); activeTurns.removeAll(); historyRequests.removeAll()
        emit("connection", ["status": "error", "message": reason])
        if reconnectAllowed, !connecting, !sleeping { recovery.start() }
    }
    func prepareForSleep() {
        sleeping = true; recovery.stop(); messageRecovery.stop()
        connectionLost("Mac 已休眠，唤醒后将自动重新连接。")
        gateway.close(); gatewayConnected = false
        emit("gateway", ["connected": false, "message": "Mac 已休眠，唤醒后自动恢复消息同步。"])
    }
    func wakeConnections() {
        sleeping = false
        if reconnectAllowed, !connected { recovery.start(immediate: true) }
        if messageReconnectAllowed, connectMessages, !gatewayConnected { messageRecovery.start(immediate: true) }
    }
    private func connectOnce() async -> Bool {
        guard workspace?.activeID != nil else { return true }
        guard !connecting, !sleeping else { return false }
        try? await remoteAccount.cancel()
        accountReady = false; accountWatch?.cancel(); remoteAccount.disconnected()
        let target = settings
        do { try target.validate() } catch { reconnectAllowed = false; emit("connection", ["status": "error", "message": error.localizedDescription]); return true }
        let changed = connectionSettings.map { DraftStore.scope($0) != DraftStore.scope(target) } ?? true
        let gatewayChanged = connectionSettings.map { $0.host != target.host || $0.gatewayPort != target.gatewayPort } ?? true
        if changed { selectedThread = nil }
        if changed || gatewayChanged { messageRecovery.stop(); gateway.close(); gatewayConnected = false; emit("gateway", ["connected": false, "message": "正在恢复消息连接…"]); emit("conversations", ["conversations": []]) }
        connectionSettings = target; connecting = true
        epoch = UUID(); let current = epoch
        defer { if epoch == current { connecting = false } }
        await restoreDrafts(target)
        guard current == epoch, !Task.isCancelled else { return false }
        if connectMessages, !gatewayConnected { messageRecovery.start(immediate: true) }
        questionAttention.clear(); attachmentTransport.cancelAll()
        goalWatch?.cancel(); goalDigests.removeAll(); goalVersions.removeAll(); threadModels.removeAll(); threadEfforts.removeAll(); threadServiceTiers.removeAll(); settingsDigests.removeAll(); settingsVersions.removeAll(); settingsInFlight.removeAll(); modelCatalog.removeAll(); agentParents.removeAll(); agentRoots.removeAll(); modePresets.removeAll()
        stopPlan(); follower.stop(); stopAgents(); selectionEpoch = UUID(); readOnlyLoads.removeAll()
        let restoreThread = selectedThread ?? workspace?.activeID.flatMap { projectSelections[$0] } ?? (rememberSelection ? UserDefaults.standard.string(forKey: selectionKey) : nil)
        writableThreads.removeAll(); resumingThreads.removeAll(); historyRequests.removeAll(); activeTurns.removeAll(); questions.clear()
        emit("connection", ["status": "connecting", "host": target.host, "project": target.project])
        rpc.onNotification = { [weak self] method, params in self?.notification(method, params) }
        rpc.onRequest = { [weak self] id, method, params in self?.serverRequest(id, method, params) }
        rpc.onDisconnect = { [weak self] reason in self?.connectionLost(reason) }
        do {
            try await rpc.connect(target)
            guard current == epoch, !Task.isCancelled else { return false }
            accountReady = true
            emit("remoteAccountReady", ["ready": true])
            let account = try await rpc.request("account/read", params: ["refreshToken": false])
            guard current == epoch, !Task.isCancelled else { return false }
            let requiresLogin = account["account"] is NSNull && (account["requiresOpenaiAuth"] as? Bool == true)
            if requiresLogin { reconnectAllowed = false; emit("connection", ["status": "error", "message": "远端 Codex 尚未登录，请打开“远端账号”，使用设备授权码登录。"]); return true }
            connected = true
            emit("connection", ["status": "connected", "host": settings.host, "project": settings.project, "persistentRuntime": rpc.persistentRuntime])
            // Listing persisted history must not block model/settings discovery.
            async let initialThreads: Void = listThreads()
            var models: [[String: Any]] = [], cursor: String?
            repeat {
                var params: [String: Any] = ["limit": 100, "includeHidden": true]
                if let cursor { params["cursor"] = cursor }
                guard let page = try? await rpc.request("model/list", params: params), current == epoch else { break }
                models += page["data"] as? [[String: Any]] ?? []
                let next = page["nextCursor"] as? String
                if next == cursor { break }; cursor = next
            } while cursor != nil
            guard current == epoch, !Task.isCancelled else { return false }
            modelCatalog = models; emit("models", ["data": models])
            if let modes = try? await rpc.request("collaborationMode/list", params: [:]) { modePresets = modes["data"] as? [[String: Any]] ?? [] }
            if let result = try? await rpc.request("config/read", params: ["cwd": settings.project, "includeLayers": false]), current == epoch, let config = result["config"] as? [String: Any] {
                let fallback = modePresets.first { $0["mode"] as? String == "default" }?["model"] as? String
                let model = config["model"] as? String ?? fallback
                let effort = config["model_reasoning_effort"] as? String ?? modelCatalog.first { $0["model"] as? String == model }?["defaultReasoningEffort"] as? String
                publishSettings("new", value: ["model": model as Any? ?? NSNull(), "effort": effort as Any? ?? NSNull(), "serviceTier": config["service_tier"] ?? NSNull()])
            }
            guard current == epoch, !Task.isCancelled else { return false }
            guard connected else { return false }
            emit("commandCapabilities", ["plan": modePresets.contains { $0["mode"] as? String == "plan" }])
            do { try await initialThreads }
            catch {
                // A slow list is recoverable independently of the SSH transport.
                // listThreads publishes a project-scoped retry state and keeps cached rows.
                guard current == epoch, connected else { return false }
            }
            guard current == epoch, connected else { return false }
            if let restoreThread {
                do { try await selectThread(restoreThread) }
                catch {
                    guard current == epoch else { return false }
                    if !connected { throw error }
                    follower.stop(); emit("error", ["threadId": restoreThread, "message": "上次会话暂时无法读取，草稿仍保留，可从列表重试。"])
                }
            }
            if connectMessages, !gatewayConnected { messageRecovery.start(immediate: true) }
            return true
        } catch {
            guard current == epoch else { return false }
            connected = false; accountReady = false; emit("remoteAccountReady", ["ready": false]); rpc.close()
            emit("connection", ["status": "error", "message": error.localizedDescription])
            return false
        }
    }
    private func connectGateway() async -> Bool {
        guard connectMessages, !sleeping else { return false }
        let target = settings, scope = DraftStore.scope(settings)
        gateway.onEvent = { [weak self] event in
            guard let self, DraftStore.scope(self.settings) == scope else { return }
            self.emit("gatewayEvent", ["event": event]); self.eventRefresh?.cancel()
            self.eventRefresh = Task { @MainActor [weak self] in
                do { try await Task.sleep(nanoseconds: 200_000_000) } catch { return }
                guard let self, DraftStore.scope(self.settings) == scope else { return }; try? await self.listConversations()
            }
        }
        gateway.onDisconnect = { [weak self] error in
            guard let self, DraftStore.scope(self.settings) == scope else { return }
            self.gatewayConnected = false; self.emit("gateway", ["connected": false, "message": error])
            if self.messageReconnectAllowed, !self.sleeping { self.messageRecovery.start() }
        }
        do {
            let health = try await gateway.connect(target)
            guard DraftStore.scope(settings) == scope, !Task.isCancelled else { return false }
            gatewayConnected = true
            messageRouting.enabled = (health["capabilities"] as? [String] ?? []).contains("desktop-routing-v1")
            emit("gateway", ["connected": true, "providers": health["providers"] ?? []]); try await listConversations()
            return true
        } catch {
            guard DraftStore.scope(settings) == scope else { return false }
            gatewayConnected = false
            emit("gateway", ["connected": false, "message": "消息连接暂不可用，正在自动重连。", "detail": error.localizedDescription])
            return false
        }
    }
    private func listThreads(projectID: String? = nil, more: Bool = false) async throws {
        let id = projectID ?? workspace?.activeID
        let profile = workspace?.projects.first(where: { $0.id == id })
        let target = profile?.settings ?? settings, generation = epoch, version = UUID(), key = id ?? "current"
        guard WorkspaceCatalog.sameServer(settings, target) else { throw ClientError.message("请先打开此项目再加载会话。") }
        var params: [String: Any] = ["limit": 80, "sortKey": "updated_at", "sourceKinds": ["cli", "vscode", "appServer", "exec"], "cwd": target.project, "useStateDbOnly": true]
        if more { guard let cursor = threadPages[key] else { return }; params["cursor"] = cursor }
        threadPageVersions[key] = version
        emit("threadListState", ["projectId": id as Any? ?? NSNull(), "status": "loading"])
        do {
            let result = try await rpc.request("thread/list", params: params)
            guard generation == epoch, threadPageVersions[key] == version else { return }
            var rows = result["data"] as? [[String: Any]] ?? []
            if !more {
                let saved = (workspace?.pinned[key] ?? []).union(workspace?.archived[key] ?? [])
                let found = Set(rows.compactMap { $0["id"] as? String })
                for missing in saved.subtracting(found).sorted().prefix(50) {
                    if let response = try? await rpc.request("thread/read", params: ["threadId": missing, "includeTurns": false]),
                       let thread = response["thread"] as? [String: Any], thread["cwd"] as? String == target.project, SessionSettings.parent(thread) == nil { rows.append(thread) }
                }
            }
            guard generation == epoch, threadPageVersions[key] == version else { return }
            threadPages[key] = result["nextCursor"] as? String
            for row in rows { if let thread = row["id"] as? String { knownProjectThreads[key, default: [:]][thread] = row } }
            emit("threads", ["threads": rows, "projectId": id as Any? ?? NSNull(), "project": target.project, "append": more, "nextCursor": result["nextCursor"] ?? NSNull()])
        } catch {
            guard generation == epoch, threadPageVersions[key] == version else { return }
            emit("threadListState", ["projectId": id as Any? ?? NSNull(), "status": "error", "message": "会话列表暂时无法读取，可重试。已有会话和草稿仍保留。"])
            throw error
        }
    }
    private func selectThread(_ id: String) async throws {
        let previousThread = selectedThread
        follower.stop(); stopPlan(); stopAgents(); selectionEpoch = UUID(); let selection = selectionEpoch
        selectedThread = id; emit("loadingThread", ["threadId": id])
        // Browsing never resumes a thread or acquires its writer lease.
        let result = try await rpc.request("thread/read", params: ["threadId": id, "includeTurns": false])
        guard selectedThread == id, selection == selectionEpoch else { return }
        guard let thread = result["thread"] as? [String: Any], thread["id"] as? String == id else { throw ClientError.message("远端返回的会话标识不一致，请刷新会话列表。") }
        if workspace != nil, let cwd = thread["cwd"] as? String, SessionSettings.parent(thread) == nil, !WorkspaceCatalog.sameDirectory(cwd, settings.project) {
            guard !projectActionInFlight else { throw ClientError.message("会话属于其他项目，请从对应项目打开。") }
            var target = settings; target.project = cwd; try target.validate()
            let project = try workspaceCatalog.add(target)
            workspace = try workspaceCatalog.load(seed: settings)
            selectedThread = previousThread
            try await switchProject(project.id, requestedThread: id)
            return
        }
        emit("thread", ["thread": thread])
        saveSelection(id)
        publishSettings(id, value: thread)
        await watchAgents(thread)
        guard selectedThread == id, selection == selectionEpoch else { return }
        watchGoal(id)
        watchPlan(id)
        emitAccess(id, writableThreads.contains(id) ? "writable" : "viewing")
        if writableThreads.contains(id) { try await history(id) }
        else { try await readAndFollow(id) }
        await refreshRuntime(id)
    }
    private func refreshRuntime(_ id: String) async {
        guard rpc.persistentRuntime else { return }
        let generation = epoch
        if rpc.officialDaemon {
            do {
                let settingsVersion = settingsVersions[id, default: 0]
                let metadata = try await rpc.request("thread/read", params: ["threadId": id, "includeTurns": false])
                guard generation == epoch, let thread = metadata["thread"] as? [String: Any], let status = thread["status"] as? [String: Any] else { return }
                if settingsVersion == settingsVersions[id, default: 0] { publishSettings(id, value: thread) }
                let running = status["type"] as? String == "active"
                var current: String?
                let controlled = writableThreads.contains(id) && rpc.controlledThreads.contains(id)
                if controlled && running {
                    let turns = try await rpc.request("thread/turns/list", params: ["threadId": id, "limit": 1, "itemsView": "summary"])
                    current = (turns["data"] as? [[String: Any]])?.first(where: { $0["status"] as? String == "inProgress" })?["id"] as? String
                }
                guard generation == epoch else { return }
                var value: [String: Any] = ["threadId": id, "managed": status["type"] as? String != "notLoaded", "controlled": controlled, "pendingApprovals": (status["activeFlags"] as? [String] ?? []).contains("waitingOnApproval") ? 1 : 0]
                value["running"] = running
                value["activeTurn"] = current as Any? ?? NSNull()
                runtimeState(value)
            } catch { /* Goal/history reads remain available during a transient status failure. */ }
            return
        }
        if let result = try? await rpc.request("runtime/state", params: ["threadId": id]), generation == epoch { runtimeState(result) }
    }
    private func runtimeState(_ value: [String: Any]) {
        guard let id = value["threadId"] as? String else { return }
        emit("runtimeState", value)
        if let plan = value["plan"] as? [String: Any] { emit("planProgress", plan) }
        if value["controlled"] as? Bool == true, writableThreads.contains(id) {
            if let turn = value["activeTurn"] as? String { activeTurns[id] = turn; emit("turn", ["threadId": id, "turn": ["id": turn, "status": "inProgress"]]) }
            else if value["running"] as? Bool != true { activeTurns.removeValue(forKey: id); emit("turn", ["threadId": id, "turn": ["status": "completed"]]) }
        }
    }
    private func emitAccess(_ id: String, _ mode: String) { emit("threadAccess", ["threadId": id, "mode": mode]) }

    private func publishGoal(_ id: String, goal: Any) {
        guard !id.isEmpty, let data = try? JSONSerialization.data(withJSONObject: goal, options: [.sortedKeys, .fragmentsAllowed]), goalDigests[id] != data else { return }
        goalDigests[id] = data
        goalVersions[id, default: 0] += 1
        emit("goal", ["threadId": id, "goal": goal])
    }
    private func readGoal(_ id: String) async {
        let generation = epoch, version = goalVersions[id, default: 0]
        do {
            let result = try await rpc.request("thread/goal/get", params: ["threadId": id])
            guard generation == epoch, version == goalVersions[id, default: 0] else { return }
            publishGoal(id, goal: result["goal"] ?? NSNull())
            if rpc.officialDaemon { await refreshRuntime(id) }
        } catch {
            guard generation == epoch, selectedThread == id else { return }
            emit("goalUnavailable", ["threadId": id, "message": error.localizedDescription])
        }
    }
    private func watchGoal(_ id: String) {
        goalWatch?.cancel(); let generation = epoch
        goalWatch = Task { @MainActor [weak self] in
            await self?.readGoal(id)
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 4_000_000_000) } catch { return }
                guard let self, generation == self.epoch, self.selectedThread == id else { return }
                if !self.writableThreads.contains(id) { await self.readGoal(id) }
            }
        }
    }
    private func command(_ body: [String: Any]) async throws {
        let operation = body["operation"] as? String ?? ""
        if operation == "getGoal", let id = body["threadId"] as? String {
            await readGoal(id); attachmentReply(body); return
        }
        guard !commandInFlight, !sendInFlight, settingsInFlight.isEmpty else { throw ClientError.message("正在处理上一项操作，请稍候。") }
        commandInFlight = true; defer { commandInFlight = false }
        let generation = epoch, target = settings
        // Validate before creating a thread or requesting its writer lease.
        _ = try ThreadCommands.goalParameters(body, threadID: "validation")
        var threadID = body["threadId"] as? String
        if threadID == nil {
            guard operation == "setGoal" else { throw ClientError.message("当前对话尚未设置目标。") }
            let ids = body["attachmentIds"] as? [String] ?? []
            _ = try attachments.resolve(ids.filter { projectReferences[$0] == nil }, draftKey: "new")
            let config = try await planReader.prepare(settings: target)
            guard generation == epoch else { throw ClientError.message("连接已变化，目标草稿已保留。") }
            var start: [String: Any] = ["cwd": target.project, "approvalPolicy": "on-request", "sandbox": "workspace-write", "config": config]
            if let model = body["model"] as? String, !model.isEmpty { start["model"] = model }
            start.merge(try SessionSettings.serviceTier(body, model: body["model"] as? String ?? threadModels["new"] ?? "", catalog: modelCatalog)) { _, new in new }
            let result = try await rpc.request("thread/start", params: start)
            guard generation == epoch, let thread = result["thread"] as? [String: Any], let id = thread["id"] as? String else { throw ClientError.message("连接已变化，目标草稿已保留，请重试。") }
            threadID = id; follower.stop(); writableThreads.insert(id); selectedThread = id; publishSettings(id, value: result)
            saveSelection(id)
            attachments.moveDraft(ids, from: "new", to: id)
            for asset in ids { if let ref = projectReferences[asset] { projectReferences[asset] = ProjectReference(draftKey: id, host: ref.host, project: ref.project, path: ref.path, name: ref.name) } }
            emit("thread", ["thread": thread, "draftFrom": "new"]); emitAccess(id, "writable"); watchGoal(id); watchPlan(id); await watchAgents(thread)
        }
        guard let id = threadID, selectedThread == id else { throw ClientError.message("对话已切换，请在目标所属对话中重试。") }
        guard try await acquireWriteAccess(id) else { throw ClientError.message("其他连接仍在使用此会话，目标未修改。原连接释放后可继续。") }
        guard generation == epoch, selectedThread == id else { throw ClientError.message("连接或对话已变化，目标未修改。") }
        let params = try ThreadCommands.goalParameters(body, threadID: id)
        if params["status"] as? String == "active" || operation == "resumeGoal" {
            let selectedModel = body["model"] as? String ?? ""
            let mode = try ThreadCommands.collaborationMode("default", model: selectedModel.isEmpty ? threadModels[id] ?? "" : selectedModel, presets: modePresets, effort: body["effort"] as? String ?? threadEfforts[id])
            var goalSettings: [String: Any] = ["threadId": id, "collaborationMode": mode]
            goalSettings.merge(try SessionSettings.serviceTier(body, model: selectedModel.isEmpty ? threadModels[id] ?? "" : selectedModel, catalog: modelCatalog)) { _, new in new }
            _ = try await rpc.request("thread/settings/update", params: goalSettings)
            if !selectedModel.isEmpty { threadModels[id] = selectedModel }
            if let effort = body["effort"] as? String, !effort.isEmpty { threadEfforts[id] = effort }
            emit("collaborationMode", ["threadId": id, "mode": "default", "force": true])
        }
        let result = try await rpc.request(operation == "clearGoal" ? "thread/goal/clear" : "thread/goal/set", params: params)
        publishGoal(id, goal: result["goal"] ?? NSNull())
        if operation == "pauseGoal", let turn = activeTurns[id] {
            _ = try? await rpc.request("turn/interrupt", params: ["threadId": id, "turnId": turn])
        }
        attachmentReply(body, value: ["threadId": id, "goal": result["goal"] ?? NSNull()])
        Task { @MainActor [weak self] in guard self?.epoch == generation else { return }; try? await self?.listThreads() }
    }

    private func readAndFollow(_ id: String) async throws {
        let selection = selectionEpoch
        guard selectedThread == id, readOnlyLoads[id] != selection else { return }
        readOnlyLoads[id] = selection
        defer { if readOnlyLoads[id] == selection { readOnlyLoads.removeValue(forKey: id) } }
        await rpc.stopObserving(except: id)
        guard selectedThread == id, selection == selectionEpoch else { return }
        let runVersion = runVersions[id, default: 0]
        if let value = try? await rpc.observeLoadedThread(id) {
            if selectedThread == id, selection == selectionEpoch { publishSettings(id, value: value) }
            let page = value["initialTurnsPage"] as? [String: Any] ?? [:]
            if runVersion == runVersions[id, default: 0], let latest = (page["data"] as? [[String: Any]])?.first { emit("runSnapshot", ["threadId": id, "turn": RunPresentation.turn(latest)]) }
            for turn in page["data"] as? [[String: Any]] ?? [] {
                let items = turn["items"] as? [[String: Any]] ?? []
                for (index, original) in items.enumerated() where ["commandExecution", "reasoning"].contains(original["type"] as? String ?? "") {
                    var item = original
                    if item["type"] as? String == "commandExecution" { item["observedAtMs"] = Date().timeIntervalSince1970 * 1000 }
                    else { item["status"] = turn["status"] as? String == "inProgress" && index == items.count - 1 ? "inProgress" : "completed" }
                    if let visible = Self.displayItem(item) { emit("item", ["threadId": id, "item": visible]) }
                }
            }
        }
        guard selectedThread == id, selection == selectionEpoch else { return }
        var ready = false
        do { try await follower.prepare(id); ready = true }
        catch { if selectedThread == id, selection == selectionEpoch { emit("threadSync", ["threadId": id, "status": "unavailable"]) } }
        guard selectedThread == id, selection == selectionEpoch else { return }
        try await history(id)
        guard selectedThread == id, selection == selectionEpoch, ready, !writableThreads.contains(id) else { return }
        follower.start(id)
    }

    private func acquireWriteAccess(_ id: String) async throws -> Bool {
        let generation = epoch
        if agentParents[id] != nil { throw ClientError.message("子代理由父会话管理，这里仅提供只读查看。") }
        if writableThreads.contains(id) { return true }
        guard !resumingThreads.contains(id) else { throw ClientError.message("正在尝试继续此会话，请稍候。") }
        selectionEpoch = UUID(); follower.stop()
        resumingThreads.insert(id); defer { resumingThreads.remove(id) }
        emitAccess(id, "resuming")
        do {
            let metadata = try await rpc.request("thread/read", params: ["threadId": id, "includeTurns": false])
            guard generation == epoch else { throw ClientError.message("连接已变化，请重新点击继续。") }
            guard let thread = metadata["thread"] as? [String: Any], thread["id"] as? String == id else { throw ClientError.message("远端返回的会话标识不一致，未尝试继续该会话。") }
            guard SessionSettings.parent(thread) == nil else { throw ClientError.message("子代理由父会话管理，这里仅提供只读查看。") }
            // Only an explicit Continue/Send action joins the daemon's live thread.
            let resumed = try await rpc.request("thread/resume", params: ["threadId": id, "excludeTurns": true])
            guard generation == epoch else { throw ClientError.message("连接已变化，请重新点击继续。") }
            publishSettings(id, value: resumed)
            if let mode = resumed["collaborationMode"] as? [String: Any] { emit("collaborationMode", ["threadId": id, "mode": mode["mode"] ?? "default"]) }
            writableThreads.insert(id)
            emitAccess(id, "writable")
            try await history(id)
            await refreshRuntime(id)
            return true
        } catch {
            if error.localizedDescription.lowercased().contains("active writer") {
                writableThreads.remove(id); activeTurns.removeValue(forKey: id)
                emitAccess(id, "busy")
                emit("sendBlocked", ["threadId": id])
                // History remains readable even while another process owns the writer.
                // Resuming is still marked in-flight until this method returns;
                // the follower waits for that guard before its first read.
                try? await readAndFollow(id)
                return false
            }
            emitAccess(id, writableThreads.contains(id) ? "writable" : "viewing")
            if !writableThreads.contains(id), selectedThread == id { try? await readAndFollow(id) }
            throw error
        }
    }
    private func history(_ id: String, cursor: Any? = nil) async throws {
        // A programming turn can contain hundreds of tools and megabytes of output.
        // Keep pages small and allow only one history request per conversation.
        guard historyRequests.insert(id).inserted else { return }
        let generation = epoch, runVersion = runVersions[id, default: 0]
        emit("historyLoading", ["threadId": id, "loading": true])
        defer {
            if generation == epoch {
                historyRequests.remove(id)
                emit("historyLoading", ["threadId": id, "loading": false])
            }
        }
        var params: [String: Any] = ["threadId": id, "limit": 3, "sortDirection": "desc", "itemsView": "full"]
        if let cursor, !(cursor is NSNull) { params["cursor"] = cursor }
        let result = try await rpc.request("thread/turns/list", params: params)
        guard generation == epoch else { return }
        let turns = result["data"] as? [[String: Any]] ?? []
        if cursor == nil, runVersion == runVersions[id, default: 0], let latest = turns.first { emit("runSnapshot", ["threadId": id, "turn": RunPresentation.turn(latest)]) }
        let rawItems = turns.reversed().flatMap { turn -> [[String: Any]] in
            // Persisted in-progress turns may belong to another process. Runtime
            // notifications from threads we own are the source of cancellable turns.
            return turn["items"] as? [[String: Any]] ?? []
        }
        follower.observe(id, items: rawItems)
        observeViewedImages(rawItems, thread: id)
        let items = rawItems.compactMap(Self.displayItem)
        emit("history", ["threadId": id, "items": items, "prepend": cursor != nil, "nextCursor": result["nextCursor"] ?? NSNull()])
    }
    // Only transport fields that the transcript can display. Full tool output is
    // retained for expansion; raw reasoning/telemetry never enter the WebView.
    static func displayItem(_ item: [String: Any]) -> [String: Any]? {
        let fields: [String]
        switch item["type"] as? String {
        case "reasoning": return RunPresentation.summary(item)
        case "userMessage":
            let content = (item["content"] as? [[String: Any]] ?? []).map { part -> [String: Any] in
                var value: [String: Any] = ["type": part["type"] ?? "", "text": part["text"] ?? ""]
                if let path = part["path"] as? String, path.count < 4096 { value["path"] = path }
                if let url = part["url"] as? String, url.count < 4096, url.hasPrefix("file:") { value["url"] = url }
                return value
            }
            return ["id": item["id"] ?? "", "type": "userMessage", "content": content]
        case "agentMessage", "plan": fields = ["id", "type", "text", "questions"]
        case "collabAgentToolCall": fields = ["id", "type", "tool", "status", "senderThreadId", "receiverThreadIds", "agentsStates", "prompt", "model", "reasoningEffort"]
        case "subAgentActivity": fields = ["id", "type", "agentPath", "agentThreadId", "kind", "model", "reasoningEffort"]
        case "commandExecution": fields = ["id", "type", "command", "commandActions", "cwd", "status", "aggregatedOutput", "exitCode", "durationMs", "startedAtMs", "completedAtMs", "observedAtMs", "source"]
        case "fileChange": fields = ["id", "type", "changes"]
        case "mcpToolCall": fields = ["id", "type", "server", "tool", "status", "result", "error"]
        case "imageView": fields = ["id", "type", "path", "status"]
        default: return nil
        }
        return item.filter { fields.contains($0.key) }
    }
    @discardableResult private func send(_ body: [String: Any], shell: Bool = false) async throws -> Bool {
        guard !projectActionInFlight, !sendInFlight, !commandInFlight, settingsInFlight.isEmpty else { throw ClientError.message("正在处理上一项操作，请稍候。") }
        sendInFlight = true; defer { sendInFlight = false }
        let generation = epoch, targetSettings = settings
        let draftKey = body["threadId"] as? String ?? "new", ids = body["attachmentIds"] as? [String] ?? []
        guard ids.count <= AttachmentStore.countLimit, Set(ids).count == ids.count else { throw ClientError.message("附件数量或标识无效。") }
        let localIDs = ids.filter { projectReferences[$0] == nil }, files = try attachments.resolve(localIDs, draftKey: draftKey)
        guard localIDs.allSatisfy({ attachmentScopes[$0] == nil || attachmentScopes[$0] == DraftStore.scope(targetSettings) }) else { throw ClientError.message("附件属于其他连接，请重新添加。") }
        for id in ids { if let ref = projectReferences[id], ref.draftKey != draftKey || ref.host != targetSettings.host || ref.project != targetSettings.project { throw ClientError.message("远端文件所属连接已变化，请重新选择。") } }
        guard let text = body["text"] as? String, (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !ids.isEmpty), text.utf8.count < 200_000 else { throw ClientError.message("消息为空或超过长度限制。") }
        let shellText = shell ? try ShellCommand.parse(text, attachmentIDs: ids) : nil
        if shell, (body["threadId"] as? String) != selectedThread { throw ClientError.message("会话已切换，命令未执行，草稿已保留。") }
        var id = body["threadId"] as? String
        if id == nil {
            let config = try await planReader.prepare(settings: targetSettings)
            guard generation == epoch else { throw ClientError.message("连接已变化，附件和草稿已保留，请重试发送。") }
            var start: [String: Any] = ["cwd": targetSettings.project, "approvalPolicy": "on-request", "sandbox": "workspace-write", "config": config]
            start.merge(try SessionSettings.serviceTier(body, model: body["model"] as? String ?? threadModels["new"] ?? "", catalog: modelCatalog)) { _, new in new }
            let result = try await rpc.request("thread/start", params: start)
            guard generation == epoch else { throw ClientError.message("连接已变化，附件和草稿已保留，请重试发送。") }
            guard let thread = result["thread"] as? [String: Any], let createdID = thread["id"] as? String else { throw ClientError.message("创建远端会话失败。") }
            id = createdID; follower.stop(); writableThreads.insert(createdID); selectedThread = createdID
            saveSelection(createdID)
            publishSettings(createdID, value: result)
            attachments.moveDraft(ids, from: "new", to: createdID)
            for attachmentID in ids { if let ref = projectReferences[attachmentID] { projectReferences[attachmentID] = ProjectReference(draftKey: createdID, host: ref.host, project: ref.project, path: ref.path, name: ref.name) } }
            emit("thread", ["thread": thread]); emitAccess(createdID, "writable")
            watchGoal(createdID)
            watchPlan(createdID)
            await watchAgents(thread)
        }
        guard let id else { throw ClientError.message("未选择远端会话。") }
        if let requested = body["threadId"] as? String, selectedThread != requested { throw ClientError.message("会话已切换，草稿已保留。") }
        guard try await acquireWriteAccess(id) else { return false }
        if let shellText {
            guard generation == epoch, selectedThread == id else { throw ClientError.message("连接或会话已变化，命令未发送。") }
            _ = try await rpc.request("thread/shellCommand", params: ["threadId": id, "command": shellText])
            guard generation == epoch else { throw ClientError.message("连接已变化，命令结果待确认，请查看记录后再决定是否重试。") }
            emit("sendAccepted", ["threadId": id, "attachmentIds": [], "requestId": body["requestId"] ?? ""])
            return true
        }
        sendingAttachments.formUnion(ids); defer { sendingAttachments.subtract(ids) }
        var metadata: [[String: Any]] = []
        for attachmentID in ids {
            if let ref = projectReferences[attachmentID] { metadata.append(["name": ref.name, "path": ref.path, "source": "project", "isImage": ref.isImage]); continue }
            guard let file = files.first(where: { $0.id == attachmentID }) else { throw ClientError.message("附件已失效。") }
            emit("attachmentProgress", ["draftKey": draftKey, "id": file.id, "status": "uploading"])
            do {
                let pathKey = targetSettings.host + ":" + file.id
                let path: String
                if let cached = attachmentPaths[pathKey] { path = cached }
                else { path = try await attachmentTransport.upload(file, settings: targetSettings); attachmentPaths[pathKey] = path }
                metadata.append(["name": file.name, "path": path, "size": file.size, "isImage": file.isImage])
                var status: [String: Any] = ["draftKey": draftKey, "id": file.id, "status": "uploaded", "path": path]
                if let thumbnail = file.thumbnail { status["thumbnail"] = thumbnail }
                emit("attachmentProgress", status)
            } catch { emit("attachmentProgress", ["draftKey": draftKey, "id": file.id, "status": "ready", "message": "上传失败，可重试发送"]); throw error }
        }
        guard generation == epoch, writableThreads.contains(id) else { throw ClientError.message("连接已变化，附件和草稿已保留，请重试发送。") }
        var input = try Self.attachmentInput(text: text, files: metadata)
        let mode = body["mode"] as? String ?? "default"
        if rpc.officialDaemon {
            // Another subscribed client may have started or completed a turn since our last event.
            let turns = try await rpc.request("thread/turns/list", params: ["threadId": id, "limit": 1, "sortDirection": "desc", "itemsView": "summary"])
            guard generation == epoch else { throw ClientError.message("连接已变化，草稿已保留，请重新查看记录。") }
            guard let rows = turns["data"] as? [[String: Any]] else { throw ClientError.message("无法确认当前任务状态，草稿已保留，请稍后重试。") }
            activeTurns[id] = rows.first(where: { $0["status"] as? String == "inProgress" })?["id"] as? String
        }
        let intendedTurn = activeTurns[id]
        let route = try await messageRouting.prepare(thread: id, expectedTurn: intendedTurn,
            selection: body["messageSelection"] as? [String: Any], project: targetSettings.project)
        guard generation == epoch else { throw ClientError.message("连接已变化，草稿已保留。") }
        // Official clients recognize async answers only when their reply marker is intact.
        // Their route is still registered/bound; MCP resolves it using transport identity.
        if let route, body["asyncQuestionReply"] as? Bool != true { input[0]["text"] = (input[0]["text"] as? String ?? "") + (try route.annotation()) }
        var acceptedTurn = intendedTurn
        if let turn = intendedTurn {
            guard mode != "plan" else { throw ClientError.message("当前任务结束后才能进入计划模式，草稿已保留。") }
            _ = try await rpc.request("turn/steer", params: ["threadId": id, "expectedTurnId": turn, "input": input])
        } else {
            var params: [String: Any] = ["threadId": id, "input": input]
            if let model = body["model"] as? String, !model.isEmpty { params["model"] = model }
            let model = body["model"] as? String ?? ""
            params.merge(try SessionSettings.serviceTier(body, model: model.isEmpty ? threadModels[id] ?? "" : model, catalog: modelCatalog)) { _, new in new }
            params["collaborationMode"] = try ThreadCommands.collaborationMode(mode, model: model.isEmpty ? threadModels[id] ?? "" : model, presets: modePresets, effort: body["effort"] as? String ?? threadEfforts[id])
            let result = try await rpc.request("turn/start", params: params)
            if !model.isEmpty { threadModels[id] = model }
            if let effort = body["effort"] as? String, !effort.isEmpty { threadEfforts[id] = effort }
            publishSettings(id, value: [:])
            if let turn = result["turn"] as? [String: Any], let turnID = turn["id"] as? String { activeTurns[id] = turnID; acceptedTurn = turnID; emit("turn", ["threadId": id, "turn": RunPresentation.turn(turn)]) }
        }
        await messageRouting.bind(route, turn: acceptedTurn)
        attachments.accepted(ids)
        ids.forEach { projectReferences.removeValue(forKey: $0) }
        emit("sendAccepted", ["threadId": id, "attachmentIds": ids, "requestId": body["requestId"] ?? ""])
        Task { @MainActor [weak self] in guard self?.epoch == generation else { return }; try? await self?.listThreads() }
        return true
    }
    static func attachmentInput(text: String, files: [[String: Any]]) throws -> [[String: Any]] {
        var prompt = text
        if !files.isEmpty {
            let json = String(data: try JSONSerialization.data(withJSONObject: files, options: [.sortedKeys]), encoding: .utf8)!
            prompt += "\n\n本次附件位于远端，可按需读取：\n<remote_codex_attachments>\n" + json + "\n</remote_codex_attachments>"
        }
        var input: [[String: Any]] = [["type": "text", "text": prompt]]
        for file in files where file["isImage"] as? Bool == true { if let path = file["path"] as? String { input.append(["type": "localImage", "path": path]) } }
        return input
    }
    static func projectPath(_ path: String, root: String) -> String? {
        let base = root == "/" ? "" : root.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let absoluteRoot = base.isEmpty ? "" : "/" + base
        let full = path.hasPrefix("/") ? path : absoluteRoot + "/" + path
        guard !full.contains("\0"), !full.split(separator: "/").contains(".."), full.hasPrefix(absoluteRoot + "/") else { return nil }
        return full
    }
    func notification(_ method: String, _ params: [String: Any]) {
        let thread = params["threadId"] as? String ?? ""
        switch method {
        case "account/login/completed":
            let success = remoteAccount.completed(params)
            if remoteAccount.login == nil { accountWatch?.cancel() }
            if success {
                emit("usageChanged", [:])
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    await self.refreshAccountMetadata()
                    if !self.connected { await self.connect() }
                }
            }
        case "account/updated":
            emit("usageChanged", [:])
            Task { @MainActor [weak self] in await self?.refreshAccountMetadata() }
        case "account/rateLimits/updated": emit("usageChanged", [:])
        case "thread/tokenUsage/updated": emit("threadTokenUsage", params)
        case "runtime/stateChanged": runtimeState(params)
        case "runtime/unavailable": emit("connection", ["status": "error", "message": params["message"] ?? "远端服务不可用。"])
        case "thread/goal/updated": publishGoal(thread, goal: params["goal"] ?? NSNull())
        case "thread/goal/cleared": publishGoal(thread, goal: NSNull())
        case "turn/plan/updated": planFollower.observeLive(thread, plan: params); emit("planProgress", params)
        case "thread/closed":
            writableThreads.remove(thread); activeTurns.removeValue(forKey: thread); emitAccess(thread, "viewing")
            if selectedThread == thread { Task { try? await self.readAndFollow(thread) } }
        case "turn/started":
            runVersions[thread, default: 0] += 1
            if let turn = params["turn"] as? [String: Any], let id = turn["id"] as? String { planFollower.observeTurn(thread, turn: id) }
            if writableThreads.contains(thread), let turn = params["turn"] as? [String: Any], let id = turn["id"] as? String { activeTurns[thread] = id }
            if let turn = params["turn"] as? [String: Any] { emit("turn", ["threadId": thread, "turn": RunPresentation.turn(turn)]) }
        case "turn/completed":
            runVersions[thread, default: 0] += 1; activeTurns.removeValue(forKey: thread)
            if let turn = params["turn"] as? [String: Any] { emit("turn", ["threadId": thread, "turn": RunPresentation.turn(turn)]) }
        case "item/started", "item/completed":
            var value = params
            if var item = params["item"] as? [String: Any], item["type"] as? String == "reasoning" {
                item["status"] = method == "item/started" ? "inProgress" : "completed"
                value["item"] = RunPresentation.summary(item)
            }
            if var item = params["item"] as? [String: Any], item["type"] as? String == "commandExecution" {
                item["status"] = item["status"] ?? (method == "item/started" ? "inProgress" : "completed")
                item["startedAtMs"] = params["startedAtMs"]
                item["completedAtMs"] = params["completedAtMs"]
                value["item"] = Self.displayItem(item)
            }
            if var item = params["item"] as? [String: Any], item["type"] as? String == "imageView" {
                item["status"] = method == "item/started" ? "inProgress" : "completed"
                observeViewedImages([item], thread: thread); value["item"] = Self.displayItem(item)
            }
            if let item = value["item"] as? [String: Any], let safe = Self.displayItem(item) { value["item"] = safe; emit("item", value) }
        case "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded":
            runVersions[thread, default: 0] += 1
            var value = params.filter { ["threadId", "turnId", "itemId", "summaryIndex", "delta"].contains($0.key) }
            if let delta = value["delta"] as? String { value["delta"] = String(delta.prefix(32000)) }
            emit("reasoningSummary", value)
        case "item/agentMessage/delta": emit("delta", params)
        case "item/commandExecution/outputDelta": emit("commandOutput", params)
        case "turn/diff/updated": emit("diff", params)
        case "serverRequest/resolved":
            if let id = params["requestId"], let token = questions.resolve(id) { questionAttention.resolve(token); emit("approvalAnswered", ["token": token]) }
        case "thread/settings/updated": if let value = params["threadSettings"] as? [String: Any] { publishSettings(thread, value: value) }
        case "thread/status/changed": emit("threadStatus", params)
        case "thread/name/updated": Task { try? await self.listThreads() }
        case "error":
            runVersions[thread, default: 0] += 1
            emit("runError", ["error": RunPresentation.error(params["error"] as? [String: Any] ?? [:]), "threadId": thread, "turnId": params["turnId"] ?? "", "willRetry": params["willRetry"] as? Bool ?? false])
        default: break
        }
    }
    private func publishSettings(_ id: String, value: [String: Any]) {
        if let model = value["model"] as? String { threadModels[id] = model }
        if let effort = value["reasoningEffort"] as? String ?? value["effort"] as? String { threadEfforts[id] = effort }
        else if value["reasoningEffort"] is NSNull || value["effort"] is NSNull { threadEfforts.removeValue(forKey: id) }
        if let tier = value["serviceTier"] as? String { threadServiceTiers[id] = tier }
        else if value["serviceTier"] is NSNull { threadServiceTiers[id] = "default" }
        let result: [String: Any] = ["threadId": id, "model": threadModels[id] as Any? ?? NSNull(), "effort": threadEfforts[id] as Any? ?? NSNull(), "serviceTier": threadServiceTiers[id] as Any? ?? NSNull()]
        guard let digest = try? JSONSerialization.data(withJSONObject: result, options: .sortedKeys), settingsDigests[id] != digest else { return }
        settingsDigests[id] = digest; settingsVersions[id, default: 0] += 1; emit("threadSettings", result)
    }
    private func updateThreadSettings(_ body: [String: Any]) async throws {
        guard let id = body["threadId"] as? String, selectedThread == id, !sendInFlight, !commandInFlight, settingsInFlight.insert(id).inserted else { throw ClientError.message("请等待当前操作完成后再切换模型。") }
        defer { settingsInFlight.remove(id) }
        let generation = epoch, model = body["model"] as? String ?? threadModels[id] ?? "", effort = body["effort"] as? String
        if body["model"] != nil || body["effort"] != nil { try SessionSettings.validate(model: model, effort: effort, catalog: modelCatalog) }
        let tier = try SessionSettings.serviceTier(body, model: model, catalog: modelCatalog)
        guard body["model"] != nil || body["effort"] != nil || !tier.isEmpty else { throw ClientError.message("没有需要修改的设置。") }
        guard try await acquireWriteAccess(id), generation == epoch, selectedThread == id else { throw ClientError.message("其他连接正在使用此会话，设置未修改。") }
        var params: [String: Any] = ["threadId": id]
        if body["model"] != nil { params["model"] = model }
        if let effort, !effort.isEmpty { params["effort"] = effort }
        params.merge(tier) { _, new in new }
        _ = try await rpc.request("thread/settings/update", params: params)
        // Thread metadata omits serviceTier. A same-thread resume with no overrides
        // reads the effective settings without starting or interrupting a turn.
        let result = try await rpc.request("thread/resume", params: ["threadId": id, "excludeTurns": true])
        guard generation == epoch, let thread = result["thread"] as? [String: Any] else { throw ClientError.message("连接已变化，重连后会读取最新设置。") }
        guard thread["id"] as? String == id else { throw ClientError.message("设置返回的会话不一致。") }
        publishSettings(id, value: result)
        attachmentReply(body, value: ["model": threadModels[id] as Any? ?? NSNull(), "effort": threadEfforts[id] as Any? ?? NSNull(), "serviceTier": threadServiceTiers[id] as Any? ?? NSNull()])
    }
    private func watchAgents(_ thread: [String: Any]) async {
        let generation = epoch, selection = selectionEpoch
        guard let id = thread["id"] as? String else { return }
        var current = thread, root = id, seen = Set<String>()
        while let parent = SessionSettings.parent(current), seen.insert(parent).inserted, seen.count <= 16 {
            if let child = current["id"] as? String { agentParents[child] = parent }
            root = parent
            guard let result = try? await rpc.request("thread/read", params: ["threadId": parent, "includeTurns": false]), let value = result["thread"] as? [String: Any] else { break }
            current = value
        }
        guard generation == epoch, selection == selectionEpoch, selectedThread == id else { return }
        if root != id { agentRoots[id] = root }
        agentRoot = root
        emit("agentContext", ["threadId": id, "rootThreadId": root, "parentThreadId": SessionSettings.parent(thread) as Any? ?? NSNull()])
        agentFollower.start(root)
    }
    private func ownsRequestThread(_ id: String) -> Bool { rpc.controlledThreads.contains(id) && (writableThreads.contains(id) || resumingThreads.contains(id)) }
    private func requestOwner(_ id: String) async -> String? {
        if ownsRequestThread(id) { return id }
        var current = id, seen = Set<String>()
        for _ in 0..<16 {
            guard seen.insert(current).inserted,
                  let response = try? await rpc.request("thread/read", params: ["threadId": current, "includeTurns": false]), let thread = response["thread"] as? [String: Any], thread["id"] as? String == current,
                  let parent = SessionSettings.parent(thread) else { return nil }
            if ownsRequestThread(parent) { return parent }; current = parent
        }
        return nil
    }
    func serverRequest(_ id: Any, _ method: String, _ params: [String: Any]) {
        guard ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "tool/requestUserInput", "item/tool/requestUserInput"].contains(method) else {
            if let thread = params["threadId"] as? String, rpc.observingThreads.contains(thread), !ownsRequestThread(thread) { return }
            // Do not reject another subscriber's app-specific tools on its behalf.
            if !rpc.isSharedServerRequest(id) { rpc.reject(id: id, reason: "This desktop client does not support this server request.") }
            emit("error", ["message": rpc.isSharedServerRequest(id) ? "此请求需在原官方客户端处理：\(method)" : "远端请求暂不支持：\(method)"])
            return
        }
        let request = questions.insert(id: id, method: method, params: params), generation = epoch
        Task { @MainActor [weak self] in
            guard let self else { return }
            let owner = await self.requestOwner(params["threadId"] as? String ?? "")
            guard generation == self.epoch, self.questions.entries[request.token] != nil else { return }
            self.questions.authorize(request.token, owner: owner)
            self.emit("approval", ["token": request.token, "method": method, "params": params, "canAnswer": owner != nil, "ownerThreadId": owner as Any? ?? NSNull()])
            if let source = params["threadId"] as? String, !source.isEmpty {
                self.questionAttention.receive(.init(token: request.token, thread: owner ?? source, sourceThread: source, isQuestion: method.hasSuffix("requestUserInput")))
            }
        }
    }
    private func answerApproval(_ body: [String: Any]) throws {
        guard let token = body["token"] as? String, let request = questions.entries[token] else { throw ClientError.message("该请求已结束，请查看最新回复。") }
        guard let owner = request.owner, ownsRequestThread(owner) else { throw ClientError.message("此请求属于原写入连接，请在那里回答，或等待原连接释放后继续。") }
        if ["tool/requestUserInput", "item/tool/requestUserInput"].contains(request.method) {
            let answers = try PendingQuestionStore.answers(body, questions: request.params["questions"] as? [[String: Any]] ?? [])
            try rpc.respond(id: request.id, result: ["answers": answers])
        } else {
            guard let decision = body["decision"] as? String, ["accept", "decline", "cancel"].contains(decision) else { throw ClientError.message("无效的审批选择。") }
            try rpc.respond(id: request.id, result: ["decision": decision])
        }
        questions.remove(token); questionAttention.resolve(token); emit("approvalAnswered", ["token": token])
    }
    private func listConversations() async throws {
        guard gatewayConnected else { return }
        emit("conversations", try await gateway.request("/conversations"))
    }
    private func messageMediaAction(_ action: String, body: [String: Any]) async throws {
        guard let id = body["mediaId"] as? String, UUID(uuidString: id) != nil, let conversation = body["conversationId"] as? String else { throw ClientError.message("媒体信息不完整。") }
        let target = settings, scope = DraftStore.scope(settings), draft = body["draftKey"] as? String
        let query = conversation.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "+&=?#"))) ?? ""
        let messages = try await gateway.request("/messages?conversation_id=" + query)["messages"] as? [[String: Any]] ?? []
        guard let message = messages.first(where: { ($0["media"] as? [String: Any])?["id"] as? String == id }), message["status"] as? String != "deleted", let media = message["media"] as? [String: Any], (media["available"] as? Bool == true || media["available"] as? Int == 1) else { throw ClientError.message("媒体已失效、撤回或不属于此聊天。旧记录需要从手机重新发送。") }
        let key = target.host + ":" + String(target.gatewayPort) + ":" + id
        let entry: MessageMediaCache.Entry
        if let cached = messageMediaCache.cached(key) { entry = cached }
        else { entry = try messageMediaCache.put(try await gateway.downloadMedia(id), metadata: media, key: key) }
        guard settings.host == target.host, settings.gatewayPort == target.gatewayPort else { throw CancellationError() }
        if action == "messageMediaPreview" { preview(entry.url) }
        if action == "messageMediaSave" {
            let panel = NSSavePanel(); panel.nameFieldStringValue = media["name"] as? String ?? "attachment"; panel.canCreateDirectories = true
            let response = await panel.beginSheetModal(for: web?.window ?? NSWindow())
            if response == .OK, let destination = panel.url { try Data(contentsOf: entry.url).write(to: destination, options: .atomic) }
        }
        if action == "messageMediaQuote" {
            guard DraftStore.scope(settings) == scope, let draft, draft == (selectedThread ?? "new"), body["draftScope"] as? String == scope else { throw ClientError.message("Codex 会话已切换，请重新引用。") }
            let file = try await attachments.importMedia(entry.url, name: media["name"] as? String ?? entry.url.lastPathComponent, draftKey: draft)
            guard DraftStore.scope(settings) == scope, draft == (selectedThread ?? "new") else { attachments.remove(file.id); throw CancellationError() }
            attachmentScopes[file.id] = scope; attachmentReply(body, value: ["attachment": file.payload]); return
        }
        attachmentReply(body, value: entry.payload)
    }
    private func sendMessage(_ body: [String: Any]) async throws {
        guard let id = body["conversationId"] as? String, let text = body["text"] as? String, let key = body["idempotencyKey"] as? String, !sendingMessages.contains(id),
              body["draftScope"] as? String == DraftStore.scope(settings) || body["draftScope"] == nil else { throw ClientError.message("回复信息无效或上一条消息正在发送。") }
        let ids = body["attachmentIds"] as? [String] ?? []
        guard ids.count <= 1, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !ids.isEmpty else { throw ClientError.message("添加文字或一个附件后再发送。") }
        let files = try attachments.resolve(ids, draftKey: MessageMediaCache.replyKey(id)), scope = DraftStore.scope(settings), host = settings.host, port = settings.gatewayPort
        guard ids.allSatisfy({ attachmentScopes[$0] == scope }) else { throw ClientError.message("附件属于其他连接。") }
        sendingMessages.insert(id); sendingAttachments.formUnion(ids)
        defer { sendingMessages.remove(id); sendingAttachments.subtract(ids) }
        var params: [String: Any] = ["conversationId": id, "text": text, "idempotencyKey": key]
        if let file = files.first {
            let uploadKey = host + ":" + String(port) + ":" + id + ":" + file.id
            if let cached = messageUploads[uploadKey] { params["mediaId"] = cached }
            else { let media = try await gateway.uploadMedia(file, conversation: id); if let mediaID = media["id"] as? String { messageUploads[uploadKey] = mediaID; params["mediaId"] = mediaID } }
        }
        guard settings.host == host, settings.gatewayPort == port else { throw CancellationError() }
        let result = try await gateway.request("/messages/send", method: "POST", body: params, timeout: 120)
        attachments.accepted(ids)
        emit("messageSent", ["conversationId": id, "message": result["message"] ?? [:], "idempotencyKey": key, "attachmentIds": ids, "draftScope": scope])
    }
    func diagnose() async {
        do {
            try await rpc.connect(settings)
            let account = try await rpc.request("account/read", params: ["refreshToken": false])
            let threads = try await rpc.request("thread/list", params: ["limit": 1, "cwd": settings.project, "sourceKinds": ["cli", "vscode", "appServer", "exec"], "useStateDbOnly": true])
            let result: [String: Any] = ["ssh": "ok", "host": settings.host, "project": settings.project, "remoteAccountPresent": account["account"] != nil && !(account["account"] is NSNull), "threadList": "ok", "sampleCount": (threads["data"] as? [Any])?.count ?? 0]
            if let data = try? JSONSerialization.data(withJSONObject: result, options: .sortedKeys), let text = String(data: data, encoding: .utf8) { print(text) }
        } catch { fputs("diagnostic failed: \(error.localizedDescription)\n", stderr) }
        close()
    }
    func close() { accountReady = false; accountWatch?.cancel(); remoteAccount.disconnected(); connecting = false; reconnectAllowed = false; messageReconnectAllowed = false; recovery.stop(); messageRecovery.stop(); connected = false; epoch = UUID(); questions.clear(); questionAttention.clear(); goalWatch?.cancel(); follower.stop(); stopPlan(); stopAgents(); eventRefresh?.cancel(); previewPanel?.close(); attachmentTransport.cancelAll(); attachments.close(); messageMediaCache.close(); gateway.close(); rpc.close(); flushWaiters.values.forEach { $0.resume() }; flushWaiters.removeAll() }
    static func icons() -> [String: String] {
        let symbols = ["zap":"bolt.fill", "target":"scope", "list-checks":"checklist", "panel-left":"sidebar.left", "panel-right":"sidebar.right", "square-pen":"square.and.pencil", "folder":"folder", "chevron-down":"chevron.down", "chevron-right":"chevron.right", "chevrons-up-down":"chevron.up.chevron.down", "settings-2":"slider.horizontal.3", "server":"server.rack", "git-branch":"point.3.connected.trianglepath.dotted", "file-code-2":"doc.text", "file-text":"doc.text", "image":"photo", "check":"checkmark", "copy":"doc.on.doc", "thumbs-up":"hand.thumbsup", "thumbs-down":"hand.thumbsdown", "plus":"plus", "arrow-up":"arrow.up", "x":"xmark", "quote":"quote.opening", "message-circle":"message", "send":"paperplane", "corner-up-left":"arrowshape.turn.up.left", "users":"person.2", "user-round":"person", "terminal":"terminal"]
        var result: [String: String] = [:]
        for (name, symbol) in symbols {
            guard let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil) else { continue }
            let rendered = NSImage(size: NSSize(width: 32, height: 32)); rendered.lockFocus()
            NSColor.black.set(); image.draw(in: NSRect(x: 2, y: 2, width: 28, height: 28), from: .zero, operation: .sourceOver, fraction: 1)
            rendered.unlockFocus()
            if let data = rendered.tiffRepresentation, let rep = NSBitmapImageRep(data: data), let png = rep.representation(using: .png, properties: [:]) { result[name] = "data:image/png;base64," + png.base64EncodedString() }
        }
        return result
    }
}
