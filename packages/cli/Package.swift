// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "sync-tasks",
    platforms: [.macOS(.v12)],
    dependencies: [
        .package(url: "https://github.com/apple/swift-log.git", from: "1.5.0"),
        .package(url: "https://github.com/onevcat/Rainbow.git", from: "4.0.0")
    ],
    targets: [
        .executableTarget(
            name: "sync-tasks",
            dependencies: [
                .product(name: "Logging", package: "swift-log"),
                .product(name: "Rainbow", package: "Rainbow")
            ],
            path: "Sources/TasksSync"
        )
    ]
)
