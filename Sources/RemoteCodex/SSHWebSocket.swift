import Foundation
import CryptoKit

/// RFC 6455 over the byte stream supplied by the official `app-server proxy`.
/// This stays on the Mac; the remote host runs only the official app-server.
struct SSHWebSocket {
    static let limit = 32_000_000
    private let key: String
    private var buffer: [UInt8] = []
    private var fragments: [UInt8] = []
    private var fragmented = false
    private(set) var ready = false

    init(key: String = Data((0..<16).map { _ in UInt8.random(in: 0...255) }).base64EncodedString()) { self.key = key }
    var handshake: Data {
        Data(("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: \(key)\r\n\r\n").utf8)
    }
    static func frame(_ data: Data, opcode: UInt8 = 1, mask: [UInt8]? = nil) -> Data {
        let mask = mask ?? (0..<4).map { _ in UInt8.random(in: 0...255) }
        precondition(mask.count == 4)
        var bytes: [UInt8] = [0x80 | opcode]
        if data.count < 126 { bytes.append(0x80 | UInt8(data.count)) }
        else if data.count <= 65535 { bytes += [0xfe, UInt8(data.count >> 8), UInt8(data.count & 255)] }
        else { bytes.append(0xff); bytes += (0..<8).reversed().map { UInt8((UInt64(data.count) >> ($0 * 8)) & 255) } }
        bytes += mask
        bytes += data.enumerated().map { $0.element ^ mask[$0.offset % 4] }
        return Data(bytes)
    }
    struct Received {
        var messages: [Data] = []
        var replies: [Data] = []
        var opened = false
        var closed = false
    }
    mutating func receive(_ data: Data) throws -> Received {
        var result = Received()
        buffer += data
        if !ready {
            guard let end = buffer.indices.first(where: { $0 + 3 < buffer.count && Array(buffer[$0...($0 + 3)]) == [13,10,13,10] }) else {
                guard buffer.count <= 16_384 else { throw ClientError.message("远端 WebSocket 握手过大。") }
                return result
            }
            guard end <= 16_384, let text = String(bytes: buffer[..<end], encoding: .utf8) else { throw ClientError.message("远端 WebSocket 握手无效。") }
            let lines = text.components(separatedBy: "\r\n")
            let headers = lines.dropFirst().reduce(into: [String: String]()) { values, line in
                if let colon = line.firstIndex(of: ":") { values[String(line[..<colon]).lowercased()] = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces) }
            }
            let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
            guard lines.first?.hasPrefix("HTTP/1.1 101 ") == true,
                  headers["sec-websocket-accept"] == accept,
                  headers["upgrade"]?.lowercased() == "websocket",
                  headers["connection"]?.lowercased().split(separator: ",").contains(where: { $0.trimmingCharacters(in: .whitespaces) == "upgrade" }) == true else { throw ClientError.message("官方 app-server WebSocket 握手失败。") }
            buffer.removeFirst(end + 4); ready = true; result.opened = true
        }
        var offset = 0
        while buffer.count - offset >= 2 {
            let first = buffer[offset], second = buffer[offset+1], opcode = first & 15
            guard first & 0x70 == 0, second & 0x80 == 0 else { throw ClientError.message("远端 WebSocket 帧标记无效。") }
            var length = UInt64(second & 127), header = 2
            if length == 126 {
                guard buffer.count - offset >= 4 else { break }
                length = UInt64(buffer[offset+2]) << 8 | UInt64(buffer[offset+3]); header = 4
                guard length >= 126 else { throw ClientError.message("远端 WebSocket 长度编码无效。") }
            } else if length == 127 {
                guard buffer.count - offset >= 10 else { break }
                length = buffer[(offset+2)..<(offset+10)].reduce(0) { ($0 << 8) | UInt64($1) }; header = 10
                guard length >= 65536 else { throw ClientError.message("远端 WebSocket 长度编码无效。") }
            }
            guard length <= UInt64(Self.limit) else { throw ClientError.message("远端返回过大的协议消息。") }
            let final = first & 0x80 != 0, control = opcode >= 8
            guard !control || (final && length <= 125) else { throw ClientError.message("远端 WebSocket 控制帧无效。") }
            guard buffer.count - offset - header >= Int(length) else { break }
            let payload = Data(buffer[(offset+header)..<(offset+header+Int(length))])
            offset += header + Int(length)
            switch opcode {
            case 8:
                guard length != 1 else { throw ClientError.message("远端 WebSocket 关闭帧无效。") }
                result.closed = true
                result.replies.append(Self.frame(payload, opcode: 8))
            case 9: result.replies.append(Self.frame(payload, opcode: 10))
            case 10: break
            case 1:
                guard !fragmented else { throw ClientError.message("远端 WebSocket 分片顺序无效。") }
                if final { result.messages.append(payload) }
                else { fragments = Array(payload); fragmented = true }
            case 0:
                guard fragmented, fragments.count + payload.count <= Self.limit else { throw ClientError.message("远端 WebSocket 分片无效或过大。") }
                fragments += payload
                if final { result.messages.append(Data(fragments)); fragments.removeAll(); fragmented = false }
            default: throw ClientError.message("远端 WebSocket 消息类型不支持。")
            }
            if result.closed { break }
        }
        if offset > 0 { buffer.removeFirst(offset) }
        guard buffer.count <= Self.limit + 10 else { throw ClientError.message("远端返回过大的协议消息。") }
        return result
    }
}
