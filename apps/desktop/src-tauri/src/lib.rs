//! agent-hangar のデスクトップシェル。
//! 起動時に同梱サーバを子プロセスとして立て、`/health` が通ったらウィンドウをサーバの URL へ移す。
//! `hangar://` のディープリンクは UI のハッシュ経路に変換して webview に流す。

pub mod bootfail;
pub mod configapply;
pub mod deeplink;
pub mod filedrop;
pub mod health;
pub mod logfile;
pub mod node;
pub mod notify;
pub mod paths;
pub mod server;

use std::cell::Cell;
use std::io::Write;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_deep_link::DeepLinkExt;

/// アプリ全体で共有する状態。
struct AppState {
    server: Mutex<Option<server::ServerProcess>>,
    ui: Mutex<Ui>,
    /// 起動の本体（`boot`）が走っているか。「もう一度試す」を連打しても、二つ目の起動を重ねない。
    booting: AtomicBool,
    /// 今の子を起こす直前の時刻。子が死んだとき、`boot-error.json` がこの子のものかを更新の時刻で見分ける。
    /// 子を起こさずに既存のサーバを採ったときは、前の値のまま使わない（その経路では子の死を見ない）。
    child_started: Mutex<Option<SystemTime>>,
    /// 設定の同期の確認（適用、世代へ戻す）が出ているか。頁から続けて呼ばれても、確認を重ねて出さない。
    config_busy: AtomicBool,
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
    /// 読み込みの前に届いた失敗の式（`bootfail::fail_js`）。読み込みの合図で流す。
    pending_failure: Option<String>,
    /// 読み込み画面の load の合図が届いた時刻。起動画面の動きの時計も同じ合図から数える。
    loading_since: Option<Instant>,
    /// 最後に起動画面へ渡した進み具合の式。
    /// 殻は変わったときだけ渡すので、読み込みの前に渡して捨てられた分を、読み込みの合図で渡し直す。
    last_progress: Option<String>,
}

