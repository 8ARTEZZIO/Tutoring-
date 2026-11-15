// swift-tools-version:5.9
// Platform-independent logic for the Kingston Tutoring iPhone app. Builds and tests on macOS and Linux:
//   swift test
import PackageDescription

let package = Package(
    name: "KingstonTutoringCore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [
        .library(name: "KingstonTutoringCore", targets: ["KingstonTutoringCore"]),
    ],
    targets: [
        .target(name: "KingstonTutoringCore"),
        .testTarget(name: "KingstonTutoringCoreTests", dependencies: ["KingstonTutoringCore"]),
    ]
)
