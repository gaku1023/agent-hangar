// リリースビルドで Windows のコンソールを出さないための属性。
// macOS では無害。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    hangar_desktop_lib::run()
}
