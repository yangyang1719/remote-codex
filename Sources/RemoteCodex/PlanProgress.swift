import Foundation
import CryptoKit

/// Projects durable plan updates without resuming/subscribing to a thread.
@MainActor final class PlanProgressFollower {
    typealias Read = (String, [String: Any]?) async throws -> [String: Any]
    private let read: Read
    private let interval: UInt64
    private var task: Task<Void, Never>?
    private var generation = UUID()
    private var selected: String?
    private var version = 0
    private var live: Data?
    private var expectedTurn: String?
    private var last: Data?
    private var status = ""
    var onSnapshot: (String, [String: Any]?) -> Void = { _, _ in }
    var onStatus: (String, String) -> Void = { _, _ in }

    init(interval: UInt64 = 4_000_000_000, read: @escaping Read) { self.interval = interval; self.read = read }
    func start(_ id: String) {
        stop(); selected = id
        let token = generation
        report(id, "loading")
        task = Task { @MainActor [weak self] in
            var cursor: [String: Any]?, failures = 0, more = true
            while !Task.isCancelled {
                guard let self, self.generation == token, self.selected == id else { return }
                do {
                    if !more { try await Task.sleep(nanoseconds: self.interval * UInt64(1 << min(failures, 3))) }
                    guard !Task.isCancelled, self.generation == token else { return }
                    let revision = self.version
                    let result = try await self.read(id, cursor)
                    guard !Task.isCancelled, self.generation == token, result["threadId"] as? String == id else { return }
                    cursor = result["cursor"] as? [String: Any]; more = result["hasMore"] as? Bool == true
                    failures = 0
                    if more { try await Task.sleep(nanoseconds: 30_000_000); continue }
                    guard revision == self.version else { continue }
                    if let expected = self.expectedTurn, result["turnId"] as? String != expected { continue }
                    let plan = result["plan"] as? [String: Any]
                    let digest = Self.digest(plan)
                    // A live event can precede the durable append. Never replace
                    // it with an older read, even on a later poll before flush.
                    if let live = self.live, digest != live { continue }
                    self.live = nil; self.expectedTurn = nil
                    if digest != self.last { self.last = digest; self.onSnapshot(id, plan) }
                    self.report(id, "current")
                } catch is CancellationError { return }
                catch {
                    guard !Task.isCancelled, self.generation == token else { return }
                    failures += 1; more = false; self.report(id, "retrying")
                }
            }
        }
    }
    func observeLive(_ id: String, plan: [String: Any]) {
        guard selected == id else { return }
        version += 1; live = Self.digest(plan); last = live; expectedTurn = plan["turnId"] as? String
        report(id, "current")
    }
    func observeTurn(_ id: String, turn: String) {
        guard selected == id, expectedTurn != turn else { return }
        version += 1; expectedTurn = turn; live = nil; last = nil
    }
    func stop() { generation = UUID(); task?.cancel(); task = nil; selected = nil; live = nil; expectedTurn = nil; last = nil; version = 0; status = "" }
    private func report(_ id: String, _ value: String) { guard status != value else { return }; status = value; onStatus(id, value) }
    private static func digest(_ value: [String: Any]?) -> Data {
        // Notification and durable snapshot carry the same user-visible fields.
        let fields = value.map { ["turnId": $0["turnId"] ?? NSNull(), "explanation": $0["explanation"] ?? NSNull(), "plan": $0["plan"] ?? []] }
        let data = (try? JSONSerialization.data(withJSONObject: fields as Any? ?? NSNull(), options: [.sortedKeys, .fragmentsAllowed])) ?? Data()
        return Data(SHA256.hash(data: data))
    }
}

