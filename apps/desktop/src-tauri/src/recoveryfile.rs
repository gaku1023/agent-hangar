//! リカバリーキーの「ファイルに保存」（設定のクラウド同期の節、試作 D2）。
//! 頁（127.0.0.1:4177）から受け取るのは 4 行の本文だけで、書く場所は殻の保存のダイアログで利用者が選ぶ（lib.rs の `save_recovery_key`）。
//! ここには、ダイアログを除いた書き出しだけを置く。
//! 暗号鍵があれば誰でも同期したデータを読めるので、書いたファイルは持ち主だけが読める権限（Unix で 0600）にする。

use std::io::Write;
use std::path::Path;

/// 保存のダイアログに出す既定の名前。UI のブラウザのダウンロードの名前（CloudRecoveryKey.tsx）とそろえる。
pub const FILE_NAME: &str = "hangar-recovery-key.txt";

/// 頁から受け取る本文の上限（バイト）。リカバリーキーは 4 行で 200 バイトほどなので、桁違いに大きいものは書かない。
pub const MAX_LEN: usize = 4096;

/// 本文を `path` に書く。末尾に改行が無ければ足す。
/// 既にあるファイルを選ばれたときは中身を置き換え、権限も持ち主だけに絞る。
/// 権限は中身を書く前に絞り、広い権限のファイルに暗号鍵が載っている時間を作らない。
pub fn write(path: &Path, text: &str) -> Result<(), String> {
    if text.is_empty() || text.len() > MAX_LEN {
        return Err(format!("recovery key text must be 1..={MAX_LEN} bytes"));
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    let body = if text.ends_with('\n') {
        text.to_string()
    } else {
        format!("{text}\n")
    };
    file.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEXT: &str =
        "hangar リカバリーキー\n作成日: 2026-10-17\nURL: https://h.example\n暗号鍵: AAAA-BBBB";

    #[test]
    fn writes_the_text_with_a_trailing_newline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        write(&path, TEXT).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{TEXT}\n"));
        // 改行で終わる本文には足さない。
        write(&path, &format!("{TEXT}\n")).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{TEXT}\n"));
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        write(&path, TEXT).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    // 既にある 0644 のファイルを選ばれても、中身を置き換えて 0600 に絞る。
    #[cfg(unix)]
    #[test]
    fn an_existing_file_is_replaced_and_narrowed() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.txt");
        std::fs::write(
            &path,
            "a much longer old body that must not survive the write",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write(&path, TEXT).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{TEXT}\n"));
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn empty_or_oversized_text_is_refused_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE_NAME);
        assert!(write(&path, "").is_err());
        assert!(write(&path, &"A".repeat(MAX_LEN + 1)).is_err());
        assert!(!path.exists());
    }
}
