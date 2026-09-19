//! ホームディレクトリとデータディレクトリ。
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// 利用者のホーム。`HOME` が無ければ `/`。
pub fn user_home() -> PathBuf {
    user_home_from(std::env::var_os("HOME"))
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
}