/// A short SSH read, with bounded private temporary files and cancellable I/O.
/// Installs only an immutable per-session callback; no resident Python service.
@MainActor final class SSHPlanReader {
    private var processes: [UUID: Process] = [:]
    private var cancelled = Set<UUID>()
    func read(thread: String, path: String, cursor: [String: Any]?, latestTurn: String? = nil, settings: ConnectionSettings) async throws -> [String: Any] {
        try settings.validate()
        guard UUID(uuidString: thread) != nil, path.hasPrefix("/"), !path.contains("\0") else { throw ClientError.message("远端计划记录标识无效。") }
        let script = try String(contentsOf: AppResources.directory.appendingPathComponent("plan_snapshot.py"), encoding: .utf8)
        return try await run(script: script, payload: ["threadId": thread, "path": path, "cursor": cursor as Any? ?? NSNull(), "latestTurnId": latestTurn as Any? ?? NSNull()], settings: settings)
    }
    func prepare(settings: ConnectionSettings) async throws -> [String: Any] {
        let data = try Data(contentsOf: AppResources.directory.appendingPathComponent("plan_recorder.py"))
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let result = try await run(script: Self.installScript, payload: ["code": data.base64EncodedString(), "sha256": digest], settings: settings)
        guard result["sha256"] as? String == digest, let config = result["config"] as? [String: Any] else { throw ClientError.message("计划记录回调校验失败。") }
        return config
    }
    func usage(thread: String, path: String, settings: ConnectionSettings) async throws -> [String: Any] {
        guard UUID(uuidString: thread) != nil, path.hasPrefix("/"), !path.contains("\0") else { throw ClientError.message("会话用量记录标识无效。") }
        let script = try String(contentsOf: AppResources.directory.appendingPathComponent("usage_snapshot.py"), encoding: .utf8)
        return try await run(script: script, payload: ["threadId": thread, "path": path], settings: settings)
    }
    private func run(script: String, payload: [String: Any], settings: ConnectionSettings) async throws -> [String: Any] {
        try settings.validate()
        let id = UUID(), folder = FileManager.default.temporaryDirectory.appendingPathComponent("RemoteCodexPlan-" + id.uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: folder) }
        let request = folder.appendingPathComponent("request"), output = folder.appendingPathComponent("output"), errors = folder.appendingPathComponent("errors")
        let data = try JSONSerialization.data(withJSONObject: payload)
        guard data.count <= 2_000_000 else { throw ClientError.message("计划进度记录过大。") }
        for (url, contents) in [(request, data), (output, Data()), (errors, Data())] {
            guard FileManager.default.createFile(atPath: url.path, contents: contents, attributes: [.posixPermissions: 0o600]) else { throw ClientError.message("无法读取计划进度。") }
        }
        let source = try FileHandle(forReadingFrom: request), destination = try FileHandle(forWritingTo: output), errorFile = try FileHandle(forWritingTo: errors)
        defer { try? source.close(); try? destination.close(); try? errorFile.close() }
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = Array(settings.sshArguments.dropLast()) + ["exec python3 -c " + ConnectionSettings.quote(script)]
        process.standardInput = source; process.standardOutput = destination; process.standardError = errorFile
        processes[id] = process
        defer { processes.removeValue(forKey: id); cancelled.remove(id) }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let timeout = Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 25_000_000_000)
                    guard !Task.isCancelled, process.isRunning else { return }; process.terminate()
                }
                process.terminationHandler = { [weak self] ended in
                    Task { @MainActor in
                        timeout.cancel(); process.terminationHandler = nil
                        do {
                            if self?.cancelled.contains(id) == true { throw CancellationError() }
                            guard ended.terminationStatus == 0 else { throw ClientError.message("远端计划进度暂时无法读取。") }
                            let size = try output.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                            guard size <= 4_000_000, let result = try JSONSerialization.jsonObject(with: Data(contentsOf: output)) as? [String: Any] else { throw ClientError.message("远端计划进度格式无效。") }
                            continuation.resume(returning: result)
                        } catch { continuation.resume(throwing: error) }
                    }
                }
                do { try Task.checkCancellation(); try process.run() }
                catch { timeout.cancel(); process.terminationHandler = nil; continuation.resume(throwing: error) }
            }
        } onCancel: { Task { @MainActor [weak self] in self?.cancel(id) } }
    }
    private func cancel(_ id: UUID) { cancelled.insert(id); if let process = processes[id], process.isRunning { process.terminate() } }
    func cancelAll() { for id in processes.keys { cancel(id) } }
    private static let installScript = #"""
import base64,hashlib,json,os,pathlib,sys,tempfile
value=json.load(sys.stdin);code=base64.b64decode(value['code']);digest=hashlib.sha256(code).hexdigest()
assert digest==value['sha256']
root=pathlib.Path.home()/'.local/share/remote-codex/plan-hooks'
root.mkdir(parents=True,exist_ok=True,mode=0o700)
assert not root.is_symlink();root.chmod(0o700)
path=root/(digest+'.py')
if path.exists():
 assert not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest()==digest
else:
 fd,temp=tempfile.mkstemp(prefix='.prepare-',dir=root)
 try:
  with os.fdopen(fd,'wb') as file:file.write(code)
  os.link(temp,path)
 finally:os.unlink(temp)
command='/usr/bin/python3 -I '+"'"+str(path).replace("'","'\\''")+"'"
handler={'type':'command','command':command,'timeout':2,'async':False}
matcher=r'^(functions\.)?update_plan$'
identity={'event_name':'post_tool_use','matcher':matcher,'hooks':[handler]}
trust='sha256:'+hashlib.sha256(json.dumps(identity,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
key='/<session-flags>/config.toml:post_tool_use:0:0'
config={'tools.update_plan.enabled':True,'features.hooks':True,'hooks.PostToolUse':[{'matcher':matcher,'hooks':[handler]}],'hooks.state':{key:{'trusted_hash':trust}}}
print(json.dumps({'sha256':digest,'config':config}))
"""#

}
