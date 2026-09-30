//! 窓に落とされたファイルを、どのプロセスからも読める場所へ写してから UI に渡す。
//!
//! 撮影直後のスクリーンショットは `TemporaryItems` の保護された一時フォルダに置かれ、
//! macOS は落とした先のアプリにしか読ませない（ファイルの `com.apple.macl` に記録される）。
//! 殻はそのアプリなので読めるが、端末の向こうの Claude が読めるとは限らない。
//! そこで `~/.agent-hangar/drops/` に写し、写した先のパスを渡す。

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// 写したファイルを残しておく期間。会話の中で読み直されることがあるので、すぐには消さない。
pub const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// 写した先の名前に使えない文字を `_` に置き換える。
/// 空白や引用符を落としておくと、端末に渡すパスを囲まずに済む。日本語はそのまま残す。
pub fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_whitespace() || c.is_control() || "'\"\\`$!*?;&|<>(){}[]#~/".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    if s.is_empty() || s.chars().all(|c| c == '.') {
        "file".to_string()
    } else {
        s
    }
}

/// 落とされたパスごとに、写した先のパスを返す。
/// ファイルでないもの（フォルダ）と、写せなかったものは元のパスのまま返す。
pub fn stash(paths: &[PathBuf], dir: &Path, stamp: u128) -> Vec<PathBuf> {
    let _ = std::fs::create_dir_all(dir);
    paths
        .iter()
        .enumerate()
        .map(|(i, p)| {
            if !p.is_file() {
                return p.clone();
            }
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let dest = dir.join(format!("{stamp}-{i}-{}", sanitize(&name)));
            match std::fs::copy(p, &dest) {
                Ok(_) => dest,
                Err(_) => p.clone(),
            }
        })
        .collect()
}

/// 残しておく期間を過ぎた写しを消す。
pub fn prune(dir: &Path, now: SystemTime, keep_for: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        let old = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age > keep_for);
        if meta.is_file() && old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// UI に `hangar:drop` を投げる式。位置は CSS の px。
pub fn drop_js(paths: &[PathBuf], x: f64, y: f64) -> String {
    let detail = serde_json::json!({
        "paths": paths.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(),
        "x": x,
        "y": y,
    });
    // JSON はそのまま JS の式になる。行区切りの二つの符号位置だけは古い JS で文字列を切るので逃がす。
    let lit = serde_json::to_string(&detail)
        .unwrap_or_else(|_| "null".to_string())
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    format!("window.dispatchEvent(new CustomEvent(\"hangar:drop\",{{detail:{lit}}}));")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("hangar-filedrop-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn sanitize_drops_blanks_quotes_and_shell_characters_but_keeps_japanese() {
        assert_eq!(
            sanitize("スクリーンショット 2026-09-30 19.51.52.png"),
            "スクリーンショット_2026-09-30_19.51.52.png"
        );
        assert_eq!(sanitize("a'b\"c$d`e\\f.png"), "a_b_c_d_e_f.png");
        assert_eq!(sanitize(""), "file");
        assert_eq!(sanitize(".."), "file");
    }

    // 写した先は元と同じ中身で、名前に空白を含まない。フォルダは写さずに元のパスを返す。
    #[test]
    fn stash_copies_files_and_passes_folders_through() {
        let src = tmp("src");
        let f = src.join("shot 1.png");
        std::fs::write(&f, b"PNG").unwrap();
        let dir = tmp("dst");
        let out = stash(&[f.clone(), src.clone()], &dir, 42);
        assert_eq!(out[0], dir.join("42-0-shot_1.png"));
        assert_eq!(std::fs::read(&out[0]).unwrap(), b"PNG");
        assert_eq!(out[1], src);
    }

    #[test]
    fn stash_hands_back_the_original_when_the_copy_fails() {
        let src = tmp("src2");
        let f = src.join("a.png");
        std::fs::write(&f, b"x").unwrap();
        // 写し先がファイルなので、その下には作れない。
        let blocked = src.join("blocked");
        std::fs::write(&blocked, b"").unwrap();
        assert_eq!(stash(std::slice::from_ref(&f), &blocked, 1), vec![f]);
    }

    #[test]
    fn prune_removes_only_copies_past_the_keep_period() {
        let dir = tmp("prune");
        std::fs::write(dir.join("old"), b"").unwrap();
        std::fs::write(dir.join("new"), b"").unwrap();
        let later = SystemTime::now() + Duration::from_secs(10);
        std::fs::File::options()
            .write(true)
            .open(dir.join("new"))
            .unwrap()
            .set_modified(later)
            .unwrap();
        prune(
            &dir,
            SystemTime::now() + Duration::from_secs(5),
            Duration::from_secs(1),
        );
        assert!(!dir.join("old").exists());
        assert!(dir.join("new").exists());
    }

    // 式の中の detail は JSON として読み戻せ、位置とパスがそのまま入る。
    #[test]
    fn drop_js_carries_paths_and_position_as_json() {
        let js = drop_js(&[PathBuf::from("/a/b\"c\u{2028}.png")], 12.5, 30.0);
        assert!(
            js.starts_with("window.dispatchEvent(new CustomEvent(\"hangar:drop\",{detail:"),
            "{js}"
        );
        assert!(!js.contains('\u{2028}'), "{js}");
        let lit = js
            .trim_start_matches("window.dispatchEvent(new CustomEvent(\"hangar:drop\",{detail:")
            .trim_end_matches("}));");
        let v: serde_json::Value = serde_json::from_str(lit).unwrap();
        assert_eq!(v["paths"][0], "/a/b\"c\u{2028}.png");
        assert_eq!(v["x"], 12.5);
        assert_eq!(v["y"], 30.0);
    }
}
