import Foundation
import Darwin

struct WorkspaceProject: Codable, Equatable {
    let id: String
    var name: String
    var settings: ConnectionSettings
    var collapsed = false
}
struct WorkspaceState: Codable {
    var projects: [WorkspaceProject] = []
    var activeID: String?
    var pinned: [String: Set<String>] = [:]
    var archived: [String: Set<String>] = [:]
}

/// Local navigation only. Removing/archiving entries never modifies remote files or tasks.
final class WorkspaceCatalog {
    let root: URL
    init(root: URL? = nil) {
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("RemoteCodex/Workspace", isDirectory: true)
    }
    private func transaction<T>(_ action: (inout WorkspaceState, Bool) throws -> T) throws -> T {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let fd = Darwin.open(root.appendingPathComponent(".lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw ClientError.message("无法读取本地项目列表。") }; defer { Darwin.close(fd) }
        guard flock(fd, LOCK_EX) == 0 else { throw ClientError.message("无法锁定项目列表。") }; defer { flock(fd, LOCK_UN) }
        let file = root.appendingPathComponent("projects.json"), exists = FileManager.default.fileExists(atPath: file.path)
        let data = exists ? try Data(contentsOf: file) : nil
        var state = try data.map { try JSONDecoder().decode(WorkspaceState.self, from: $0) } ?? WorkspaceState()
        let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
        let old = try encoder.encode(state), result = try action(&state, exists), new = try encoder.encode(state)
        if !exists || old != new { try new.write(to: file, options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path) }
        return result
    }
    func load(seed: ConnectionSettings) throws -> WorkspaceState {
        try transaction { state, exists in
            if !exists { state.projects = [.init(id: UUID().uuidString, name: Self.defaultName(seed), settings: seed)]; state.activeID = state.projects.first?.id }
            return state
        }
    }
    func add(_ settings: ConnectionSettings, name: String? = nil) throws -> WorkspaceProject {
        try settings.validate()
        let title = try Self.title(name?.isEmpty == false ? name! : Self.defaultName(settings))
        return try transaction { state, _ in
            if let existing = state.projects.first(where: { DraftStore.scope($0.settings) == DraftStore.scope(settings) }) { return existing }
            let project = WorkspaceProject(id: UUID().uuidString, name: title, settings: settings)
            state.projects.append(project); return project
        }
    }
    func update(_ id: String, operation: String, name: String? = nil, flag: Bool? = nil, thread: String? = nil) throws -> WorkspaceState {
        try transaction { state, _ in
            guard let index = state.projects.firstIndex(where: { $0.id == id }) else { throw ClientError.message("项目已不在列表中。") }
            switch operation {
            case "select": state.activeID = id; state.projects[index].collapsed = false
            case "rename": state.projects[index].name = try Self.title(name ?? "")
            case "collapse": state.projects[index].collapsed = flag ?? false
            case "remove": state.projects.remove(at: index); state.pinned.removeValue(forKey: id); state.archived.removeValue(forKey: id); if state.activeID == id { state.activeID = state.projects.first?.id }
            case "pin", "archive":
                guard let thread, !thread.isEmpty, thread.utf8.count < 256 else { throw ClientError.message("会话标识无效。") }
                if operation == "pin" { if flag == true { state.pinned[id, default: []].insert(thread) } else { state.pinned[id]?.remove(thread) } }
                else { if flag == true { state.archived[id, default: []].insert(thread) } else { state.archived[id]?.remove(thread) } }
            default: throw ClientError.message("项目操作无效。")
            }
            return state
        }
    }
    func configure(_ settings: ConnectionSettings) throws -> WorkspaceState {
        let project = try add(settings)
        return try transaction { state, _ in
            if let index = state.projects.firstIndex(where: { $0.id == project.id }) { state.projects[index].settings = settings }
            state.activeID = project.id; return state
        }
    }
    static func title(_ name: String) throws -> String {
        let result = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !result.isEmpty, result.count <= 128, !result.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { throw ClientError.message("名称需为 1–128 个字符，不能包含控制字符。") }
        return result
    }
    static func defaultName(_ settings: ConnectionSettings) -> String { settings.project.split(separator: "/").last.map(String.init) ?? settings.host }
    static func sameServer(_ lhs: ConnectionSettings, _ rhs: ConnectionSettings) -> Bool { lhs.host == rhs.host && lhs.executable == rhs.executable && lhs.socketIdentity == rhs.socketIdentity && lhs.usesOfficialDaemon == rhs.usesOfficialDaemon }
    static func sameDirectory(_ lhs: String, _ rhs: String) -> Bool { (lhs as NSString).standardizingPath == (rhs as NSString).standardizingPath }
}

@MainActor final class ThreadManagement {
    typealias Request = (String, [String: Any]) async throws -> [String: Any]
    private let request: Request
    init(request: @escaping Request) { self.request = request }
    func metadata(_ id: String, project: String) async throws -> [String: Any] {
        let result = try await request("thread/read", ["threadId": id, "includeTurns": false])
        guard let thread = result["thread"] as? [String: Any], thread["id"] as? String == id,
              let cwd = thread["cwd"] as? String, WorkspaceCatalog.sameDirectory(cwd, project), SessionSettings.parent(thread) == nil else { throw ClientError.message("会话不属于此项目，或它是子代理。") }
        return thread
    }
    func rename(_ id: String, project: String, name: String) async throws -> [String: Any] {
        _ = try await metadata(id, project: project)
        _ = try await request("thread/name/set", ["threadId": id, "name": WorkspaceCatalog.title(name)])
        return try await metadata(id, project: project)
    }
    func fork(_ id: String, project: String, config: [String: Any]) async throws -> [String: Any] {
        _ = try await metadata(id, project: project)
        let turns = try await request("thread/turns/list", ["threadId": id, "limit": 100, "sortDirection": "desc", "itemsView": "summary"])
        guard let turn = (turns["data"] as? [[String: Any]])?.first(where: { $0["status"] as? String != "inProgress" }), let last = turn["id"] as? String else { throw ClientError.message("此会话还没有已结束的回合，请稍后再分叉。") }
        let result = try await request("thread/fork", ["threadId": id, "cwd": project, "lastTurnId": last, "excludeTurns": true, "deferGoalContinuation": true, "config": config])
        guard let thread = result["thread"] as? [String: Any], let newID = thread["id"] as? String, newID != id else { throw ClientError.message("分叉返回的会话标识异常。") }
        // The official deferred continuation prevents inference before this pause.
        if let goal = try? await request("thread/goal/get", ["threadId": newID])["goal"] as? [String: Any], goal["status"] as? String == "active" {
            _ = try await request("thread/goal/set", ["threadId": newID, "status": "paused", "origin": "user"])
        }
        return result
    }
}
