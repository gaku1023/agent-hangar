//! `~/.agent-hangar/desktop.log` を開く。
//! 起動画面の「ログを開く」と、UI の切断の帯の「ログを開く」が使う。
//! 開く先は決まった 1 つのファイルだけで、呼び手からパスは受け取らない。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// 殻とサーバがともに書くログ。
pub fn log_path(hangar_home: &Path) -> PathBuf {
    hangar_home.join("desktop.log")
}

/// ログが無ければ空で作る。あれば中身に触らない。
/// 無いファイルを `open` に渡すと、何も開かずに失敗するからである。
pub fn ensure_log(file: &Path) -> std::io::Result<()> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .map(|_| ())
}

/// ログを開くコマンド。macOS の `open` に任せ、.log に結び付いたアプリ（ふつうは Console.app）で開く。
pub fn open_command(file: &Path) -> (&'static str, Vec<OsString>) {
    ("/usr/bin/open", vec![file.as_os_str().to_owned()])
}

/// ログを開く。用意してから `open` を走らせ、終わりの状態で成否を返す。
pub fn open_log(hangar_home: &Path) -> Result<(), String> {
    let file = log_path(hangar_home);
    ensure_log(&file).map_err(|e| format!("ログを用意できません: {e}"))?;
    let (program, args) = open_command(&file);
    let status = std::process::Command::new(program)
        .args(&args)
        .status()
        .map_err(|e| format!("ログを開けません: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("ログを開けません（{status}）"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_lives_in_the_data_dir() {
        assert_eq!(
            log_path(Path::new("/h/.agent-hangar")),
            PathBuf::from("/h/.agent-hangar/desktop.log")
        );
    }

    #[test]
    fn a_missing_log_is_created_empty_and_an_existing_one_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let file = log_path(dir.path());
        ensure_log(&file).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "");
        std::fs::write(&file, "1 [desktop] setup\n").unwrap();
        ensure_log(&file).unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "1 [desktop] setup\n"
        );
    }

    #[test]
    fn the_log_is_opened_with_open_and_nothing_else() {
        let (program, args) = open_command(Path::new("/h/.agent-hangar/desktop.log"));
        assert_eq!(program, "/usr/bin/open");
        assert_eq!(args, vec![OsString::from("/h/.agent-hangar/desktop.log")]);
    }
}
