import Foundation

enum OfficialRuntimeBootstrap {
    static var encodedSource: String? {
        try? Data(contentsOf: AppResources.directory.appendingPathComponent("official_runtime.py")).base64EncodedString()
    }

    static func command(_ operation: String, settings: ConnectionSettings) -> String {
        guard ["proxy", "status", "start", "stop"].contains(operation), let source = encodedSource else { return "exec false" }
        let runner = "import base64;exec(compile(base64.b64decode(\"" + source + "\"),\"<remote-codex-runtime>\",\"exec\"))"
        var command = "exec python3 -c " + ConnectionSettings.quote(runner) + " " + operation + " --executable " + ConnectionSettings.quote(settings.executable)
        if operation == "proxy" { command += " --project " + ConnectionSettings.quote(settings.project) }
        if let socket = settings.officialSocket { command += " --socket " + ConnectionSettings.quote(socket) }
        return command
    }
}
