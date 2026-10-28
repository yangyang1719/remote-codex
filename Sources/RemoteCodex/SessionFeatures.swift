import Foundation

/// Pending requests retain the server ID across replay; UI tokens never expose it.
struct PendingQuestionStore {
    struct Entry { let token: String, id: Any, method: String, params: [String: Any]; var owner: String? }
    private(set) var entries: [String: Entry] = [:]
    static func key(_ id: Any) -> Data? { try? JSONSerialization.data(withJSONObject: id, options: [.fragmentsAllowed, .sortedKeys]) }
    mutating func insert(id: Any, method: String, params: [String: Any]) -> Entry {
        if let old = entries.values.first(where: { Self.key($0.id) == Self.key(id) }) { return old }
        let entry = Entry(token: UUID().uuidString, id: id, method: method, params: params)
        entries[entry.token] = entry; return entry
    }
    mutating func authorize(_ token: String, owner: String?) { entries[token]?.owner = owner }
    mutating func remove(_ token: String) { entries.removeValue(forKey: token) }
    mutating func resolve(_ id: Any) -> String? {
        guard let token = entries.values.first(where: { Self.key($0.id) == Self.key(id) })?.token else { return nil }
        remove(token); return token
    }
    mutating func clear() { entries.removeAll() }
    static func answers(_ body: [String: Any], questions: [[String: Any]]) throws -> [String: Any] {
        guard let answers = body["answers"] as? [String: Any], !questions.isEmpty else { throw ClientError.message("请回答问题后提交。") }
        var result: [String: Any] = [:]
        for question in questions {
            guard let id = question["id"] as? String, let value = answers[id] as? [String: Any], let texts = value["answers"] as? [String], texts.count == 1,
                  let text = texts.first, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf8.count <= 32_000 else { throw ClientError.message("请回答每个问题后提交。") }
            let options = question["options"] as? [[String: Any]] ?? []
            if !options.isEmpty && question["isOther"] as? Bool != true {
                guard options.contains(where: { $0["label"] as? String == text }) else { throw ClientError.message("请选择问题提供的选项。") }
            }
            result[id] = ["answers": texts]
        }
        return result
    }
}

enum SessionSettings {
    static func serviceTier(_ body: [String: Any], model: String, catalog: [[String: Any]]) throws -> [String: Any] {
        guard let raw = body["serviceTier"] else { return [:] }
        guard let tier = raw as? String, ["default", "fast", "priority"].contains(tier) else { throw ClientError.message("Fast 设置无效。") }
        if tier != "default" {
            let entry = catalog.first { $0["model"] as? String == model || $0["id"] as? String == model }
            let tiers = (entry?["serviceTiers"] as? [[String: Any]] ?? []).compactMap { $0["id"] as? String } + (entry?["additionalSpeedTiers"] as? [String] ?? [])
            guard tiers.contains(tier) else { throw ClientError.message("远端未提供该模型的 Fast 模式，请重新选择。") }
        }
        return ["serviceTier": tier]
    }
    static func validate(model: String, effort: String?, catalog: [[String: Any]]) throws {
        guard let entry = catalog.first(where: { $0["model"] as? String == model || $0["id"] as? String == model }) else { throw ClientError.message("该模型不在远端可选列表中，请重新选择。") }
        if let effort, !effort.isEmpty {
            guard (entry["supportedReasoningEfforts"] as? [[String: Any]] ?? []).contains(where: { $0["reasoningEffort"] as? String == effort }) else { throw ClientError.message("该模型不支持所选思考等级。") }
        }
    }
    static func parent(_ thread: [String: Any]) -> String? {
        thread["parentThreadId"] as? String ?? (((thread["source"] as? [String: Any])?["subAgent"] as? [String: Any])?["thread_spawn"] as? [String: Any])?["parent_thread_id"] as? String
    }
    static func agent(_ thread: [String: Any]) -> [String: Any] {
        let fields = ["id", "parentThreadId", "agentNickname", "agentRole", "name", "preview", "status", "model", "reasoningEffort", "updatedAt"]
        var result = thread.filter { fields.contains($0.key) }
        if let parent = parent(thread) { result["parentThreadId"] = parent }
        return result
    }
}

