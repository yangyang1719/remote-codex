import AppKit
import WebKit

enum AppResources {
    static var directory: URL {
        if let root = Bundle.main.resourceURL?.appendingPathComponent("Resources"), FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path) { return root }
        return Bundle.module.url(forResource: "index", withExtension: "html", subdirectory: "Resources")!.deletingLastPathComponent()
    }
}

@main enum RemoteCodexMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = DesktopDelegate()
        app.delegate = delegate
        app.setActivationPolicy(CommandLine.arguments.contains("--diagnose") ? .prohibited : .regular)
        app.run()
        withExtendedLifetime(delegate) {}
    }
}

@MainActor final class DesktopDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var coordinator: AppCoordinator!
    private let runtimeControl = RuntimeControl()
    private var serviceLabel: NSTextField?
    private var serviceStart: NSButton?
    private var serviceStop: NSButton?
    private weak var settingsWindow: NSWindow?
    private var runtimeBusy = false
    private var questionNotifications: QuestionNotifications?
    private var workspaceObservers: [NSObjectProtocol] = []
    func applicationDidFinishLaunching(_ notification: Notification) {
        if let url = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"), let icon = NSImage(contentsOf: url) {
            NSApplication.shared.applicationIconImage = icon
        }
        coordinator = AppCoordinator()
        if CommandLine.arguments.contains("--diagnose") {
            Task { await coordinator.diagnose(); NSApplication.shared.terminate(nil) }; return
        }
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(coordinator.messageMediaCache, forURLScheme: "remote-codex-media")
        config.userContentController.add(coordinator, name: "native")
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = coordinator; web.uiDelegate = coordinator
        web.setValue(false, forKey: "drawsBackground")
        coordinator.web = web
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.minSize = NSSize(width: 900, height: 640)
        window.title = "Remote Codex"
        window.delegate = self
        window.titleVisibility = .hidden; window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.contentView = web; window.center(); window.makeKeyAndOrderFront(nil)
        let resource = AppResources.directory.appendingPathComponent("index.html")
        web.loadFileURL(resource, allowingReadAccessTo: resource.deletingLastPathComponent())
        let menu = NSMenu(), appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "连接设置…", action: #selector(openSettings), keyEquivalent: ",").target = self
        appMenu.addItem(withTitle: "问题通知设置…", action: #selector(openQuestionNotificationSettings), keyEquivalent: "").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 Remote Codex", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem(); menu.addItem(editItem); let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        let viewItem = NSMenuItem(title: "显示", action: nil, keyEquivalent: ""), viewMenu = NSMenu(title: "显示"); viewItem.submenu = viewMenu; menu.addItem(viewItem)
        for (title, key, command) in [("字体大小…", "", "open"), ("放大字体", "+", "increase"), ("缩小字体", "-", "decrease"), ("恢复默认字体", "0", "reset")] {
            let item = NSMenuItem(title: title, action: #selector(changeFontSize(_:)), keyEquivalent: key); item.target = self; item.representedObject = command; viewMenu.addItem(item)
        }
        let equal = NSMenuItem(title: "放大字体", action: #selector(changeFontSize(_:)), keyEquivalent: "="); equal.target = self; equal.representedObject = "increase"; equal.isHidden = true; equal.allowsKeyEquivalentWhenHidden = true; viewMenu.addItem(equal)
        NSApplication.shared.mainMenu = menu
        coordinator.openSettings = { [weak self] in self?.openSettings() }
        if !CommandLine.arguments.contains("--demo") {
            let workspace = NSWorkspace.shared.notificationCenter
            workspaceObservers.append(workspace.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.coordinator.prepareForSleep(); await self?.coordinator.flushDrafts() } })
            workspaceObservers.append(workspace.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.coordinator.wakeConnections() } })
        }
        coordinator.openNotificationSettings = { [weak self] in self?.openQuestionNotificationSettings() }
        if !CommandLine.arguments.contains("--demo") {
            let notifications = QuestionNotifications(); questionNotifications = notifications
            notifications.permissionChanged = { [weak self] status in self?.coordinator.notificationPermission = status }
            notifications.open = { [weak self] token in
                guard let self else { return }
                NSApplication.shared.activate(ignoringOtherApps: true)
                self.window.deminiaturize(nil); self.window.makeKeyAndOrderFront(nil)
                self.coordinator.openQuestion(token)
            }
            coordinator.questionAttention.deliver = { [weak notifications] notice in notifications?.deliver(notice) }
            coordinator.questionAttention.remove = { [weak notifications] tokens in notifications?.remove(tokens) }
            coordinator.questionAttention.countChanged = { count in NSApplication.shared.dockTile.badgeLabel = count > 0 ? String(count) : nil }
            Task { _ = await notifications.requestPermission() }
        }
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
    @objc private func openQuestionNotificationSettings() {
        Task {
            _ = await questionNotifications?.requestPermission()
            if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=com.dli.remote-codex") { NSWorkspace.shared.open(url) }
        }
    }
    @objc private func changeFontSize(_ sender: NSMenuItem) { coordinator.emit("appearanceCommand", ["command": sender.representedObject as? String ?? "open"]) }
    @objc private func openSettings() {
        let alert = NSAlert(); alert.messageText = "连接设置"; alert.informativeText = "使用已有 SSH 配置。Codex 和消息账号均登录在远端。"
        alert.addButton(withTitle: "保存并重连"); alert.addButton(withTitle: "取消")
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 430, height: 348))
        let aliases = NSComboBox(frame: NSRect(x: 126, y: 208, width: 290, height: 26)); aliases.addItems(withObjectValues: ConnectionSettings.aliases()); aliases.stringValue = coordinator.settings.host
        let project = NSTextField(string: coordinator.settings.project), executable = NSTextField(string: coordinator.settings.executable), port = NSTextField(string: String(coordinator.settings.gatewayPort))
        let labels = ["SSH 主机", "远端项目目录", "Codex 绝对路径", "消息服务端口"]
        let fields: [NSView] = [aliases, project, executable, port]
        for (index, field) in fields.enumerated() {
            let y = 308 - index * 49
            let label = NSTextField(labelWithString: labels[index]); label.frame = NSRect(x: 0, y: y + 3, width: 120, height: 22); view.addSubview(label)
            field.frame = NSRect(x: 126, y: y, width: 290, height: 26); view.addSubview(field)
        }
        let tip = NSTextField(wrappingLabelWithString: "优先复用远端官方常驻，不存在时自动创建。关闭窗口只断开本客户端，远端任务继续运行。")
        tip.font = .systemFont(ofSize: 11); tip.textColor = .secondaryLabelColor; tip.frame = NSRect(x: 0, y: 78, width: 416, height: 42); view.addSubview(tip)
        let label = NSTextField(labelWithString: "远端常驻 · \(coordinator.settings.host) · 正在检查…"); label.font = .systemFont(ofSize: 12); label.frame = NSRect(x: 0, y: 51, width: 425, height: 23); view.addSubview(label); serviceLabel = label
        let start = NSButton(title: "开启远端常驻", target: self, action: #selector(startRuntime)), stop = NSButton(title: "关闭远端常驻…", target: self, action: #selector(stopRuntime))
        start.frame = NSRect(x: 0, y: 12, width: 145, height: 30); stop.frame = NSRect(x: 155, y: 12, width: 155, height: 30); start.isEnabled = false; stop.isEnabled = false; view.addSubview(start); view.addSubview(stop); serviceStart = start; serviceStop = stop
        alert.accessoryView = view
        settingsWindow = alert.window
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn else { return }
            var settings = self.coordinator.settings
            settings.host = aliases.stringValue.trimmingCharacters(in: .whitespacesAndNewlines); settings.project = project.stringValue; settings.executable = executable.stringValue; settings.gatewayPort = Int(port.stringValue) ?? 0
            do { try settings.validate(); Task { await self.coordinator.flushDrafts(); do { try self.coordinator.configureProject(settings); await self.coordinator.connect() } catch { let errorAlert = NSAlert(error: error); _ = await errorAlert.beginSheetModal(for: self.window) } } }
            catch { let errorAlert = NSAlert(error: error); errorAlert.beginSheetModal(for: self.window) }
        }
        Task { await updateRuntimeStatus() }
    }
    private func updateRuntimeStatus() async {
        do {
            let status = try await runtimeControl.request("status", settings: coordinator.settings), running = status["running"] as? Bool == true
            let owned = status["owned"] as? Bool == true, canStop = status["canStop"] as? Bool == true
            serviceLabel?.stringValue = running ? (owned ? "本客户端创建的官方常驻" : "复用官方常驻") + " · \(status["loadedThreads"] as? Int ?? 0) 个已加载会话 · \(status["activeTurns"] as? Int ?? 0) 个运行回合" : "官方常驻 · 未运行"
            serviceStart?.title = running ? "连接现有常驻" : "创建并连接"
            serviceStop?.title = canStop ? "关闭空闲常驻…" : "断开本客户端"
            serviceStart?.isEnabled = !runtimeBusy; serviceStop?.isEnabled = !runtimeBusy && running
        } catch { serviceLabel?.stringValue = error.localizedDescription; serviceStart?.isEnabled = false; serviceStop?.isEnabled = false }
    }
    @objc private func startRuntime() { Task { await changeRuntime("start") } }
    @objc private func stopRuntime() {
        guard !runtimeBusy else { return }
        Task {
            do {
                let status = try await runtimeControl.request("status", settings: coordinator.settings)
                guard status["canStop"] as? Bool == true else {
                    await coordinator.flushDrafts()
                    coordinator.runtimeStopped(message: "已断开本客户端，远端常驻和其他会话继续运行。可在连接设置中重新连接。")
                    serviceLabel?.stringValue = "已断开本客户端 · 远端常驻继续运行"
                    return
                }
                let alert = NSAlert(); alert.messageText = "关闭本客户端创建的空闲常驻？"
                alert.informativeText = "仅关闭本客户端创建且没有已加载会话的实例。若有其他连接或任务，自动改为只断开本客户端。手动关闭后需点击“创建并连接”重新开启。"
                alert.addButton(withTitle: "关闭空闲常驻"); alert.addButton(withTitle: "取消")
                alert.beginSheetModal(for: settingsWindow ?? window) { [weak self] response in if response == .alertFirstButtonReturn { Task { await self?.changeRuntime("stop") } } }
            } catch { serviceLabel?.stringValue = error.localizedDescription }
        }
    }
    private func changeRuntime(_ operation: String) async {
        guard !runtimeBusy else { return }; runtimeBusy = true; serviceStart?.isEnabled = false; serviceStop?.isEnabled = false
        serviceLabel?.stringValue = operation == "stop" ? "正在检查并关闭本客户端创建的空闲常驻…" : "正在连接或创建官方常驻…"
        var operationError: String?
        do {
            if operation == "stop" { await coordinator.flushDrafts(); coordinator.runtimeStopped(message: "本客户端已断开。") }
            let result = try await runtimeControl.request(operation, settings: coordinator.settings)
            if operation == "stop" {
                coordinator.runtimeStopped(message: result["detached"] as? Bool == true ? "已断开本客户端，远端常驻和其他会话继续运行。" : "远端空闲常驻已关闭。可在连接设置中创建并连接。")
            } else { await coordinator.connect() }
        } catch { operationError = error.localizedDescription }
        runtimeBusy = false; await updateRuntimeStatus()
        if let operationError { serviceLabel?.stringValue = operationError }
    }
    func applicationWillTerminate(_ notification: Notification) { coordinator?.close() }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard coordinator != nil else { return .terminateNow }
        Task { await coordinator.cancelAccountLogin(); await coordinator.flushDrafts(); sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
    private func publishMessageVisibility() { coordinator?.emit("messageVisibility", ["active": NSApplication.shared.isActive && window?.isVisible == true && window?.isMiniaturized != true]) }
    func windowDidMiniaturize(_ notification: Notification) { coordinator?.emit("messageVisibility", ["active": false]) }
    func windowDidDeminiaturize(_ notification: Notification) { publishMessageVisibility() }
    func applicationDidBecomeActive(_ notification: Notification) { publishMessageVisibility(); Task { await questionNotifications?.refreshPermission() } }
    func applicationDidResignActive(_ notification: Notification) { coordinator?.emit("messageVisibility", ["active": false]) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
