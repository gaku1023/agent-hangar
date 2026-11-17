// swift-tools-version: 5.10
import PackageDescription

// MLX に依らない芯（約束の読み書き、声の区切り、読みの変換）。
// hangar-voice のパッケージから分けておくと、芯の試験が MLX を作らずに回る。
// 同じパッケージに置くと、swift test は --filter を付けても MLX と hangar-voice まで作り、CI で 7 分を食っていた（2026-11-17）。
let package = Package(
    name: "VoiceCore",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "VoiceCore", targets: ["VoiceCore"]),
    ],
    targets: [
        .target(name: "VoiceCore"),
        .testTarget(name: "VoiceCoreTests", dependencies: ["VoiceCore"]),
    ]
)
