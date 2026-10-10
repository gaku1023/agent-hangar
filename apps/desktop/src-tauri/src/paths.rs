//! ホームディレクトリとデータディレクトリ。
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// 利用者のホーム。`HOME` が無ければ `/`。
/// Windows は `USERPROFILE` を先に見る。スタートメニューから起こしたアプリに `HOME` は無く、あっても Git Bash の持ち物である。
/// サーバ側の `os.homedir()` も Windows では `USERPROFILE` を返す。
pub fn user_home() -> PathBuf {
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    user_home_from(home)
}

/// hangar のデータディレクトリ。サーバと同じく `HANGAR_HOME` を優先する。
pub fn hangar_home() -> PathBuf {
    hangar_home_from(std::env::var_os("HANGAR_HOME"), &user_home())
}

/// 環境変数の値を引数で受け取る形。
/// 試験がプロセス全体の環境変数を書き換えずに済むように分けてある。
pub fn user_home_from(home: Option<OsString>) -> PathBuf {
    home.map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// 同上。`HANGAR_HOME` が無ければ利用者のホームの下を使う。
pub fn hangar_home_from(hangar_home: Option<OsString>, user_home: &Path) -> PathBuf {
    hangar_home
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home.join(".agent-hangar"))
}

/// 子のプロセスや登録へ渡すパスから、Windows の verbatim の接頭辞（`\\?\`）を外す。
///
/// Tauri の `resource_dir()` は Windows で `\\?\C:\…` の形を返す（current_exe を canonicalize するため）。
/// Node 22.20 以降はこの形の主スクリプトを読めず、`lstat 'C:'` の EISDIR で落ちる。
/// 殻が子（Node、CLI）や登録へ渡すパスは、ここを通して普通の形にしてから渡す。
///
/// 外すのは、外しても同じものを指すときだけである（`strip_verbatim`）。
/// macOS と Linux には verbatim の形が無いので、何も変えない。
pub fn plain(path: &Path) -> PathBuf {
    #[cfg(windows)]
    if let Some(s) = path.to_str().and_then(strip_verbatim) {
        return PathBuf::from(s);
    }
    path.to_path_buf()
}

