// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "DownloadsTriage",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "DownloadsTriage", targets: ["DownloadsTriage"])
    ],
    targets: [
        .executableTarget(name: "DownloadsTriage", path: "Sources/DownloadsTriage")
    ]
)
