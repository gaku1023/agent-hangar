// 頁から呼べる殻の命令の一覧。ここに載せた命令にだけ allow-<名前> の権限が作られ、
// capabilities/ で与えた頁からしか呼べなくなる。
// UI の出どころは remote-shell.json と remote-notify.json と remote-pick-folder.json、起動画面は boot-screen.json である。
// 名前は lib.rs の #[tauri::command] とそろえる（apps/desktop/test/config.test.ts が突き合わせる）。
const COMMANDS: &[&str] = &[
    "notify_request",
    "notify_status",
    "notify_waiting",
    "open_log",
    "pick_folder",
    "restart_app",
    "retry_boot",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
