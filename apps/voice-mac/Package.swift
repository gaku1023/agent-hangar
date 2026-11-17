// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    // xcodebuild の scheme の名前になる（scripts/build.sh が -scheme hangar-voice で使う）。
    // 製品が 1 つのとき、scheme は製品ではなくパッケージの名前で作られるので、製品と同じ名前にしておく。
    name: "hangar-voice",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "hangar-voice", targets: ["hangar-voice"]),
    ],
    dependencies: [
        .package(url: "https://github.com/Neywa-Labs/mlx-audio-swift.git", exact: "0.1.9"),
        // MLX に依らない芯は Core/ の別のパッケージにある。芯の試験もそちらで回す（Core/Package.swift）。
        .package(path: "Core"),
    ],
    targets: [
        .executableTarget(
            name: "hangar-voice",
            dependencies: [
                .product(name: "VoiceCore", package: "Core"),
                .product(name: "MLXAudioSTT", package: "mlx-audio-swift"),
                .product(name: "MLXAudioTTS", package: "mlx-audio-swift"),
                .product(name: "MLXAudioVAD", package: "mlx-audio-swift"),
                .product(name: "MLXAudioCore", package: "mlx-audio-swift"),
            ]
        ),
    ]
)
