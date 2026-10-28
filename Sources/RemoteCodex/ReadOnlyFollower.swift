import Foundation
import CryptoKit

/// Follows persisted items from another connection without loading its writer.
@MainActor final class ReadOnlyFollower {
    typealias Request = (String, [String: Any]) async throws -> [String: Any]
    private let request: Request
    private let interval: UInt64
    private var task: Task<Void, Never>?
    private var generation = UUID()
    private var threadID: String?
    private var cursor: String?
    private var seen: [String: Data] = [:]
    private var status = ""
    var canRead: (String) -> Bool = { _ in true }
    var onItems: (String, [[String: Any]]) -> Void = { _, _ in }
    var onStatus: (String, String) -> Void = { _, _ in }

    init(interval: UInt64 = 2_000_000_000, request: @escaping Request) {
        self.interval = interval; self.request = request
    }

    // Capture the tail BEFORE the initial history read. Items written during
    // that read are then included, even if the writer starts another turn.
    func prepare(_ id: String) async throws {
        stop(); threadID = id
        let token = generation
        let result = try await request("thread/items/list", ["threadId": id, "sortDirection": "desc", "limit": 1])
        guard token == generation, threadID == id else { return }
        cursor = result["backwardsCursor"] as? String
        if cursor == nil, !(result["data"] as? [Any] ?? []).isEmpty { throw ClientError.message("远端未提供增量历史游标。") }
    }

    func observe(_ id: String, items: [[String: Any]]) {
        guard threadID == id else { return }
        for item in items { if let key = item["id"] as? String { seen[key] = Self.fingerprint(item) } }
    }

    func start(_ id: String) {
        guard threadID == id, task == nil else { return }
        let token = generation
        report(id, "active")
        task = Task { @MainActor [weak self] in
            var failures = 0
            while !Task.isCancelled {
                guard let self, self.generation == token, self.threadID == id else { return }
                do {
                    try await Task.sleep(nanoseconds: self.interval * UInt64(1 << min(failures, 4)))
                    guard !Task.isCancelled, self.generation == token else { return }
                    guard self.canRead(id) else { continue }
                    // Drain a bounded batch, then yield before requesting more.
                    // At the tail, retain the last page's cursor so its anchor
                    // can be updated while new items are appended after it.
                    var params: [String: Any] = ["threadId": id, "sortDirection": "asc", "limit": 40]
                    if let cursor = self.cursor { params["cursor"] = cursor }
                    let result = try await self.request("thread/items/list", params)
                    guard !Task.isCancelled, self.generation == token, self.canRead(id) else { continue }
                    let entries = result["data"] as? [[String: Any]] ?? []
                    let items = entries.compactMap { $0["item"] as? [String: Any] }
                    var changed: [[String: Any]] = []
                    for item in items {
                        guard let key = item["id"] as? String else { continue }
                        let digest = Self.fingerprint(item)
                        if self.seen[key] != digest { self.seen[key] = digest; changed.append(item) }
                    }
                    if !changed.isEmpty { self.onItems(id, changed) }
                    if let next = result["nextCursor"] as? String { self.cursor = next }
                    else if entries.count > 3 {
                        // Compact the overlap only when the fresh tail has
                        // already been observed. A racing append is never skipped.
                        let head = try await self.request("thread/items/list", ["threadId": id, "sortDirection": "desc", "limit": 1])
                        guard !Task.isCancelled, self.generation == token, self.canRead(id) else { continue }
                        if let latest = (head["data"] as? [[String: Any]])?.first?["item"] as? [String: Any],
                           let key = latest["id"] as? String, self.seen[key] == Self.fingerprint(latest),
                           let anchor = head["backwardsCursor"] as? String { self.cursor = anchor }
                    }
                    failures = 0; self.report(id, "active")
                } catch is CancellationError { return }
                catch {
                    guard !Task.isCancelled, self.generation == token else { return }
                    failures += 1; self.report(id, "retrying")
                }
            }
        }
    }

    func stop() { generation = UUID(); task?.cancel(); task = nil; threadID = nil; cursor = nil; seen.removeAll(); status = "" }
    private func report(_ id: String, _ value: String) { guard status != value else { return }; status = value; onStatus(id, value) }
    private static func fingerprint(_ item: [String: Any]) -> Data {
        let data = (try? JSONSerialization.data(withJSONObject: item, options: [.sortedKeys])) ?? Data()
        return Data(SHA256.hash(data: data))
    }
}
