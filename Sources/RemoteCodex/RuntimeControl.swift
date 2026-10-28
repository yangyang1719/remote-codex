import AppKit

@MainActor final class RuntimeControl {
    func request(_ operation: String, settings: ConnectionSettings) async throws -> [String: Any] {
        guard ["status", "start", "stop"].contains(operation) else { throw ClientError.message("未知远端服务操作。") }
        try settings.validate()
        let process = Process(), output = Pipe(), errors = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = Array(settings.sshArguments.dropLast()) + [OfficialRuntimeBootstrap.command(operation, settings: settings)]
        process.standardInput = FileHandle.nullDevice; process.standardOutput = output; process.standardError = errors
        let data: Data = try await withCheckedThrowingContinuation { continuation in
            let timeout = Task { @MainActor in try? await Task.sleep(nanoseconds: 100_000_000_000); if !Task.isCancelled, process.isRunning { process.terminate() } }
            process.terminationHandler = { ended in
                let data = output.fileHandleForReading.readDataToEndOfFile(), detail = errors.fileHandleForReading.readDataToEndOfFile()
                Task { @MainActor in
                    timeout.cancel(); process.terminationHandler = nil
                    if ended.terminationStatus == 0 { continuation.resume(returning: data) }
                    else { continuation.resume(throwing: ClientError.message("远端服务操作失败：" + (String(data: detail.prefix(1500), encoding: .utf8) ?? "请检查 SSH。"))) }
                }
            }
            do { try process.run() } catch { timeout.cancel(); process.terminationHandler = nil; continuation.resume(throwing: error) }
        }
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ClientError.message("远端服务返回无效状态。") }
        return value
    }
}
