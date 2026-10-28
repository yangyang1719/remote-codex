import Foundation

struct ConnectionSettings: Codable, Equatable {
    var host = "my-dev-server"
    var project = "/srv/projects/my-project"
    var executable = "/home/developer/.local/bin/codex"
    var gatewayPort = 18765
    // Optional fields preserve decoding of settings saved by older builds.
    var legacyRuntime: Bool?
    var officialSocket: String?
    var usesOfficialDaemon: Bool { legacyRuntime != true }
    // Keep the legacy logical identity so automatic discovery preserves existing drafts.
    var socketIdentity: String { officialSocket ?? "~/.local/state/remote-codex-runtime/official.sock" }

    static func load() -> Self {
        guard let data = UserDefaults.standard.data(forKey: "connection"),
              let value = try? JSONDecoder().decode(Self.self, from: data) else { return .init() }
        return value
    }
    func save() { UserDefaults.standard.set(try? JSONEncoder().encode(self), forKey: "connection") }
    func validate() throws {
        guard !host.isEmpty, !host.hasPrefix("-"), host.range(of: "^[a-zA-Z0-9._-]+$", options: .regularExpression) != nil else { throw ClientError.message("请选择有效的 SSH 主机别名。") }
        guard project.hasPrefix("/"), executable.hasPrefix("/"), !project.contains("\n"), !executable.contains("\n"), !project.contains("\0"), !executable.contains("\0") else { throw ClientError.message("工作目录和 Codex 路径必须是远端绝对路径。") }
        guard (1024...65535).contains(gatewayPort) else { throw ClientError.message("消息服务端口应为 1024–65535。") }
        if let socket = officialSocket { guard socket.hasPrefix("/"), !socket.contains("\n"), !socket.contains("\0") else { throw ClientError.message("官方服务 socket 必须是远端绝对路径。") } }
        if usesOfficialDaemon, officialSocket == nil, OfficialRuntimeBootstrap.encodedSource == nil { throw ClientError.message("缺少官方常驻启动助手，请重新 build 客户端。") }
    }
    static func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    var remoteCommand: String {
        if !usesOfficialDaemon { return "exec python3 \"$HOME/.local/share/remote-codex-runtime/current/client.py\" --project " + Self.quote(project) + " --executable " + Self.quote(executable) }
        if let socket = officialSocket { return "cd " + Self.quote(project) + " && exec " + Self.quote(executable) + " app-server proxy --sock " + Self.quote(socket) }
        return "cd " + Self.quote(project) + " && " + OfficialRuntimeBootstrap.command("proxy", settings: self)
    }
    var sshArguments: [String] { ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=20", "-o", "ServerAliveCountMax=3", host, remoteCommand] }
    static func aliases() -> [String] {
        // Only read Host declarations. Never log SSH config contents or its comments.
        var result: [String] = []
        var visited = Set<String>()
        func parse(_ path: String, depth: Int = 0) {
            guard depth < 5, !visited.contains(path), let contents = try? String(contentsOfFile: path, encoding: .utf8) else { return }
            visited.insert(path)
            for line in contents.components(separatedBy: .newlines) {
                let parts = line.split(separator: "#", maxSplits: 1).first?.split(whereSeparator: { $0.isWhitespace }).map(String.init) ?? []
                guard parts.count > 1 else { continue }
                if parts[0].lowercased() == "host" {
                    result += parts.dropFirst().filter { !$0.contains("*") && !$0.contains("?") && !$0.hasPrefix("!") }
                } else if parts[0].lowercased() == "include" {
                    for child in parts.dropFirst() where !child.contains("*") {
                        let expanded = NSString(string: child).expandingTildeInPath
                        parse(expanded.hasPrefix("/") ? expanded : URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent(expanded).path, depth: depth + 1)
                    }
                }
            }
        }
        parse(NSHomeDirectory() + "/.ssh/config")
        return Array(Set(result)).sorted()
    }
}

enum ClientError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

@MainActor final class RPCConnection {
    private(set) var persistentRuntime = false
    private(set) var officialDaemon = false
    // Subscriptions are not exclusive writer ownership. The daemon owns the live thread.
    var controlledThreads: Set<String> { subscriptions.union(sharedConnection?.controlledThreads ?? []) }
    private var subscriptions: Set<String> = []
    private var observations: Set<String> = []
    var observingThreads: Set<String> { observations.union(sharedConnection?.observingThreads ?? []) }
    private(set) var sharedThreadIDs: Set<String> = []
    private var sharedConnection: RPCConnection?
    private var sharedOpening: Task<RPCConnection, Error>?
    private var remoteCodexHome: String?
    private let sharedRequests = RPCRequestNamespace()
    private var planConfigKey: String { "official-plan-configs:" + settings.host + ":" + settings.socketIdentity }
    private var planConfigs: [String: [String: Any]] {
        guard let data = UserDefaults.standard.data(forKey: planConfigKey), let value = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else { return [:] }
        return value
    }
    private var settings = ConnectionSettings()
    private var websocket = SSHWebSocket()
    private var opening: CheckedContinuation<Void, Error>?
    private var process: Process?
    private var input: FileHandle?
    private var buffer = Data()
    private var stderr = Data()
    private var sequence = 0
    private var pending: [String: CheckedContinuation<[String: Any], Error>] = [:]
    private var timeouts: [String: Task<Void, Never>] = [:]
    private var generation = UUID()
    var onNotification: ((String, [String: Any]) -> Void)?
    var onRequest: ((Any, String, [String: Any]) -> Void)?
    var onDisconnect: ((String) -> Void)?
    var onMethodSent: ((String) -> Void)?

