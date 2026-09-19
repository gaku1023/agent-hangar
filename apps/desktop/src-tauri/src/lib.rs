//! agent-hangar のデスクトップシェル。
//! 起動時に同梱サーバを子プロセスとして立て、`/health` が通ったらウィンドウをサーバの URL へ移す。
//! `hangar://` のディープリンクは UI のハッシュ経路に変換して webview に流す。

pub mod deeplink;
pub mod health;
pub mod node;
pub mod paths;
pub mod server;

use std::cell::Cell;
use std::io::Write;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_deep_link::DeepLinkExt;

/// アプリ全体で共有する状態。
struct AppState {
    server: Mutex<Option<server::ServerProcess>>,
    ui: Mutex<Ui>,
}

/// ウィンドウが今どの段にいるか。
/// 評価（`eval`）は、頁の読み込みが終わっていないと捨てられることがある。
/// そのため「出せるか」をここで決め、出せないものは貯めて読み込みの合図で流す。
#[derive(Default)]
struct Ui {
    /// サーバの URL へ navigate を出したか。
    ready: bool,
    /// 今出している頁の読み込みが終わったか。
    loaded: bool,
    pending_hash: Option<String>,
    pending_status: Option<(String, bool)>,
}

impl Ui {
    /// 読み込みの前に出す文言を控える。
    /// 読み込みが済んでいれば、呼び出し側がその場で評価できるので控えない。
    fn remember_status(&mut self, text: &str, error: bool) {
        if !self.loaded {
            self.pending_status = Some((text.to_string(), error));
        }
    }

    /// ディープリンクのハッシュ。
    /// 今すぐ評価してよければ返し、駄目なら貯めて `None` を返す。
    /// 読み込みの最中に `location.hash` を書くと、その読み込みでハッシュごと捨てられることがある。
    fn hash_to_eval(&mut self, hash: String) -> Option<String> {
        if self.ready && self.loaded {
            return Some(hash);
        }
        self.pending_hash = Some(hash);
        None
    }

    /// navigate を出す直前。
    /// 貯めたハッシュを取り出して、行き先の URL の末尾に載せてもらう。
    /// ここから読み込みが終わるまでに届くリンクは、また貯める側へ回る。
    fn navigating(&mut self) -> String {
        self.ready = true;
        self.loaded = false;
        self.pending_hash.take().unwrap_or_default()
    }

    /// navigate に至らなかった。読み込み画面がそのまま残っているので、段を戻す。
    fn navigation_failed(&mut self) {
        self.ready = false;
        self.loaded = true;
    }

    /// 頁の読み込みが終わった。今流してよい文言とハッシュを返す。
    /// 文言は読み込み画面のものだけ、ハッシュはサーバの頁のものだけを流す。
    /// 段に合わない合図（navigate の後に届く読み込み画面の側の合図など）は何もしない。
    /// 消えていく頁へ流すと、そのハッシュはそのまま失われるからである。
    fn page_loaded(&mut self, server_page: bool) -> (Option<(String, bool)>, Option<String>) {
        if self.ready != server_page {
            return (None, None);
        }
        self.loaded = true;
        if self.ready {
            (None, self.pending_hash.take())
        } else {
            (self.pending_status.take(), None)
        }
    }
}

/// 文言に入場の鍵が混じっていたら伏せる。
/// 例外の文言をそのまま画面やログへ出す前に必ず通す。
fn redact(text: &str, token: &str) -> String {
    if token.is_empty() {
        return text.to_string();
    }
    text.replace(token, "***")
}

/// データの置き場所を用意する。無ければ 0700 で作り、あれば権限を確かめて直す。
/// 中の `hangar.db`（全セッションの記録）と `desktop.log` は 0644 なので、
/// ここが 0755 だと同じ機械の別の利用者に中身が読める。
/// サーバ側の `ensureHome` と同じ意思をここでも守る。
/// 既に 0755 で作られてしまった手元も直るように、作るときだけでなく起動のたびに確かめる。
/// 利用者が 0700 より厳しくした権限は緩めない。
fn ensure_hangar_home(home: &std::path::Path) {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let _ = std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(home);
    if let Ok(md) = std::fs::metadata(home) {
        if md.is_dir() && md.permissions().mode() & 0o077 != 0 {
            let _ = std::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700));
        }
    }
}

