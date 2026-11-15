// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "voice-mac",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/Neywa-Labs/mlx-audio-swift.git", exact: "0.1.9"),
    ],
    targets: [
        // MLX に依らない芯。約束の読み書きと、声の区切り。
        .target(name: "VoiceCore"),
        .executableTarget(
            name: "hangar-voice",
            dependencies: [
                "VoiceCore",
                .product(name: "MLXAudioSTT", package: "mlx-audio-swift"),
                .product(name: "MLXAudioTTS", package: "mlx-audio-swift"),
                .product(name: "MLXAudioVAD", package: "mlx-audio-swift"),
                .product(name: "MLXAudioCore", package: "mlx-audio-swift"),
            ]
        ),
        .testTarget(name: "VoiceCoreTests", dependencies: ["VoiceCore"]),
    ]
)
