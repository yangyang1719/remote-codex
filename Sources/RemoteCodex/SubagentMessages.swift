import Foundation

enum SubagentMessageContent {
    static func item(_ raw: [String: Any]) -> [String: Any]? {
        guard let id = raw["id"] as? String, let type = raw["type"] as? String else { return nil }
        var value: [String: Any] = ["id": id, "type": type]
        switch type {
        case "agentMessage":
            let text = raw["text"] as? String ?? ""
            value["text"] = String(text.prefix(64_000)); value["truncated"] = text.count > 64_000
        case "userMessage":
            let text = (raw["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined(separator: "\n")
            value["text"] = String(text.prefix(64_000)); value["truncated"] = text.count > 64_000
        case "commandExecution": value["command"] = String((raw["command"] as? String ?? "运行命令").prefix(1000)); value["status"] = raw["status"]
        case "mcpToolCall": value["tool"] = raw["tool"]; value["server"] = raw["server"]; value["status"] = raw["status"]
        case "fileChange": value["paths"] = (raw["changes"] as? [[String: Any]] ?? []).compactMap { $0["path"] as? String }
        case "imageView": value["path"] = raw["path"]
        default: return nil
        }
        return value
    }
    /// Entries are newest first; the task prompt is never presented as a reply.
    static func latestReply(_ entries: [[String: Any]]) -> [String: Any]? {
        for entry in entries {
            guard let item = entry["item"] as? [String: Any], item["type"] as? String == "agentMessage", let text = item["text"] as? String, !text.isEmpty else { continue }
            return ["id": item["id"] ?? "", "text": String(text.prefix(500))]
        }
        return nil
    }
}

/// One visible inline conversation. Its independent cursor never moves the parent.
@MainActor final class SubagentMessages {
    typealias Read = ReadOnlyFollower.Request
    private let read: Read
    private let interval: UInt64
    private var task: Task<Void, Never>?
    private var follower: ReadOnlyFollower?
    private var generation = UUID()
    private(set) var thread: String?
    private var root: String?
    private var olderCursor: String?
    private var olderLoading = false
    var onPage: ((String, String, [[String: Any]], Bool, Bool) -> Void)?
    var onStatus: ((String, String, String) -> Void)?
    init(interval: UInt64 = 2_000_000_000, read: @escaping Read) { self.interval = interval; self.read = read }
    func stop() { generation = UUID(); task?.cancel(); task = nil; follower?.stop(); follower = nil; thread = nil; root = nil; olderCursor = nil; olderLoading = false }
    func start(root: String, thread: String) {
        if self.root == root, self.thread == thread { return }
        stop(); self.root = root; self.thread = thread
        let current = generation, follow = ReadOnlyFollower(interval: interval, request: read)
        follower = follow
        follow.canRead = { [weak self] id in self?.generation == current && self?.thread == id }
        follow.onItems = { [weak self] id, items in
            guard let self, self.generation == current else { return }
            let visible = items.compactMap(SubagentMessageContent.item)
            if !visible.isEmpty { self.onPage?(root, id, visible, false, self.olderCursor != nil) }
        }
        follow.onStatus = { [weak self] id, status in guard let self, self.generation == current else { return }; self.onStatus?(root, id, status) }
        onStatus?(root, thread, "loading")
        task = Task { @MainActor [weak self] in
            var failures = 0
            while let self, self.generation == current, !Task.isCancelled {
                do {
                    try await follow.prepare(thread)
                    let response = try await self.read("thread/items/list", ["threadId": thread, "limit": 30, "sortDirection": "desc"])
                    try Task.checkCancellation(); guard self.generation == current else { return }
                    let raw = (response["data"] as? [[String: Any]] ?? []).reversed().compactMap { $0["item"] as? [String: Any] }
                    self.olderCursor = response["nextCursor"] as? String
                    follow.observe(thread, items: raw)
                    self.onPage?(root, thread, raw.compactMap(SubagentMessageContent.item), true, self.olderCursor != nil)
                    follow.start(thread); return
                } catch {
                    if Task.isCancelled || self.generation != current { return }
                    self.onStatus?(root, thread, "retrying"); failures += 1
                    do { try await Task.sleep(nanoseconds: self.interval * UInt64(1 << min(failures, 4))) } catch { return }
                }
            }
        }
    }
    func loadOlder() async throws {
        guard !olderLoading, let thread, let root, let cursor = olderCursor else { return }
        let current = generation; olderLoading = true
        defer { if current == generation { olderLoading = false } }
        let response = try await read("thread/items/list", ["threadId": thread, "cursor": cursor, "limit": 30, "sortDirection": "desc"])
        guard current == generation else { return }
        let raw = (response["data"] as? [[String: Any]] ?? []).reversed().compactMap { $0["item"] as? [String: Any] }
        olderCursor = response["nextCursor"] as? String
        follower?.observe(thread, items: raw)
        onPage?(root, thread, raw.compactMap(SubagentMessageContent.item), true, olderCursor != nil)
    }
}