/// `~/.agent-hangar/desktop.log` に 1 行追記する。サーバの標準出力も同じファイルに流れる。
/// 入場の鍵は決してここへ書かない。
fn log(line: &str) {
    let home = paths::hangar_home();
    ensure_hangar_home(&home);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.join("desktop.log"))
    {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = writeln!(f, "{ms} [desktop] {line}");
    }
}

/// 読み込み画面の `#status` を書き換える JavaScript。
fn status_js(text: &str, error: bool) -> String {
    format!(
        "(function(){{var s=document.getElementById('status');if(!s)return;s.textContent={};s.dataset.level={};}})();",
        serde_json::to_string(text).unwrap_or_default(),
        if error { "'error'" } else { "''" }
    )
}

fn eval_main(app: &AppHandle, js: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(js);
    }
}

/// 読み込み画面の文言を差し替える。サーバへ移る前だけ意味を持つ。
/// 読み込みが終わる前の評価は捨てられることがあるので、そのときは文言を控えて読み込みの合図でもう一度流す。
/// 控えるときも評価自体は試す。
/// 読み込みの合図が来ない作りに変わっても、今までの見え方を下回らないためである。
fn set_status(app: &AppHandle, text: &str, error: bool) {
    {
        let state = app.state::<AppState>();
        state.ui.lock().unwrap().remember_status(text, error);
    }
    eval_main(app, &status_js(text, error));
}

fn fail(app: &AppHandle, msg: &str) {
    log(msg);
    set_status(app, msg, true);
}

