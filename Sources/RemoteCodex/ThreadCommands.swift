import Foundation

enum ThreadCommands {
    static func objective(_ value: String) throws -> String {
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.unicodeScalars.count <= 4000 else { throw ClientError.message("目标需填写 1–4000 个字符。") }
        return text
    }
    static func goalParameters(_ body: [String: Any], threadID: String) throws -> [String: Any] {
        var params: [String: Any] = ["threadId": threadID, "origin": "user"]
        switch body["operation"] as? String {
        case "setGoal":
            params["objective"] = try objective(body["objective"] as? String ?? "")
            if let status = body["status"] as? String {
                guard ["active", "paused"].contains(status) else { throw ClientError.message("目标状态无效。") }
                params["status"] = status
            }
            if let budget = body["tokenBudget"] {
                if budget is NSNull { params["tokenBudget"] = NSNull() }
                else if let count = budget as? Int, count > 0, count <= 9_007_199_254_740_991 { params["tokenBudget"] = count }
                else { throw ClientError.message("Token 预算应为正整数，留空则不设预算。") }
            }
        case "pauseGoal": params["status"] = "paused"
        case "resumeGoal": params["status"] = "active"
        case "clearGoal": break
        default: throw ClientError.message("不支持此目标命令。")
        }
        return params
    }
    static func collaborationMode(_ mode: String, model: String, presets: [[String: Any]], effort: String? = nil) throws -> [String: Any] {
        guard ["plan", "default"].contains(mode), !model.isEmpty else { throw ClientError.message("计划模式或远端模型尚未准备好，请稍后重试。") }
        let preset = presets.first { $0["mode"] as? String == mode }
        return ["mode": mode, "settings": ["model": model, "reasoning_effort": effort as Any? ?? preset?["reasoning_effort"] ?? NSNull(), "developer_instructions": NSNull()]]
    }
}
