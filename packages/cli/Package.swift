// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "sync-tasks",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(
            name: "sync-tasks",
            path: "Sources/TasksSync"
        )
    ]
)