/// ディープリンクをハッシュとして適用する。
/// サーバの頁が出来上がる前なら保持して、最初のナビゲーションか読み込みの合図に乗せる。
/// 読み込みの最中に `location.hash` を評価で書くと、その読み込みでハッシュごと捨てられることがある。
/// なので一件目は navigate する URL の末尾に付け、出来上がった後のものだけを評価で渡す。
fn apply_hash(app: &AppHandle, hash: String) {
    let now = {
        let state = app.state::<AppState>();
        let mut ui = state.ui.lock().unwrap();
        ui.hash_to_eval(hash)
    };
    if let Some(w) = app.get_webview_window("main") {
        if let Some(h) = now {
            let _ = w.eval(&deeplink::hash_to_js(&h));
        }
        // 貯めた場合もウィンドウは前へ出す。利用者はリンクを踏んだのだから、画面はこちらを向く。
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 読み込みが終わった頁がサーバの頁か。
/// 読み込み画面は `tauri://localhost` から出るので、宛先で見分けられる。
/// この URL には入場の鍵が載っているので、ホストとポート以外は見ないし、どこにも出さない。
fn is_server_page(u: &url::Url) -> bool {
    u.host_str() == Some("127.0.0.1") && u.port() == Some(server::PORT)
}

/// 頁の読み込みが終わった合図。
/// 読み込みの前に出しそこねた文言と、navigate の最中に届いたハッシュをここで流す。
fn page_loaded(app: &AppHandle, server_page: bool) {
    let (status, hash) = {
        let state = app.state::<AppState>();
        let mut ui = state.ui.lock().unwrap();
        ui.page_loaded(server_page)
    };
    if let Some((text, error)) = status {
        eval_main(app, &status_js(&text, error));
    }
    if let Some(h) = hash {
        eval_main(app, &deeplink::hash_to_js(&h));
    }
}

/// ログに残すディープリンクの長さの上限（バイト）。
/// `deeplink.rs` の 2048 バイトの上限は形の検査の中にあり、ログには効かない。
const LOG_URL_MAX: usize = 200;

/// ログへ書く前に URL を丸める。
/// macOS では同じ機械の誰でも `open hangar://...` を実行できるので、
/// 上限を置かないと外から何度でも `desktop.log` を太らせられる。
/// 切ったことが分かるように、元の長さを添える。
fn url_for_log(u: &str) -> String {
    if u.len() <= LOG_URL_MAX {
        return u.to_string();
    }
    // 多バイト文字の途中で切らない。
    let mut cut = LOG_URL_MAX;
    while cut > 0 && !u.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}... (全 {} バイト)", &u[..cut], u.len())
}

/// 届いた URL をハッシュに直して流す。起動時の取りこぼしを防ぐため、
/// `on_open_url` と `get_current` の両方からここへ来る。
fn handle_urls(app: &AppHandle, urls: &[url::Url]) {
    for u in urls {
        log(&format!("deep link {}", url_for_log(u.as_str())));
        match deeplink::deep_link_to_hash(u.as_str()) {
            Some(hash) => apply_hash(app, hash),
            None => log("deep link ignored"),
        }
    }
}

/// `server_dir` が返した置き場所を受け取ってよいか決める。
/// `HANGAR_SERVER_DIR` はその置き場所を任意の木へ動かせるので、開発（`dev`）のときだけ認める。
/// 配布版で認めると、環境変数を書ける相手が指した木に `strip_quarantine` が
/// `xattr -rd` を再帰で掛け、その中の JavaScript を Node が走らせることになる。
/// 配布版では、アプリのリソースの中に収まっている置き場所だけを受け取る。
/// symlink と `..` で外へ抜けられないように、実体の場所へ直してから比べる。
fn accept_server_dir(
    dir: std::path::PathBuf,
    resource_dir: &std::path::Path,
    dev: bool,
) -> Option<std::path::PathBuf> {
    if dev {
        return Some(dir);
    }
    let inside = match (dir.canonicalize(), resource_dir.canonicalize()) {
        (Ok(d), Ok(r)) => d.starts_with(r),
        _ => false,
    };
    inside.then_some(dir)
}

/// 同梱サーバを起こす。成功したら `Ok(())`。
/// 既に 4177 で hangar が動いていれば、子は起こさずそれを使う。
fn start_server(
    app: &AppHandle,
    hangar_home: &std::path::Path,
    addr: SocketAddr,
) -> Result<(), String> {
    if health::probe_health(addr) {
        // hangar start などで既にサーバがいる。子は起こさず、そのサーバを使う。
        log("adopting the server already listening on 4177");
        return Ok(());
    }
    // 読み取り専用の写しから走っていないか先に見る。
    // ここでは検疫属性を外せないので、外せないまま Node にネイティブを読ませることになる。
    if let Ok(exe) = std::env::current_exe() {
        if server::is_translocated(&exe) {
            return Err(concat!(
                "この .app は読み取り専用の写しから起動されています（macOS の App Translocation）。\n",
                "Hangar.app を /Applications へ移してから開き直してください。\n",
                "移さずに使うときは、ダウンロードした Hangar.app に対して次を実行してください。\n",
                "xattr -rd com.apple.quarantine /path/to/Hangar.app"
            )
            .to_string());
        }
    }
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("リソースの場所が分かりません: {e}"))?;
    let dir = server::server_dir(&resource_dir)
        .ok_or_else(|| format!("同梱のサーバが見つかりません: {}", resource_dir.display()))?;
    let dir = accept_server_dir(dir, &resource_dir, cfg!(debug_assertions)).ok_or_else(|| {
        concat!(
            "HANGAR_SERVER_DIR は開発のときだけ効きます。\n",
            "配布版はアプリの中に同梱したサーバだけを使います。"
        )
        .to_string()
    })?;
    server::strip_quarantine(&dir);
    let manifest = node::read_manifest(&dir)?;
    let candidates = node::candidate_paths(&paths::user_home(), hangar_home);
    let node_path = node::choose_node(&candidates, &manifest, node::probe_node)
        .map_err(|e| node::describe_error(&e))?;
    log(&format!(
        "node {} server {}",
        node_path.display(),
        dir.display()
    ));
    let child = server::spawn_server(
        &node_path,
        &dir,
        hangar_home,
        &hangar_home.join("desktop.log"),
    )
    .map_err(|e| format!("サーバを起動できません: {e}"))?;
    log(&format!("server pid {}", child.pid()));
    *app.state::<AppState>().server.lock().unwrap() = Some(child);
    wait_for_server(app, addr, Duration::from_secs(20))
}