impl Ui {
    /// 読み込みの前に出す失敗を控える。
    /// 読み込みが済んでいれば、呼び出し側がその場で評価できるので控えない。
    fn remember_failure(&mut self, js: &str) {
        if !self.loaded {
            self.pending_failure = Some(js.to_string());
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

    /// 頁の読み込みが終わった。今流してよい失敗の式とハッシュを返す。
    /// 失敗は読み込み画面のものだけ、ハッシュはサーバの頁のものだけを流す。
    /// 段に合わない合図（navigate の後に届く読み込み画面の側の合図など）は何もしない。
    /// 消えていく頁へ流すと、そのハッシュはそのまま失われるからである。
    /// 読み込み画面の読み込みが終わったときに渡し直す進み具合。サーバの頁へ移った後は渡さない。
    fn progress_to_replay(&self, server_page: bool) -> Option<String> {
        if server_page || self.ready {
            return None;
        }
        self.last_progress.clone()
    }

    /// 起動に失敗した後の「もう一度試す」。
    /// サーバの頁へ移った後はやり直さないので偽を返す。
    /// やり直すときは、殻が読み込み画面を読み込み直すので、読み込みの合図まで文言を貯める側へ戻す。
    /// 前の失敗と進み具合は、新しい頁へ持ち込まない。
    fn retry(&mut self) -> bool {
        if self.ready {
            return false;
        }
        self.loaded = false;
        self.pending_failure = None;
        self.last_progress = None;
        true
    }

    fn page_loaded(&mut self, server_page: bool) -> (Option<String>, Option<String>) {
        if self.ready != server_page {
            return (None, None);
        }
        self.loaded = true;
        if self.ready {
            (None, self.pending_hash.take())
        } else {
            (self.pending_failure.take(), None)
        }
    }
}

/// 準備ができたら、起動画面に読み込みが終わった合図を打たせる式（loading/boot.js の __hangarBootFinish）。
/// 起動画面は周のどこからでも合図に入れるので、周の境目は待たない。
/// 合図の後、起動画面は UI の背景の光を画面いっぱいに満たし、UI はその光の上から始まる。
/// 決まった文字列だけを評価し、入場の鍵や行き先の URL は決して混ぜない。
const BOOT_FINISH_JS: &str = "window.__hangarBootFinish && window.__hangarBootFinish()";

/// 合図を打ち始めてから光が満ち切るまで（ミリ秒）。loading/boot-frames.js の FINISH_MS と揃える（config.test.ts が突き合わせる）。
/// これより早く移ると、光が満ちる途中の絵のまま画面が替わる。
const BOOT_FINISH_MS: u64 = 900;
// 合図と光を待つ分、起動は遅くなる。待ちは 1 秒に収める。
const _: () = assert!(BOOT_FINISH_MS <= 1000);

/// 最初の索引づけが済むのを待つ間の問い合わせの間隔。
const READY_POLL: Duration = Duration::from_millis(100);
/// 最初の索引づけを待つ上限。過ぎても失敗にはせず、済んでいないまま画面を移す（UI のヘッダが続きを出す）。
/// 空の DB から 987 件を索引づけると 17.7 秒かかった（2026-09-30 の実測）。履歴がその数倍あっても収まる長さにする。
const READY_DEADLINE: Duration = Duration::from_secs(120);

/// 起動画面に索引の進み具合を渡す式（loading/boot.js の __hangarBootProgress）。
/// 段階は決まった名前、数は整数だけを埋める。サーバが返した文字列は混ぜない。
fn progress_js(b: &health::Boot) -> String {
    format!(
        "window.__hangarBootProgress && window.__hangarBootProgress({{\"phase\":\"{}\",\"done\":{},\"total\":{}}})",
        b.phase.as_str(),
        b.done,
        b.total
    )
}

/// 応答が途切れたまま、これだけ経ったら諦める。
const UNRESPONSIVE_AFTER: Duration = Duration::from_secs(10);

/// 最初の索引づけを待った結果。
#[derive(Debug, PartialEq, Eq)]
enum ReadyWait {
    Ready,
    /// 上限まで待っても済まなかった。済まないまま移ってよい。
    TimedOut,
    /// 待っている間に子が終わった。
    Died,
    /// 子は生きているが、応答が途切れたまま戻らない。
    Unresponsive,
}

/// 最初の索引づけを待つ長さ。
#[derive(Debug, Clone, Copy)]
struct ReadyLimits {
    /// 待つ上限。
    deadline: Duration,
    /// 応答が途切れたまま、これだけ経ったら諦める。
    unresponsive: Duration,
    /// 問い合わせの間隔。
    interval: Duration,
}

/// `wait_for_ready` の本体。問い合わせ、子の生死、進み具合の渡し先、待ち、時計を差し替えられる。
/// 進み具合は変わったときだけ `report` に渡す。
fn wait_ready_with(
    limits: ReadyLimits,
    mut probe: impl FnMut() -> Option<health::Boot>,
    mut dead: impl FnMut() -> bool,
    mut report: impl FnMut(&health::Boot),
    mut sleep: impl FnMut(Duration),
    mut elapsed: impl FnMut() -> Duration,
) -> ReadyWait {
    // 進まない時計を渡されても必ず終わるための歯止め。
    let ReadyLimits {
        deadline,
        unresponsive,
        interval,
    } = limits;
    let cap = if interval.is_zero() {
        1
    } else {
        (deadline.as_nanos() / interval.as_nanos()).min(1_000_000) as u32 + 2
    };
    let mut last: Option<health::Boot> = None;
    let mut lost_since: Option<Duration> = None;
    for _ in 0..cap {
        let now = elapsed();
        match probe() {
            Some(b) => {
                lost_since = None;
                if last != Some(b) {
                    report(&b);
                    last = Some(b);
                }
                if b.ready {
                    return ReadyWait::Ready;
                }
            }
            None => {
                if dead() {
                    return ReadyWait::Died;
                }
                let since = *lost_since.get_or_insert(now);
                if now.saturating_sub(since) >= unresponsive {
                    return ReadyWait::Unresponsive;
                }
            }
        }
        if elapsed() >= deadline {
            return ReadyWait::TimedOut;
        }
        sleep(interval);
    }
    ReadyWait::TimedOut
}

/// 最初の索引づけと紐づけが済むまで待ち、その間の進み具合を起動画面へ渡す。
/// サーバは索引づけより先に待ち受けを始めるので、`/health` が返った時点ではまだ済んでいないことがある。
/// 済む前に移ると、UI は索引づけの間 API の応答を待たされる（100 件溜まっていたとき最大 1.4 秒、2026-09-30 の実測）。
/// ふだんは 0.2 秒で済むので、起動はほとんど長くならない。
/// 待つ間に子が終わったか、応答が途切れたまま戻らなければ、落ちたサーバへ移らず失敗の札を出す。
fn wait_for_ready(
    app: &AppHandle,
    addr: SocketAddr,
    home: &std::path::Path,
    deadline: Duration,
) -> Result<(), bootfail::BootFailure> {
    let t0 = Instant::now();
    let outcome = wait_ready_with(
        ReadyLimits {
            deadline,
            unresponsive: UNRESPONSIVE_AFTER,
            interval: READY_POLL,
        },
        || health::probe_boot(addr),
        || take_dead_server(app),
        |b| {
            let js = progress_js(b);
            app.state::<AppState>().ui.lock().unwrap().last_progress = Some(js.clone());
            eval_main(app, &js);
        },
        std::thread::sleep,
        || t0.elapsed(),
    );
    match outcome {
        ReadyWait::Ready => Ok(()),
        ReadyWait::TimedOut => {
            log("moving on before the first index finished");
            Ok(())
        }
        ReadyWait::Died => Err(server_died(app, home)),
        ReadyWait::Unresponsive => Err(bootfail::BootFailure::other(format!(
            "サーバが {} 秒応答しません。~/.agent-hangar/desktop.log を確認してください。",
            UNRESPONSIVE_AFTER.as_secs()
        ))),
    }
}

/// 画面を移した後も子の生死を見て、勝手に終わったらその終わり方をログに残す。
/// アプリが起動から数秒で終わる件を、アプリが閉じたのかサーバが落ちたのかで切り分けるためである。
/// 終了の手続きで止めた子は、先に状態から外されるので、ここでは拾わない。
fn watch_server(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let state = app.state::<AppState>();
        let mut slot = state.server.lock().unwrap();
        let Some(p) = slot.as_mut() else {
            return;
        };
        if let Some(status) = p.exit_status() {
            log(&format!("server exited on its own ({status})"));
            *slot = None;
            return;
        }
    });
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
#[cfg(unix)]
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

/// Windows には 0700 に当たるモードが無い。
/// 利用者のプロフィールの下に作れば、既定の ACL で他の利用者からは読めないので、作るだけにする。
#[cfg(not(unix))]
fn ensure_hangar_home(home: &std::path::Path) {
    let _ = std::fs::create_dir_all(home);
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

fn eval_main(app: &AppHandle, js: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(js);
    }
}

/// 失敗の札の材料のうち、失敗の種類によらないもの。頁の言語、アプリの版、OS、置き場の名前である。
/// 置き場の名前は、利用者のホームを `~` に縮めて渡す（札の文に、ユーザー名の入ったパスを出さない）。
fn boot_env(app: &AppHandle, home: &std::path::Path) -> bootfail::Env {
    bootfail::Env {
        lang: bootfail::page_language(home),
        version: app.package_info().version.to_string(),
        os: bootfail::os_label(),
        home: bootfail::tilde(&home.to_string_lossy(), &paths::user_home()),
    }
}

/// ログに残す失敗の 1 行。詳細は長いことがあるので、最初の行だけを丸めて載せる。
fn failure_log_line(f: &bootfail::BootFailure) -> String {
    let first: String = f
        .detail
        .lines()
        .next()
        .unwrap_or("")
        .chars()
        .take(300)
        .collect();
    format!("boot failed ({}): {first}", f.kind)
}

/// 起動の失敗を札で出す。サーバへ移る前だけ意味を持つ。
/// 読み込みが終わる前の評価は捨てられることがあるので、そのときは式を控えて読み込みの合図でもう一度流す。
/// 控えるときも評価自体は試す。
/// 読み込みの合図が来ない作りに変わっても、今までの見え方を下回らないためである。
/// 詳細に入場の鍵が混じっていたら、頁へ渡す前に伏せる。
fn fail(app: &AppHandle, failure: bootfail::BootFailure) {
    let home = paths::hangar_home();
    let failure = match server::read_token(&home) {
        Some(token) => failure.map_text(|s| redact(s, &token)),
        None => failure,
    };
    log(&failure_log_line(&failure));
    let js = bootfail::fail_js(&failure, &boot_env(app, &home));
    {
        let state = app.state::<AppState>();
        state.ui.lock().unwrap().remember_failure(&js);
    }
    eval_main(app, &js);
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
            let _ = w.eval(deeplink::hash_to_js(&h));
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
    let (failure, hash, replay) = {
        let state = app.state::<AppState>();
        let mut ui = state.ui.lock().unwrap();
        // 読み込み画面の最初の load だけを時計の起点にする。
        if !server_page && ui.loading_since.is_none() {
            ui.loading_since = Some(Instant::now());
        }
        let replay = ui.progress_to_replay(server_page);
        let (failure, hash) = ui.page_loaded(server_page);
        (failure, hash, replay)
    };
    if let Some(js) = replay {
        eval_main(app, &js);
    }
    if let Some(js) = failure {
        eval_main(app, &js);
    }
    if let Some(h) = hash {
        eval_main(app, &deeplink::hash_to_js(&h));
    }
    // 位相を読めるのはこの殻の中だけである。画面はこの印を見て、時間で当てずっぽうに決めるのをやめる。
    // 殻の中であることの印も同じ時に付ける。画面はこれを見て、信号の 3 点の分だけサイドバーの上を空ける。
    if server_page && cfg!(target_os = "macos") {
        eval_main(app, "window.__hangarPhaseAware = true");
        eval_main(app, "document.documentElement.dataset.shell = 'desktop'");
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

/// 同梱のサーバの置き場と、それを走らせる Node を決める。
/// サーバを起こすときと、設定の同期の命令（CLI の cli.mjs は同じ置き場にある）が使う。
fn bundled_node_and_dir(
    app: &AppHandle,
    hangar_home: &std::path::Path,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
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
    Ok((node_path, dir))
}

/// 同梱サーバを起こす。成功したら `Ok(())`。
/// 既に 4177 で互換の版の合う hangar が動いていれば、子は起こさずそれを使う。
/// 版の合わない hangar が動いていれば、採らずに理由を返す（そのサーバは止めない）。
fn start_server(
    app: &AppHandle,
    hangar_home: &std::path::Path,
    addr: SocketAddr,
) -> Result<(), bootfail::BootFailure> {
    match health::probe_existing(addr, health::COMPAT_VERSION) {
        health::Existing::Adopt => {
            // hangar start などで既にサーバがいる。子は起こさず、そのサーバを使う。
            log("adopting the server already listening on 4177");
            return Ok(());
        }
        health::Existing::Mismatch { theirs } => {
            log(&format!(
                "refusing the server on 4177 (compat {theirs}, ours {})",
                health::COMPAT_VERSION
            ));
            // 札の文は頁の表が持つ（loading/boot-fail.js）。殻は版の数とポートだけを渡す。
            return Err(bootfail::BootFailure::compat_mismatch(
                addr.port(),
                theirs,
                health::COMPAT_VERSION,
            ));
        }
        health::Existing::Absent => {}
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
            .to_string()
            .into());
        }
    }
    let (node_path, dir) = bundled_node_and_dir(app, hangar_home)?;
    log(&format!(
        "node {} server {}",
        node_path.display(),
        dir.display()
    ));
    // 子を起こす直前の時刻を控える。サーバは起動の先頭で古い boot-error.json を消し、失敗したら書き直す。
    // 子の死を見たとき、これより古いファイルは前の起動のものとして捨てる。
    *app.state::<AppState>().child_started.lock().unwrap() = Some(SystemTime::now());
    let child = server::spawn_server(
        &node_path,
        &dir,
        hangar_home,
        &hangar_home.join("desktop.log"),
    )
    .map_err(|e| format!("サーバを起動できません: {e}"))?;
    log(&format!("server pid {}", child.pid()));
    *app.state::<AppState>().server.lock().unwrap() = Some(child);
    wait_for_server(app, addr, hangar_home, Duration::from_secs(20))
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
fn wait_for_server(
    app: &AppHandle,
    addr: SocketAddr,
    home: &std::path::Path,
    deadline: Duration,
) -> Result<(), bootfail::BootFailure> {
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
        return Err(server_died(app, home));
    }
    Err(bootfail::BootFailure::other(format!(
        "サーバが {} 秒以内に応答しませんでした。~/.agent-hangar/desktop.log を確認してください。",
        deadline.as_secs()
    )))
}

/// 子のサーバが死んだ失敗。サーバが書いた `boot-error.json` が今の子のものなら、その種類を採る。
/// 読めない、古い、無いときは「サーバが起きない」にし、詳細にはログの終わりの数行を載せる（Node の読み込みの失敗などは、標準エラーにしか出ない）。
fn server_died(app: &AppHandle, home: &std::path::Path) -> bootfail::BootFailure {
    let started = *app.state::<AppState>().child_started.lock().unwrap();
    bootfail::for_dead_server(home, started, || {
        bootfail::log_tail(&home.join("desktop.log"), 20)
    })
}

/// 起動の本体。別スレッドで走り、ウィンドウはその間読み込み画面を出している。
fn boot(app: AppHandle) {
    let hangar_home = paths::hangar_home();
    ensure_hangar_home(&hangar_home);
    let addr: SocketAddr = ([127, 0, 0, 1], server::PORT).into();

    if let Err(failure) = start_server(&app, &hangar_home, addr) {
        return fail(&app, failure);
    }
    if let Err(failure) = wait_for_ready(&app, addr, &hangar_home, READY_DEADLINE) {
        return fail(&app, failure);
    }

    // サーバの `GET /` は鍵かクッキーが無ければ 401 の案内を返す。
    // 新しい webview はクッキーを持たないので、鍵付きの URL で開く。
    let Some(token) = server::read_token(&hangar_home) else {
        return fail(
            &app,
            bootfail::BootFailure::other(format!(
                "入場の鍵が読めません: {}\nサーバが鍵を作れたか ~/.agent-hangar/desktop.log を確認してください。",
                hangar_home.join("token").display()
            )),
        );
    };

    // ウィンドウが取れなければ行き先を変えられない。黙って止まらず、理由を残す。
    let Some(w) = app.get_webview_window("main") else {
        let msg = "ウィンドウが見つからないので、サーバの画面へ移れません。";
        return fail(&app, bootfail::BootFailure::other(msg));
    };

    // 読み込みが終わった合図を打たせ、光が満ち切るまで待ってから移る。起動画面は周のどこからでも合図に入れる。
    // load の合図がまだ来ていなければ、描いている札も無いので、合図も待ちもしない。
    let drawing = app
        .state::<AppState>()
        .ui
        .lock()
        .unwrap()
        .loading_since
        .is_some();
    if drawing {
        eval_main(&app, BOOT_FINISH_JS);
        std::thread::sleep(Duration::from_millis(BOOT_FINISH_MS));
    }

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
        fail(
            &app,
            bootfail::BootFailure::other(format!(
                "サーバの画面（ポート {}）へ移れません: {}",
                server::PORT,
                redact(&e, &token)
            )),
        );
        return;
    }
    watch_server(app);
}

