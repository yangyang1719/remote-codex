import AppKit
import CryptoKit
import ImageIO
import UniformTypeIdentifiers

struct ChatAttachment {
    let id: String
    let draftKey: String
    let name: String
    let localURL: URL
    let size: Int
    let isImage: Bool
    let thumbnail: String?
    let sha256: String
    var payload: [String: Any] {
        var value: [String: Any] = ["id": id, "name": name, "size": size, "isImage": isImage, "status": "ready"]
        if let thumbnail { value["thumbnail"] = thumbnail }
        return value
    }
}

@MainActor final class AttachmentStore {
    nonisolated static let fileLimit = 25 * 1024 * 1024
    nonisolated static let totalLimit = 100 * 1024 * 1024
    nonisolated static let countLimit = 10
    private struct Incoming {
        let draftKey: String, name: String, size: Int, url: URL, handle: FileHandle
        var received = 0
    }
    let root: URL
    private var incoming: [String: Incoming] = [:]
    private var files: [String: ChatAttachment] = [:]
    private var sent: [String: ChatAttachment] = [:]

    init(root: URL? = nil) {
        self.root = root ?? FileManager.default.temporaryDirectory.appendingPathComponent("RemoteCodexAttachments-" + UUID().uuidString, isDirectory: true)
    }
    func begin(id: String, draftKey: String, name: String, size: Int) throws {
        guard UUID(uuidString: id) != nil, files[id] == nil, incoming[id] == nil, !draftKey.isEmpty, draftKey.count <= 128 else { throw ClientError.message("附件标识无效。") }
        guard size >= 0, size <= Self.fileLimit else { throw ClientError.message("单个附件最多 25 MB。") }
        let count = files.values.filter { $0.draftKey == draftKey }.count + incoming.values.filter { $0.draftKey == draftKey }.count
        let total = files.values.reduce(0) { $0 + $1.size } + incoming.values.reduce(0) { $0 + $1.size }
        guard count < Self.countLimit, total + size <= Self.totalLimit else { throw ClientError.message("每条消息最多 10 个附件，暂存总量最多 100 MB。") }
        guard !name.isEmpty, name.utf8.count <= 512, name != ".", name != "..", !name.contains("/"), !name.contains("\0") else { throw ClientError.message("附件文件名无效。") }
        let directory = root.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = directory.appendingPathComponent(name)
        guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { throw ClientError.message("无法暂存附件。") }
        incoming[id] = Incoming(draftKey: draftKey, name: name, size: size, url: url, handle: try FileHandle(forWritingTo: url))
    }
    func append(id: String, offset: Int, base64: String) throws {
        guard var item = incoming[id], offset == item.received,
              base64.utf8.count <= 100_000, let data = Data(base64Encoded: base64),
              item.received + data.count <= item.size else { throw ClientError.message("附件传入的数据不完整，请重新添加。") }
        try item.handle.write(contentsOf: data); item.received += data.count; incoming[id] = item
    }
    func finish(id: String) async throws -> ChatAttachment {
        guard let item = incoming[id], item.received == item.size else { throw ClientError.message("附件尚未添加完成。") }
        try item.handle.close()
        let result = try await Task.detached(priority: .userInitiated) {
            try Self.prepare(id: id, draftKey: item.draftKey, name: item.name, url: item.url)
        }.value
        guard incoming[id] != nil else { throw CancellationError() }
        let total = files.values.reduce(0) { $0 + $1.size } + incoming.filter { $0.key != id }.values.reduce(0) { $0 + $1.size }
        guard total + result.size <= Self.totalLimit else { throw ClientError.message("附件转换后暂存总量超过 100 MB。") }
        incoming.removeValue(forKey: id); files[id] = result
        return result
    }
    func resolve(_ ids: [String], draftKey: String) throws -> [ChatAttachment] {
        guard ids.count <= Self.countLimit, Set(ids).count == ids.count else { throw ClientError.message("附件数量或标识无效。") }
        return try ids.map { id in
            guard let item = files[id], item.draftKey == draftKey, FileManager.default.fileExists(atPath: item.localURL.path) else { throw ClientError.message("附件已失效，请重新添加。") }
            return item
        }
    }
    func localURL(_ id: String) -> URL? { files[id]?.localURL ?? sent[id]?.localURL }
    func restore(id: String, draftKey: String, name: String, url: URL, sha256: String) async throws -> ChatAttachment {
        if let existing = files[id], existing.draftKey == draftKey { return existing }
        let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? -1
        try begin(id: id, draftKey: draftKey, name: name, size: size)
        guard let entry = incoming[id] else { throw CancellationError() }
        do {
            let data = try Data(contentsOf: url)
            guard SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == sha256 else { throw ClientError.message("保存的附件校验失败，请重新添加。") }
            if url.lastPathComponent == name {
                try entry.handle.write(contentsOf: data)
                incoming[id]?.received = data.count
            } else {
                // Keep the normalized PNG extension when the display name was HEIC/TIFF.
                try entry.handle.close()
                let restoredURL = entry.url.deletingLastPathComponent().appendingPathComponent(url.lastPathComponent)
                try data.write(to: restoredURL, options: .atomic)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: restoredURL.path)
                incoming[id] = Incoming(draftKey: draftKey, name: name, size: size, url: restoredURL, handle: try FileHandle(forWritingTo: restoredURL), received: data.count)
            }
            return try await finish(id: id)
        } catch { remove(id); throw error }
    }
    func accepted(_ ids: [String]) { for id in ids { if let file = files.removeValue(forKey: id) { sent[id] = file } } }
    func moveDraft(_ ids: [String], from: String, to: String) {
        for id in ids { if let file = files[id], file.draftKey == from { files[id] = ChatAttachment(id: file.id, draftKey: to, name: file.name, localURL: file.localURL, size: file.size, isImage: file.isImage, thumbnail: file.thumbnail, sha256: file.sha256) } }
    }
    func remove(_ id: String) {
        if let item = incoming.removeValue(forKey: id) { try? item.handle.close() }
        files.removeValue(forKey: id)
        guard UUID(uuidString: id) != nil else { return }
        try? FileManager.default.removeItem(at: root.appendingPathComponent(id, isDirectory: true))
    }
    func close() { incoming.values.forEach { try? $0.handle.close() }; incoming.removeAll(); files.removeAll(); sent.removeAll(); if FileManager.default.fileExists(atPath: root.path) { try? FileManager.default.removeItem(at: root) } }

    private nonisolated static func prepare(id: String, draftKey: String, name: String, url: URL) throws -> ChatAttachment {
        var localURL = url, thumbnail: String?, image = false
        if let type = UTType(filenameExtension: url.pathExtension), type.conforms(to: .image), type != .svg {
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? Int, let height = properties[kCGImagePropertyPixelHeight] as? Int,
                  width > 0, height > 0, Double(width) * Double(height) <= 40_000_000,
                  let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 240, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { throw ClientError.message("无法读取这张图片，或图片尺寸过大。") }
            let data = NSMutableData()
            if let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) { CGImageDestinationAddImage(destination, thumb, nil); if CGImageDestinationFinalize(destination) { thumbnail = "data:image/png;base64," + (data as Data).base64EncodedString() } }
            image = true
            // Normalize formats the model cannot directly consume, including HEIC/TIFF.
            let format = CGImageSourceGetType(source) as String? ?? ""
            if ![UTType.png.identifier, UTType.jpeg.identifier, "org.webmproject.webp"].contains(format) {
                localURL = url.deletingLastPathComponent().appendingPathComponent("converted-" + UUID().uuidString + ".png")
                guard let bitmap = CGImageSourceCreateImageAtIndex(source, 0, nil), let output = CGImageDestinationCreateWithURL(localURL as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw ClientError.message("图片格式转换失败。") }
                CGImageDestinationAddImage(output, bitmap, nil)
                guard CGImageDestinationFinalize(output) else { throw ClientError.message("图片格式转换失败。") }
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: localURL.path)
            }
        }
        let data = try Data(contentsOf: localURL, options: .mappedIfSafe)
        guard data.count <= fileLimit else { throw ClientError.message("图片转换后超过 25 MB，请使用较小的图片。") }
        return ChatAttachment(id: id, draftKey: draftKey, name: name, localURL: localURL, size: data.count, isImage: image, thumbnail: thumbnail, sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
    }
}

