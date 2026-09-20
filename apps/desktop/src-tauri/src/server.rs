//! サーバ子プロセスの起動と停止、同梱サーバの置き場所、ウィンドウが開く入場 URL。
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const PORT: u16 = 4177;

/// 同梱サーバのディレクトリ。開発時は `HANGAR_SERVER_DIR` で差し替える。
/// バンドラの都合で置き場所が `server/` か `_up_/server-dist/` のどちらかになるので両方を見る。
pub fn server_dir(resource_dir: &Path) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("HANGAR_SERVER_DIR") {
        let p = PathBuf::from(p);
        return if p.join("server.mjs").is_file() {
            Some(p)
        } else {
            None
        };
    }
    ["server", "_up_/server-dist"]
        .iter()
        .map(|rel| resource_dir.join(rel))
        .find(|p| p.join("server.mjs").is_file())
}

pub struct ServerProcess {
    child: Child,
}

/// サーバの番犬が `process.exit(0)` を呼ぶまでの秒数。
/// 正本は `packages/server/src/server.ts` の `STOP_WATCHDOG_MS` で、ここはその写しである。
/// 片方だけ変えると `packages/server/src/server.test.ts` の「終了の時間の予算」が落ちる。
pub const SERVER_WATCHDOG_SECS: u64 = 8;

/// 猶予は番犬より後でなければならない。
/// 逆にすると、サーバが自分で降りて `db.close()` を呼ぶ前に SIGKILL が届く。
const _: () = assert!(ServerProcess::STOP_GRACE.as_secs() > SERVER_WATCHDOG_SECS);

/// `node server.mjs` を起動する。標準出力と標準エラーはログファイルに追記する。
/// UI と Worker のソースは同梱の場所を環境変数で教える。
/// 単一ファイルにまとめた server.mjs と cli.mjs からは、相対では届かないためである。
pub fn spawn_server(
    node: &Path,
    dir: &Path,
    hangar_home: &Path,
    log: &Path,
) -> std::io::Result<ServerProcess> {
    let out = OpenOptions::new().create(true).append(true).open(log)?;
    let err = out.try_clone()?;
    let child = Command::new(node)
        .arg(dir.join("server.mjs"))
        .env("HANGAR_PARENT_PID", std::process::id().to_string())
        .env("HANGAR_PORT", PORT.to_string())
        .env("HANGAR_UI_DIST", dir.join("ui"))
        .env("HANGAR_CLOUD_DIR", dir.join("cloud"))
        .env("HANGAR_HOME", hangar_home)
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()?;
    Ok(ServerProcess { child })
}

impl ServerProcess {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// 生きているか。終了していれば false。
    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// SIGTERM を送ってから SIGKILL に移るまでの猶予。
    ///
    /// 終了の時間は 3 つの数が噛み合っていなければならない。
    /// 決め方の正本は `packages/server/src/server.ts` の `CLOSE_DEADLINE_MS` の説明である。
    ///
    /// 1. `close()` 全体の締め切り（5 秒）。
    /// 2. サーバの番犬（`SERVER_WATCHDOG_SECS`、8 秒）。締め切りより後でなければ `db.close()` に届かない。
    /// 3. この猶予。番犬より後でなければ、サーバが自分で降りる前に殺される。
    ///
    /// 普段は待つものが無いので SIGTERM の直後に終わり、この猶予は使い切らない。
    /// 10 秒は最悪の場合の保険である。
    pub const STOP_GRACE: Duration = Duration::from_secs(10);

    /// SIGTERM を送って猶予まで待ち、まだ生きていれば SIGKILL。サーバは SIGTERM で DB を閉じてから終わる。
    pub fn stop(&mut self) {
        self.stop_within(Self::STOP_GRACE);
    }

