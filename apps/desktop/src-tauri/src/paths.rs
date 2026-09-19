//! ホームディレクトリとデータディレクトリ。
use std::path::PathBuf;

/// 利用者のホーム。`HOME` が無ければ `/`。
pub fn user_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// hangar のデータディレクトリ。サーバと同じく `HANGAR_HOME` を優先する。
pub fn hangar_home() -> PathBuf {
    std::env::var_os("HANGAR_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home().join(".agent-hangar"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hangar_home_defaults_under_user_home() {
        std::env::remove_var("HANGAR_HOME");
        assert_eq!(hangar_home(), user_home().join(".agent-hangar"));
        std::env::set_var("HANGAR_HOME", "/tmp/h");
        assert_eq!(hangar_home(), PathBuf::from("/tmp/h"));
        std::env::remove_var("HANGAR_HOME");
    }
}