    func accountDiagnostics() async throws -> [[String: Any]] {
        var own = try await rawRequest("server/diagnostics", params: [:])
        let gauges = own["gauges"] as? [[String: Any]] ?? []
        if let active = gauges.first(where: { $0["name"] as? String == "core.turns.active" })?["value"] as? Int { own["accountActiveTurns"] = active }
        else {
            // A fresh daemon does not emit the turn gauge until its first turn.
            // Confirm loaded metadata instead of interpreting missing data as zero.
            let result = try await rawRequest("thread/loaded/list", params: [:])
            guard let ids = result["data"] as? [String], ids.count <= 256 else { throw ClientError.message("无法完整确认远端运行状态。") }
            var active = 0
            for id in ids {
                let thread = try await rawRequest("thread/read", params: ["threadId": id, "includeTurns": false])["thread"] as? [String: Any]
                guard let status = (thread?["status"] as? [String: Any])?["type"] as? String, ["idle", "active", "notLoaded"].contains(status) else { throw ClientError.message("远端会话状态未知，请稍后再切换。") }
                if status == "active" { active += 1 }
            }
            own["accountActiveTurns"] = active
        }
        var values = [own]
        if let sharedConnection { values += try await sharedConnection.accountDiagnostics() }
        return values
    }

    func connect(_ settings: ConnectionSettings) async throws {
        try settings.validate()
        close()
        self.settings = settings; officialDaemon = settings.usesOfficialDaemon; websocket = SSHWebSocket()
        let current = UUID(); generation = current
        let proc = Process(), stdin = Pipe(), stdout = Pipe(), errors = Pipe()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        proc.arguments = settings.sshArguments
        proc.standardInput = stdin; proc.standardOutput = stdout; proc.standardError = errors
        input = stdin.fileHandleForWriting
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { @MainActor in guard let self, self.generation == current else { return }; self.consume(data) }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            Task { @MainActor in guard let self, self.generation == current else { return }; self.stderr.append(data); if self.stderr.count > 6000 { self.stderr = self.stderr.suffix(6000) } }
        }
        proc.terminationHandler = { [weak self] proc in
            Task { @MainActor in
                guard let self, self.generation == current else { return }
                let details = String(data: self.stderr, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let reason = details.isEmpty ? "SSH 连接已断开（\(proc.terminationStatus)）。" : details
                self.subscriptions.removeAll()
                self.failAll(reason); self.onDisconnect?(reason)
            }
        }
        process = proc
        do {
            try proc.run()
            if officialDaemon {
                try await withCheckedThrowingContinuation { continuation in
                    opening = continuation
                    do { try input?.write(contentsOf: websocket.handshake) }
                    catch { opening = nil; continuation.resume(throwing: error) }
                    Task { @MainActor [weak self] in
                        try? await Task.sleep(nanoseconds: settings.officialSocket == nil ? 45_000_000_000 : 20_000_000_000)
                        guard let self, self.generation == current, let opening = self.opening else { return }
                        self.opening = nil; opening.resume(throwing: ClientError.message("官方常驻未连接。可在连接设置中开启后重连。"))
                    }
                }
            }
            guard generation == current, !Task.isCancelled else { throw CancellationError() }
            let hello = try await request("initialize", params: ["clientInfo": ["name": "remote_codex_desktop", "title": "Remote Codex", "version": "0.2.0"], "capabilities": ["experimentalApi": true]])
            guard generation == current, !Task.isCancelled else { throw CancellationError() }
            remoteCodexHome = hello["codexHome"] as? String
            persistentRuntime = officialDaemon || (hello["remoteRuntime"] as? [String: Any])?["persistent"] as? Bool == true
            try send(["method": "initialized", "params": [:]])
        } catch { if generation == current { close() }; throw error }
    }
    func request(_ method: String, params: [String: Any] = [:]) async throws -> [String: Any] {
        let route = ["threadId", "ancestorThreadId", "parentThreadId"].compactMap { params[$0] as? String }.first(where: sharedThreadIDs.contains)
        if route != nil, let sharedConnection {
            let result = try await sharedConnection.request(method, params: params)
            rememberSharedThreads(result, list: method == "thread/list")
            return result
        }
        let originalParams = params, current = generation
        var params = params
        if officialDaemon, method == "thread/resume", let id = params["threadId"] as? String, let config = planConfigs[id] {
            params["config"] = config.merging(params["config"] as? [String: Any] ?? [:]) { _, explicit in explicit }
        }
        let joining = officialDaemon && method == "thread/resume" ? params["threadId"] as? String : nil
        let wasSubscribed = joining.map(subscriptions.contains) ?? false
        if let joining { subscriptions.insert(joining) }
        do {
            let result = try await rawRequest(method, params: params)
            guard generation == current else { throw CancellationError() }
            if officialDaemon, ["thread/start", "thread/fork"].contains(method), let thread = result["thread"] as? [String: Any], let id = thread["id"] as? String {
                if method == "thread/fork", id == params["threadId"] as? String { throw ClientError.message("分叉标识异常，未取得原会话控制权。") }
                subscriptions.insert(id)
                if let config = params["config"] as? [String: Any], config["hooks.PostToolUse"] != nil {
                    var saved = planConfigs; saved[id] = config
                    UserDefaults.standard.set(try JSONSerialization.data(withJSONObject: saved), forKey: planConfigKey)
                }
            }
            if let joining, (result["thread"] as? [String: Any])?["id"] as? String != joining { throw ClientError.message("远端返回的会话标识不一致，未加入会话。") }
            if method == "thread/unsubscribe", let id = params["threadId"] as? String { subscriptions.remove(id) }
            return result
        } catch {
            if let joining, !wasSubscribed { subscriptions.remove(joining) }
            guard generation == current, let joining, settings.officialSocket == nil,
                  error.localizedDescription.lowercased().contains("active writer") else { throw error }
            // Another daemon owns the rollout. Join that daemon instead of reclaiming its lock.
            let shared = try await openSharedConnection(threadID: joining)
            guard generation == current else { throw CancellationError() }
            let loaded = try await shared.request("thread/loaded/list")["data"] as? [String] ?? []
            guard loaded.contains(joining) else { throw error }
            let metadata = try await shared.request("thread/read", params: ["threadId": joining, "includeTurns": false])
            guard generation == current, (metadata["thread"] as? [String: Any])?["id"] as? String == joining else { throw ClientError.message("共享服务返回的会话标识不一致。") }
            let result = try await shared.request(method, params: originalParams)
            guard generation == current else { throw CancellationError() }
            sharedThreadIDs.insert(joining); rememberSharedThreads(result)
            return result
        }
    }
    /// Joins only a thread already loaded by a known official daemon, without
    /// applying config overrides or granting the UI send/interrupt permissions.
    func observeLoadedThread(_ id: String) async throws -> [String: Any]? {
        guard officialDaemon, !controlledThreads.contains(id), !observingThreads.contains(id) else { return nil }
        let current = generation
        let loaded = try await rawRequest("thread/loaded/list", params: [:])["data"] as? [String] ?? []
        guard generation == current else { throw CancellationError() }
        if !loaded.contains(id) {
            guard settings.officialSocket == nil, let shared = try? await openSharedConnection(threadID: id) else { return nil }
            let value = try await shared.observeLoadedThread(id)
            guard generation == current else { throw CancellationError() }
            sharedThreadIDs.insert(id); return value
        }
        observations.insert(id)
        do {
            let value = try await rawRequest("thread/resume", params: ["threadId": id, "excludeTurns": true, "initialTurnsPage": ["limit": 1, "itemsView": "full"]])
            guard generation == current, (value["thread"] as? [String: Any])?["id"] as? String == id else { throw CancellationError() }
            return value
        } catch { if generation == current { observations.remove(id) }; throw error }
    }
    func stopObserving(except id: String? = nil) async {
        for thread in observations where thread != id {
            observations.remove(thread)
            if !subscriptions.contains(thread) { _ = try? await rawRequest("thread/unsubscribe", params: ["threadId": thread]) }
        }
        await sharedConnection?.stopObserving(except: id)
    }
    private func rememberSharedThreads(_ result: [String: Any], list: Bool = false) {
        if let thread = result["thread"] as? [String: Any], let id = thread["id"] as? String { sharedThreadIDs.insert(id) }
        if list { for thread in result["data"] as? [[String: Any]] ?? [] { if let id = thread["id"] as? String { sharedThreadIDs.insert(id) } } }
    }
    private func openSharedConnection(threadID: String) async throws -> RPCConnection {
        if let sharedConnection { return sharedConnection }
        if let sharedOpening { return try await sharedOpening.value }
        guard let remoteCodexHome, remoteCodexHome.hasPrefix("/") else { throw ClientError.message("远端未提供 Codex 目录，无法连接原会话所在服务。") }
        let current = generation
        let canonical = remoteCodexHome + "/app-server-control/app-server-control.sock"
        let legacy = URL(fileURLWithPath: remoteCodexHome).deletingLastPathComponent().appendingPathComponent(".local/state/remote-codex-runtime/official.sock").path
        let candidates = canonical == legacy ? [canonical] : [canonical, legacy]
        let task = Task { @MainActor [weak self] () throws -> RPCConnection in
            for socket in candidates {
                guard let self, self.generation == current, !Task.isCancelled else { throw CancellationError() }
                var target = self.settings; target.officialSocket = socket
                let shared = RPCConnection()
                shared.onMethodSent = { [weak self] method in self?.onMethodSent?(method) }
                shared.onNotification = { [weak self] method, params in
                    guard let self, self.generation == current else { return }
                    if let id = params["threadId"] as? String { self.sharedThreadIDs.insert(id) }
                    self.rememberSharedThreads(params)
                    var params = params
                    if method == "serverRequest/resolved", let id = params["requestId"], let wrapped = self.sharedRequests.encode(id) { params["requestId"] = wrapped }
                    self.onNotification?(method, params)
                }
                shared.onRequest = { [weak self] id, method, params in
                    guard let self, self.generation == current, let wrapped = self.sharedRequests.encode(id) else { return }
                    if let thread = params["threadId"] as? String { self.sharedThreadIDs.insert(thread) }
                    self.onRequest?(wrapped, method, params)
                }
                shared.onDisconnect = { [weak self] reason in
                    guard let self, self.generation == current else { return }
                    self.onDisconnect?("原会话所在的 Codex 服务连接已断开：" + reason)
                }
                do {
                    try await shared.connect(target)
                    guard self.generation == current, !Task.isCancelled else { shared.close(); throw CancellationError() }
                    let loaded = try await shared.request("thread/loaded/list")["data"] as? [String] ?? []
                    guard loaded.contains(threadID) else { shared.close(); continue }
                    return shared
                } catch { shared.close(); if Task.isCancelled || self.generation != current || error is CancellationError { throw error } }
            }
            throw ClientError.message("无法确认会话所在的官方服务，草稿已保留，继续只读查看。")
        }
        sharedOpening = task
        do {
            let shared = try await task.value
            guard generation == current else { shared.close(); throw CancellationError() }
            sharedConnection = shared; sharedOpening = nil; return shared
        } catch { if generation == current { sharedOpening = nil }; throw error }
    }
    private func rawRequest(_ method: String, params: [String: Any]) async throws -> [String: Any] {
        guard process?.isRunning == true else { throw ClientError.message("SSH 尚未连接。") }
        onMethodSent?(method)
        sequence += 1; let id = "desktop-\(sequence)"
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            timeouts[id] = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 45_000_000_000)
                guard !Task.isCancelled, let self, let item = self.pending.removeValue(forKey: id) else { return }
                self.timeouts.removeValue(forKey: id)
                item.resume(throwing: ClientError.message("远端请求超时：\(method)。可在连接设置中重连。"))
            }
            do { try send(["id": id, "method": method, "params": params]) }
            catch { pending.removeValue(forKey: id)?.resume(throwing: error); timeouts.removeValue(forKey: id)?.cancel() }
        }
    }
    func respond(id: Any, result: [String: Any]) throws {
        if let original = sharedRequests.decode(id) {
            guard let sharedConnection else { throw ClientError.message("原会话服务已断开，请等待重新连接。") }
            try sharedConnection.respond(id: original, result: result); return
        }
        try send(["id": id, "result": result])
    }
    func isSharedServerRequest(_ id: Any) -> Bool { sharedRequests.decode(id) != nil }
    func reject(id: Any, reason: String) {
        if let original = sharedRequests.decode(id) { sharedConnection?.reject(id: original, reason: reason); return }
        try? send(["id": id, "error": ["code": -32601, "message": reason]])
    }
    private func send(_ message: [String: Any]) throws {
        guard let input else { throw ClientError.message("SSH 未连接。") }
        var data = try JSONSerialization.data(withJSONObject: message)
        if officialDaemon { data = SSHWebSocket.frame(data) } else { data.append(10) }
        try input.write(contentsOf: data)
    }
    private func consume(_ data: Data) {
        guard !data.isEmpty else { return }
        if officialDaemon {
            do {
                let received = try websocket.receive(data)
                for reply in received.replies { try input?.write(contentsOf: reply) }
                if received.opened { let continuation = opening; opening = nil; continuation?.resume() }
                for message in received.messages { receiveMessage(message) }
                if received.closed { close(); onDisconnect?("官方服务连接已关闭。") }
            } catch { close(); onDisconnect?(error.localizedDescription) }
            return
        }
        buffer.append(data)
        guard buffer.count < 32_000_000 else { close(); onDisconnect?("远端返回过大的协议消息。"); return }
        while let newline = buffer.firstIndex(of: 10) {
            let line = buffer[..<newline]; buffer.removeSubrange(...newline)
            receiveMessage(Data(line))
        }
    }
    private func receiveMessage(_ data: Data) {
            guard let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            if let id = value["id"], let method = value["method"] as? String {
                onRequest?(id, method, value["params"] as? [String: Any] ?? [:])
            } else if let id = value["id"] as? String, let callback = pending.removeValue(forKey: id) {
                timeouts.removeValue(forKey: id)?.cancel()
                if let error = value["error"] as? [String: Any] { callback.resume(throwing: ClientError.message(error["message"] as? String ?? "远端协议错误。")) }
                else { callback.resume(returning: value["result"] as? [String: Any] ?? [:]) }
            } else if let method = value["method"] as? String { onNotification?(method, value["params"] as? [String: Any] ?? [:]) }
    }
    private func failAll(_ reason: String) {
        let callbacks = pending.values; pending.removeAll(); timeouts.values.forEach { $0.cancel() }; timeouts.removeAll()
        callbacks.forEach { $0.resume(throwing: ClientError.message(reason)) }
        let continuation = opening; opening = nil; continuation?.resume(throwing: ClientError.message(reason))
    }
    func close() {
        persistentRuntime = false
        generation = UUID()
        sharedOpening?.cancel(); sharedOpening = nil
        sharedConnection?.close(); sharedConnection = nil; sharedThreadIDs.removeAll()
        subscriptions.removeAll(); observations.removeAll(); remoteCodexHome = nil
        process?.terminationHandler = nil
        if let out = process?.standardOutput as? Pipe { out.fileHandleForReading.readabilityHandler = nil }
        if let err = process?.standardError as? Pipe { err.fileHandleForReading.readabilityHandler = nil }
        try? input?.close(); input = nil
        if process?.isRunning == true { process?.terminate() }
        process = nil; buffer.removeAll(); stderr.removeAll(); failAll("连接已关闭。")
    }
}

/// Server request IDs are scoped to their daemon, including numeric vs string IDs.
struct RPCRequestNamespace {
    private let prefix = "shared-" + UUID().uuidString + ":"
    func encode(_ id: Any) -> String? {
        guard id is String || id is NSNumber, let data = try? JSONSerialization.data(withJSONObject: id, options: [.fragmentsAllowed]) else { return nil }
        return prefix + data.base64EncodedString()
    }
    func decode(_ id: Any) -> Any? {
        guard let id = id as? String, id.hasPrefix(prefix), let data = Data(base64Encoded: String(id.dropFirst(prefix.count))) else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }
}
