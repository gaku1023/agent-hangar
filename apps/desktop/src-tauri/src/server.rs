//! サーバ子プロセスの起動と停止、同梱サーバの置き場所、ウィンドウが開く入場 URL。
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const PORT: u16 = 4177;

/// 同梱サーバのディレクトリ。開発時は `HANGAR_SERVER_DIR` で差し替える。
/// 置き場所は `tauri.conf.json` の `bundle.resources`（`"../server-dist": "server"`）で `server/` に決めてある。
pub fn server_dir(resource_dir: &Path) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("HANGAR_SERVER_DIR") {
        let p = PathBuf::from(p);
        return if p.join("server.mjs").is_file() {
            Some(p)
        } else {
            None
        };
    }
    let p = resource_dir.join("server");
    p.join("server.mjs").is_file().then_some(p)
}

pub struct ServerProcess {
    child: Child,
    /// 止める合図に閉じる、サーバの標準入力の管（Windows だけ）。
    /// Windows には SIGTERM が無いので、管を閉じることで止める合図を送る。
    #[cfg(windows)]
    stdin: Option<std::process::ChildStdin>,
    /// サーバとその孫を入れたジョブ（Windows だけ）。入れられなかったときは None で、サーバだけを止める。
    #[cfg(windows)]
    job: Option<crate::winjob::Job>,
}

/// サーバの番犬が `process.exit(0)` を呼ぶまでの秒数。
/// 正本は `packages/server/src/server.ts` の `STOP_WATCHDOG_MS` で、ここはその写しである。
/// 片方だけ変えると `packages/server/src/server.test.ts` の「終了の時間の予算」が落ちる。
pub const SERVER_WATCHDOG_SECS: u64 = 8;

/// 猶予は番犬より後でなければならない。
/// 逆にすると、サーバが自分で降りて `db.close()` を呼ぶ前に SIGKILL が届く。
const _: () = assert!(ServerProcess::STOP_GRACE.as_secs() > SERVER_WATCHDOG_SECS);

/// サーバの子が継ぐ PATH。
///
/// .app を Finder から起こすと PATH は `/usr/bin:/bin:/usr/sbin:/sbin` だけになる。
/// サーバが起こす claude は tmux のペインでこの PATH を継ぐので、
/// `~/.local/bin` に入るネイティブ版の claude が名前では引けず、ペインの中で 127 で落ちる。
/// 手元のツールの置き場所を後ろに足しておく。
///
/// 足すのは後ろで、元の並びは変えない。利用者が選んだ優先順を覆さないためである。
/// これは念のための備えで、claude の場所を決める正本はサーバ側の `which` と Settings の `claudePath` である。
pub fn augmented_path(current: Option<&str>, user_home: &Path) -> String {
    // 足す置き場は POSIX のものである。Windows の PATH は ';' 区切りで、これらの置き場も無いので、そのまま渡す。
    if cfg!(windows) {
        return current.unwrap_or("").to_string();
    }
    let mut out: Vec<String> = current
        .unwrap_or("")
        .split(':')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    let extra = [
        user_home.join(".local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        user_home.join(".claude/local"),
    ];
    for d in extra {
        let d = d.to_string_lossy().to_string();
        if !out.contains(&d) {
            out.push(d);
        }
    }
    out.join(":")
}

/// サーバへ渡さない、殻が受け継いだ変数。
///
/// 殻を Claude Code のセッションの Bash から起こすと（`open` や osascript の launch）、
/// 呼び手のセッションの印が殻に入る。そのまま渡すと、サーバが起こす tmux サーバと claude まで届き、
/// hangar の claude が別のセッションの子として振る舞う（再開の一覧から外れる、別のセッションのソケットへ話しかける）。
/// 後ろの 7 つは hangar の部品のあいだの受け渡しの変数で、殻が自分の値を入れ直すか、サーバが読まないものである。
///
/// 正本は `packages/server/src/launch/env.ts` の `SERVER_DROPPED_ENV` で、ここはその写しである。
/// サーバも起動の最初に同じ名前を自分の環境から消す。
/// 片方だけ変えると `apps/desktop/test/config.test.ts` の「殻がサーバへ渡さない変数」が落ちる。
pub const INHERITED_ENV_DROPPED: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "AI_AGENT",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_SESSION_KIND",
    "CLAUDE_CODE_SESSION_NAME",
    "CLAUDE_JOB_DIR",
    "CLAUDE_BG_BACKEND",
    "CLAUDE_BG_SOURCE",
    "HANGAR_PARENT_PID",
    "HANGAR_PORT",
    "HANGAR_UI_DIST",
    "HANGAR_STOP_ON_STDIN_END",
    "HANGAR_RUN_ID",
    "HANGAR_UNSET_ENV",
    "HANGAR_CLOUD_DIR",
];

