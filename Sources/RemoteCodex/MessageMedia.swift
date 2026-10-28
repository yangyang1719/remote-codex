import AppKit
import WebKit
import CryptoKit
import UniformTypeIdentifiers
import ImageIO

/// Only native-registered media is exposed. A URL cannot address an arbitrary local file.
final class MessageMediaCache: NSObject, WKURLSchemeHandler {
    struct Entry { let url: URL; let mime: String; let size: Int; let payload: [String: Any] }
    private let root = FileManager.default.temporaryDirectory.appendingPathComponent("RemoteCodexMessageMedia-" + UUID().uuidString)
    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    private var scopes: [String: String] = [:]
    private var stopped = Set<ObjectIdentifier>()
    static func mime(_ url: URL) -> String { UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream" }
    static func replyKey(_ conversation: String) -> String { "wa:" + SHA256.hash(data: Data(conversation.utf8)).map { String(format: "%02x", $0) }.joined() }
    func cached(_ key: String) -> Entry? { lock.lock(); defer { lock.unlock() }; return scopes[key].flatMap { entries[$0] } }
    func put(_ data: Data, metadata: [String: Any], key: String) throws -> Entry {
        guard data.count <= AttachmentStore.fileLimit else { throw ClientError.message("媒体超过 25 MB。") }
        if let existing = cached(key) { return existing }
        let id = UUID().uuidString, name = AttachmentStore.safeMediaName(metadata["name"] as? String ?? "attachment")
        let directory = root.appendingPathComponent(id)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = directory.appendingPathComponent(name)
        try data.write(to: url, options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let kind = metadata["kind"] as? String ?? "document"
        let declared = metadata["mime"] as? String ?? Self.mime(url)
        let safeMIME = declared.range(of: #"^[A-Za-z0-9.+_-]+/[A-Za-z0-9.+_-]+$"#, options: .regularExpression) != nil
        let mime = safeMIME && ["image", "video", "audio"].contains(kind) && declared.hasPrefix(kind + "/") ? declared : "application/octet-stream"
        var payload: [String: Any] = ["url": "remote-codex-media://cache/" + id, "name": name, "size": data.count, "kind": kind, "mime": mime]
        if kind == "image", let source = CGImageSourceCreateWithData(data as CFData, nil),
           let p = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
           let width = p[kCGImagePropertyPixelWidth] as? Int, let height = p[kCGImagePropertyPixelHeight] as? Int,
           Double(width) * Double(height) <= 40_000_000,
           let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 480, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) {
            let bytes = NSMutableData()
            if let out = CGImageDestinationCreateWithData(bytes, UTType.png.identifier as CFString, 1, nil) { CGImageDestinationAddImage(out, image, nil); if CGImageDestinationFinalize(out) { payload["thumbnail"] = "data:image/png;base64," + (bytes as Data).base64EncodedString() } }
        }
        let entry = Entry(url: url, mime: mime, size: data.count, payload: payload)
        lock.lock(); entries[id] = entry; scopes[key] = id; lock.unlock()
        return entry
    }
    static func range(_ value: String?, size: Int) -> Range<Int>? {
        guard let value else { return 0..<size }
        guard value.hasPrefix("bytes="), !value.contains(",") else { return nil }
        let bits = value.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
        guard bits.count == 2 else { return nil }
        if bits[0].isEmpty, let suffix = Int(bits[1]), suffix > 0 { return max(0, size - suffix)..<size }
        guard let start = Int(bits[0]), start >= 0, start < size else { return nil }
        let end: Int
        if bits[1].isEmpty { end = size - 1 } else if let parsed = Int(bits[1]), parsed >= start { end = min(parsed, size - 1) } else { return nil }
        return start..<(end + 1)
    }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let token = ObjectIdentifier(urlSchemeTask)
        lock.lock(); stopped.remove(token); let entry = urlSchemeTask.request.url.flatMap { $0.host == "cache" ? entries[$0.lastPathComponent] : nil }; lock.unlock()
        guard let entry, let url = urlSchemeTask.request.url else { urlSchemeTask.didFailWithError(ClientError.message("媒体缓存不存在。")); return }
        do {
            let range = Self.range(urlSchemeTask.request.value(forHTTPHeaderField: "Range"), size: entry.size)
            guard let range else {
                urlSchemeTask.didReceive(HTTPURLResponse(url: url, statusCode: 416, httpVersion: "HTTP/1.1", headerFields: ["Content-Range": "bytes */\(entry.size)"])!); urlSchemeTask.didFinish(); return
            }
            let handle = try FileHandle(forReadingFrom: entry.url); defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(range.lowerBound))
            var headers = ["Content-Type": entry.mime, "Content-Length": String(range.count), "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*"]
            let partial = urlSchemeTask.request.value(forHTTPHeaderField: "Range") != nil
            if partial { headers["Content-Range"] = "bytes \(range.lowerBound)-\(range.upperBound - 1)/\(entry.size)" }
            urlSchemeTask.didReceive(HTTPURLResponse(url: url, statusCode: partial ? 206 : 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
            var remaining = range.count
            while remaining > 0 { let data = try handle.read(upToCount: min(65536, remaining)) ?? Data(); if data.isEmpty { break }; urlSchemeTask.didReceive(data); remaining -= data.count }
            urlSchemeTask.didFinish()
        } catch { urlSchemeTask.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { lock.lock(); stopped.insert(ObjectIdentifier(urlSchemeTask)); lock.unlock() }
    func close() { lock.lock(); entries.removeAll(); scopes.removeAll(); lock.unlock(); try? FileManager.default.removeItem(at: root) }
}

extension AttachmentStore {
    nonisolated static func safeMediaName(_ name: String) -> String {
        let cleaned = name.map { "/\\\0\r\n".contains($0) ? "_" : $0 }
        var value = ""
        for character in cleaned { if value.utf8.count + String(character).utf8.count > 240 { break }; value.append(character) }
        return value.isEmpty || value == "." || value == ".." ? "attachment" : value
    }
    func importMedia(_ url: URL, name: String, draftKey: String) async throws -> ChatAttachment {
        let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? Int.max
        let id = UUID().uuidString
        try begin(id: id, draftKey: draftKey, name: Self.safeMediaName(name), size: size)
        do {
            let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }; var offset = 0
            while let data = try handle.read(upToCount: 65536), !data.isEmpty { try append(id: id, offset: offset, base64: data.base64EncodedString()); offset += data.count }
            return try await finish(id: id)
        } catch { remove(id); throw error }
    }
}
