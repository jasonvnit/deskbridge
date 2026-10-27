// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "DeskBridgeHelper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "deskbridge-helper",
            path: "Sources/DeskBridgeHelper",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("CoreImage"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
            ]
        ),
    ]
)