/// `node server.mjs` のコマンド。受け継いだ印を外してから、殻が渡す値を入れる。
/// 外すのを先にする。逆の順だと、入れた `HANGAR_PORT` などまで消える。
fn server_command(node: &Path, dir: &Path, hangar_home: &Path) -> Command {
    let path = augmented_path(
        std::env::var("PATH").ok().as_deref(),
        &crate::paths::user_home(),
    );
    let mut cmd = Command::new(node);
    for name in INHERITED_ENV_DROPPED {
        cmd.env_remove(name);
    }
    cmd.arg(dir.join("server.mjs"))
        .env("PATH", path)
        .env("HANGAR_PARENT_PID", std::process::id().to_string())
        .env("HANGAR_PORT", PORT.to_string())
        .env("HANGAR_UI_DIST", dir.join("ui"))
        .env("HANGAR_HOME", hangar_home);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 標準入力の閉じを止める合図にするよう頼む（ServerProcess::stop_within）。
        cmd.env("HANGAR_STOP_ON_STDIN_END", "1");
        // 窓を持たない殻から Node を起こすと、黒いコンソールの窓が開いたままになる。
        // 窓の無いコンソールを持たせておけば、サーバが起こす孫（psmux の CLI、PowerShell）もそれを継ぎ、窓を開かない。
        cmd.creation_flags(crate::winjob::CREATE_NO_WINDOW);
    }
    cmd
}

/// `node server.mjs` を起動する。標準出力と標準エラーはログファイルに追記する。
/// UI の置き場は、同梱の場所を環境変数で教える。
/// 単一ファイルにまとめた server.mjs からは、相対では届かないためである。
///
/// Windows では標準入力を管でつなぎ（止める合図に閉じる）、サーバをジョブに入れる（孫ごと止める）。
/// macOS では標準入力は空のままで、止めるのは SIGTERM である。
pub fn spawn_server(
    node: &Path,
    dir: &Path,
    hangar_home: &Path,
    log: &Path,
) -> std::io::Result<ServerProcess> {
    let out = OpenOptions::new().create(true).append(true).open(log)?;
    let err = out.try_clone()?;
    let stdin = if cfg!(windows) {
        Stdio::piped()
    } else {
        Stdio::null()
    };
    #[allow(unused_mut)]
    let mut child = server_command(node, dir, hangar_home)
        .stdin(stdin)
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .spawn()?;
    Ok(ServerProcess {
        #[cfg(windows)]
        job: crate::winjob::contain(&child),
        #[cfg(windows)]
        stdin: child.stdin.take(),
        child,
    })
}

impl ServerProcess {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// 生きているか。終了していれば false。
    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// 終了していれば、その終わり方（終了コードか信号）。生きていれば None。
    pub fn exit_status(&mut self) -> Option<std::process::ExitStatus> {
        self.child.try_wait().ok().flatten()
    }

    /// 止める合図（macOS は SIGTERM、Windows は標準入力の閉じ）を送ってから、力ずくで止めるまでの猶予。
    ///
    /// 終了の時間は 3 つの数が噛み合っていなければならない。
    /// 決め方の正本は `packages/server/src/server.ts` の `CLOSE_DEADLINE_MS` の説明である。
    ///
    /// 1. `close()` 全体の締め切り（5 秒）。
    /// 2. サーバの番犬（`SERVER_WATCHDOG_SECS`、8 秒）。締め切りより後でなければ `db.close()` に届かない。
    /// 3. この猶予。番犬より後でなければ、サーバが自分で降りる前に殺される。
    ///
    /// 普段は待つものが無いので合図の直後に終わり、この猶予は使い切らない。
    /// 10 秒は最悪の場合の保険である。
    pub const STOP_GRACE: Duration = Duration::from_secs(10);

    /// 止める合図を送って猶予まで待ち、まだ生きていれば力ずくで止める。サーバは合図で DB を閉じてから終わる。
    pub fn stop(&mut self) {
        self.stop_within(Self::STOP_GRACE);
    }

