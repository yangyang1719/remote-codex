import Foundation

/// Account and optional thread estimates. No loading/resuming/turn mutations are permitted here.
@MainActor struct UsageReader {
    typealias Request = (String, [String: Any]) async throws -> [String: Any]
    let request: Request
    var recordUsage: ((String) async throws -> [String: Any])? = nil
    private func read(_ method: String, params: [String: Any] = [:]) async -> [String: Any] {
        do { return ["data": try await request(method, params)] }
        catch { return ["error": String(error.localizedDescription.prefix(300))] }
    }
    func snapshot(thread: String?) async -> [String: Any] {
        async let limits = read("account/rateLimits/read")
        async let account = read("account/usage/read")
        async let session: [String: Any] = thread == nil ? [:] : read("account/usage/read", params: ["threadId": thread!])
        let responses = await (limits, account, session)
        var record: Any = NSNull()
        if let thread, let recordUsage { record = ((try? await recordUsage(thread))?["snapshot"]) ?? NSNull() }
        return ["rateLimits": responses.0["data"] ?? NSNull(), "accountUsage": responses.1["data"] ?? NSNull(), "threadUsage": (responses.2["data"] as? [String: Any])?["threadUsage"] ?? NSNull(), "threadTokenSnapshot": record,
                "errors": ["rateLimits": responses.0["error"] ?? NSNull(), "accountUsage": responses.1["error"] ?? NSNull(), "threadUsage": responses.2["error"] ?? NSNull()],
                "threadId": thread as Any? ?? NSNull(), "fetchedAt": Int(Date().timeIntervalSince1970)]
    }
}