@MainActor final class SSHAttachmentTransport {
    private var processes: [UUID: Process] = [:]
    private var cancelled = Set<UUID>()
    private let root = FileManager.default.temporaryDirectory.appendingPathComponent("RemoteCodexTransfers-" + UUID().uuidString)

    func upload(_ file: ChatAttachment, settings: ConnectionSettings) async throws -> String {
        try settings.validate()
        let command = "python3 -c " + ConnectionSettings.quote(Self.uploadScript) + " " + [file.id, file.localURL.lastPathComponent, String(file.size), file.sha256].map(ConnectionSettings.quote).joined(separator: " ")
        let data = try await run(command, settings: settings, input: file.localURL)
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], let path = result["path"] as? String,
              result["sha256"] as? String == file.sha256, result["size"] as? Int == file.size else { throw ClientError.message("附件上传校验失败，请重试发送。") }
        return path
    }
    func download(_ path: String, settings: ConnectionSettings, projectRoot: String? = nil, recordedImage: Bool = false) async throws -> URL {
        try settings.validate()
        let projectFile = projectRoot.map { root in let base = "/" + root.split(separator: "/").joined(separator: "/"); return path.hasPrefix(base == "/" ? "/" : base + "/") } ?? false
        guard path.hasPrefix("/"), (path.contains("/.local/share/remote-codex/attachments/") || projectFile || recordedImage), !path.contains("\0"), path.utf8.count < 4096 else { throw ClientError.message("此文件不在当前项目或附件目录内。") }
        let data = try await run("python3 -c " + ConnectionSettings.quote(Self.downloadScript) + " " + ConnectionSettings.quote(path) + " " + ConnectionSettings.quote(projectRoot ?? "") + " " + ConnectionSettings.quote(recordedImage ? "recorded-image" : ""), settings: settings)
        let directory = root.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let url = directory.appendingPathComponent(URL(fileURLWithPath: path).lastPathComponent)
        try data.write(to: url, options: .atomic)
        return url
    }
    private func run(_ command: String, settings: ConnectionSettings, input: URL? = nil) async throws -> Data {
        let id = UUID(), process = Process(), directory = root.appendingPathComponent(id.uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let outputURL = directory.appendingPathComponent("output"), errorURL = directory.appendingPathComponent("errors")
        FileManager.default.createFile(atPath: outputURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        FileManager.default.createFile(atPath: errorURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let output = try FileHandle(forWritingTo: outputURL), errors = try FileHandle(forWritingTo: errorURL)
        let source = try FileHandle(forReadingFrom: input ?? URL(fileURLWithPath: "/dev/null"))
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = Array(settings.sshArguments.dropLast()) + [command]
        process.standardInput = source; process.standardOutput = output; process.standardError = errors
        processes[id] = process
        defer { processes.removeValue(forKey: id); cancelled.remove(id); try? source.close(); try? output.close(); try? errors.close(); try? FileManager.default.removeItem(at: directory) }
        return try await withCheckedThrowingContinuation { continuation in
            let timeout = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 120_000_000_000)
                guard !Task.isCancelled, process.isRunning else { return }; self?.cancelled.insert(id); process.terminate()
            }
            process.terminationHandler = { [weak self] ended in
                Task { @MainActor in
                    timeout.cancel()
                    do {
                        if self?.cancelled.contains(id) == true { throw ClientError.message("附件传输已取消或超时，草稿已保留。") }
                        guard ended.terminationStatus == 0 else {
                            let data = try Data(contentsOf: errorURL)
                            let detail = String(data: data.prefix(1200), encoding: .utf8) ?? ""
                            throw ClientError.message("附件传输失败，草稿已保留。" + (detail.isEmpty ? "" : "\n" + detail))
                        }
                        let data = try Data(contentsOf: outputURL)
                        guard data.count <= AttachmentStore.fileLimit + 8192 else { throw ClientError.message("远端附件超出大小限制。") }
                        continuation.resume(returning: data)
                    } catch { continuation.resume(throwing: error) }
                }
            }
            do { try process.run() }
            catch { timeout.cancel(); process.terminationHandler = nil; continuation.resume(throwing: error) }
        }
    }
    func cancelAll() { for (id, process) in processes { cancelled.insert(id); if process.isRunning { process.terminate() } } }

    private static let uploadScript = #"""
import hashlib,json,os,pathlib,sys,uuid
ident,name,size,digest=sys.argv[1:]
uuid.UUID(ident);size=int(size)
assert pathlib.Path(name).name==name and name not in ('.','..') and 0<=size<=25*1024*1024
root=pathlib.Path.home()/'.local/share/remote-codex/attachments'
directory=root/ident;directory.mkdir(parents=True,exist_ok=True,mode=0o700)
os.chmod(root,0o700);os.chmod(directory,0o700)
target=directory/name;temp=directory/('.upload-'+str(uuid.uuid4()))
h=hashlib.sha256();count=0
try:
 with open(temp,'xb') as f:
  os.chmod(temp,0o600)
  while chunk:=sys.stdin.buffer.read(65536):
   count+=len(chunk)
   if count>size:raise ValueError('size mismatch')
   f.write(chunk);h.update(chunk)
 if count!=size or h.hexdigest()!=digest:raise ValueError('checksum mismatch')
 os.replace(temp,target)
 print(json.dumps({'path':str(target),'size':count,'sha256':h.hexdigest()}))
finally:
 temp.unlink(missing_ok=True)
"""#
    private static let downloadScript = #"""
import pathlib,sys,os,stat
root=(pathlib.Path.home()/'.local/share/remote-codex/attachments').resolve()
target=pathlib.Path(sys.argv[1]).resolve()
roots=[root]
if len(sys.argv)>2 and sys.argv[2]:roots.append(pathlib.Path(sys.argv[2]).resolve())
image=len(sys.argv)>3 and sys.argv[3]=='recorded-image'
if not image and not any(target.is_relative_to(base) for base in roots):raise ValueError('outside attachment or project directory')
if not target.is_file() or target.stat().st_size>25*1024*1024:raise ValueError('invalid attachment')
with open(target,'rb') as f:
 info=os.fstat(f.fileno())
 if not stat.S_ISREG(info.st_mode) or info.st_size>25*1024*1024:raise ValueError('invalid attachment')
 if image:
  head=f.read(32);f.seek(0)
  valid=head.startswith((b'\x89PNG\r\n\x1a\n',b'\xff\xd8\xff',b'GIF87a',b'GIF89a',b'II*\0',b'MM\0*',b'BM')) or (head[:4]==b'RIFF' and head[8:12]==b'WEBP') or (head[4:8]==b'ftyp' and head[8:12] in (b'heic',b'heix',b'hevc',b'hevx',b'mif1',b'msf1',b'avif',b'avis'))
  if not valid:raise ValueError('not a supported image')
 count=0
 while chunk:=f.read(65536):
  count+=len(chunk)
  if count>25*1024*1024:raise ValueError('attachment grew beyond limit')
  sys.stdout.buffer.write(chunk)
"""#
}
