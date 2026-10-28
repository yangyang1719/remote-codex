import Foundation
import CryptoKit
import Darwin

/// Private local drafts. Each mutation patches one record under a cross-process lock.
/// No credentials, pending approvals, or automatic send queue are stored here.
final class DraftStore {
    let root: URL
    init(root: URL? = nil) {
        self.root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("RemoteCodex/Drafts", isDirectory: true)
    }
    static func scope(_ settings: ConnectionSettings) -> String {
        digest([settings.host, settings.project, settings.socketIdentity, settings.executable].joined(separator: "\0"))
    }
    private static func digest(_ string: String) -> String { SHA256.hash(data: Data(string.utf8)).map { String(format: "%02x", $0) }.joined() }
    private func folder(_ scope: String) throws -> URL {
        guard scope.count == 64, scope.allSatisfy({ $0.isHexDigit }) else { throw ClientError.message("草稿所属连接无效。") }
        let dir = root.appendingPathComponent(scope, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        return dir
    }
    private func locked<T>(_ scope: String, _ work: (URL) throws -> T) throws -> T {
        let dir = try folder(scope), fd = Darwin.open(dir.appendingPathComponent(".lock").path, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw ClientError.message("无法打开本地草稿。") }
        defer { Darwin.close(fd) }
        guard flock(fd, LOCK_EX) == 0 else { throw ClientError.message("无法锁定本地草稿。") }
        defer { flock(fd, LOCK_UN) }
        return try work(dir)
    }
    private func read(_ dir: URL) throws -> [String: Any] {
        let file = dir.appendingPathComponent("drafts.json")
        guard FileManager.default.fileExists(atPath: file.path) else { return [:] }
        let data = try Data(contentsOf: file)
        guard data.count <= 32 * 1024 * 1024, let records = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ClientError.message("本地草稿损坏，已保留原文件。") }
        return records
    }
    func load(_ scope: String) throws -> [String: Any] { try locked(scope) { try read($0) } }
    func save(_ scope: String, kind: String, key: String, value: [String: Any], localFiles: [ChatAttachment] = []) throws {
        guard ["codex", "reply", "preferences"].contains(kind), !key.isEmpty, key.utf8.count <= 1024 else { throw ClientError.message("草稿信息无效。") }
        let encoded = try JSONSerialization.data(withJSONObject: value)
        guard encoded.count <= 2 * 1024 * 1024 else { throw ClientError.message("草稿过大，暂未保存。") }
        try locked(scope) { dir in
            var records = try read(dir)
            var value = value
            if ["codex", "reply"].contains(kind), !localFiles.isEmpty {
                var archived: [String: [String: Any]] = [:]
                for file in localFiles { archived[file.id] = try archive(file, scope: scope) }
                value["attachments"] = (value["attachments"] as? [[String: Any]] ?? []).map { row in (row["id"] as? String).flatMap { archived[$0] } ?? row }
            }
            // No whole-window snapshot can overwrite another conversation's draft.
            records[kind + ":" + key] = value
            let data = try JSONSerialization.data(withJSONObject: records, options: .sortedKeys)
            guard data.count <= 32 * 1024 * 1024 else { throw ClientError.message("本地草稿空间已满，暂未保存。") }
            let url = dir.appendingPathComponent("drafts.json")
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            let retained = Set(records.filter { $0.key.hasPrefix("codex:") || $0.key.hasPrefix("reply:") }.values.flatMap { raw in
                ((raw as? [String: Any])?["attachments"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String }
            })
            let files = dir.appendingPathComponent("files", isDirectory: true)
            for item in (try? FileManager.default.contentsOfDirectory(at: files, includingPropertiesForKeys: nil)) ?? [] where UUID(uuidString: item.lastPathComponent) != nil && !retained.contains(item.lastPathComponent) {
                try? FileManager.default.removeItem(at: item)
            }
        }
    }
    func archive(_ file: ChatAttachment, scope: String) throws -> [String: Any] {
        let dir = try folder(scope).appendingPathComponent("files/" + file.id, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let destination = dir.appendingPathComponent(file.localURL.lastPathComponent)
        if !FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.copyItem(at: file.localURL, to: destination); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path) }
        return ["id": file.id, "name": file.name, "file": destination.lastPathComponent, "sha256": file.sha256, "size": file.size]
    }
    func archivedURL(_ value: [String: Any], scope: String) throws -> URL {
        guard let id = value["id"] as? String, UUID(uuidString: id) != nil, let name = value["file"] as? String,
              !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\0") else { throw ClientError.message("保存的附件路径无效。") }
        let base = try folder(scope).appendingPathComponent("files", isDirectory: true).resolvingSymlinksInPath()
        let url = base.appendingPathComponent(id).appendingPathComponent(name).resolvingSymlinksInPath()
        guard url.path.hasPrefix(base.path + "/") else { throw ClientError.message("保存的附件超出草稿目录。") }
        return url
    }
}