    /// 猶予を指定して止める。試験が実時間を使わずに SIGKILL の経路を踏むために分けてある。
    pub fn stop_within(&mut self, grace: Duration) {
        unsafe {
            libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM);
        }
        let t0 = Instant::now();
        while t0.elapsed() < grace {
            if !self.is_running() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// ダウンロードした zip から展開したファイルに付く検疫属性を外す。
/// 未署名の `.node` を Node が読み込むとき、属性が残っていると Gatekeeper に止められる。
pub fn strip_quarantine(dir: &Path) {
    let _ = Command::new("/usr/bin/xattr")
        .args(["-rd", "com.apple.quarantine"])
        .arg(dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// App Translocation で走っているか。
/// zip を展開してそのままダブルクリックすると、macOS は `.app` を読み取り専用のマウントに写して起動する。
/// その写しでは `strip_quarantine` が書き込めず、検疫属性を外せない。
/// つまり検疫属性が問題になる唯一の経路でだけ、外す手立てが効かない。
/// 先に見分けて、利用者に `/Applications` へ移してもらう。
/// 写しの置き場は `/private/var/folders/.../AppTranslocation/<番号>/d/<名前>.app` の形で、
/// 段の名前として `AppTranslocation` が現れる。
/// 字面の一致だけで見ると、この語を名前に含む置き場から起動した利用者が、
/// 正しく `/Applications` へ移した `.app` でも移動を案内されて止まる。
pub fn is_translocated(exe: &Path) -> bool {
    exe.starts_with("/private/var/folders")
        && exe
            .components()
            .any(|c| c.as_os_str() == "AppTranslocation")
}

/// サーバが `~/.agent-hangar/token` に書いた入場の鍵を読む。
/// 値はどこにも出さない。ログにも読み込み画面にも載せない。
pub fn read_token(hangar_home: &Path) -> Option<String> {
    let text = std::fs::read_to_string(hangar_home.join("token")).ok()?;
    let token = text.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// `encodeURIComponent` と同じ範囲を残して百分率で逃がす。
/// 逃がしすぎても復号すれば同じ値になるので、非予約文字以外は一律に逃がす。
fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 新しい webview が最初に開く URL。
/// `GET /` は鍵付きの問い合わせかクッキーが無ければ 401 の案内を返すので、鍵を付けて開く。
/// webview はクッキーを持たないので、付けないと UI が出ない。
/// CLI の `entryUrl` と同じ形にしてある。
/// ハッシュは末尾に置く。UI の `stripEntryToken` は `?t=` だけを消してハッシュを残す。
pub fn entry_url(port: u16, token: &str, hash: &str) -> String {
    format!("http://127.0.0.1:{port}/?t={}{hash}", percent_encode(token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_dir_finds_bundled_layouts() {
        let res = tempfile::tempdir().unwrap();
        assert_eq!(server_dir(res.path()), None);
        std::fs::create_dir_all(res.path().join("_up_/server-dist")).unwrap();
        std::fs::write(res.path().join("_up_/server-dist/server.mjs"), "").unwrap();
        assert_eq!(
            server_dir(res.path()),
            Some(res.path().join("_up_/server-dist"))
        );
        std::fs::create_dir_all(res.path().join("server")).unwrap();
        std::fs::write(res.path().join("server/server.mjs"), "").unwrap();
        assert_eq!(server_dir(res.path()), Some(res.path().join("server")));
    }

    #[test]
    fn spawn_passes_env_and_stop_terminates() {
        // Node の代わりに /bin/sh を使い、server.mjs をシェルスクリプトにして環境変数と停止を確かめる。
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("server.mjs"),
            "echo \"pid=$HANGAR_PARENT_PID ui=$HANGAR_UI_DIST cloud=$HANGAR_CLOUD_DIR port=$HANGAR_PORT home=$HANGAR_HOME\"\ntrap 'exit 0' TERM\nwhile :; do sleep 0.1; done\n",
        )
        .unwrap();
        let log = home.path().join("desktop.log");
        let mut p = spawn_server(Path::new("/bin/sh"), dir.path(), home.path(), &log).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let text = std::fs::read_to_string(&log).unwrap();
        assert!(
            text.contains(&format!("pid={}", std::process::id())),
            "{text}"
        );
        assert!(
            text.contains(&format!("ui={}", dir.path().join("ui").display())),
            "{text}"
        );
        assert!(
            text.contains(&format!("cloud={}", dir.path().join("cloud").display())),
            "{text}"
        );
        assert!(text.contains("port=4177"), "{text}");
        assert!(
            text.contains(&format!("home={}", home.path().display())),
            "{text}"
        );
        assert!(p.is_running());
        let t0 = Instant::now();
        p.stop();
        assert!(!p.is_running());
        assert!(t0.elapsed() < Duration::from_secs(2));
    }

    // SIGTERM を無視する子は、猶予を使い切ってから SIGKILL で止める。
    // 猶予の途中で切らないこと（走っている押し出しを待つため）も同時に見る。
    #[test]
    fn stop_waits_the_grace_then_kills() {
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("server.mjs"),
            "trap '' TERM\nwhile :; do sleep 0.1; done\n",
        )
        .unwrap();
        let log = home.path().join("desktop.log");
        let mut p = spawn_server(Path::new("/bin/sh"), dir.path(), home.path(), &log).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(p.is_running());
        let t0 = Instant::now();
        p.stop_within(Duration::from_millis(400));
        let waited = t0.elapsed();
        assert!(!p.is_running());
        assert!(waited >= Duration::from_millis(400), "{waited:?}");
        assert!(waited < Duration::from_secs(2), "{waited:?}");
    }

    #[test]
    fn read_token_trims_and_ignores_missing_or_empty() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(read_token(home.path()), None);
        std::fs::write(home.path().join("token"), "  \n").unwrap();
        assert_eq!(read_token(home.path()), None);
        std::fs::write(home.path().join("token"), "deadbeef\n").unwrap();
        assert_eq!(read_token(home.path()), Some("deadbeef".to_string()));
    }

    // 入場 URL の形。
    // 鍵は問い合わせに、ハッシュはその後ろに置く。
    // UI の stripEntryToken が `?t=` だけを消して、ハッシュは残す形に合わせてある。
    #[test]
    fn entry_url_carries_the_token_then_the_hash() {
        assert_eq!(
            entry_url(4177, "abc123", ""),
            "http://127.0.0.1:4177/?t=abc123"
        );
        assert_eq!(
            entry_url(4177, "abc123", "#/session/42"),
            "http://127.0.0.1:4177/?t=abc123#/session/42"
        );
        assert_eq!(
            entry_url(4177, "a b/c&d", ""),
            "http://127.0.0.1:4177/?t=a%20b%2Fc%26d"
        );
        // 組み立てた URL は Tauri が navigate に使う。読み戻せることを確かめる。
        let u = url::Url::parse(&entry_url(PORT, "abc123", "#/sessions?q=a+b")).unwrap();
        assert_eq!(u.query(), Some("t=abc123"));
        assert_eq!(u.fragment(), Some("/sessions?q=a+b"));
    }

    #[test]
    fn translocated_paths_are_recognised() {
        assert!(is_translocated(Path::new(
            "/private/var/folders/x/AppTranslocation/1234/d/Hangar.app/Contents/MacOS/Hangar"
        )));
        assert!(!is_translocated(Path::new(
            "/Applications/Hangar.app/Contents/MacOS/Hangar"
        )));
        assert!(!is_translocated(Path::new(
            "/Users/me/workspace/agent-hangar/apps/desktop/src-tauri/target/debug/hangar-desktop"
        )));
        // 字面だけを見ると、この語を名前に含む置き場から起動した利用者が、
        // 正しく /Applications へ移した .app でも移動を案内されて止まる。
        assert!(!is_translocated(Path::new(
            "/Users/me/AppTranslocation/Hangar.app/Contents/MacOS/Hangar"
        )));
        assert!(!is_translocated(Path::new(
            "/private/var/folders/x/AppTranslocationNotes/Hangar.app/Contents/MacOS/Hangar"
        )));
    }
}
