import Foundation

enum ShellCommand {
    static func parse(_ text: String, attachmentIDs: [String]) throws -> String {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.hasPrefix("!"), !value.contains("\0"), value.utf8.count < 200_000, attachmentIDs.isEmpty else { throw ClientError.message("执行命令需以 ! 开头，且不能附带图片或文件。") }
        let command = String(value.dropFirst()).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !command.isEmpty else { throw ClientError.message("请在 ! 后输入远端命令，例如 ! ls。") }
        return command
    }
}
