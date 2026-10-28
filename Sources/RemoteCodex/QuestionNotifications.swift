import AppKit
import UserNotifications

/// Routes contain only local request tokens and verified thread IDs, never answers or question text.
@MainActor final class QuestionAttention {
    struct Notice: Equatable {
        let token: String
        let thread: String
        let sourceThread: String
        let isQuestion: Bool
    }
    private(set) var pending: [String: Notice] = [:]
    var isVisible: (String) -> Bool = { _ in false }
    var deliver: ((Notice) -> Void)?
    var remove: (([String]) -> Void)?
    var countChanged: ((Int) -> Void)?
    var navigate: ((Notice) -> Void)?

    func receive(_ notice: Notice) {
        if pending[notice.token] != nil { pending[notice.token] = notice; return }
        pending[notice.token] = notice; countChanged?(pending.count)
        if !isVisible(notice.thread) { deliver?(notice) }
    }
    @discardableResult func open(_ token: String) -> Bool {
        guard let notice = pending[token] else { return false }
        navigate?(notice); return true
    }
    func resolve(_ token: String) {
        guard pending.removeValue(forKey: token) != nil else { return }
        remove?([token]); countChanged?(pending.count)
    }
    func clear() {
        let tokens = Array(pending.keys); pending.removeAll()
        if !tokens.isEmpty { remove?(tokens) }; countChanged?(0)
    }
}

/// Only the packaged GUI creates this adapter; CLI diagnostics and tests use injected delivery.
@MainActor final class QuestionNotifications: NSObject, UNUserNotificationCenterDelegate {
    private let center: UNUserNotificationCenter
    private var pending = Set<String>()
    private var authorization: Task<Bool, Never>?
    var open: ((String) -> Void)?
    var permissionChanged: ((String) -> Void)?
    private let prefix = "codex-question-"

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center; super.init(); center.delegate = self
    }
    func requestPermission() async -> Bool {
        if let authorization { return await authorization.value }
        let task = Task { @MainActor in
            do {
                let status = await center.notificationSettings().authorizationStatus
                let allowed: Bool
                if status == .notDetermined { allowed = try await center.requestAuthorization(options: [.alert, .sound, .badge]) }
                else { allowed = status == .authorized || status == .provisional }
                permissionChanged?(allowed ? "allowed" : "denied"); return allowed
            } catch { permissionChanged?("error"); return false }
        }
        authorization = task
        let allowed = await task.value; authorization = nil; return allowed
    }
    func refreshPermission() async {
        guard authorization == nil else { return }
        let status = await center.notificationSettings().authorizationStatus
        guard authorization == nil else { return }
        permissionChanged?(status == .notDetermined ? "unknown" : status == .authorized || status == .provisional ? "allowed" : "denied")
    }
    func deliver(_ notice: QuestionAttention.Notice) {
        pending.insert(notice.token)
        Task {
            guard await requestPermission(), pending.contains(notice.token) else { return }
            let content = UNMutableNotificationContent()
            content.title = notice.isQuestion ? "Codex 需要你的回答" : "Codex 需要审批"
            content.body = "点击打开对应会话并定位到待处理的问题。"
            content.sound = .default
            content.userInfo = ["questionToken": notice.token]
            content.threadIdentifier = notice.thread
            let id = prefix + notice.token
            do { try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) }
            catch { permissionChanged?("error") }
            // Resolution/disconnect can race permission UI or notification delivery.
            if !pending.contains(notice.token) { center.removePendingNotificationRequests(withIdentifiers: [id]); center.removeDeliveredNotifications(withIdentifiers: [id]) }
        }
    }
    func remove(_ tokens: [String]) {
        pending.subtract(tokens)
        let ids = tokens.map { prefix + $0 }
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        Task { @MainActor in
            let token = notification.request.content.userInfo["questionToken"] as? String ?? ""
            completionHandler(pending.contains(token) ? [.banner, .list, .sound] : [])
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let token = response.notification.request.content.userInfo["questionToken"] as? String
        let isOpen = response.actionIdentifier == UNNotificationDefaultActionIdentifier
        Task { @MainActor in
            if isOpen, let token, response.notification.request.identifier == prefix + token { open?(token) }
            completionHandler()
        }
    }
}
