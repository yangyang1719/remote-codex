import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Authorizes only image paths actually reported by the server for this thread.
@MainActor final class ViewedImageStore {
    private struct Record { let path: String; var local: URL?; var thumbnail: String? }
    private struct Key: Hashable { let scope: String, thread: String, item: String }
    private var records: [Key: Record] = [:]

    func observe(_ item: [String: Any], thread: String, scope: String) {
        guard item["type"] as? String == "imageView", let id = item["id"] as? String, !id.isEmpty,
              let path = item["path"] as? String, path.hasPrefix("/"), path.utf8.count < 4096, !path.contains("\0") else { return }
        let key = Key(scope: scope, thread: thread, item: id)
        if records[key]?.path != path { records[key] = Record(path: path) }
    }
    func path(thread: String, item: String, scope: String) throws -> String {
        guard let record = records[Key(scope: scope, thread: thread, item: item)] else { throw ClientError.message("未找到此会话的图片查看记录，请刷新记录。") }
        return record.path
    }
    func cached(thread: String, item: String, scope: String) -> (URL, String)? {
        guard let record = records[Key(scope: scope, thread: thread, item: item)], let local = record.local, let thumbnail = record.thumbnail,
              FileManager.default.fileExists(atPath: local.path) else { return nil }
        return (local, thumbnail)
    }
    func cache(_ url: URL, thread: String, item: String, scope: String, path: String) async throws -> (URL, String) {
        let thumbnail = try await Task.detached(priority: .utility) { try Self.thumbnail(url) }.value
        let key = Key(scope: scope, thread: thread, item: item)
        guard records[key]?.path == path else { throw ClientError.message("图片查看记录已变化，请重新打开。") }
        records[key]?.local = url; records[key]?.thumbnail = thumbnail
        return (url, thumbnail)
    }
    nonisolated static func thumbnail(_ url: URL) throws -> String {
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= AttachmentStore.fileLimit,
              let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = props[kCGImagePropertyPixelWidth] as? Int, let height = props[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, Double(width) * Double(height) <= 40_000_000,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 240, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else {
            throw ClientError.message("图片已不可读取、格式不支持或尺寸过大。")
        }
        let data = NSMutableData()
        guard let output = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { throw ClientError.message("无法生成图片缩略图。") }
        CGImageDestinationAddImage(output, image, nil)
        guard CGImageDestinationFinalize(output) else { throw ClientError.message("无法生成图片缩略图。") }
        return "data:image/png;base64," + (data as Data).base64EncodedString()
    }
}
