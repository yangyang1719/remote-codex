// swift-tools-version: 5.9
import PackageDescription
import Foundation

var targets: [Target] = [
    .executableTarget(name: "RemoteCodex", resources: [.copy("Resources")])
]
// The public source checkout omits private desktop acceptance tests.
let testsPath = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("Tests/RemoteCodexTests").path
if FileManager.default.fileExists(atPath: testsPath) {
    targets.append(.testTarget(name: "RemoteCodexTests", dependencies: ["RemoteCodex"]))
}

let package = Package(
    name: "RemoteCodex",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "RemoteCodex", targets: ["RemoteCodex"])],
    targets: targets
)
