import Foundation

enum RunPresentation {
    static func error(_ value: [String: Any]) -> [String: Any] {
        var result: [String: Any] = ["message": String((value["message"] as? String ?? "远端运行失败。").prefix(16000))]
        if let details = value["additionalDetails"] as? String { result["additionalDetails"] = String(details.prefix(16000)) }
        if let code = value["codexErrorInfo"] as? String { result["codexErrorInfo"] = code }
        else if let code = value["codexErrorInfo"] as? [String: Any] {
            result["codexErrorInfo"] = code.mapValues { value -> Any in
                guard let fields = value as? [String: Any] else { return NSNull() }
                return fields.filter { $0.key == "httpStatusCode" }
            }
        }
        return result
    }
    static func turn(_ value: [String: Any]) -> [String: Any] {
        var result = value.filter { ["id", "status", "startedAt", "completedAt", "durationMs"].contains($0.key) }
        if let failure = value["error"] as? [String: Any] { result["error"] = error(failure) }
        return result
    }
    static func summary(_ value: [String: Any]) -> [String: Any] {
        // Only user-visible summaries; never forward raw reasoning content.
        ["id": value["id"] ?? "", "type": "reasoning", "summary": Array((value["summary"] as? [String] ?? []).prefix(64)).map { String($0.prefix(32000)) }, "status": value["status"] ?? "completed"]
    }
}