/// Uses metadata only. Never resumes, interrupts or acquires a child writer.
@MainActor final class SubagentFollower {
    typealias Read = (String, [String: Any]) async throws -> [String: Any]
    private let read: Read
    private let interval: UInt64
    private var task: Task<Void, Never>?
    private var generation = UUID()
    var onSnapshot: ((String, [[String: Any]], Bool) -> Void)?
    var onStatus: ((String, String) -> Void)?
    init(interval: UInt64 = 4_000_000_000, read: @escaping Read) { self.interval = interval; self.read = read }
    func stop() { generation = UUID(); task?.cancel(); task = nil }
    func start(_ root: String) {
        stop(); let current = generation
        task = Task { @MainActor [weak self] in
            guard let self else { return }
            var digest: Data?, lastStatus = ""
            var turns: [String: (stamp: Data, status: String)] = [:]
            var replies: [String: (stamp: Data, reply: [String: Any]?)] = [:]
            var previewOffset = 0
            while !Task.isCancelled, current == self.generation {
                do {
                    var rows: [String: [String: Any]] = [:], cursor: String?, seen = Set<String>(), more = false
                    for _ in 0..<40 {
                        var params: [String: Any] = ["ancestorThreadId": root, "sourceKinds": ["subAgent", "subAgentThreadSpawn", "subAgentOther", "subAgentReview", "subAgentCompact"], "limit": 50, "sortKey": "created_at", "sortDirection": "asc"]
                        if let cursor { params["cursor"] = cursor }
                        let response = try await self.read("thread/list", params)
                        try Task.checkCancellation(); guard current == self.generation else { return }
                        for thread in response["data"] as? [[String: Any]] ?? [] { if let id = thread["id"] as? String, id != root, SessionSettings.parent(thread) != nil { rows[id] = SessionSettings.agent(thread) } }
                        cursor = response["nextCursor"] as? String
                        guard let next = cursor, seen.insert(next).inserted else { more = false; break }
                        more = true
                    }
                    var reads = 0
                    let headIDs = rows.keys.sorted(), headStart = headIDs.isEmpty ? 0 : previewOffset % headIDs.count
                    let headOrder = Array(headIDs.dropFirst(headStart)) + Array(headIDs.prefix(headStart))
                    for id in headOrder {
                        guard var agent = rows[id], let status = agent["status"] as? [String: Any], status["type"] as? String != "active" else { continue }
                        let stamp = try JSONSerialization.data(withJSONObject: [status, agent["updatedAt"] ?? NSNull()], options: .sortedKeys)
                        if (turns[id]?.stamp != stamp || turns[id]?.status == "inProgress"), reads < 8 {
                            reads += 1
                            if let head = try? await self.read("thread/turns/list", ["threadId": id, "limit": 1, "sortDirection": "desc", "itemsView": "summary"]), let turn = (head["data"] as? [[String: Any]])?.first, let value = turn["status"] as? String {
                                turns[id] = (stamp, value)
                            }
                            try Task.checkCancellation(); guard current == self.generation else { return }
                        }
                        if let cached = turns[id], cached.stamp == stamp { agent["lastTurnStatus"] = cached.status; rows[id] = agent }
                    }
                    // Bounded, rotating reads: a large historical agent list must not
                    // create one always-on follower per agent.
                    let ids = rows.keys.sorted()
                    if !ids.isEmpty {
                        let start = previewOffset % ids.count
                        let order = Array(ids[start...]) + Array(ids[..<start])
                        var budget = 8
                        for id in order {
                            guard var agent = rows[id], let status = agent["status"] as? [String: Any] else { continue }
                            let stamp = try JSONSerialization.data(withJSONObject: [status, agent["updatedAt"] ?? NSNull(), agent["lastTurnStatus"] ?? NSNull()], options: .sortedKeys)
                            if budget > 0 && (status["type"] as? String == "active" || agent["lastTurnStatus"] as? String == "inProgress" || replies[id]?.stamp != stamp) {
                                budget -= 1
                                if let response = try? await self.read("thread/items/list", ["threadId": id, "limit": 20, "sortDirection": "desc"]) {
                                    replies[id] = (stamp, SubagentMessageContent.latestReply(response["data"] as? [[String: Any]] ?? []) ?? replies[id]?.reply)
                                }
                                try Task.checkCancellation(); guard current == self.generation else { return }
                            }
                            if let reply = replies[id]?.reply { agent["latestReply"] = reply; rows[id] = agent }
                        }
                        previewOffset = (start + 8) % ids.count
                    }
                    let agents = rows.values.sorted { ($0["id"] as? String ?? "") < ($1["id"] as? String ?? "") }
                    let value = try JSONSerialization.data(withJSONObject: agents, options: .sortedKeys)
                    if value != digest { digest = value; self.onSnapshot?(root, agents, more) }
                    if lastStatus != "current" { lastStatus = "current"; self.onStatus?(root, "current") }
                } catch { if Task.isCancelled || current != self.generation { return }; if lastStatus != "retrying" { lastStatus = "retrying"; self.onStatus?(root, "retrying") } }
                do { try await Task.sleep(nanoseconds: self.interval) } catch { return }
            }
        }
    }
}
