// リリースビルドで Windows のコンソールを出さないための属性。
// macOS では無害。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Windows では、サーバが外のアプリを Hangar のジョブの外で起こすために、この実行ファイルを起こし役として呼ぶ（breakaway.rs）。
    // その印があれば、Tauri を立ち上げずに子を起こし、子の終了コードで降りる。
    #[cfg(windows)]
    if let Some(code) =
        hangar_desktop_lib::breakaway::run_if_requested(&std::env::args_os().collect::<Vec<_>>())
    {
        std::process::exit(code);
    }
    hangar_desktop_lib::run()
}