/// 起動の本体を別のスレッドで走らせる。走っている間は二つ目を起こさず、偽を返す。
fn spawn_boot(app: AppHandle) -> bool {
    if app.state::<AppState>().booting.swap(true, Ordering::SeqCst) {
        return false;
    }
    std::thread::spawn(move || {
        boot(app.clone());
        app.state::<AppState>()
            .booting
            .store(false, Ordering::SeqCst);
    });
    true
}

// ここから下の 4 つと、入力待ちの知らせの 3 つ（notify_waiting、notify_request、notify_status）と、設定の同期の 2 つ（apply_config_sync、restore_config_sync）が、頁から呼べる殻の命令である。
// 名前は build.rs の一覧、capabilities、UI（packages/ui/src/runtime/desktop.ts）、起動画面（loading/boot.js）とそろえる。
// pick_folder のほかは引数を受け取らない。開くファイルも、やり直す手順も、殻の側で決まっている。

/// フォルダを 1 つ選ぶ macOS のダイアログを開き、選んだパスを返す。取り消したら None を返す。
/// 新しいセッションのダイアログと、プロジェクトを作るダイアログの「ほかの場所を選ぶ…」が呼ぶ。
/// 既定の場所はワークスペースのルートで、`~/` で始まればホームに展開する。ディレクトリでなければ渡さない。
/// ダイアログは選び終えるまで戻らないので、非同期の実行の糸を塞がないよう spawn_blocking で待つ。
#[tauri::command]
async fn pick_folder(app: AppHandle, default_path: Option<String>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut builder = app.dialog().file();
    if let Some(p) = default_path {
        let expanded = match p.strip_prefix("~/") {
            Some(rest) => std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(rest)),
            None => Some(std::path::PathBuf::from(p)),
        };
        if let Some(dir) = expanded.filter(|d| d.is_dir()) {
            builder = builder.set_directory(dir);
        }
    }
    let picked = tauri::async_runtime::spawn_blocking(move || builder.blocking_pick_folder())
        .await
        .ok()
        .flatten()?;
    picked
        .into_path()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// 設定の同期の確認と、その後の CLI の呼び出しに要るもの。
