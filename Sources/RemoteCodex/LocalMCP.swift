import Foundation

/// Owns only the local helper. Credentials and MCP commands never leave the Mac.
@MainActor final class LocalMCP {
    private var process: Process?
    private var input: FileHandle?
    private var buffer = Data()
    private var sequence = 0
    private var pending: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    private var timeouts: [Int: Task<Void, Never>] = [:]
    private(set) var host: String?
    var changed: (([String: Any]) -> Void)?
    let stateDirectory: URL
    init(stateDirectory: URL? = nil) {
        self.stateDirectory = stateDirectory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("RemoteCodex/LocalMCP", isDirectory: true)
    }
    private func start() throws {
        if process?.isRunning == true { return }
        let source = AppResources.directory.appendingPathComponent("local_mcp.py")
        guard FileManager.default.fileExists(atPath: source.path) else { throw ClientError.message("缺少本地 MCP 组件，请重新构建客户端。") }
        let child = Process(), output = Pipe(), incoming = Pipe()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        child.arguments = [source.path, "--state", stateDirectory.path]
        child.standardInput = incoming; child.standardOutput = output; child.standardError = FileHandle.nullDevice
        child.terminationHandler = { [weak self] ended in Task { @MainActor in
            guard let self, self.process === ended else { return }
            self.failed("本地 MCP 组件已退出，可能由另一个窗口管理；请重新打开面板检查。")
        } }
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            Task { @MainActor in self?.received(data, source: child) }
        }
        try child.run(); process = child; input = incoming.fileHandleForWriting; buffer.removeAll()
    }
    private func received(_ data: Data, source: Process) {
        guard process === source else { return }
        buffer.append(data)
        guard buffer.count <= 4 * 1024 * 1024 else { close(); return }
        while let end = buffer.firstIndex(of: 10) {
            let line = buffer.prefix(upTo: end); buffer.removeSubrange(...end)
            guard let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            if value["event"] as? String == "snapshot", let snapshot = value["value"] as? [String: Any] { changed?(snapshot); continue }
            guard let id = value["id"] as? Int, let waiter = pending.removeValue(forKey: id) else { continue }
            timeouts.removeValue(forKey: id)?.cancel()
            if let error = value["error"] as? String { waiter.resume(throwing: ClientError.message(error)) }
            else { waiter.resume(returning: value["result"] as? [String: Any] ?? [:]) }
        }
    }
    func request(_ operation: String, _ params: [String: Any] = [:]) async throws -> [String: Any] {
        try start(); sequence += 1; let id = sequence
        var data = try JSONSerialization.data(withJSONObject: ["id": id, "operation": operation, "params": params]); data.append(10)
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            timeouts[id] = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: 90_000_000_000) } catch { return }
                guard let self, let waiting = self.pending.removeValue(forKey: id) else { return }
                self.timeouts.removeValue(forKey: id)
                waiting.resume(throwing: ClientError.message("本地 MCP 操作超时，结果待确认；请刷新状态，不要重复执行工具。"))
                self.close()
            }
            do { try input?.write(contentsOf: data) }
            catch { pending.removeValue(forKey: id)?.resume(throwing: ClientError.message("本地 MCP 组件连接中断。")); timeouts.removeValue(forKey: id)?.cancel() }
        }
    }
    func share(settings: ConnectionSettings, thread: String, rpc: @escaping (String, [String: Any]) async throws -> [String: Any]) async throws -> [String: Any] {
        try settings.validate()
        let result = try await request("share", ["host": settings.host, "threadId": thread])
        do {
            let registration = try Self.registration(result)
            let read = try await rpc("config/read", ["cwd": settings.project, "includeLayers": false])
            let servers = (read["config"] as? [String: Any])?["mcp_servers"] as? [String: Any] ?? [:]
            if let existing = servers[registration.name] as? [String: Any] {
                guard existing["command"] as? String == registration.config["command"] as? String,
                      existing["args"] as? [String] == registration.config["args"] as? [String] else {
                    throw ClientError.message("远端存在同名的其他 MCP 配置，未覆盖。")
                }
            }
            _ = try await rpc("config/value/write", ["keyPath": "mcp_servers." + registration.name, "value": registration.config, "mergeStrategy": "replace"])
            _ = try await rpc("config/mcpServer/reload", [:])
            host = settings.host
            return result["snapshot"] as? [String: Any] ?? [:]
        } catch {
            _ = try? await request("stopBridge"); host = nil
            throw error
        }
    }
    static func registration(_ value: [String: Any]) throws -> (name: String, config: [String: Any]) {
        guard let name = value["serverName"] as? String, name.range(of: "^mac_local_[a-f0-9]{12}$", options: .regularExpression) != nil,
              let config = value["config"] as? [String: Any], config["command"] as? String == "python3",
              let args = config["args"] as? [String], args.count == 3, args[1] == "--endpoint",
              args[0].hasPrefix("/"), args[0].contains("/.local/share/remote-codex/local-mcp/"), args[0].hasSuffix("/proxy.py"),
              args[2].hasPrefix("/"), args[2].contains("/.local/state/remote-codex/local-mcp/"), args[2].hasSuffix("/endpoint.json"),
              args.allSatisfy({ !$0.contains("\n") && !$0.contains("\0") }) else { throw ClientError.message("本地 MCP 注册信息无效。") }
        return (name, ["command": "python3", "args": args, "enabled": true])
    }
    private func failed(_ message: String) {
        process = nil; input = nil; host = nil; buffer.removeAll()
        let waiters = pending; pending.removeAll(); timeouts.values.forEach { $0.cancel() }; timeouts.removeAll()
        waiters.values.forEach { $0.resume(throwing: ClientError.message(message)) }
        changed?(["servers": [], "sharing": false, "authorizedThreads": [], "message": message])
    }
    func close() {
        let child = process; process = nil
        try? input?.close(); input = nil
        if child?.isRunning == true { child?.terminate() }
        failed("本地 MCP 连接已关闭，远端任务继续运行。")
    }
}