/// 子が死んでいたら、状態から外して真を返す。
/// `is_running` の `try_wait` は死んだ子を回収するので、外さずに置いておくと
/// 終了時の `stop()` が回収済みの pid へ信号を送ることになる。
/// その pid は別のプロセスに使い回されうる。
/// 子を持たない枝（既に動いているサーバを採用したとき）では生死を見ない。
fn take_dead_server(app: &AppHandle) -> bool {
    let state = app.state::<AppState>();
    let mut slot = state.server.lock().unwrap();
    let Some(p) = slot.as_mut() else {
        return false;
    };
    if p.is_running() {
        return false;
    }
    *slot = None;
    true
}

/// 同梱サーバが応えるのを待つ。
/// 子が先に死んだときは、残りの時間を待たずに理由を返す。
/// ネイティブモジュールが読めない、ポートが取れないといった即死で 20 秒固まらないためである。
fn wait_for_server(app: &AppHandle, addr: SocketAddr, deadline: Duration) -> Result<(), String> {
    let died = Cell::new(false);
    let t0 = Instant::now();
    let healthy = health::wait_until(
        deadline,
        Duration::from_millis(250),
        || {
            if health::probe_health(addr) {
                return true;
            }
            if take_dead_server(app) {
                died.set(true);
            }
            false
        },
        std::thread::sleep,
        // 子が死んだら経過を締め切りに見せる。待ちの輪はその場で抜ける。
        || {
            if died.get() {
                deadline
            } else {
                t0.elapsed()
            }
        },
    );
    if healthy {
        return Ok(());
    }
    if died.get() {
        return Err(
            "サーバが起動直後に終了しました。~/.agent-hangar/desktop.log を確認してください。"
                .to_string(),
        );
    }
    Err(format!(
        "サーバが {} 秒以内に応答しませんでした。~/.agent-hangar/desktop.log を確認してください。",
        deadline.as_secs()
    ))
}

