import Foundation

/// The official remote app-server owns OAuth credentials. Only display metadata
/// and the temporary user-facing device code may cross this boundary.
@MainActor final class RemoteAccount {
    typealias Request = (String, [String: Any]) async throws -> [String: Any]
    let request: Request
    let diagnostics: () async throws -> [[String: Any]]
    private(set) var login: [String: String]?
    private(set) var busy = false
    private var generation = UUID()
    var changed: (([String: Any]) -> Void)?
    init(request: @escaping Request, diagnostics: @escaping () async throws -> [[String: Any]]) {
        self.request = request; self.diagnostics = diagnostics
    }
    static func display(_ result: [String: Any]) -> [String: Any] {
        let account = (result["account"] as? [String: Any])?.filter { ["type", "email", "planType"].contains($0.key) }
        return ["account": account as Any? ?? NSNull(), "requiresOpenaiAuth": result["requiresOpenaiAuth"] as? Bool ?? true]
    }
    static func verificationURL(_ value: String) -> URL? {
        guard let url = URL(string: value), url.scheme == "https", url.host == "auth.openai.com", url.path == "/codex/device", url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil else { return nil }
        return url
    }
    func read() async throws -> [String: Any] { Self.display(try await request("account/read", ["refreshToken": false])) }
    func assertIdle() async throws {
        let rows = try await diagnostics()
        guard !rows.isEmpty else { throw ClientError.message("无法确认远端运行状态，请稍后重试。") }
        for row in rows {
            let gauges = row["gauges"] as? [[String: Any]] ?? []
            guard let active = row["accountActiveTurns"] as? Int ?? gauges.first(where: { $0["name"] as? String == "core.turns.active" })?["value"] as? Int else { throw ClientError.message("远端未提供任务运行状态，暂不能切换账号。") }
            guard active == 0 else { throw ClientError.message("远端仍有任务在运行，请等任务结束后再切换账号。") }
        }
    }
    func start() async throws -> [String: String] {
        guard !busy, login == nil else { throw ClientError.message("已有授权正在进行，请完成或取消后再试。") }
        busy = true; defer { busy = false }
        let current = generation
        try await assertIdle()
        guard current == generation else { throw CancellationError() }
        do { _ = try await request("account/logout", [:]) }
        catch { throw ClientError.message("退出远端账号未完成或结果未确认，未发起新登录。请刷新账号后重试。") }
        guard current == generation else { throw CancellationError() }
        do {
            let cleared = try await request("account/read", ["refreshToken": false])
            guard current == generation else { throw CancellationError() }
            guard cleared["account"] is NSNull else { throw ClientError.message("远端仍返回登录身份，未继续发起授权。") }
        } catch {
            guard current == generation else { throw CancellationError() }
            throw ClientError.message("退出请求已完成，但无法确认远端已登出，未发起新登录。请刷新账号后重试。")
        }
        changed?(["status": "signedOut", "message": "旧账号已退出，正在申请新账号的设备授权码。"])
        do {
            try await assertIdle()
            guard current == generation else { throw CancellationError() }
            return try await startDeviceCode(current: current)
        } catch {
            guard current == generation else { throw CancellationError() }
            throw ClientError.message("旧账号已退出，新登录尚未完成：\(error.localizedDescription) 请重新登录，旧账号不会自动恢复。")
        }
    }
    private func startDeviceCode(current: UUID) async throws -> [String: String] {
        let result = try await request("account/login/start", ["type": "chatgptDeviceCode"])
        guard current == generation else { throw CancellationError() }
        guard let id = result["loginId"] as? String, !id.isEmpty else { throw ClientError.message("远端未返回有效的设备授权，请重试。") }
        // Retain the exact ID before validating so malformed responses can still be canceled.
        login = ["loginId": id]
        guard result["type"] as? String == "chatgptDeviceCode", let code = result["userCode"] as? String,
              code.range(of: "^[A-Za-z0-9-]{4,64}$", options: .regularExpression) != nil,
              let url = result["verificationUrl"] as? String, Self.verificationURL(url) != nil else {
            try? await cancel(); throw ClientError.message("远端返回的设备授权信息无效，未打开登录页面。")
        }
        login = ["loginId": id, "userCode": code, "verificationUrl": url]
        return login!
    }
    func cancel() async throws {
        guard let id = login?["loginId"] else { return }
        let current = generation
        _ = try await request("account/login/cancel", ["loginId": id])
        if current == generation, login?["loginId"] == id { login = nil; changed?(["status": "canceled", "message": "已取消本次授权；旧账号不会自动恢复，请重新登录。"]) }
    }
    @discardableResult func completed(_ params: [String: Any]) -> Bool {
        guard let id = params["loginId"] as? String, id == login?["loginId"] else { return false }
        login = nil
        let success = params["success"] as? Bool == true
        changed?(["status": success ? "completed" : "failed", "message": success ? "远端账号已更新。" : "旧账号已退出；新授权未完成或已过期，请重新登录。"])
        return success
    }
    func disconnected() { let pending = login != nil || busy; generation = UUID(); login = nil; changed?(["status": "disconnected", "pending": pending]) }
}
