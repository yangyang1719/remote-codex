import Foundation
import Darwin
import CryptoKit

@MainActor final class MessageGateway {
    private var tunnel: Process?
    private var base: URL?
    private var socket: URLSessionWebSocketTask?
    private var generation = UUID()
    private let tunnelFactory: ((ConnectionSettings, UInt16) -> Process)?
    init(tunnelFactory: ((ConnectionSettings, UInt16) -> Process)? = nil) { self.tunnelFactory = tunnelFactory }
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 7
        config.connectionProxyDictionary = [:]
        return URLSession(configuration: config)
    }()
    var onEvent: (([String: Any]) -> Void)?
    var onDisconnect: ((String) -> Void)?

    static func availablePort() throws -> UInt16 {
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw ClientError.message("无法分配本机 SSH 转发端口。") }
        defer { Darwin.close(fd) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard bound == 0 else { throw ClientError.message("无法绑定本机回环端口。") }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let found = withUnsafeMutablePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
        guard found == 0 else { throw ClientError.message("无法读取本机转发端口。") }
        return UInt16(bigEndian: address.sin_port)
    }
    func connect(_ settings: ConnectionSettings) async throws -> [String: Any] {
        close()
        let token = generation
        let port = try Self.availablePort()
        let proc = tunnelFactory?(settings, port) ?? Process()
        if tunnelFactory == nil {
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
            proc.arguments = ["-N", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=20", "-L", "127.0.0.1:\(port):127.0.0.1:\(settings.gatewayPort)", settings.host]
        }
        proc.standardOutput = FileHandle.nullDevice; proc.standardError = FileHandle.nullDevice
        proc.terminationHandler = { [weak self] _ in Task { @MainActor in
            guard let self, self.generation == token else { return }
            self.close(); self.onDisconnect?("消息 SSH 通道已断开，正在自动重连。")
        } }
        try proc.run(); tunnel = proc; base = URL(string: "http://127.0.0.1:\(port)")!
        var last: Error = ClientError.message("远端消息服务尚未连接。")
        for _ in 0..<12 {
            try await Task.sleep(nanoseconds: 250_000_000)
            try Task.checkCancellation()
            guard tunnel === proc, proc.isRunning else { throw ClientError.message("消息服务 SSH 通道未建立。") }
            do {
                let result = try await request("/health")
                guard generation == token else { throw CancellationError() }
                let url = URL(string: "ws://127.0.0.1:\(port)/events")!
                var req = URLRequest(url: url); req.setValue("desktop", forHTTPHeaderField: "X-Remote-Codex")
                socket = session.webSocketTask(with: req); socket?.resume(); readEvents()
                return result
            } catch { last = error }
        }
        if generation == token { close() }; throw last
    }
    func request(_ path: String, method: String = "GET", body: [String: Any]? = nil, timeout: TimeInterval? = nil) async throws -> [String: Any] {
        let token = generation
        guard let base, let url = URL(string: path, relativeTo: base)?.absoluteURL else { throw ClientError.message("远端消息服务尚未连接。") }
        var req = URLRequest(url: url); req.httpMethod = method
        if let timeout { req.timeoutInterval = timeout }
        req.setValue("desktop", forHTTPHeaderField: "X-Remote-Codex")
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body); req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: req)
        guard token == generation else { throw CancellationError() }
        let payload = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { throw ClientError.message(payload["error"] as? String ?? "消息服务请求失败。") }
        return payload
    }
    func uploadMedia(_ file: ChatAttachment, conversation: String) async throws -> [String: Any] {
        let token = generation
        guard let base else { throw ClientError.message("消息服务尚未连接。") }
        var components = URLComponents(url: base.appendingPathComponent("media/upload"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "conversation_id", value: conversation), URLQueryItem(name: "name", value: file.isImage && URL(fileURLWithPath: file.name).pathExtension.lowercased() != file.localURL.pathExtension.lowercased() ? URL(fileURLWithPath: file.name).deletingPathExtension().lastPathComponent + "." + file.localURL.pathExtension : file.name)]
        var request = URLRequest(url: components.url!); request.httpMethod = "POST"; request.timeoutInterval = 120
        request.setValue("desktop", forHTTPHeaderField: "X-Remote-Codex")
        request.setValue(MessageMediaCache.mime(file.localURL), forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.upload(for: request, fromFile: file.localURL)
        guard token == generation else { throw CancellationError() }
        let result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode), let media = result["media"] as? [String: Any], media["sha256"] as? String == file.sha256 else { throw ClientError.message(result["error"] as? String ?? "媒体上传校验失败。") }
        return media
    }
    func downloadMedia(_ id: String) async throws -> Data {
        guard UUID(uuidString: id) != nil, let base else { throw ClientError.message("媒体标识无效或消息服务未连接。") }
        let token = generation
        var request = URLRequest(url: base.appendingPathComponent("media/" + id)); request.timeoutInterval = 120
        request.setValue("desktop", forHTTPHeaderField: "X-Remote-Codex")
        let (url, response) = try await session.download(for: request)
        defer { try? FileManager.default.removeItem(at: url) }
        guard token == generation else { throw CancellationError() }
        let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? Int.max
        guard size <= AttachmentStore.fileLimit else { throw ClientError.message("媒体超过 25 MB。") }
        let data = try Data(contentsOf: url)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
            let error = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw ClientError.message(error?["error"] as? String ?? "媒体下载失败，附件可能已过期。")
        }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard response.value(forHTTPHeaderField: "X-Content-SHA256") == digest else { throw ClientError.message("媒体下载校验失败。") }
        return data
    }
    private func readEvents() {
        guard let current = socket else { return }
        Task { @MainActor [weak self] in
            do {
                let message = try await current.receive()
                guard let self, self.socket === current else { return }
                let data: Data
                switch message { case .string(let text): data = Data(text.utf8); case .data(let bytes): data = bytes; @unknown default: return }
                if let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { self.onEvent?(event) }
                self.readEvents()
            } catch { guard let self, self.socket === current else { return }; self.close(); self.onDisconnect?("消息实时连接中断，正在自动重连并补读。") }
        }
    }
    func close() { generation = UUID(); socket?.cancel(with: .goingAway, reason: nil); socket = nil; tunnel?.terminationHandler = nil; if tunnel?.isRunning == true { tunnel?.terminate() }; tunnel = nil; base = nil }
}