    /// 猶予を指定して止める。試験が実時間を使わずに力ずくの経路を踏むために分けてある。
    ///
    /// macOS は SIGTERM を送り、残れば SIGKILL でサーバだけを止める。
    /// Windows は標準入力の管を閉じ（サーバはそれを SIGTERM と同じに受け取る）、残ればジョブごと止める。
    /// Windows では、サーバが猶予のうちに降りた後も、ジョブに残った孫（node-pty の端末など）をここで止める。
    /// psmux のサーバは自分からジョブを抜けているので止まらない（winjob.rs）。
    pub fn stop_within(&mut self, grace: Duration) {
        #[cfg(unix)]
        unsafe {
            libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM);
        }
        #[cfg(windows)]
        drop(self.stdin.take());
        let t0 = Instant::now();
        let mut exited = false;
        while t0.elapsed() < grace {
            if !self.is_running() {
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        #[cfg(windows)]
        if let Some(job) = self.job.take() {
            job.terminate();
        }
        if exited {
            return;
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
    fn server_dir_finds_the_bundled_server_only_under_server() {
        let res = tempfile::tempdir().unwrap();
        assert_eq!(server_dir(res.path()), None);
        // 古い置き場所（_up_/server-dist）は見ない。
        std::fs::create_dir_all(res.path().join("_up_/server-dist")).unwrap();
        std::fs::write(res.path().join("_up_/server-dist/server.mjs"), "").unwrap();
        assert_eq!(server_dir(res.path()), None);
        std::fs::create_dir_all(res.path().join("server")).unwrap();
        std::fs::write(res.path().join("server/server.mjs"), "").unwrap();
        assert_eq!(server_dir(res.path()), Some(res.path().join("server")));
    }

    // server_dir が見る置き場所と、バンドルが置く場所を 1 か所でつなぐ。
    // tauri.conf.json の resources を変えたら、ここが落ちる。
    #[test]
    fn the_bundle_puts_the_server_where_server_dir_looks() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["bundle"]["resources"]["../server-dist"], "server");
    }

    // 外す一覧のどの名前も、子へは「消す」として渡る。殻が入れ直す 3 つだけは、殻の値になる。
    // 試験のプロセスの環境に頼らずに、組み立てたコマンドそのものを見る。
    #[test]
    fn server_command_drops_inherited_markers_and_sets_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let cmd = server_command(Path::new("/bin/sh"), dir.path(), home.path());
        let envs: std::collections::HashMap<_, _> = cmd.get_envs().collect();
        let mut own = vec!["HANGAR_PARENT_PID", "HANGAR_PORT", "HANGAR_UI_DIST"];
        // Windows では、標準入力の閉じを止める合図にするようサーバに頼む。macOS では立てない。
        if cfg!(windows) {
            own.push("HANGAR_STOP_ON_STDIN_END");
        }
        for name in INHERITED_ENV_DROPPED {
            let v = envs.get(std::ffi::OsStr::new(name));
            if own.contains(name) {
                assert!(matches!(v, Some(Some(_))), "{name}: {v:?}");
            } else {
                assert_eq!(v, Some(&None), "{name}");
            }
        }
        assert_eq!(
            envs.get(std::ffi::OsStr::new("HANGAR_PORT")),
            Some(&Some(std::ffi::OsStr::new("4177")))
        );
        // statusline の台本と hangar の CLI が claude の中で読む置き場は、殻の値で渡す。
        assert_eq!(
            envs.get(std::ffi::OsStr::new("HANGAR_HOME")),
            Some(&Some(home.path().as_os_str()))
        );
    }

