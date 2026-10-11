//! `~/.agent-hangar/desktop.log` に書き足し、開く。
//! 殻の行は `append_line` で 1 行ずつ書く。
//! 起動画面の「ログを開く」と、UI の切断の帯の「ログを開く」が使う。
//! 開く先は決まった 1 つのファイルだけで、呼び手からパスは受け取らない。

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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

/// 殻の中で書き足しを 1 つずつにする錠。
static APPEND: Mutex<()> = Mutex::new(());

/// ログに 1 行を書き足す。
/// 本文と改行を 1 つの塊にしてから、追記（O_APPEND、Windows は FILE_APPEND_DATA）で開いたファイルへ 1 回の write で書く。
/// `writeln!` は書式の部品ごとに write を出すので、殻の糸が同時に書くと行が別の行の途中に割り込んでいた。
/// 殻の中の糸どうしは錠でも並べる。
/// 1 回の write が途中までしか書けず `write_all` が残りを書き足すとき、その間に別の行を割り込ませないためである。
/// サーバ（子）は自分の標準出力を同じファイルへ追記で書くので、行の途中に割り込むのは 1 回の write が分かれたときだけである。
pub fn append_line(file: &Path, line: &str) -> std::io::Result<()> {
    let mut buf = String::with_capacity(line.len() + 1);
    buf.push_str(line);
    buf.push('\n');
    let _held = APPEND.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)?
        .write_all(buf.as_bytes())
}

/// ログを開くコマンド。.log に結び付いたアプリで開く。
pub fn open_command(file: &Path) -> (&'static str, Vec<OsString>) {
    open_command_on(cfg!(windows), file)
}

/// 同上。OS を引数で決める形（試験がどちらの形も見るため）。
/// macOS は `open` に任せる（ふつうは Console.app）。
/// Windows は rundll32 の FileProtocolHandler に任せる（ふつうはメモ帳）。
/// サーバが URL を開く形（`packages/server/src/platform/browser.ts`）と同じで、cmd.exe の start を通さない。
pub fn open_command_on(windows: bool, file: &Path) -> (&'static str, Vec<OsString>) {
    if windows {
        return (
            "rundll32.exe",
            vec![
                OsString::from("url.dll,FileProtocolHandler"),
                file.as_os_str().to_owned(),
            ],
        );
    }
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

    // 殻の糸がいくつも同時に 1 行ずつ書いても、行が別の行の途中に割り込まない。
    // 以前は本文と改行を別々の write で書いていて、取得の終わりの行と確認の行がつながった（2026-10-11、CI の通し稽古）。
    #[test]
    fn lines_written_from_many_threads_never_interleave() {
        let dir = tempfile::tempdir().unwrap();
        let file = log_path(dir.path());
        let threads: Vec<_> = (0..8)
            .map(|t| {
                let file = file.clone();
                std::thread::spawn(move || {
                    for i in 0..400 {
                        append_line(&file, &format!("t{t} n{i} {}", "x".repeat(64 + t * 7)))
                            .unwrap();
                    }
                })
            })
            .collect();
        for h in threads {
            h.join().unwrap();
        }
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.ends_with('\n'));
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 8 * 400);
        for line in lines {
            let mut parts = line.split(' ');
            let t: usize = parts.next().unwrap()[1..].parse().unwrap();
            assert!(parts.next().unwrap().starts_with('n'), "{line}");
            assert_eq!(parts.next().unwrap(), "x".repeat(64 + t * 7), "{line}");
            assert_eq!(parts.next(), None, "{line}");
        }
    }

    // 書き足すだけで、前の中身は残す。
    #[test]
    fn a_line_is_appended_after_what_is_already_there() {
        let dir = tempfile::tempdir().unwrap();
        let file = log_path(dir.path());
        std::fs::write(&file, "1 [desktop] setup\n").unwrap();
        append_line(&file, "2 [desktop] server pid 7").unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "1 [desktop] setup\n2 [desktop] server pid 7\n"
        );
    }

    #[test]
    fn the_log_is_opened_with_open_and_nothing_else() {
        let (program, args) = open_command_on(false, Path::new("/h/.agent-hangar/desktop.log"));
        assert_eq!(program, "/usr/bin/open");
        assert_eq!(args, vec![OsString::from("/h/.agent-hangar/desktop.log")]);
    }

    // Windows は既定のアプリ（.log はメモ帳）で開く。サーバの URL を開く口（platform/browser.ts）と同じ rundll32 の形にする。
    // cmd.exe の start を通さないので、パスの & などで文が切れない。
    #[test]
    fn on_windows_the_log_is_opened_with_the_default_app() {
        let file = Path::new("C:\\Users\\me\\.agent-hangar\\desktop.log");
        let (program, args) = open_command_on(true, file);
        assert_eq!(program, "rundll32.exe");
        assert_eq!(
            args,
            vec![
                OsString::from("url.dll,FileProtocolHandler"),
                file.as_os_str().to_owned()
            ]
        );
        assert_eq!(open_command(file).0, open_command_on(cfg!(windows), file).0);
    }
}
