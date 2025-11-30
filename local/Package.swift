// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tasks-sync",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(
            name: "tasks-sync",
            path: "Sources"
        )
    ]
)