    #[cfg(unix)]
    #[test]
    fn spawn_passes_env_and_stop_terminates() {
        // Node の代わりに /bin/sh を使い、server.mjs をシェルスクリプトにして環境変数と停止を確かめる。
        let dir = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("server.mjs"),
            "echo \"pid=$HANGAR_PARENT_PID ui=$HANGAR_UI_DIST cloud=$HANGAR_CLOUD_DIR port=$HANGAR_PORT home=$HANGAR_HOME path=$PATH\"\necho \"leak=[$CLAUDECODE$CLAUDE_CODE_SESSION_ID$CLAUDE_CODE_CHILD_SESSION$HANGAR_RUN_ID]\"\ntrap 'exit 0' TERM\nwhile :; do sleep 0.1; done\n",
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
        // サーバは HANGAR_CLOUD_DIR を読まないので渡さない。試験を走らせる人の環境に残っていても外す。
        assert!(text.contains("cloud= port="), "{text}");
        // Claude Code のセッションから試験を走らせると、試験のプロセスはそのセッションの印を持っている。それも渡さない。
        assert!(text.contains("leak=[]"), "{text}");
        assert!(text.contains("port=4177"), "{text}");
        assert!(
            text.contains(&format!("home={}", home.path().display())),
            "{text}"
        );
        // 子が継ぐ PATH には手元のツールの置き場所が入っている。
        // Finder から起こすと PATH は /usr/bin:/bin:/usr/sbin:/sbin だけになり、
        // これが無いとサーバは claude を名前で引けない。
        assert!(
            text.contains(
                &crate::paths::user_home()
                    .join(".local/bin")
                    .to_string_lossy()
                    .to_string()
            ),
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
    #[cfg(unix)]
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

    /// Windows の試験のサーバ。Node の本物で、server.mjs だけを差し替える。
    /// Node は CI の windows ジョブに入っている（setup-node）。
    #[cfg(windows)]
    fn spawn_windows_server(body: &str) -> (ServerProcess, tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("server.mjs"), body).unwrap();
        let log = dir.path().join("desktop.log");
        let p = spawn_server(Path::new("node"), dir.path(), dir.path(), &log).unwrap();
        (p, dir, log)
    }

    #[cfg(windows)]
    fn wait_for_log(log: &Path, needle: &str) -> String {
        let mut text = String::new();
        let found = crate::winjob::tests::wait_until(Duration::from_secs(20), || {
            text = std::fs::read_to_string(log).unwrap_or_default();
            text.contains(needle)
        });
        assert!(found, "{needle} が出ない: {text}");
        text
    }

    // Windows には SIGTERM が無い。殻は標準入力の管を閉じ、サーバはそれを合図に自分で降りる（entry.ts の runMain）。
    // 猶予（10 秒）を使い切らずに終わることで、力ずくの経路を踏んでいないことを見る。
    #[cfg(windows)]
    #[test]
    fn stop_closes_stdin_and_the_server_leaves_on_its_own() {
        let (mut p, _dir, log) = spawn_windows_server(
            "console.log(`flag=${process.env.HANGAR_STOP_ON_STDIN_END}`);\n\
             process.stdin.on('end', () => { console.log('stdin closed'); process.exit(0); });\n\
             process.stdin.resume();\n\
             setInterval(() => {}, 1000);\n",
        );
        wait_for_log(&log, "flag=1");
        assert!(p.is_running());
        let t0 = Instant::now();
        p.stop();
        assert!(!p.is_running());
        assert!(t0.elapsed() < Duration::from_secs(5), "{:?}", t0.elapsed());
        wait_for_log(&log, "stdin closed");
    }

    // 合図を聞かないサーバは、猶予を使い切ってから孫ごと止める。
    // 孫は detached で起こす。Node（libuv）が自分の子を道連れにする仕組みには乗らないので、残れば殻のジョブの落ち度である。
    #[cfg(windows)]
    #[test]
    fn stop_kills_the_whole_tree_when_the_server_does_not_leave() {
        let (mut p, _dir, log) = spawn_windows_server(
            "import { spawn } from 'node:child_process';\n\
             const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });\n\
             console.log(`grandchild=${c.pid};`);\n\
             setInterval(() => {}, 1000);\n",
        );
        let text = wait_for_log(&log, ";");
        let grandchild: u32 = text
            .split("grandchild=")
            .nth(1)
            .and_then(|r| r.split(';').next())
            .and_then(|n| n.trim().parse().ok())
            .unwrap_or_else(|| panic!("孫の番号が読めない: {text}"));
        assert!(crate::winjob::tests::is_alive(grandchild));
        let t0 = Instant::now();
        p.stop_within(Duration::from_millis(400));
        let waited = t0.elapsed();
        assert!(!p.is_running());
        assert!(waited >= Duration::from_millis(400), "{waited:?}");
        assert!(waited < Duration::from_secs(5), "{waited:?}");
        let gone = crate::winjob::tests::wait_until(Duration::from_secs(10), || {
            !crate::winjob::tests::is_alive(grandchild)
        });
        if !gone {
            crate::winjob::tests::kill_pid(grandchild);
        }
        assert!(gone, "孫が残った");
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

    #[cfg(windows)]
    #[test]
    fn augmented_path_is_left_alone_on_windows() {
        let home = Path::new("C:\\Users\\me");
        assert_eq!(augmented_path(Some("C:\\a;C:\\b"), home), "C:\\a;C:\\b");
        assert_eq!(augmented_path(None, home), "");
    }

    #[cfg(unix)]
    #[test]
    fn augmented_path_adds_the_local_tool_dirs_without_duplicates() {
        let home = Path::new("/Users/me");
        // Finder から起こした .app の PATH。手元の置き場所がどれも入っていない。
        assert_eq!(
            augmented_path(Some("/usr/bin:/bin:/usr/sbin:/sbin"), home),
            "/usr/bin:/bin:/usr/sbin:/sbin:/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/Users/me/.claude/local"
        );
        // 既にある項目は増やさない。並びは元のままにする。
        assert_eq!(
            augmented_path(Some("/opt/homebrew/bin:/usr/bin"), home),
            "/opt/homebrew/bin:/usr/bin:/Users/me/.local/bin:/usr/local/bin:/Users/me/.claude/local"
        );
        // PATH が無い、または空のときも足した分だけは渡す。
        assert_eq!(
            augmented_path(None, home),
            "/Users/me/.local/bin:/opt/homebrew/bin:/usr/local/bin:/Users/me/.claude/local"
        );
        assert_eq!(augmented_path(Some(""), home), augmented_path(None, home));
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