/// 同梱の Node と cli.mjs の置き場、hangar の置き場の 3 つ。
fn config_runtime(
    app: &AppHandle,
) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
    let home = paths::hangar_home();
    let (node, dir) = bundled_node_and_dir(app, &home)?;
    Ok((node, dir, home))
}

/// ネイティブの確認を出し、承諾されたかを返す。選ぶまで戻らないので、呼び手は別のスレッドで待つ。
/// 実行される内容を含むときは、警告の見た目で出す。
fn confirm_natively(app: &AppHandle, c: &configapply::Confirm) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    app.dialog()
        .message(c.body.clone())
        .title(c.title.clone())
        .kind(if c.warn {
            MessageDialogKind::Warning
        } else {
            MessageDialogKind::Info
        })
        .buttons(MessageDialogButtons::OkCancelCustom(
            c.ok.to_string(),
            c.cancel.to_string(),
        ))
        .blocking_show()
}

/// 失敗を、画面を見ていなくても気付けるよう、ネイティブの確認で知らせる。
fn show_failure(app: &AppHandle, title: &str, message: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    app.dialog()
        .message(message.to_string())
        .title(title.to_string())
        .kind(MessageDialogKind::Error)
        .blocking_show();
}

/// 失敗の結果を作る。指示書がまだ無いだけのとき（none）は、確認を出さずに結果だけを返す。
fn config_failure(app: &AppHandle, title: &str, f: &configapply::Failure) -> configapply::Outcome {
    let outcome = configapply::Outcome::failure(f);
    if outcome.status == "failed" {
        log(&format!("config sync: {} ({})", f.message, f.code));
        show_failure(app, title, &f.message);
    }
    outcome
}

fn config_runtime_failure(app: &AppHandle, title: &str, message: String) -> configapply::Outcome {
    log(&format!("config sync: {message}"));
    show_failure(app, title, &message);
    configapply::Outcome::simple("failed", message)
}

/// 確認が重ならないよう、走っている間は印を立てる。
fn with_config_guard(
    app: &AppHandle,
    run: impl FnOnce() -> configapply::Outcome,
) -> configapply::Outcome {
    let state = app.state::<AppState>();
    if state.config_busy.swap(true, Ordering::SeqCst) {
        return configapply::Outcome::simple("busy", "設定の確認がすでに出ています。");
    }
    let outcome = run();
    state.config_busy.store(false, Ordering::SeqCst);
    outcome
}