/// `\\?\C:\…` を `C:\…` に、`\\?\UNC\server\share\…` を `\\server\share\…` に直す。
/// 直すと意味が変わるときは None を返す（呼び手は元のまま使う）。
///
/// 規則は dunce の `simplified` と同じで、それに UNC の形を足してある。
/// verbatim の形では、Windows はパスを解釈せずにそのまま使う。
/// 接頭辞を外すと、次のものは別のものを指すか、開けなくなる。
///
/// - 全体が 260 字（UTF-16 の数）を超えるもの。接頭辞なしでは MAX_PATH に掛かる。
/// - `.`、`..`、空の段。普通の形では畳まれる。
/// - 末尾が点か空白の名前。普通の形では落とされる。
/// - `/`、`:`、`*` などの字を含む名前。普通の形では区切りや特別な意味になる。
/// - 予約名（CON、NUL、COM1 など、拡張子付きも）。普通の形では装置を指す。
pub fn strip_verbatim(path: &str) -> Option<String> {
    let rest = path.strip_prefix(r"\\?\")?;
    let (plain, names) = if let Some(unc) = rest.strip_prefix(r"UNC\") {
        // \\?\UNC\server\share\… は \\server\share\… になる。server と share はどちらも要る。
        let mut parts = unc.splitn(3, '\\');
        parts.next().filter(|s| !s.is_empty())?;
        parts.next().filter(|s| !s.is_empty())?;
        (format!(r"\\{unc}"), unc)
    } else {
        // \\?\C:\… は C:\… になる。ドライブの直後に区切りが要る（`C:foo` はその drive の今の場所からの相対になる）。
        let b = rest.as_bytes();
        if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || b[2] != b'\\' {
            return None;
        }
        (rest.to_string(), &rest[3..])
    };
    let parts: Vec<&str> = names.split('\\').collect();
    let last = parts.len() - 1;
    for (i, name) in parts.iter().enumerate() {
        // 末尾の区切り（`C:\foo\`）だけは空の段を許す。
        if name.is_empty() && i == last {
            continue;
        }
        if !valid_name(name) {
            return None;
        }
    }
    if path.encode_utf16().count() > 260 {
        return None;
    }
    Some(plain)
}

/// verbatim の接頭辞を外しても、そのまま 1 つの名前として読まれるか。
fn valid_name(name: &str) -> bool {
    if name.is_empty() || name.encode_utf16().count() > 255 {
        return false;
    }
    if name.bytes().any(|c| {
        matches!(
            c,
            0..=31 | b'<' | b'>' | b':' | b'"' | b'/' | b'\\' | b'|' | b'?' | b'*'
        )
    }) {
        return false;
    }
    if name.ends_with([' ', '.']) {
        return false;
    }
    !is_reserved(name)
}

/// Windows の予約名か。拡張子を除いた部分の末尾の点と空白を落として比べる（`con.txt`、`COM4 .txt` も予約名）。
fn is_reserved(name: &str) -> bool {
    const RESERVED: [&str; 22] = [
        "AUX", "NUL", "PRN", "CON", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = match name.rfind('.') {
        None | Some(0) => name,
        Some(i) => &name[..i],
    };
    let stem = stem.trim_end_matches([' ', '.']);
    stem.len() <= 4 && RESERVED.iter().any(|r| stem.eq_ignore_ascii_case(r))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn user_home_falls_back_to_root() {
        assert_eq!(
            user_home_from(Some(OsString::from("/Users/x"))),
            PathBuf::from("/Users/x")
        );
        assert_eq!(user_home_from(None), PathBuf::from("/"));
    }

    #[test]
    fn hangar_home_defaults_under_user_home() {
        let home = Path::new("/Users/x");
        assert_eq!(hangar_home_from(None, home), home.join(".agent-hangar"));
        assert_eq!(
            hangar_home_from(Some(OsString::from("/elsewhere/h")), home),
            PathBuf::from("/elsewhere/h")
        );
    }

    // macOS と Linux のパスはそのまま返す。verbatim の形は Windows にしか無い。
    #[test]
    fn plain_leaves_posix_paths_alone() {
        for p in [
            "/Applications/Hangar.app/Contents/Resources/server",
            "relative/dir",
            "",
        ] {
            assert_eq!(plain(Path::new(p)), PathBuf::from(p), "{p}");
        }
    }

    // 外し方の規則そのもの。文字列だけで決まるので、どの OS でも走らせる。
    // 規則は dunce の simplified と同じで、それに `\\?\UNC\` の形を足してある。
    #[test]
    fn strip_verbatim_makes_plain_paths_only_when_the_meaning_stays() {
        let stripped = [
            (
                r"\\?\C:\Users\me\AppData\Local\Hangar",
                r"C:\Users\me\AppData\Local\Hangar",
            ),
            (r"\\?\c:\x\server\server.mjs", r"c:\x\server\server.mjs"),
            (r"\\?\Z:\foo\bar\", r"Z:\foo\bar\"),
            (r"\\?\C:\", r"C:\"),
            (r"\\?\C:\ユーザー\ファイル", r"C:\ユーザー\ファイル"),
            (r"\\?\C:\a........a\       b", r"C:\a........a\       b"),
            (r"\\?\UNC\srv\share\Hangar", r"\\srv\share\Hangar"),
            // 予約名に見えても、予約名ではないもの。
            (
                r"\\?\C:\COM0\not.CON\.CON\CON。",
                r"C:\COM0\not.CON\.CON\CON。",
            ),
        ];
        for (from, to) in stripped {
            assert_eq!(strip_verbatim(from).as_deref(), Some(to), "{from}");
        }
        let kept = [
            // 接頭辞の無いもの、ドライブでも UNC でもないもの。
            r"C:\Users\me\.agent-hangar",
            r"\\srv\share\x",
            r"\\.\C:\notdisk",
            r"\\?\GLOBALROOT\Device\ImDisk0\path\file.txt",
            r"\\?\Volume{0000}\x",
            r"\\?\serv\",
            r"\\?\c\foo",
            r"\\?\cc:\foo",
            r"\\?\c:foo",
            r"\\?\c:foo\bar",
            r"\\?\UNC\srv",
            // Rust の std が UNC と読むのは大文字の UNC だけなので、ほかの綴りは触らない。
            r"\\?\unc\srv\share",
            r"\\?\C:",
            r"\\?\UNC\srv\",
            r"\\?\UNC\\share",
            // 予約名と、末尾の点や空白は、接頭辞を外すと別のものを指す。
            r"\\?\C:\x\nul",
            r"\\?\C:\x\con.txt",
            r"\\?\C:\x\COM4 .txt",
            r"\\?\C:\x\PrN.....",
            r"\\?\UNC\srv\share\aux",
            r"\\?\C:\x\dir.",
            r"\\?\C:\x\dir ",
            r"\\?\C:\foo\.\bar",
            r"\\?\C:\foo\..\bar",
            r"\\?\C:\foo\\bar",
            // verbatim では / も : も名前の一部である。
            r"\\?\C:\x/y",
            r"\\?\C:\x\a:b",
            r"\\?\C:\x\a*b",
        ];
        for from in kept {
            assert_eq!(strip_verbatim(from), None, "{from}");
        }
        assert_eq!(strip_verbatim("\\\\?\\C:\\x\\a\u{1f}b"), None);
        // 260 字（UTF-16 の数）を超えると、接頭辞なしでは開けないので残す。
        let ok = format!(r"\\?\c:\{}", "®".repeat(160));
        assert!(strip_verbatim(&ok).is_some());
        let long = format!(r"\\?\c:\{0}\{0}", "®".repeat(160));
        assert_eq!(strip_verbatim(&long), None);
        let long_unc = format!(r"\\?\UNC\srv\share\{0}\{0}", "a".repeat(140));
        assert_eq!(strip_verbatim(&long_unc), None);
        // 1 つの名前は 255 字まで。
        let name = format!(r"\\?\c:\{}", "a".repeat(256));
        assert_eq!(strip_verbatim(&name), None);
    }

    // Tauri の resource_dir は Windows で `\\?\C:\…` を返す。Node 22.20 以降はその形の主スクリプトを読めない。
    // Windows では、外せるものを外す。
    #[cfg(windows)]
    #[test]
    fn plain_strips_the_verbatim_prefix_on_windows() {
        assert_eq!(
            plain(Path::new(r"\\?\C:\Users\me\AppData\Local\Hangar\server")),
            PathBuf::from(r"C:\Users\me\AppData\Local\Hangar\server")
        );
        assert_eq!(
            plain(Path::new(r"\\?\UNC\srv\share\Hangar")),
            PathBuf::from(r"\\srv\share\Hangar")
        );
        assert_eq!(
            plain(Path::new(r"\\?\C:\x\nul")),
            PathBuf::from(r"\\?\C:\x\nul")
        );
    }

    // macOS では何も変えない。`\\?\` で始まる名前も、POSIX ではただの名前である。
    #[cfg(not(windows))]
    #[test]
    fn plain_changes_nothing_off_windows() {
        let p = Path::new(r"\\?\C:\x");
        assert_eq!(plain(p), p.to_path_buf());
    }
}
