import Foundation

enum AsyncQuestionReply {
    static func encode(_ body: [String: Any]) throws -> String {
        guard let source = body["sourceItemId"] as? String, !source.isEmpty, source.utf8.count < 512,
              let index = body["questionIndex"] as? Int, (0..<100).contains(index),
              let question = body["question"] as? String, !question.isEmpty, question.utf8.count < 100_000,
              let answer = body["answer"] as? String, !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              answer.utf8.count <= 32_000 else { throw ClientError.message("问题或回答无效，请重新打开问题卡片。") }
        let id = String(decoding: try JSONSerialization.data(withJSONObject: ["request_user_input_async", source, index], options: [.withoutEscapingSlashes]), as: UTF8.self)
        let value = [["questionItemId": id, "question": question, "answer": answer]]
        let json = String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]), as: UTF8.self)
        return "<send_user_message_question_reply>\n" + json + "\n</send_user_message_question_reply>"
    }
}

/// Async questions are ordinary agent items, not server RPC requests. Keep their
/// attention state separately; observing never acquires a writer or submits input.
struct AsyncQuestionStore {
    struct Entry {
        let token: String, thread: String, source: String, index: Int
        var question: [String: Any]
        var identity: String { AsyncQuestionStore.identity(source, index) }
        var snapshot: [String: Any] { ["token": token, "sourceItemId": source, "questionIndex": index, "questionItemId": identity, "question": question] }
    }
    private(set) var pending: [String: Entry] = [:]
    private var answered = Set<String>()
    static func identity(_ source: String, _ index: Int) -> String {
        String(decoding: try! JSONSerialization.data(withJSONObject: ["request_user_input_async", source, index], options: [.withoutEscapingSlashes]), as: UTF8.self)
    }
    private static func key(_ thread: String, _ identity: String) -> String { thread + "\0" + identity }
    static func replies(_ item: [String: Any]) -> [String] {
        guard item["type"] as? String == "userMessage" else { return [] }
        let text = (item["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined(separator: "\n")
        let start = "<send_user_message_question_reply>", end = "</send_user_message_question_reply>"
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix(start), trimmed.hasSuffix(end) else { return [] }
        let raw = String(trimmed.dropFirst(start.count).dropLast(end.count))
        guard let data = raw.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) else { return [] }
        let rows = value as? [[String: Any]] ?? (value as? [String: Any]).map { [$0] } ?? []
        var ids: [String] = []
        for row in rows {
            guard row["answer"] is String, row["question"] is String, let id = row["questionItemId"] as? String,
                  let data = id.data(using: .utf8), let parts = try? JSONSerialization.jsonObject(with: data) as? [Any],
                  parts.count == 3, parts[0] as? String == "request_user_input_async", let source = parts[1] as? String,
                  let index = parts[2] as? Int, (0..<100).contains(index) else { continue }
            ids.append(identity(source, index))
        }
        return ids
    }
    mutating func observe(_ items: [[String: Any]], thread: String) {
        // Process answers before questions, even on reverse-ordered history pages.
        for item in items { for id in Self.replies(item) { resolve(thread: thread, identity: id) } }
        for item in items where item["type"] as? String == "agentMessage" {
            guard let source = item["id"] as? String, !source.isEmpty, source.utf8.count < 512 else { continue }
            for (index, value) in (item["questions"] as? [[String: Any]] ?? []).prefix(100).enumerated() {
                guard let title = value["title"] as? String, !title.isEmpty, title.utf8.count < 100_000 else { continue }
                let key = Self.key(thread, Self.identity(source, index))
                guard !answered.contains(key) else { continue }
                let question: [String: Any] = ["title": title, "options": value["options"] as? [String] ?? []]
                if pending[key] != nil { pending[key]?.question = question }
                else { pending[key] = Entry(token: UUID().uuidString, thread: thread, source: source, index: index, question: question) }
            }
        }
    }
    mutating func resolve(thread: String, identity: String) { let key = Self.key(thread, identity); answered.insert(key); pending.removeValue(forKey: key) }
    mutating func clear() { pending.removeAll(); answered.removeAll() }
    func entries(thread: String) -> [Entry] { pending.values.filter { $0.thread == thread }.sorted { $0.source == $1.source ? $0.index < $1.index : $0.source < $1.source } }
}