fn apply_config_flow(app: &AppHandle) -> configapply::Outcome {
    const TITLE: &str = "設定の適用";
    let (node, dir, home) = match config_runtime(app) {
        Ok(v) => v,
        Err(e) => return config_runtime_failure(app, TITLE, e),
    };
    let run = |args: &[&str]| {
        configapply::run_cli(
            configapply::cli_command(&node, &dir, &home, args),
            configapply::CLI_TIMEOUT,
        )
    };
    // 見立ては CLI に出させる。書くものの数と種類を、殻が自分では数えない。
    let plan_out = match run(&["config", "apply", "--plan", "--json"]) {
        Ok(o) => o,
        Err(e) => return config_runtime_failure(app, TITLE, e),
    };
    let plan = match configapply::parse_reply::<configapply::ApplyPlan>(&plan_out, "plan") {
        Ok(p) => p,
        Err(f) => return config_failure(app, TITLE, &f),
    };
    if !confirm_natively(app, &configapply::apply_confirm(&plan)) {
        log("config sync: apply declined");
        return configapply::Outcome::simple(
            "cancelled",
            "適用しませんでした。指示書はそのまま残しています。",
        );
    }
    // 確認したのと同じ指示書にだけ適用する。確認のあとに選び直されていたら、CLI が断る。
    let order = plan.created_at.to_string();
    let applied = match run(&["config", "apply", "--yes", "--json", "--order", &order]) {
        Ok(o) => o,
        Err(e) => return config_runtime_failure(app, TITLE, e),
    };
    match configapply::parse_reply::<configapply::ApplyResult>(&applied, "result") {
        Ok(r) => {
            log(&format!("config sync: applied ({:?})", r.generation));
            configapply::Outcome::applied(&r)
        }
        Err(f) => config_failure(app, TITLE, &f),
    }
}

fn restore_config_flow(app: &AppHandle, name: &str) -> configapply::Outcome {
    const TITLE: &str = "設定を世代へ戻す";
    // 頁から来る値は、世代の名前の形だけを受け取る。
    if !configapply::valid_generation_name(name) {
        return configapply::Outcome::simple("failed", "世代の名前が正しくありません。");
    }
    let (node, dir, home) = match config_runtime(app) {
        Ok(v) => v,
        Err(e) => return config_runtime_failure(app, TITLE, e),
    };
    let run = |args: &[&str]| {
        configapply::run_cli(
            configapply::cli_command(&node, &dir, &home, args),
            configapply::CLI_TIMEOUT,
        )
    };
    let plan_out = match run(&["config", "restore", name, "--plan", "--json"]) {
        Ok(o) => o,
        Err(e) => return config_runtime_failure(app, TITLE, e),
    };
    let plan = match configapply::parse_reply::<configapply::RestorePlan>(&plan_out, "plan") {
        Ok(p) => p,
        Err(f) => return config_failure(app, TITLE, &f),
    };
    if !confirm_natively(app, &configapply::restore_confirm(&plan)) {
        log("config sync: restore declined");
        return configapply::Outcome::simple("cancelled", "戻しませんでした。");
    }
    let restored = match run(&["config", "restore", name, "--yes", "--json"]) {
        Ok(o) => o,
        Err(e) => return config_runtime_failure(app, TITLE, e),
    };
    match configapply::parse_reply::<configapply::RestoreResult>(&restored, "result") {
        Ok(r) => {
            log(&format!("config sync: restored ({:?})", r.safety));
            configapply::Outcome::restored(&r)
        }
        Err(f) => config_failure(app, TITLE, &f),
    }
}

/// 他の PC から届いて、承諾した設定を適用する。UI の設定の「適用…」が呼ぶ。引数は受け取らない。
/// 適用の指示書（hangar の置き場の claude-config/apply-order.json）を CLI が読み、
/// 件数と種類をネイティブの確認に見せ、承諾されたときだけ、控えを取って書く。サーバは `~/.claude` に書かない。
#[tauri::command]
async fn apply_config_sync(app: AppHandle) -> configapply::Outcome {
    tauri::async_runtime::spawn_blocking(move || {
        with_config_guard(&app, || apply_config_flow(&app))
    })
    .await
    .unwrap_or_else(|_| configapply::Outcome::simple("failed", "設定の適用の処理が止まりました。"))
}

/// 控えの世代へ戻す。UI の設定の「この世代に戻す」が呼ぶ。受け取るのは世代の名前（yyyyMMdd-HHmmss）だけで、形を確かめる。
#[tauri::command]
async fn restore_config_sync(app: AppHandle, name: String) -> configapply::Outcome {
    tauri::async_runtime::spawn_blocking(move || {
        with_config_guard(&app, || restore_config_flow(&app, &name))
    })
    .await
    .unwrap_or_else(|_| configapply::Outcome::simple("failed", "設定を戻す処理が止まりました。"))
}

/// `~/.agent-hangar/desktop.log` を開く。起動画面と、UI の切断の帯の「ログを開く」が呼ぶ。
#[tauri::command]
async fn open_log() -> Result<(), String> {
    let home = paths::hangar_home();
    ensure_hangar_home(&home);
    logfile::open_log(&home).inspect_err(|e| log(&format!("open log failed: {e}")))
}

/// アプリを再起動する。UI の切断の帯の「再起動」が呼ぶ。
/// 終了の手続き（`RunEvent::Exit`）を通るので、子のサーバも止めてから起き直す。
#[tauri::command]
fn restart_app(app: AppHandle) {
    log("restart requested from the UI");
    app.request_restart();
}

/// 起動をやり直す。起動画面の「もう一度試す」が呼ぶ。
/// 残っている子のサーバを止めてから、読み込み画面を読み込み直し、起動の本体をもう一度走らせる。
/// 応答しないまま生きている子がポートを握っていると、やり直しても同じところで止まるからである。
#[tauri::command]
async fn retry_boot(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state.booting.load(Ordering::SeqCst) {
        return Ok(());
    }
    if !state.ui.lock().unwrap().retry() {
        return Err("もう起動しています".to_string());
    }
    let previous = state.server.lock().unwrap().take();
    if let Some(mut p) = previous {
        p.stop();
        log("stopped the previous server before retrying");
    }
    log("retrying the boot");
    eval_main(&app, "location.reload()");
    spawn_boot(app.clone());
    Ok(())
}

