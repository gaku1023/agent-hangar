// 頁から呼べる殻の命令の一覧。ここに載せた命令にだけ allow-<名前> の権限が作られ、
// capabilities/ で与えた頁からしか呼べなくなる。
// UI の出どころは remote-shell.json と remote-notify.json と remote-pick-folder.json と remote-config-apply.json と remote-setup.json と remote-update.json と remote-cloud.json と remote-link.json、起動画面は boot-screen.json、承諾の窓は approve.json である。
// pick_node（Node の札の「node を選ぶ…」）は起動画面だけに与える。
// boot_probe は試験のための書き出しで、殻が HANGAR_BOOT_PROBE を持って起きたときだけ書く（bootprobe.rs）。
// 名前は lib.rs の #[tauri::command] とそろえる（apps/desktop/test/config.test.ts が突き合わせる）。
const COMMANDS: &[&str] = &[
    "apply_config_sync",
    "approve_answer",
    "approve_view",
    "boot_card_shown",
    "boot_probe",
    "boot_state",
    "cloud_join",
    "cloud_join_plan",
    "cloud_leave",
    "cloud_revoke",
    "notify_feed",
    "notify_prune",
    "notify_request",
    "notify_status",
    "notify_waiting",
    "open_link",
    "open_log",
    "pick_folder",
    "pick_node",
    "restart_app",
    "restore_config_sync",
    "retry_boot",
    "setup_integration",
    "update_check",
    "update_download",
    "update_install",
    "update_status",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
