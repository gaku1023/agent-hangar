fn main() {
    // 頁から呼ぶ殻のコマンド。
    // ここに並べると、コマンドごとの権限（allow-notify-waiting など）が作られる。
    // 並べたコマンドは、capabilities で許したものしか頁から呼べない。
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["notify_waiting", "notify_request"]),
    ))
    .expect("failed to run tauri-build");
}