/// トラックパッドの「指が離れた」瞬間を画面へ伝える。
///
/// ホイールの打鍵には指の上げ下げが乗らないので、画面の側だけでは離した時点を当てられない。
/// 速さの落ち込みで当てようとすると、引いている最中に誤って動く（実際にそうなった）。
/// WebKit の手勢が使っているのと同じ NSEvent の位相をここで読み、合図だけを画面へ送る。
///
/// 打鍵そのものは飲み込まず素通しするので、頁の中の横スクロールはそのまま効く。
/// WKWebView 自身の手勢は使わない。あれは前の画面の写しを滑らせる演出まで一式で、演出だけを切る術が無い。
#[cfg(target_os = "macos")]
fn watch_swipe_phase(app: &AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventPhase};
    use std::ptr::NonNull;

    let handle = app.clone();
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let phase = unsafe { event.as_ref().phase() };
        // 触れた時点も知らせる。指を置いたまま止めている間は打鍵が来ないので、
        // これが無いと画面の側は「途切れた」と読んで、離す前に動いてしまう。
        if phase.contains(NSEventPhase::Began) {
            eval_main(
                &handle,
                "window.__hangarSwipeBegin && window.__hangarSwipeBegin()",
            );
        }
        if phase.contains(NSEventPhase::Ended) || phase.contains(NSEventPhase::Cancelled) {
            eval_main(
                &handle,
                "window.__hangarSwipeEnd && window.__hangarSwipeEnd()",
            );
        }
        event.as_ptr()
    });
    // 監視はアプリが終わるまで外さないので、返ってきた印は持ったままにする。
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::ScrollWheel, &block)
    };
    if monitor.is_none() {
        log("swipe phase monitor not installed");
        return;
    }
    std::mem::forget(monitor);
    log("swipe phase monitor installed");
}

#[cfg(not(target_os = "macos"))]
fn watch_swipe_phase(_app: &AppHandle) {}

/// 入力待ちの通知を出す。
/// 頁（UI）が、窓が背面にあるときに呼ぶ。
/// 値は頁から来るので、notify::waiting で確かめてから OS に渡す。
#[tauri::command]
fn notify_waiting(session_id: String, title: String, body: String) -> Result<(), String> {
    let w = notify::waiting(&session_id, &title, &body)?;
    notify::show(&w);
    Ok(())
}

/// 通知の許可を求め、許されたかを返す。
/// 決まっていなければ OS が尋ねる。
/// 利用者が答えるまで待つので、窓の描画を止めないよう別のスレッドで待つ。
#[tauri::command]
async fn notify_request() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        let (tx, rx) = std::sync::mpsc::channel();
        notify::request(move |granted| {
            let _ = tx.send(granted);
        });
        rx.recv_timeout(Duration::from_secs(600)).unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// 通知の許可の状態を返す（granted、denied、undetermined、unsupported）。
/// 尋ねはしないので、OS のダイアログは出ない。
/// 頁はこれを見て、システム設定で切られていれば受け取らないにし、設定に許可の仕方を出す。
#[tauri::command]
async fn notify_status() -> String {
    tauri::async_runtime::spawn_blocking(|| {
        let (tx, rx) = std::sync::mpsc::channel();
        notify::status(move |raw| {
            let _ = tx.send(raw);
        });
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(raw) => notify::status_name(raw),
            Err(_) => "undetermined",
        }
    })
    .await
    .unwrap_or("undetermined")
    .to_string()
}

/// 押された通知のセッションを開く。
/// 窓を前に出し、頁が出来上がっていれば頁の受け口でターミナルにフォーカスして開く。
/// 出来上がる前（押された通知でアプリが起きたときなど）は、ディープリンクと同じくハッシュとして貯める。
fn open_waiting(app: &AppHandle, session_id: &str) {
    log("waiting notification opened");
    let loaded = {
        let state = app.state::<AppState>();
        let ui = state.ui.lock().unwrap();
        ui.ready && ui.loaded
    };
    if !loaded {
        apply_hash(app, format!("#/session/{session_id}"));
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = w.eval(notify::open_js(session_id));
    }
}

/// 殻から届く位置を CSS の px にする。
/// wry は macOS で位置を窓のポイント（CSS の px と同じ）で返し、Tauri はそれを物理の型に包むだけで換算しない。
/// 倍率で割ると半分の位置を指してしまうので、macOS では値をそのまま使う。
fn css_point(
    w: &tauri::WebviewWindow,
    position: tauri::PhysicalPosition<f64>,
) -> tauri::LogicalPosition<f64> {
    if cfg!(target_os = "macos") {
        tauri::LogicalPosition::new(position.x, position.y)
    } else {
        position.to_logical::<f64>(w.scale_factor().unwrap_or(1.0))
    }
}

/// ドラッグが窓の上にある間の位置を UI へ渡す。出たとき（と落としたとき）は None を渡す。
fn file_dragged(app: &AppHandle, position: Option<tauri::PhysicalPosition<f64>>) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let over = position.map(|p| {
        let at = css_point(&w, p);
        (at.x, at.y)
    });
    let _ = w.eval(filedrop::drag_js(over));
}