/// 起動の本体。別スレッドで走り、ウィンドウはその間読み込み画面を出している。
fn boot(app: AppHandle) {
    let hangar_home = paths::hangar_home();
    ensure_hangar_home(&hangar_home);
    let addr: SocketAddr = ([127, 0, 0, 1], server::PORT).into();

    if let Err(msg) = start_server(&app, &hangar_home, addr) {
        return fail(&app, &msg);
    }

    // サーバの `GET /` は鍵かクッキーが無ければ 401 の案内を返す。
    // 新しい webview はクッキーを持たないので、鍵付きの URL で開く。
    let Some(token) = server::read_token(&hangar_home) else {
        return fail(
            &app,
            &format!(
                "入場の鍵が読めません: {}\nサーバが鍵を作れたか ~/.agent-hangar/desktop.log を確認してください。",
                hangar_home.join("token").display()
            ),
        );
    };

    // ウィンドウが取れなければ行き先を変えられない。黙って止まらず、理由を残す。
    let Some(w) = app.get_webview_window("main") else {
        return fail(
            &app,
            "ウィンドウが見つからないので、サーバの画面へ移れません。",
        );
    };

    // 段の切り替えと pending の取り出しは同じロックの下で行い、その隙に届いたリンクを落とさない。
    // ここから読み込みが終わるまでに届くリンクも貯める側へ回り、読み込みの合図で流れる。
    let url = {
        let state = app.state::<AppState>();
        let mut ui = state.ui.lock().unwrap();
        server::entry_url(server::PORT, &token, &ui.navigating())
    };
    // 鍵は URL に載るので、ログには載せない。行き先はハッシュだけを残して書く。
    log("navigating to the server");
    let navigated = tauri::Url::parse(&url)
        .map_err(|e| format!("URL を組み立てられません: {e}"))
        .and_then(|u| w.navigate(u).map_err(|e| format!("{e}")));
    if let Err(e) = navigated {
        // navigate に至らなかったので、読み込み画面がそのまま残る。段を戻してから文言を出す。
        app.state::<AppState>()
            .ui
            .lock()
            .unwrap()
            .navigation_failed();
        // 例外の文言に URL が混じることがある。鍵を伏せてから出す。
        return fail(
            &app,
            &format!(
                "サーバの画面（ポート {}）へ移れません: {}",
                server::PORT,
                redact(&e, &token)
            ),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 読み込み画面が出来上がる前の評価は捨てられることがある。
    // 早すぎる失敗の文言を貯めておき、読み込みが終わった合図で出す。
    #[test]
    fn a_status_from_before_the_load_comes_out_after_it() {
        let mut ui = Ui::default();
        ui.remember_status("同梱のサーバが見つかりません", true);
        let (status, hash) = ui.page_loaded(false);
        assert_eq!(
            status,
            Some(("同梱のサーバが見つかりません".to_string(), true))
        );
        assert_eq!(hash, None);
        // 一度出したものは二度出さない。
        assert_eq!(ui.page_loaded(false).0, None);
        // 読み込みが済んだ後の文言は、その場で評価できるので貯めない。
        ui.remember_status("次の文言", false);
        assert_eq!(ui.page_loaded(false).0, None);
    }

    // 起動と同時に届いたリンクは、最初の navigate の URL の末尾に載せる。
    #[test]
    fn the_first_hash_rides_on_the_entry_url() {
        let mut ui = Ui::default();
        ui.page_loaded(false);
        assert_eq!(ui.hash_to_eval("#/session/1".to_string()), None);
        assert_eq!(ui.navigating(), "#/session/1");
        // 取り出した後は残さない。
        assert_eq!(ui.page_loaded(true).1, None);
    }

    // ready を立ててから読み込みが終わるまでの窓で届いたリンクも落とさない。
    #[test]
    fn a_hash_arriving_while_navigating_is_flushed_after_the_load() {
        let mut ui = Ui::default();
        ui.page_loaded(false);
        assert_eq!(ui.navigating(), "");
        assert_eq!(ui.hash_to_eval("#/session/2".to_string()), None);
        let (status, hash) = ui.page_loaded(true);
        assert_eq!(hash, Some("#/session/2".to_string()));
        assert_eq!(status, None);
        // サーバの頁が出来た後は、その場で評価する。
        assert_eq!(
            ui.hash_to_eval("#/project/3".to_string()),
            Some("#/project/3".to_string())
        );
    }

    // navigate に至らなかったときは読み込み画面がそのまま残る。
    // 失敗の文言はその場で評価できるので、貯めない。
    #[test]
    fn a_failed_navigation_puts_the_loading_page_back() {
        let mut ui = Ui::default();
        ui.page_loaded(false);
        ui.navigating();
        ui.navigation_failed();
        ui.remember_status("行き先を組み立てられません", true);
        assert_eq!(ui.page_loaded(false).0, None);
        // ready は降りているので、次のリンクは貯める側へ回る。
        assert_eq!(ui.hash_to_eval("#/session/4".to_string()), None);
    }

    // サーバの頁へ移った後は、貯めた文言を流さない。UI の DOM を書き換えないためである。
    #[test]
    fn a_stale_status_never_reaches_the_server_page() {
        let mut ui = Ui::default();
        ui.remember_status("サーバを起動しています", false);
        ui.navigating();
        assert_eq!(ui.page_loaded(true).0, None);
    }

    // 段に合わない読み込みの合図は無視する。
    // navigate を出した後に読み込み画面の側の合図が遅れて届いても、
    // 貯めたハッシュを消えていく頁へ流さない。
    #[test]
    fn a_load_signal_from_the_wrong_page_changes_nothing() {
        let mut ui = Ui::default();
        ui.page_loaded(false);
        ui.navigating();
        assert_eq!(ui.hash_to_eval("#/session/5".to_string()), None);
        // 読み込み画面の側の遅れた合図。
        assert_eq!(ui.page_loaded(false), (None, None));
        // サーバの頁の合図でだけ流れる。
        assert_eq!(ui.page_loaded(true).1, Some("#/session/5".to_string()));
    }

    #[test]
    fn the_server_page_is_recognised_by_host_and_port() {
        let server = url::Url::parse("http://127.0.0.1:4177/?t=abc#/session/1").unwrap();
        let loading = url::Url::parse("tauri://localhost/index.html").unwrap();
        assert!(is_server_page(&server));
        assert!(!is_server_page(&loading));
        assert!(!is_server_page(
            &url::Url::parse("http://127.0.0.1:5173/").unwrap()
        ));
        assert!(!is_server_page(
            &url::Url::parse("http://example.com:4177/").unwrap()
        ));
    }

    #[test]
    fn redact_hides_the_token_anywhere_in_the_text() {
        assert_eq!(
            redact("url http://x/?t=abc123 が開けません", "abc123"),
            "url http://x/?t=*** が開けません"
        );
        assert_eq!(redact("abc", ""), "abc");
    }

    // データの置き場所は 0700 で作る。
    // 中の hangar.db と desktop.log は 0644 なので、ここが緩いと同じ機械の別の利用者に全セッションの記録が読める。
    // 既に 0755 で作られている手元も、起動のたびに直す。
    #[test]
    fn the_data_dir_is_created_private_and_tightened_every_time() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("nested/.agent-hangar");
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        ensure_hangar_home(&home);
        assert_eq!(mode(&home), 0o700, "作るときに 0700 になっていない");
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_hangar_home(&home);
        assert_eq!(mode(&home), 0o700, "既にある 0755 を直していない");
        // 利用者がより厳しくした権限は緩めない。
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o500)).unwrap();
        ensure_hangar_home(&home);
        assert_eq!(mode(&home), 0o500);
    }

    // HANGAR_SERVER_DIR による差し替えは開発のときだけ効かせる。
    // 配布版でこれを認めると、環境変数を書ける相手が任意の木を指させられる。
    // その木には strip_quarantine が xattr -rd を再帰で掛け、中の JavaScript が Node で走る。
    #[test]
    fn a_server_dir_outside_the_resources_is_only_taken_in_development() {
        let res = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let bundled = res.path().join("server");
        std::fs::create_dir_all(&bundled).unwrap();
        // 同梱の置き場所は配布版でもそのまま使う。
        assert_eq!(
            accept_server_dir(bundled.clone(), res.path(), false),
            Some(bundled.clone())
        );
        // リソースの外は配布版では受け取らない。開発では受け取る。
        let out = outside.path().to_path_buf();
        assert_eq!(accept_server_dir(out.clone(), res.path(), false), None);
        assert_eq!(
            accept_server_dir(out.clone(), res.path(), true),
            Some(out.clone())
        );
        // `..` を挟んで字面だけ中に見える形も、実体の場所で見分ける。
        let sibling = res.path().join("..").join(out.file_name().unwrap());
        assert!(sibling.starts_with(res.path()), "字面では中に見えるはず");
        assert_eq!(accept_server_dir(sibling.clone(), res.path(), false), None);
        assert_eq!(
            accept_server_dir(sibling.clone(), res.path(), true),
            Some(sibling)
        );
    }

    // 届いた URL は形の検査より前にログへ行く。
    // 長さに上限を置き、同じ機械の誰かが何度も投げてログを太らせられないようにする。
    #[test]
    fn a_long_deep_link_is_cut_before_it_reaches_the_log() {
        let short = "hangar://session/42";
        assert_eq!(url_for_log(short), short);
        let long = format!("hangar://search?q={}", "あ".repeat(4000));
        let cut = url_for_log(&long);
        assert!(cut.len() <= LOG_URL_MAX + 40, "{}", cut.len());
        assert!(cut.starts_with("hangar://search?q="));
        // 切ったことと元の長さが分かるようにする。
        assert!(cut.contains(&long.len().to_string()), "{cut}");
        // 多バイト文字の途中では切らない。
        assert!(cut.chars().all(|c| c != '\u{fffd}'));
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .manage(AppState {
            server: Mutex::new(None),
            ui: Mutex::new(Ui::default()),
        })
        // 頁の読み込みが終わる前の評価は捨てられることがある。
        // 出しそこねた文言と、navigate の最中に届いたリンクをここで流す。
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                page_loaded(webview.app_handle(), is_server_page(payload.url()));
            }
        })
        .setup(|app| {
            log("setup");
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                handle_urls(&handle, &event.urls());
            });
            // 起動そのものがディープリンクで起きた場合、`on_open_url` より前に URL が届いていることがある。
            // 公式の手順どおり `get_current` でも拾う。同じ URL を二度扱っても行き先は変わらない。
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                handle_urls(app.handle(), &urls);
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || boot(handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut p) = app.state::<AppState>().server.lock().unwrap().take() {
                    p.stop();
                    log("server stopped");
                }
            }
        });
}
