//! agent-hangar のデスクトップシェル。
//! サーバを子プロセスとして起動し、ウィンドウに UI を表示する。
//! 各モジュールは後のタスクでこのファイルの末尾に足し、この骨格は Task 6 で置き換える。

use tauri_plugin_deep_link::DeepLinkExt;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            app.deep_link().on_open_url(|event| {
                eprintln!("deep link: {:?}", event.urls());
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
pub mod deeplink;
pub mod health;
pub mod node;
pub mod paths;