/// 窓に落とされたファイルを drops/ に写し、写した先を落とした位置と一緒に UI へ渡す。
/// 写すのは別のスレッドで行い、窓の描画を止めない。
fn file_dropped(
    app: &AppHandle,
    paths: Vec<std::path::PathBuf>,
    position: tauri::PhysicalPosition<f64>,
) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let at = css_point(&w, position);
    let size = w
        .inner_size()
        .ok()
        .map(|s| s.to_logical::<f64>(w.scale_factor().unwrap_or(1.0)));
    std::thread::spawn(move || {
        let dir = paths::hangar_home().join("drops");
        filedrop::prune(&dir, std::time::SystemTime::now(), filedrop::KEEP_FOR);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let out = filedrop::stash(&paths, &dir, stamp);
        let copied = out.iter().filter(|p| p.starts_with(&dir)).count();
        log(&format!(
            "file drop: {} item(s), {copied} copied, at ({:.0}, {:.0}) in {:?}",
            out.len(),
            at.x,
            at.y,
            size.map(|s| (s.width.round(), s.height.round()))
        ));
        let _ = w.eval(filedrop::drop_js(&out, at.x, at.y));
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            server: Mutex::new(None),
            ui: Mutex::new(Ui::default()),
            booting: AtomicBool::new(false),
            child_started: Mutex::new(None),
            config_busy: AtomicBool::new(false),
        })
        // 頁から呼べる殻の命令は、この 1 か所でまとめて登録する。
        // invoke_handler を 2 度呼ぶと後のものだけが残り、先に並べた命令が呼べなくなる。
        // 頁ごとに許す命令は capabilities/ の remote-shell.json、remote-notify.json、remote-pick-folder.json、boot-screen.json で絞る。
        .invoke_handler(tauri::generate_handler![
            open_log,
            pick_folder,
            restart_app,
            retry_boot,
            notify_waiting,
            notify_request,
            notify_status,
            apply_config_sync,
            restore_config_sync
        ])
        // 頁の読み込みが終わる前の評価は捨てられることがある。
        // 出しそこねた文言と、navigate の最中に届いたリンクをここで流す。
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                page_loaded(webview.app_handle(), is_server_page(payload.url()));
            }
        })
        .setup(|app| {
            log("setup");
            watch_swipe_phase(app.handle());
            // 押された通知でアプリが起きたときも受け取れるよう、窓を動かす前に付ける。
            let handle = app.handle().clone();
            notify::install(move |id| open_waiting(&handle, &id));
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                handle_urls(&handle, &event.urls());
            });
            // 起動そのものがディープリンクで起きた場合、`on_open_url` より前に URL が届いていることがある。
            // 公式の手順どおり `get_current` でも拾う。同じ URL を二度扱っても行き先は変わらない。
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                handle_urls(app.handle(), &urls);
            }
            spawn_boot(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // 終わったきっかけを 1 行ずつ残す。起動から数秒で終わる件を、ログだけで切り分けられるようにする。
        // 窓を閉じたときは close requested の後に exit requested が続き、⌘Q では exit requested だけが出る。
        .run(|app, event| match event {
            RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { .. },
                ..
            } => log(&format!("window {label} close requested")),
            RunEvent::WindowEvent {
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Enter { position, .. }),
                ..
            } => file_dragged(app, Some(position)),
            RunEvent::WindowEvent {
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Over { position }),
                ..
            } => file_dragged(app, Some(position)),
            RunEvent::WindowEvent {
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Leave),
                ..
            } => file_dragged(app, None),
            RunEvent::WindowEvent {
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }),
                ..
            } => {
                // 写している間も色は戻す。落とし先への添付は、写し終わってから hangar:drop で届く。
                file_dragged(app, None);
                file_dropped(app, paths, position)
            }
            RunEvent::ExitRequested { code, .. } => log(&match code {
                None => "exit requested by the user".to_string(),
                Some(c) => format!("exit requested with code {c}"),
            }),
            RunEvent::Exit => {
                if let Some(mut p) = app.state::<AppState>().server.lock().unwrap().take() {
                    p.stop();
                    log("server stopped");
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    // 読み込み画面が出来上がる前の評価は捨てられることがある。
    // 早すぎる失敗の文言を貯めておき、読み込みが終わった合図で出す。
    #[test]
    fn a_failure_from_before_the_load_comes_out_after_it() {
        let mut ui = Ui::default();
        ui.remember_failure("fail-js-1");
        let (failure, hash) = ui.page_loaded(false);
        assert_eq!(failure, Some("fail-js-1".to_string()));
        assert_eq!(hash, None);
        // 一度出したものは二度出さない。
        assert_eq!(ui.page_loaded(false).0, None);
        // 読み込みが済んだ後の失敗は、その場で評価できるので貯めない。
        ui.remember_failure("fail-js-2");
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
        let (failure, hash) = ui.page_loaded(true);
        assert_eq!(hash, Some("#/session/2".to_string()));
        assert_eq!(failure, None);
        // サーバの頁が出来た後は、その場で評価する。
        assert_eq!(
            ui.hash_to_eval("#/project/3".to_string()),
            Some("#/project/3".to_string())
        );
    }

    // navigate に至らなかったときは読み込み画面がそのまま残る。
    // 失敗はその場で評価できるので、貯めない。
    #[test]
    fn a_failed_navigation_puts_the_loading_page_back() {
        let mut ui = Ui::default();
        ui.page_loaded(false);
        ui.navigating();
        ui.navigation_failed();
        ui.remember_failure("fail-js");
        assert_eq!(ui.page_loaded(false).0, None);
        // ready は降りているので、次のリンクは貯める側へ回る。
        assert_eq!(ui.hash_to_eval("#/session/4".to_string()), None);
    }

    // サーバの頁へ移った後は、貯めた失敗を流さない。UI の DOM を書き換えないためである。
    #[test]
    fn a_stale_failure_never_reaches_the_server_page() {
        let mut ui = Ui::default();
        ui.remember_failure("fail-js");
        ui.navigating();
        assert_eq!(ui.page_loaded(true).0, None);
    }

    // 起動に失敗した後の「もう一度試す」。殻は読み込み画面を読み込み直してから起動をやり直す。
    // 読み込み直しの最中に出た失敗は捨てられうるので、読み込みの合図まで貯める側へ戻す。
    // 前の失敗と進み具合は、新しい頁へ持ち込まない。
    #[test]
    fn a_retry_reloads_the_loading_page_and_holds_new_failures_for_it() {
        let mut ui = Ui::default();
        ui.page_loaded(false);
        ui.last_progress = Some("progress".to_string());
        assert!(ui.retry());
        assert_eq!(ui.progress_to_replay(false), None);
        ui.remember_failure("fail-js-after-retry");
        assert_eq!(
            ui.page_loaded(false).0,
            Some("fail-js-after-retry".to_string())
        );
    }

    // サーバの頁へ移った後は、やり直さない。
    #[test]
    fn a_retry_after_the_server_page_is_refused() {
        let mut ui = Ui::default();
        ui.page_loaded(false);
        ui.navigating();
        assert!(!ui.retry());
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
    #[cfg(unix)]
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

    fn boot(ready: bool, done: u64) -> health::Boot {
        health::Boot {
            ready,
            phase: health::Phase::Indexing,
            done,
            total: 9,
        }
    }

    /// 偽の時計で wait_ready_with を回す。probe は呼ばれた順に答えを返し、尽きたら最後の答えを繰り返す。
    fn run_wait(
        answers: Vec<Option<health::Boot>>,
        dead_after: Option<usize>,
    ) -> (ReadyWait, Vec<health::Boot>, Duration) {
        let clock = std::cell::Cell::new(Duration::ZERO);
        let calls = std::cell::Cell::new(0usize);
        let mut reported = Vec::new();
        let outcome = wait_ready_with(
            ReadyLimits {
                deadline: Duration::from_secs(120),
                unresponsive: Duration::from_secs(10),
                interval: Duration::from_millis(100),
            },
            || {
                let i = calls.get();
                calls.set(i + 1);
                answers[i.min(answers.len() - 1)]
            },
            || dead_after.is_some_and(|n| calls.get() > n),
            |b| reported.push(*b),
            |d| clock.set(clock.get() + d),
            || clock.get(),
        );
        (outcome, reported, clock.get())
    }

    // 索引づけが済むまで待ち、進み具合は変わったときだけ渡す。
    #[test]
    fn waiting_for_ready_reports_each_change_once_and_stops_when_ready() {
        let (outcome, reported, _) = run_wait(
            vec![
                Some(boot(false, 1)),
                Some(boot(false, 1)),
                Some(boot(false, 5)),
                Some(boot(true, 9)),
            ],
            None,
        );
        assert_eq!(outcome, ReadyWait::Ready);
        assert_eq!(
            reported,
            vec![boot(false, 1), boot(false, 5), boot(true, 9)]
        );
    }

    // 待つ間に子が終わったら、落ちたサーバへ移らず、失敗として返す。
    #[test]
    fn waiting_for_ready_gives_up_when_the_server_dies() {
        let (outcome, _, waited) = run_wait(vec![Some(boot(false, 1)), None], Some(1));
        assert_eq!(outcome, ReadyWait::Died);
        assert!(waited < Duration::from_secs(1), "{waited:?}");
    }

    // 子は生きていても、応答が途切れたまま戻らなければ諦める。一度だけの途切れでは諦めない。
    #[test]
    fn waiting_for_ready_gives_up_when_the_server_stops_answering() {
        let (outcome, _, waited) = run_wait(vec![Some(boot(false, 1)), None], None);
        assert_eq!(outcome, ReadyWait::Unresponsive);
        assert!(
            waited >= Duration::from_secs(10) && waited < Duration::from_secs(11),
            "{waited:?}"
        );
        let (outcome, _, _) = run_wait(vec![Some(boot(false, 1)), None, Some(boot(true, 9))], None);
        assert_eq!(outcome, ReadyWait::Ready);
    }

    // 上限まで済まなければ、済まないまま移ってよいと返す。
    #[test]
    fn waiting_for_ready_moves_on_at_the_deadline() {
        let (outcome, _, waited) = run_wait(vec![Some(boot(false, 1))], None);
        assert_eq!(outcome, ReadyWait::TimedOut);
        assert!(
            waited >= Duration::from_secs(120) && waited < Duration::from_secs(121),
            "{waited:?}"
        );
    }

    // 読み込みの前に渡した進み具合は捨てられることがある。読み込み画面の読み込みの合図で渡し直す。
    #[test]
    fn the_last_progress_is_replayed_when_the_loading_page_loads() {
        let mut ui = Ui::default();
        assert_eq!(ui.progress_to_replay(false), None);
        ui.last_progress = Some("p".to_string());
        assert_eq!(ui.progress_to_replay(false), Some("p".to_string()));
        // サーバの頁には渡さない。
        assert_eq!(ui.progress_to_replay(true), None);
        ui.navigating();
        assert_eq!(ui.progress_to_replay(false), None);
    }

    // 進み具合の式は、決まった段階の名前と整数だけでできている。
    #[test]
    fn the_boot_progress_script_carries_only_the_phase_name_and_counts() {
        let b = health::Boot {
            ready: false,
            phase: health::Phase::Indexing,
            done: 412,
            total: 987,
        };
        assert_eq!(
            progress_js(&b),
            r#"window.__hangarBootProgress && window.__hangarBootProgress({"phase":"indexing","done":412,"total":987})"#
        );
        let url = server::entry_url(server::PORT, "secret-token", "#/home");
        for part in ["?t=", "secret-token", "http", "127.0.0.1", &url] {
            assert!(!progress_js(&b).contains(part), "{part}");
        }
    }

    // 合図の式は決まった文字列で、鍵も行き先も持たない。
    // 殻は評価する式をログに残さないが、式に鍵が混じれば webview の側で漏れうる。
    #[test]
    fn the_boot_finish_script_is_fixed_and_carries_no_entry_url() {
        assert_eq!(
            BOOT_FINISH_JS,
            "window.__hangarBootFinish && window.__hangarBootFinish()"
        );
        let url = server::entry_url(server::PORT, "secret-token", "#/home");
        for part in ["?t=", "secret-token", "http", "127.0.0.1", &url] {
            assert!(!BOOT_FINISH_JS.contains(part), "{part}");
        }
    }

    // 起動の失敗は、種類と数を決まった式に埋めて頁へ渡す。文は殻が書かない。
    #[test]
    fn a_failure_reaches_the_page_as_one_fixed_call_with_kind_and_numbers() {
        let env = bootfail::Env {
            lang: "en",
            version: "0.1.0".to_string(),
            os: "macOS 15.1".to_string(),
            home: "~/.agent-hangar".to_string(),
        };
        let f = bootfail::BootFailure::compat_mismatch(server::PORT, 0, health::COMPAT_VERSION);
        let js = bootfail::fail_js(&f, &env);
        assert!(js.starts_with("window.__hangarBootFail && window.__hangarBootFail({"));
        assert!(js.contains("\"kind\":\"compat-mismatch\""));
        assert!(js.contains(&format!("\"ours\":{}", health::COMPAT_VERSION)));
        assert!(
            !js.contains("もう一度試す"),
            "the shell does not write the page's sentences"
        );
    }

    // 入場の鍵が詳細に混じっても、頁へ渡す前に伏せる（`fail` は read_token の値で map_text を通す）。
    #[test]
    fn a_token_in_the_detail_is_hidden_before_it_is_sent_to_the_page() {
        let f = bootfail::BootFailure::other("open http://127.0.0.1:4177/?t=abc123 failed")
            .map_text(|s| redact(s, "abc123"));
        assert!(!bootfail::fail_js(
            &f,
            &bootfail::Env {
                lang: "ja",
                version: String::new(),
                os: String::new(),
                home: String::new()
            }
        )
        .contains("abc123"));
    }

    // ログには種類と詳細の最初の行だけを残す。詳細は長いことがある。
    #[test]
    fn the_log_keeps_the_kind_and_the_first_line_of_the_detail() {
        let f =
            bootfail::BootFailure::server_exited(format!("first\nsecond\n{}", "x".repeat(2000)));
        assert_eq!(failure_log_line(&f), "boot failed (server-exited): first");
        let long = bootfail::BootFailure::other("y".repeat(2000));
        assert!(failure_log_line(&long).chars().count() < 400);
    }
}
