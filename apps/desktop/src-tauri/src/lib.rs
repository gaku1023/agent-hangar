//! agent-hangar のデスクトップシェル。
//! 起動時に同梱サーバを子プロセスとして立て、`/health` が通ったらウィンドウをサーバの URL へ移す。
//! `hangar://` のディープリンクは UI のハッシュ経路に変換して webview に流す。

pub mod approve;
pub mod bootfail;
pub mod bootmsg;
pub mod bootprobe;
#[cfg(windows)]
pub mod breakaway;
pub mod cloudmember;
pub mod configapply;
pub mod deeplink;
pub mod filedrop;
pub mod health;
pub mod instance;
pub mod links;
pub mod logfile;
pub mod node;
pub mod notify;
pub mod paths;
pub mod placement;
pub mod recoveryfile;
pub mod server;
pub mod tempclean;
pub mod updater;
#[cfg(windows)]
pub mod winjob;

use std::cell::Cell;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_updater::UpdaterExt;

/// アプリ全体で共有する状態。
struct AppState {
    server: Mutex<Option<server::ServerProcess>>,
    ui: Mutex<Ui>,
    /// 起動の本体（`boot`）が走っているか。「もう一度試す」を連打しても、二つ目の起動を重ねない。
    booting: AtomicBool,
    /// 今の子を起こす直前の時刻。子が死んだとき、`boot-error.json` がこの子のものかを更新の時刻で見分ける。
    /// 子を起こさずに既存のサーバを採ったときは、前の値のまま使わない（その経路では子の死を見ない）。
    child_started: Mutex<Option<SystemTime>>,
    /// 設定の同期の確認（適用、世代へ戻す）と、連携の書き込みの確認が出ているか。頁から続けて呼ばれても、確認を重ねて出さない。
    config_busy: AtomicBool,
    /// 開いている承認の窓（`approve`）の状態。窓は同時に 1 つだけである。
    approve: Mutex<Option<approve::Session>>,
    /// 試験のための書き出しの先（`HANGAR_BOOT_PROBE`、`bootprobe`）。起動のときに一度だけ読む。ふだんは無い。
    /// 試験用の feature（`boot-probe`）を立てていない build では、変数があっても無い。
    boot_probe: Option<std::path::PathBuf>,
}

/// ウィンドウが今どの段にいるか。
/// 評価（`eval`）は、頁の読み込みが終わっていないと捨てられることがある。
/// そのため「出せるか」をここで決め、出せないものは貯めて読み込みの合図で流す。
///
/// 起動画面への知らせ（失敗、進み具合、読み込みが終わった合図）は、読み込みの合図でも間に合わない。
/// macOS では合図（`PageLoadEvent::Finished`）の時点で、起動画面の口を作る boot.js がまだ走っていないことがある。
/// Node の無い Mac で、起動から 40ms で出た失敗が合図で渡し直しても落ち、読み込み中のまま止まった（2026-10-11）。
/// なので殻はこの 3 つを状態として持ち、起動画面が口を作り終えてから問い合わせる（`boot_state`）。
/// その場の評価も続けるので、口が出来た後に起きたことはそのまま届く。
#[derive(Default)]
struct Ui {
    /// サーバの URL へ navigate を出したか。
    ready: bool,
    /// 今出している頁の読み込みが終わったか。
    loaded: bool,
    pending_hash: Option<String>,
    /// 起動の失敗。起動画面へ渡す材料（`bootfail::payload`）で、やり直すまで持ち続ける。
    failure: Option<serde_json::Value>,
    /// 読み込み画面の load の合図が届いた時刻。起動画面の動きの時計も同じ合図から数える。
    loading_since: Option<Instant>,
    /// 最後に起動画面へ渡した索引の進み具合。
    last_progress: Option<health::Boot>,
    /// 読み込みが終わった合図（`BOOT_FINISH_JS`）を打ったか。
    finishing: bool,
    /// 起動に失敗した後に殻が見つけた、新しい版。起動画面の札に出す。やり直しても消さない（新しい版があることは変わらない）。
    update: Option<String>,
    /// 起動に失敗した後に、殻が自分で更新を確かめ始めたか（`card_shown`）。確かめるのはアプリが動いている間に 1 度だけで、やり直しても戻さない。
    update_checked: bool,
}

impl Ui {
    /// 起動画面が問い合わせたときに渡す、起動の今の様子。
    /// `{ failure, progress, finishing, update }` の形で、起動画面（loading/boot.js）が引き取る。
    /// `update` は殻が見つけた新しい版（`{ version }`）で、無ければ null。
    /// サーバの頁へ移った後は、何も渡さない。UI の DOM を書き換えないためである。
    fn boot_state(&self) -> serde_json::Value {
        if self.ready {
            return serde_json::json!({ "failure": null, "progress": null, "finishing": false, "update": null });
        }
        serde_json::json!({
            "failure": self.failure,
            "progress": self.last_progress.as_ref().map(progress_payload),
            "finishing": self.finishing,
            "update": self.update.as_ref().map(|v| serde_json::json!({ "version": v })),
        })
    }

    /// 起動画面が失敗の札を描いた（`boot_card_shown`）。殻が今、更新を確かめ始めてよければ真を返す。
    /// 札を出す前には確かめない。札の最初の描画と、目録の取得や証明書の検証を重ねないためである。
    /// 確かめるのは 1 度だけで、やり直して読み込み直した頁が知らせても重ねない。サーバの頁へ移った後も確かめない（UI が自分で確かめる）。
    fn card_shown(&mut self) -> bool {
        if self.ready || self.failure.is_none() || self.update_checked {
            return false;
        }
        self.update_checked = true;
        true
    }

    /// 起動に失敗した後に、殻が新しい版を見つけた。起動画面へ渡してよければ真を返す。
    /// サーバの頁へ移った後は渡さない（UI が自分で確かめて知らせる）。
    fn update_found(&mut self, version: String) -> bool {
        if self.ready {
            return false;
        }
        self.update = Some(version);
        true
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

    /// 起動に失敗した後の「もう一度試す」。
    /// サーバの頁へ移った後はやり直さないので偽を返す。
    /// やり直すときは、殻が読み込み画面を読み込み直すので、読み込みの合図まで段を戻す。
    /// 前の失敗、進み具合、合図は、新しい頁へ持ち込まない。
    fn retry(&mut self) -> bool {
        if self.ready {
            return false;
        }
        self.loaded = false;
        self.failure = None;
        self.last_progress = None;
        self.finishing = false;
        true
    }

    /// 頁の読み込みが終わった。今流してよいハッシュを返す。ハッシュはサーバの頁のものだけを流す。
    /// 段に合わない合図（navigate の後に届く読み込み画面の側の合図など）は何もしない。
    /// 消えていく頁へ流すと、そのハッシュはそのまま失われるからである。
    /// 起動画面への知らせはここで渡し直さない。起動画面が口を作り終えてから問い合わせる（`boot_state`）。
    fn page_loaded(&mut self, server_page: bool) -> Option<String> {
        if self.ready != server_page {
            return None;
        }
        self.loaded = true;
        if self.ready {
            self.pending_hash.take()
        } else {
            None
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

/// 起動画面が問い合わせたときに渡す進み具合（`boot_state`）。中身は `progress_js` と同じ 3 つである。
fn progress_payload(b: &health::Boot) -> serde_json::Value {
    serde_json::json!({ "phase": b.phase.as_str(), "done": b.done, "total": b.total })
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
            app.state::<AppState>().ui.lock().unwrap().last_progress = Some(*b);
            eval_main(app, &progress_js(b));
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
        ReadyWait::Unresponsive => Err(bootfail::BootFailure::other(say(
            home,
            bootmsg::Msg::Unresponsive {
                secs: UNRESPONSIVE_AFTER.as_secs(),
                log: log_display(home),
            },
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
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // 1 行を 1 回の write で書く。糸が同時に書いても行がつながらない（logfile.rs）。
    let _ = logfile::append_line(&logfile::log_path(&home), &format!("{ms} [desktop] {line}"));
}

/// 失敗の詳細に書く、記録のファイルの場所。
/// 利用者のホームを `~` に縮め、OS の区切りのまま出す（Windows なら `~\.agent-hangar\desktop.log`）。
fn log_display(home: &std::path::Path) -> String {
    bootfail::tilde(
        &home.join("desktop.log").to_string_lossy(),
        &paths::user_home(),
    )
}

/// 殻が書く失敗の詳細を、頁の言語で文にする。
/// 言語は失敗の札と同じく、置き場の設定ファイルか OS から決める（`bootfail::page_language`）。
fn say(home: &std::path::Path, m: bootmsg::Msg) -> String {
    m.text(bootfail::page_language(home))
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
        sep: std::path::MAIN_SEPARATOR_STR,
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

/// 頁へ渡す失敗。詳細と文字の params から、入場の鍵を伏せ、利用者のホームを `~` に縮める。
/// サーバが書く `params` の `file` と `dir`、Node の「調べた場所」、例外の文に、ユーザー名を出さないためである。
fn for_page(
    failure: bootfail::BootFailure,
    token: Option<&str>,
    user_home: &std::path::Path,
) -> bootfail::BootFailure {
    let failure = match token {
        Some(token) => failure.map_text(|s| redact(s, token)),
        None => failure,
    };
    failure.map_text(|s| bootfail::shorten_home(s, user_home))
}

/// 殻が見つけた新しい版を、起動画面へ渡す式（loading/boot.js の __hangarBootUpdate）。
/// 版は JSON の文字として埋める。
fn boot_update_js(version: &str) -> String {
    format!(
        "window.__hangarBootUpdate && window.__hangarBootUpdate({})",
        serde_json::json!({ "version": version })
    )
}

/// 起動に失敗したとき、殻が自分で更新を確かめ、新しい版があれば起動画面の札に出す。
/// 起動に失敗する版を入れた人は UI まで届かないので、UI の自動の確認では新しい版を受け取れない。
/// 呼ぶのは、起動画面が札を描いたと知らせたとき（`boot_card_shown`）の 1 度だけである（`Ui::card_shown`）。
/// 見つけた版は状態に置き（`Ui::update_found`）、その場の評価でも渡す。失敗はログに残すだけで、札には出さない。
fn check_update_after_failure(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(updater::Found {
            version: Some(version),
            ..
        }) = find_update(&app).await
        else {
            return;
        };
        let now = app
            .state::<AppState>()
            .ui
            .lock()
            .unwrap()
            .update_found(version.clone());
        if now {
            eval_main(&app, &boot_update_js(&version));
        }
    });
}

/// 起動の失敗を札で出す。サーバへ移る前だけ意味を持つ。
/// 失敗は状態に置き、起動画面が口を作り終えてから問い合わせたとき（`boot_state`）に渡す。
/// 口が出来る前の評価は捨てられるからである（`Ui` の説明）。
/// 口が出来た後の失敗のために、その場の評価も続ける。状態に置くのを先にするので、どちらかで必ず届く。
/// 詳細に入場の鍵が混じっていたら、頁へ渡す前に伏せ、利用者のホームを `~` に縮める（`for_page`）。
/// 更新はここでは確かめない。札を描いたと起動画面が知らせてから確かめる（`boot_card_shown`）。
fn fail(app: &AppHandle, failure: bootfail::BootFailure) {
    let home = paths::hangar_home();
    let token = server::read_token(&home);
    let failure = for_page(failure, token.as_deref(), &paths::user_home());
    log(&failure_log_line(&failure));
    let env = boot_env(app, &home);
    app.state::<AppState>().ui.lock().unwrap().failure =
        Some(bootfail::payload_value(&failure, &env));
    eval_main(app, &bootfail::fail_js(&failure, &env));
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
/// navigate の最中に届いたハッシュをここで流す。
/// 起動画面への知らせは、起動画面が口を作り終えてから自分で引き取る（`boot_state`）。
fn page_loaded(app: &AppHandle, server_page: bool) {
    let hash = {
        let state = app.state::<AppState>();
        let mut ui = state.ui.lock().unwrap();
        // 読み込み画面の最初の load だけを時計の起点にする。
        if !server_page && ui.loading_since.is_none() {
            ui.loading_since = Some(Instant::now());
        }
        ui.page_loaded(server_page)
    };
    // 信号の 3 点が窓の中に重なる殻であることの印。画面はこれを見て、信号の 3 点の分だけヘッダの左を空ける。
    // macOS でだけ付ける。Windows の窓は標準の枠で、信号は窓の中に無い。
    // 読み込み画面にも付ける（失敗の札のロゴの位置）。札を出す合図より先に付くよう、流す文言より前に置く。
    if cfg!(target_os = "macos") {
        eval_main(app, "document.documentElement.dataset.shell = 'desktop'");
        // 位相を読めるのはこの殻の中だけである。画面はこの印を見て、時間で当てずっぽうに決めるのをやめる。
        if server_page {
            eval_main(app, "window.__hangarPhaseAware = true");
        }
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

/// 同梱のサーバの置き場と、その manifest.json を読む。
/// サーバを起こすとき（`bundled_node_and_dir`）と、起動の失敗の札の「node を選ぶ…」（`pick_node`）が使う。
fn bundled_dir_and_manifest(
    app: &AppHandle,
    hangar_home: &std::path::Path,
) -> Result<(std::path::PathBuf, node::Manifest), bootfail::BootFailure> {
    // Windows の resource_dir は `\\?\C:\…`（verbatim）の形で来る。子へ渡す前に普通の形へ直す。
    // Node 22.20 以降はその形の主スクリプトを読めず、起動の直後に落ちる。
    // 文は失敗したときだけ頁の言語で作る（言語を決めるのに OS へ聞くことがあるので、成功の道では聞かない）。
    let resource_dir = app
        .path()
        .resource_dir()
        .map(|d| paths::plain(&d))
        .map_err(|e| {
            say(
                hangar_home,
                bootmsg::Msg::NoResourceDir { err: e.to_string() },
            )
        })?;
    let dir = server::server_dir(&resource_dir).ok_or_else(|| {
        say(
            hangar_home,
            bootmsg::Msg::NoBundledServer {
                dir: resource_dir.display().to_string(),
            },
        )
    })?;
    let dir = accept_server_dir(dir, &resource_dir, cfg!(debug_assertions))
        .ok_or_else(|| say(hangar_home, bootmsg::Msg::ServerDirDevOnly))?;
    server::strip_quarantine(&dir);
    let manifest = node::read_manifest(&dir).map_err(|m| say(hangar_home, m))?;
    Ok((dir, manifest))
}

/// 同梱のサーバの置き場と、それを走らせる Node を決める。
/// サーバを起こすときと、設定の同期の命令（CLI の cli.mjs は同じ置き場にある）が使う。
/// 合う Node が無いときは、見つからない、版が古い、アーキテクチャが違うを種類で分けて返し（`node::failure_kind`）、
/// 頁が入れ方を主にした札を出す。
fn bundled_node_and_dir(
    app: &AppHandle,
    hangar_home: &std::path::Path,
) -> Result<(std::path::PathBuf, std::path::PathBuf), bootfail::BootFailure> {
    let (dir, manifest) = bundled_dir_and_manifest(app, hangar_home)?;
    let candidates = node::candidate_paths(&paths::user_home(), hangar_home);
    let node_path = node::choose_node(&candidates, &manifest, node::probe_node).map_err(|e| {
        bootfail::BootFailure::node(
            node::failure_kind(&e),
            node::failure_params(&e),
            node::describe_error(&e, bootfail::page_language(hangar_home)),
        )
    })?;
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
            return Err(say(hangar_home, bootmsg::Msg::Translocated).into());
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
    .map_err(|e| {
        say(
            hangar_home,
            bootmsg::Msg::CannotSpawn { err: e.to_string() },
        )
    })?;
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
    Err(bootfail::BootFailure::other(say(
        home,
        bootmsg::Msg::NoAnswerWithin {
            secs: deadline.as_secs(),
            log: log_display(home),
        },
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
    // 初めての起動なら、OS の表示言語を設定の language に書く。サーバ、UI、札、CLI がこの値を読む。
    let lang = bootfail::ensure_language(&hangar_home);
    log(&format!("language {lang}"));
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
        let msg = bootmsg::Msg::TokenUnreadable {
            file: bootfail::tilde(
                &hangar_home.join("token").to_string_lossy(),
                &paths::user_home(),
            ),
            log: log_display(&hangar_home),
        };
        return fail(&app, say(&hangar_home, msg).into());
    };

    // ウィンドウが取れなければ行き先を変えられない。黙って止まらず、理由を残す。
    let Some(w) = app.get_webview_window("main") else {
        let msg = say(&hangar_home, bootmsg::Msg::NoWindow);
        return fail(&app, bootfail::BootFailure::other(msg));
    };

    // 読み込みが終わった合図を打たせ、光が満ち切るまで待ってから移る。起動画面は周のどこからでも合図に入れる。
    // load の合図がまだ来ていなければ、描いている札も無いので、合図も待ちもしない。
    // 合図を打ったことは状態にも置く。口が出来る前に打った合図は、起動画面が問い合わせて引き取る。
    let drawing = {
        let state = app.state::<AppState>();
        let mut ui = state.ui.lock().unwrap();
        ui.finishing = ui.loading_since.is_some();
        ui.finishing
    };
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
        .map_err(|e| say(&hangar_home, bootmsg::Msg::BadUrl { err: e.to_string() }))
        .and_then(|u| w.navigate(u).map_err(|e| format!("{e}")));
    if let Err(e) = navigated {
        // navigate に至らなかったので、読み込み画面がそのまま残る。段を戻してから文言を出す。
        app.state::<AppState>()
            .ui
            .lock()
            .unwrap()
            .navigation_failed();
        // 例外の文言に URL が混じることがある。鍵を伏せてから出す。
        let msg = bootmsg::Msg::CannotNavigate {
            port: server::PORT,
            err: redact(&e, &token),
        };
        fail(&app, bootfail::BootFailure::other(say(&hangar_home, msg)));
        return;
    }
    // 入力待ちと使用制限の通知は、サーバが決めて並べる。頁が背面で止まっていても出るよう、殻のスレッドが読みに行く。
    watch_notices(app.clone(), addr, token);
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

// ここから下の 5 つと、入力待ちの知らせの 4 つ（notify_waiting、notify_prune、notify_request、notify_status）と、設定の同期の 2 つ（apply_config_sync、restore_config_sync）と、連携の書き込み（setup_integration）と、承認の窓の 2 つ（approve_view、approve_answer。承認の窓の頁だけ）が、頁から呼べる殻の命令である。
// 名前は build.rs の一覧、capabilities、UI（packages/ui/src/runtime/desktop.ts）、起動画面（loading/boot.js）とそろえる。
// pick_folder、boot_probe、restore_config_sync、setup_integration、approve_answer、save_recovery_key（本文だけ）のほかは引数を受け取らない。開くファイルも、やり直す手順も、殻の側で決まっている。
// pick_node（起動画面だけ）も引数を受け取らない。選ぶのは利用者で、確かめる条件と書く先は殻が決める。

/// 起動画面が口を作り終えた時点で引き取る、起動の今の様子（`Ui::boot_state`）。
/// 口が出来る前に殻が評価で渡した失敗、進み具合、合図は捨てられるので、頁の側から取りに来る。
/// 引数は受け取らない。返すのは起動画面へ評価で渡すものと同じ材料だけで、入場の鍵や URL は持たない。
/// 試験のための書き出しが求められていれば（`HANGAR_BOOT_PROBE`）、`probe` を真で添える。頁はそのときだけ `boot_probe` を呼ぶ。
#[tauri::command]
fn boot_state(app: AppHandle) -> serde_json::Value {
    let state = app.state::<AppState>();
    let mut now = state.ui.lock().unwrap().boot_state();
    // 待っている間の文（読み込み中、ようこそ）の言語。失敗の札と同じ決め方で、起動の頭で書いた設定を読む。
    now["lang"] = bootfail::page_language(&paths::hangar_home()).into();
    bootprobe::mark(now, state.boot_probe.is_some())
}

/// 起動画面が失敗の札を描いた知らせ。描いたコマの後で、頁（loading/boot.js）が 1 度だけ呼ぶ。
/// 殻はこれを受けてから、1 度だけ更新を確かめる（`Ui::card_shown`、`check_update_after_failure`）。答えは待たせない。
/// 引数は受け取らない。
#[tauri::command]
fn boot_card_shown(app: AppHandle) {
    let now = app.state::<AppState>().ui.lock().unwrap().card_shown();
    if now {
        check_update_after_failure(&app);
    }
}

/// 試験のための書き出し（`bootprobe`）。起動画面が描いた様子を、`HANGAR_BOOT_PROBE` のファイルへ書く。
/// CI が、Node の無い機械で読み込み画面が失敗の札に切り替わったことを、これで確かめる。
/// 殻がその変数を持たずに起きたときは何もしない。
#[tauri::command]
fn boot_probe(app: AppHandle, drawn: serde_json::Value) -> Result<(), String> {
    match &app.state::<AppState>().boot_probe {
        Some(path) => bootprobe::write(path, &drawn),
        None => Ok(()),
    }
}

/// フォルダの選択のダイアログに渡す親の窓を決める。渡すのは Windows だけで、窓が取れなければ親なしで開く。
/// Windows では、ダイアログの持ち主が hangar の窓でないと、入力待ちの知らせの前景の判定（`notify::window_owns_foreground`）が、ダイアログを前にしている利用者を見ているとみなせない。
/// macOS で親を渡すと、ダイアログが窓に付くシートに変わって見た目が変わるので渡さない。
fn dialog_parent<W>(windows: bool, window: Option<W>) -> Option<W> {
    if windows {
        window
    } else {
        None
    }
}

/// フォルダを 1 つ選ぶダイアログを開き、選んだパスを返す。取り消したら None を返す。
/// 新しいセッションのダイアログと、プロジェクトを作るダイアログの「ほかの場所を選ぶ…」が呼ぶ。
/// 既定の場所はワークスペースのルートで、`~/` で始まればホームに展開する。ディレクトリでなければ渡さない。
/// ダイアログは選び終えるまで戻らないので、非同期の実行の糸を塞がないよう spawn_blocking で待つ。
#[tauri::command]
async fn pick_folder(app: AppHandle, default_path: Option<String>) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let mut builder = app.dialog().file();
    if let Some(parent) = dialog_parent(cfg!(windows), app.get_webview_window("main")) {
        builder = builder.set_parent(&parent);
    }
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

/// 起動の失敗の札（Node の札）の「node を選ぶ…」。ファイルの選択を開き、選んだ Node を確かめる。
/// 確かめる条件は、殻が Node を探すときと、設定の画面の「Node のパス」と同じ（Node-API が manifest.json の nodeApi 以上で、アーキテクチャが同じ）。
/// 合えば `<HANGAR_HOME>/settings.json` の `nodePath` に書く。頁はその答えを見て起動をやり直す。
/// 答えは `node::pick_answer` の形で、取り消したら `{"result":"cancel"}`、書けなければ `{"result":"saveFailed","error":…}` を返す。
/// 引数は受け取らない。nodePath は次の起動で殻が起こす実行ファイルなので、頁からパスを受け取らず、利用者がダイアログで選んだものだけを書く。
/// 起動画面（capabilities/boot-screen.json）だけに与え、UI の出どころには与えない。
#[tauri::command]
async fn pick_node(app: AppHandle) -> serde_json::Value {
    use tauri_plugin_dialog::DialogExt;
    let home = paths::hangar_home();
    let manifest = match bundled_dir_and_manifest(&app, &home) {
        Ok((_, m)) => m,
        Err(f) => return serde_json::json!({ "result": "other", "error": f.detail }),
    };
    let mut builder = app.dialog().file();
    if let Some(parent) = dialog_parent(cfg!(windows), app.get_webview_window("main")) {
        builder = builder.set_parent(&parent);
    }
    if cfg!(windows) {
        builder = builder.add_filter("node.exe", &["exe"]);
        // 札の手順は %LOCALAPPDATA%\Programs に展開するよう勧めるので、そこから開く。
        if let Some(dir) = std::env::var_os("LOCALAPPDATA")
            .map(|d| std::path::PathBuf::from(d).join("Programs"))
            .filter(|d| d.is_dir())
        {
            builder = builder.set_directory(dir);
        }
    }
    let picked = tauri::async_runtime::spawn_blocking(move || builder.blocking_pick_file())
        .await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok());
    let Some(path) = picked else {
        return serde_json::json!({ "result": "cancel" });
    };
    // 候補を起こして訊くので、最大で PROBE_TIMEOUT（5 秒）かかる。非同期の実行の糸を塞がない。
    let (p, m) = (path.clone(), manifest.clone());
    let checked =
        tauri::async_runtime::spawn_blocking(move || node::check_picked(&p, &m, node::probe_node))
            .await
            .unwrap_or(node::Picked::NotNode);
    log(&format!("picked node {} ({:?})", path.display(), checked));
    if checked == node::Picked::Ok {
        if let Err(e) = node::save_node_path(&home, &path) {
            log(&format!("could not save nodePath: {e}"));
            return serde_json::json!({ "result": "saveFailed", "error": e });
        }
    }
    node::pick_answer(&path, &checked, &manifest)
}

/// リカバリーキーの「ファイルに保存」（設定のクラウド同期の節、試作 D2）。
/// 保存のダイアログを既定の名前 `hangar-recovery-key.txt` で開き、利用者が選んだ場所にだけ本文を書く（`recoveryfile::write`、Unix で 0600）。
/// 引数は本文だけで、パスは受け取らない。頁から書く先を決められないようにするためである。
/// 書いたら true、取り消したら false を返す（取り消しは失敗にしない）。書けなければ理由の文で失敗にする。
/// UI の出どころ（capabilities/remote-save-recovery-key.json）だけに与える。
#[tauri::command]
async fn save_recovery_key(app: AppHandle, text: String) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    if text.is_empty() || text.len() > recoveryfile::MAX_LEN {
        return Err("recovery key text is out of range".into());
    }
    let mut builder = app
        .dialog()
        .file()
        .set_file_name(recoveryfile::FILE_NAME)
        .add_filter("Text", &["txt"]);
    if let Some(parent) = dialog_parent(cfg!(windows), app.get_webview_window("main")) {
        builder = builder.set_parent(&parent);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || builder.blocking_save_file())
        .await
        .ok()
        .flatten();
    let Some(picked) = picked else {
        return Ok(false);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    recoveryfile::write(&path, &text).map_err(|e| {
        log(&format!("could not save the recovery key: {e}"));
        e
    })?;
    Ok(true)
}

/// 設定の同期の確認と、その後の CLI の呼び出しに要るもの。
/// 同梱の Node と cli.mjs の置き場、hangar の置き場の 3 つ。
fn config_runtime(
    app: &AppHandle,
) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
    let home = paths::hangar_home();
    // 設定の同期は札を出さないので、詳細の文だけを使う。
    let (node, dir) = bundled_node_and_dir(app, &home).map_err(|f| f.detail)?;
    Ok((node, dir, home))
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
    w: &configapply::Words,
    run: impl FnOnce() -> configapply::Outcome,
) -> configapply::Outcome {
    let state = app.state::<AppState>();
    if state.config_busy.swap(true, Ordering::SeqCst) {
        return configapply::Outcome::simple("busy", w.busy);
    }
    let outcome = run();
    state.config_busy.store(false, Ordering::SeqCst);
    outcome
}

/// 設定の同期の文の言語。殻の頁と同じく、置き場の設定ファイルか OS から決める（`bootfail::page_language`）。
fn config_language() -> &'static str {
    bootfail::page_language(&paths::hangar_home())
}

fn apply_config_flow(app: &AppHandle, lang: &'static str) -> configapply::Outcome {
    let title = configapply::words(lang).apply_flow_title;
    let (node, dir, home) = match config_runtime(app) {
        Ok(v) => v,
        Err(e) => return config_runtime_failure(app, title, e),
    };
    let run = |args: &[&str]| {
        configapply::run_cli(
            configapply::cli_command(&node, &dir, &home, args),
            configapply::CLI_TIMEOUT,
            lang,
        )
    };
    // 見立ては CLI に出させる。書くものの数と種類を、殻が自分では数えない。
    let plan_out = match run(&["config", "apply", "--plan", "--json"]) {
        Ok(o) => o,
        Err(e) => return config_runtime_failure(app, title, e),
    };
    let plan = match configapply::parse_reply::<serde_json::Value>(&plan_out, "plan", lang) {
        Ok(p) => p,
        Err(f) => return config_failure(app, title, &f),
    };
    // 確認は殻の承認の窓で行い、承認されたら、確認したのと同じ指示書（--order）と同じ手元（--expect）にだけ適用する。
    let outcome = approval_flow(app, approve::Job::Apply, plan, lang);
    log(&format!("config sync: apply {}", outcome.status));
    outcome
}

fn restore_config_flow(
    app: &AppHandle,
    name: &str,
    target: &str,
    lang: &'static str,
) -> configapply::Outcome {
    let w = configapply::words(lang);
    let title = w.restore_flow_title;
    // 頁から来る値は、世代の名前の形と、決まった対象の名前だけを受け取る。
    if !configapply::valid_generation_name(name) {
        return configapply::Outcome::simple("failed", w.bad_generation);
    }
    let Some(target) = approve::restore_target(target) else {
        return configapply::Outcome::simple("failed", w.bad_target);
    };
    let job = approve::Job::Restore {
        name: name.to_string(),
        target,
    };
    let (node, dir, home) = match config_runtime(app) {
        Ok(v) => v,
        Err(e) => return config_runtime_failure(app, title, e),
    };
    let run = |args: &[&str]| {
        configapply::run_cli(
            configapply::cli_command(&node, &dir, &home, args),
            configapply::CLI_TIMEOUT,
            lang,
        )
    };
    let plan_args = approve::plan_args(&job, 0);
    let plan_refs: Vec<&str> = plan_args.iter().map(String::as_str).collect();
    let plan_out = match run(&plan_refs) {
        Ok(o) => o,
        Err(e) => return config_runtime_failure(app, title, e),
    };
    let plan = match configapply::parse_reply::<serde_json::Value>(&plan_out, "plan", lang) {
        Ok(p) => p,
        Err(f) => return config_failure(app, title, &f),
    };
    let outcome = approval_flow(app, job, plan, lang);
    log(&format!("config sync: restore {}", outcome.status));
    outcome
}

/// 他の PC から届いて、承認した設定を適用する。UI の設定の「適用…」が呼ぶ。引数は受け取らない。
/// 適用の指示書（hangar の置き場の claude-config/apply-order.json）を CLI が読み、
/// 書く先ごとの差分を承認の窓に見せ、承認されたときだけ、控えを取って書く。サーバは `~/.claude` に書かない。
#[tauri::command]
async fn apply_config_sync(app: AppHandle) -> configapply::Outcome {
    let lang = config_language();
    let w = configapply::words(lang);
    tauri::async_runtime::spawn_blocking(move || {
        with_config_guard(&app, w, || apply_config_flow(&app, lang))
    })
    .await
    .unwrap_or_else(|_| configapply::Outcome::simple("failed", w.apply_stopped))
}

/// バックアップの世代へ戻す。UI の設定の「この世代に戻す」が呼ぶ。
/// 受け取るのは世代の名前（yyyyMMdd-HHmmss）と、戻す先の対象の名前（省くと claude）だけで、どちらも形を確かめる。
#[tauri::command]
async fn restore_config_sync(
    app: AppHandle,
    name: String,
    target: Option<String>,
) -> configapply::Outcome {
    let lang = config_language();
    let w = configapply::words(lang);
    tauri::async_runtime::spawn_blocking(move || {
        with_config_guard(&app, w, || {
            restore_config_flow(&app, &name, target.as_deref().unwrap_or("claude"), lang)
        })
    })
    .await
    .unwrap_or_else(|_| configapply::Outcome::simple("failed", w.restore_stopped))
}

// ---- 承認の窓（approve.rs） ----

/// 承認の窓を開く。もう開いていれば前に出す。窓は main の窓の子にし、閉じたら結果を返す（`approve_closed`）。
/// 頁は殻に同梱した approve.html で、サーバの頁へは移らせない（`approve::allowed_navigation`）。
fn open_approve_window(app: &AppHandle, lang: &str) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(approve::LABEL) {
        let _ = w.set_focus();
        return Ok(());
    }
    let words = approve::words(lang);
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        approve::LABEL,
        tauri::WebviewUrl::App(approve::PAGE.into()),
    )
    .title(words.window_title)
    .inner_size(680.0, 640.0)
    .min_inner_size(480.0, 420.0)
    .center()
    .focused(true)
    .on_navigation(approve::allowed_navigation);
    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main).map_err(|e| e.to_string())?;
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    let handle = app.clone();
    window.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            approve_closed(&handle);
        }
    });
    Ok(())
}

/// 承認の窓が閉じた。結果をまだ返していなければ、取り消し（書けなかった理由があればその失敗）を返す。
/// 書いている最中に閉じられたときは、書き終わったところで結果を返す（`approve_answer`）。
fn approve_closed(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut slot = state.approve.lock().unwrap();
    if let Some(s) = slot.as_mut() {
        if s.stage == approve::Stage::Writing {
            s.closed = true;
            return;
        }
    }
    if let Some(mut s) = slot.take() {
        if s.waiting() {
            let o = s.closed_outcome();
            s.finish(o);
        }
    }
}

/// 承認の窓を開き、利用者が書くか閉じるまで待って、結果を返す。呼び手は別のスレッドで待つ。
fn approval_flow(
    app: &AppHandle,
    job: approve::Job,
    plan: serde_json::Value,
    lang: &'static str,
) -> configapply::Outcome {
    let words = approve::words(lang);
    let (tx, rx) = std::sync::mpsc::channel();
    *app.state::<AppState>().approve.lock().unwrap() =
        Some(approve::Session::new(job, plan, lang, tx));
    if let Err(e) = open_approve_window(app, lang) {
        log(&format!("approve: cannot open the window: {e}"));
        app.state::<AppState>().approve.lock().unwrap().take();
        return configapply::Outcome::simple("failed", words.cannot_open);
    }
    rx.recv()
        .unwrap_or_else(|_| configapply::Outcome::simple("cancelled", words.cancelled))
}

/// CLI を走らせる。殻の同梱の Node と cli.mjs と、hangar の置き場を使う。
fn run_hangar_cli(app: &AppHandle, args: &[String], lang: &str) -> Result<String, String> {
    let (node, dir, home) = config_runtime(app)?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    configapply::run_cli(
        configapply::cli_command(&node, &dir, &home, &args),
        configapply::CLI_TIMEOUT,
        lang,
    )
}

/// 連携の書き込みの流れ。見立てを出させ、済んでいれば知らせだけ、書けなければ理由を返し、書けるなら承認の窓を開く。
fn setup_flow(app: &AppHandle, target: &'static str, lang: &'static str) -> configapply::Outcome {
    let job = approve::Job::Setup(target);
    let out = match run_hangar_cli(app, &approve::plan_args(&job, server::PORT), lang) {
        Ok(o) => o,
        Err(e) => {
            log(&format!("setup {target}: {e}"));
            return configapply::Outcome::simple("failed", e);
        }
    };
    let plan = match configapply::parse_reply::<serde_json::Value>(&out, "plan", lang) {
        Ok(p) => p,
        Err(f) => return configapply::Outcome::failure(&f),
    };
    match approve::plan_state(&plan) {
        approve::PlanState::Noop { code, message } => configapply::Outcome {
            code: Some(code),
            ..configapply::Outcome::simple("none", message)
        },
        approve::PlanState::Blocked { code, message } => configapply::Outcome {
            code: Some(code),
            ..configapply::Outcome::simple("failed", message)
        },
        approve::PlanState::Ready => {
            let outcome = approval_flow(app, job, plan, lang);
            log(&format!("setup {target}: {}", outcome.status));
            outcome
        }
    }
}

/// 連携を書き込む（MCP の登録と解除、シェル連携のインストールとアンインストール、ステータスラインの設定と解除）。
/// UI の設定の連携の節と、ホームの始める前の確認のボタンが呼ぶ。受け取るのは決まった対象の名前（`approve::SETUP_TARGETS`）だけである。
/// 見立てを殻の承認の窓に見せ、承認されたときだけ CLI が書く。サーバは書かない。
#[tauri::command]
async fn setup_integration(app: AppHandle, target: String) -> configapply::Outcome {
    let lang = config_language();
    let words = approve::words(lang);
    let Some(target) = approve::setup_target(&target) else {
        return configapply::Outcome::simple("failed", words.stopped);
    };
    let busy = configapply::words(lang);
    if app.state::<AppState>().config_busy.load(Ordering::SeqCst) {
        if let Some(w) = app.get_webview_window(approve::LABEL) {
            let _ = w.set_focus();
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        with_config_guard(&app, busy, || setup_flow(&app, target, lang))
    })
    .await
    .unwrap_or_else(|_| configapply::Outcome::simple("failed", words.stopped))
}

/// 承認の窓の頁に出す材料。承認の窓（approve）の頁だけが呼べる。
fn approve_view_of(app: &AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<AppState>();
    let slot = state.approve.lock().unwrap();
    let s = slot.as_ref().ok_or_else(|| "no approval".to_string())?;
    Ok(s.view(
        &paths::user_home().to_string_lossy(),
        &paths::hangar_home().to_string_lossy(),
        cfg!(windows),
    ))
}

#[tauri::command]
fn approve_view(window: tauri::Window, app: AppHandle) -> Result<serde_json::Value, String> {
    if window.label() != approve::LABEL {
        return Err("not allowed".into());
    }
    approve_view_of(&app)
}

/// 承認の窓の答え。write は書く、reload は見立てを出させ直す、cancel と close は窓を閉じる。
/// 承認の窓（approve）の頁だけが呼べる（capabilities/approve.json。殻の側でも窓の名前を確かめる）。
/// 返すのは、答えたあとの頁の材料である。
#[tauri::command]
async fn approve_answer(
    window: tauri::Window,
    app: AppHandle,
    choice: String,
) -> Result<serde_json::Value, String> {
    if window.label() != approve::LABEL {
        return Err("not allowed".into());
    }
    let state = app.state::<AppState>();
    let (args, lang, reading) = {
        let mut slot = state.approve.lock().unwrap();
        let s = slot.as_mut().ok_or_else(|| "no approval".to_string())?;
        match (choice.as_str(), s.stage) {
            ("cancel" | "close", _) => {
                drop(slot);
                let _ = window.close();
                return Ok(serde_json::Value::Null);
            }
            ("write", approve::Stage::Confirm) => {
                match approve::write_args(&s.job, &s.plan, server::PORT) {
                    Some(a) => {
                        s.stage = approve::Stage::Writing;
                        (a, s.lang, false)
                    }
                    None => {
                        s.fail(configapply::Failure {
                            code: "unreadable".into(),
                            message: approve::words(s.lang).unreadable.to_string(),
                        });
                        drop(slot);
                        return approve_view_of(&app);
                    }
                }
            }
            ("reload", approve::Stage::Confirm | approve::Stage::Fail) => {
                s.stage = approve::Stage::Writing;
                (approve::plan_args(&s.job, server::PORT), s.lang, true)
            }
            ("write" | "reload", _) => {
                drop(slot);
                return approve_view_of(&app);
            }
            _ => return Err("unknown answer".into()),
        }
    };
    let handle = app.clone();
    let reply = tauri::async_runtime::spawn_blocking(move || run_hangar_cli(&handle, &args, lang))
        .await
        .unwrap_or_else(|_| Err(approve::words(lang).stopped.to_string()));
    let key = if reading { "plan" } else { "result" };
    let parsed = reply
        .map_err(|message| configapply::Failure {
            code: "failed".into(),
            message,
        })
        .and_then(|out| configapply::parse_reply::<serde_json::Value>(&out, key, lang));
    {
        let mut slot = state.approve.lock().unwrap();
        let Some(s) = slot.as_mut() else {
            return Ok(serde_json::Value::Null);
        };
        if reading {
            s.replan(parsed);
        } else {
            s.written(parsed);
            log(&format!("approve: {} {:?}", s.job.target(), s.stage));
        }
        // 書いている最中に窓が閉じられていたら、結果を返したところで片付ける。
        if s.closed {
            if let Some(mut s) = slot.take() {
                if s.waiting() {
                    let o = s.closed_outcome();
                    s.finish(o);
                }
            }
            return Ok(serde_json::Value::Null);
        }
    }
    approve_view_of(&app)
}

/// クラウド同期の CLI を走らせる。参加コードは `input` で標準入力へ渡し、引数には載せない（cloudmember.rs）。
/// 返すのは CLI の最後の 1 行の JSON（`{ ok, ... }`）か、走らせられなかったときの `{ ok: false, code }` である。
fn run_cloud_cli(app: &AppHandle, args: &[&str], input: Option<&str>) -> serde_json::Value {
    let (node, dir, home) = match config_runtime(app) {
        Ok(v) => v,
        Err(e) => return cloudmember::failure("cannot-start", &e),
    };
    let cmd = configapply::cli_command(&node, &dir, &home, args);
    let reply = match cloudmember::run_with_input(cmd, input, cloudmember::CLI_TIMEOUT) {
        Ok(out) => cloudmember::parse_reply(&out),
        Err(f) => f,
    };
    // 残すのは命令と結果の符号だけで、参加コードも宛先も残さない。
    let code = reply.get("code").and_then(|c| c.as_str()).unwrap_or("ok");
    log(&format!(
        "cloud: {} {}",
        args[..2.min(args.len())].join(" "),
        code
    ));
    reply
}

/// 参加の接続先の確認。origin の形にそろえた URL とホストと、参加済みの PC の台数と、いまの参加を返す。
/// 新しい PC の参加の「次へ」が呼ぶ。
#[tauri::command]
async fn cloud_join_check(app: AppHandle, url: String) -> serde_json::Value {
    if !cloudmember::valid_join_url(&url) {
        return cloudmember::failure("invalid-url", "");
    }
    tauri::async_runtime::spawn_blocking(move || {
        cloudmember::guarded(|| run_cloud_cli(&app, &cloudmember::join_check_args(&url), None))
    })
    .await
    .unwrap_or_else(|_| cloudmember::failure("failed", ""))
}

/// 参加のリクエストを置き、確認コードと期限の目安を返す。参加コードは CLI の標準入力へ渡す。
/// 別のクラウドへの上書きの承認（overwrite）は、頁の段で済ませてある。省けば偽で、参加済みなら CLI が overwrite-required で断る。
#[tauri::command]
async fn cloud_join_request(
    app: AppHandle,
    url: String,
    code: String,
    overwrite: Option<bool>,
) -> serde_json::Value {
    if !cloudmember::valid_join_url(&url) {
        return cloudmember::failure("invalid-url", "");
    }
    if !cloudmember::valid_join_code(&code) {
        return cloudmember::failure("invalid-code", "");
    }
    let overwrite = overwrite.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        cloudmember::guarded(|| {
            run_cloud_cli(
                &app,
                &cloudmember::join_request_args(&url, overwrite),
                Some(&code),
            )
        })
    })
    .await
    .unwrap_or_else(|_| cloudmember::failure("failed", ""))
}

/// 承認されたかを 1 回だけ問い合わせる。承認なら CLI が cloud.json を書き終えてから approved を返す。
/// 問い合わせの間隔は頁が決める。参加したあとは、サーバを立て直すまで同期が始まらないので、頁が再起動を頼む。
#[tauri::command]
async fn cloud_join_poll(app: AppHandle) -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(move || {
        cloudmember::guarded(|| run_cloud_cli(&app, &cloudmember::join_poll_args(), None))
    })
    .await
    .unwrap_or_else(|_| cloudmember::failure("failed", ""))
}

/// ほかの PC を同期から解除する。受け取るのは端末 ID だけで、形を確かめる。
#[tauri::command]
async fn cloud_revoke(app: AppHandle, id: String) -> serde_json::Value {
    if !cloudmember::valid_device_id(&id) {
        return cloudmember::failure("invalid-id", "");
    }
    tauri::async_runtime::spawn_blocking(move || {
        cloudmember::guarded(|| {
            run_cloud_cli(
                &app,
                &["cloud", "revoke", id.as_str(), "--yes", "--json"],
                None,
            )
        })
    })
    .await
    .unwrap_or_else(|_| cloudmember::failure("failed", ""))
}

/// この PC の参加を解除する（cloud.json を消す。revoke が真ならクラウドでもこの PC を解除する）。
/// 解除したあとは、サーバを立て直すまで手元の同期が止まらないので、頁が再起動を頼む。
#[tauri::command]
async fn cloud_leave(app: AppHandle, revoke: bool) -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(move || {
        cloudmember::guarded(|| run_cloud_cli(&app, &cloudmember::leave_args(revoke), None))
    })
    .await
    .unwrap_or_else(|_| cloudmember::failure("failed", ""))
}

/// `~/.agent-hangar/desktop.log` を開く。起動画面と、UI の切断の帯の「ログを開く」が呼ぶ。
#[tauri::command]
async fn open_log() -> Result<(), String> {
    let home = paths::hangar_home();
    ensure_hangar_home(&home);
    logfile::open_log(&home).inspect_err(|e| log(&format!("open log failed: {e}")))
}

/// ターミナルに出たリンクを既定のブラウザで開く。UI のターミナルの修飾キー付きのクリックが呼ぶ（links.rs）。
/// http と https のほかは断る。
#[tauri::command]
async fn open_link(url: String) -> Result<(), String> {
    links::open_link(&url).inspect_err(|e| log(&format!("open link failed: {e}")))
}

/// アプリを再起動する。UI の切断の帯の「再起動」が呼ぶ。
/// 終了の手続き（`RunEvent::Exit`）を通るので、子のサーバも止めてから起き直す。
#[tauri::command]
fn restart_app(app: AppHandle) {
    log("restart requested from the UI");
    app.request_restart();
}

/// 子のサーバを止める。終了の手続き（`RunEvent::Exit`）と、Windows で更新のインストーラへ渡す直前に呼ぶ。
/// 止めても、tmux（Windows は psmux）の中のセッションは動き続ける。
/// 止め方は `ServerProcess::stop` にある。Windows は標準入力の管を閉じて待ち、残ればジョブごと止める（server.rs、winjob.rs）。
fn stop_server(app: &AppHandle) {
    if let Some(mut p) = app.state::<AppState>().server.lock().unwrap().take() {
        p.stop();
        log("server stopped");
    }
}

/// 動いている版と、取得の進みを返す。頁は起動したときに版を読み、取得の最中は繰り返し呼ぶ。
#[tauri::command]
fn update_status(app: AppHandle) -> updater::Status {
    let (done, total) = app.state::<updater::UpdateSlot>().progress.snapshot();
    updater::Status {
        current: app.package_info().version.to_string(),
        done,
        total,
    }
}

/// GitHub の Release の目録を引き、新しい版があればその版を返す。見つけた版は取得のために持っておく。
/// 取得からインストールまでの途中は、目録を引かずに途中の版を返し、見つけた版を差し替えない（`updater::Flow`）。
/// UI と起動画面の「更新を確認」が呼ぶ。起動に失敗したときは殻も 1 度だけ自分で呼ぶ（`check_update_after_failure`）。
/// 頁どうしは互いの途中を知らないので、別の頁の取得の最中にも呼ばれる。
#[tauri::command]
async fn update_check(app: AppHandle) -> Result<updater::Found, updater::Failure> {
    find_update(&app).await
}

/// `update_check` の中身。
async fn find_update(app: &AppHandle) -> Result<updater::Found, updater::Failure> {
    let slot = app.state::<updater::UpdateSlot>();
    let busy = slot.flow.lock().unwrap().busy_version();
    if let Some(version) = busy {
        log(&format!("update: checked while {version} is in progress"));
        return Ok(updater::Found {
            version: Some(version),
            notes: None,
        });
    }
    let handle = app.clone();
    // Windows ではインストーラへ渡すとき、updater が std::process::exit で抜ける。終了の手続きを通らないので、ここで子のサーバを止める。
    let found = app
        .updater_builder()
        .on_before_exit(move || {
            log("update: handing over to the installer");
            stop_server(&handle);
            handle.cleanup_before_exit();
        })
        .build()
        .map_err(|e| update_failed("check", &e))?
        .check()
        .await
        .map_err(|e| update_failed("check", &e))?;
    let seen = found.as_ref().map(|u| u.version.clone());
    let notes = found
        .as_ref()
        .and_then(|u| u.body.clone())
        .filter(|b| !b.trim().is_empty());
    let checked = slot.flow.lock().unwrap().checked(found);
    let (version, notes) = match checked {
        updater::Checked::Kept(version) => {
            log(&format!(
                "update: checked, found {}",
                version.as_deref().unwrap_or("none")
            ));
            (version, notes)
        }
        // 目録を引いている間に、別の頁が取得を始めていた。見つけた版は捨て、途中の版を答える。
        updater::Checked::Busy(version) => {
            log(&format!(
                "update: checked, found {} but kept {version} in progress",
                seen.as_deref().unwrap_or("none")
            ));
            (Some(version), None)
        }
    };
    Ok(updater::Found { version, notes })
}

/// 見つけた版を取得し、公開鍵で署名を確かめて持っておく。進みは update_status で読める。
/// 取得が済んでいれば取りに行かずに済んだと答え、取得の最中ならもう 1 本は断る。
#[tauri::command]
async fn update_download(app: AppHandle) -> Result<(), updater::Failure> {
    let slot = app.state::<updater::UpdateSlot>();
    let begin = slot.flow.lock().unwrap().begin_download();
    let update = match begin.map_err(|e| update_refused("download", e))? {
        updater::Begin::Fetch(update) => update,
        updater::Begin::Ready => return Ok(()),
    };
    slot.progress.reset();
    let result = update
        .download(|chunk, total| slot.progress.record(chunk, total), || {})
        .await;
    match result {
        Ok(bytes) => {
            log(&format!("update: downloaded {}", update.version));
            // 中身は取得を始めた版の段にだけ置く（`Flow::finish_download`）。
            if slot
                .flow
                .lock()
                .unwrap()
                .finish_download(&update.version, Some(bytes))
            {
                Ok(())
            } else {
                Err(update_refused(
                    "download",
                    "the update changed while downloading",
                ))
            }
        }
        Err(e) => {
            slot.flow
                .lock()
                .unwrap()
                .finish_download(&update.version, None);
            Err(update_failed("download", &e))
        }
    }
}

/// 取得した更新物を入れ、アプリを再起動する。
/// macOS は .app を入れ替えてから終了の手続きを通って起き直す（子のサーバも止まる）。
/// Windows はインストーラを起こして updater がそのまま抜け、インストーラが入れ終えてから起こし直す。
/// どちらでも tmux（psmux）の中のセッションは止まらない。
#[tauri::command]
async fn update_install(app: AppHandle) -> Result<(), updater::Failure> {
    let slot = app.state::<updater::UpdateSlot>();
    let begin = slot.flow.lock().unwrap().begin_install();
    // 版と中身は取得済みの段から一緒に受け取るので、取得した版と入れる版は必ず同じである。
    let (update, bytes) = begin.map_err(|e| update_refused("install", e))?;
    log(&format!("update: installing {}", update.version));
    // 入れ替えは管理者の許可を尋ねることがあり、答えを待つので、窓の描画を止めないよう別のスレッドで行う。
    let result = tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| updater::Failure::other(e.to_string()))
        .and_then(|r| r.map_err(|e| update_failed("install", &e)));
    if let Err(e) = result {
        slot.flow.lock().unwrap().install_failed();
        return Err(e);
    }
    log("update: installed, restarting");
    app.request_restart();
    Ok(())
}

/// 段が合わずに断った命令をログに 1 行残し、頁へ返す形にする。
fn update_refused(step: &str, detail: &str) -> updater::Failure {
    log(&format!("update: {step} refused: {detail}"));
    updater::Failure::other(detail)
}

/// 更新の失敗をログに 1 行残し、頁へ返す形にする。
fn update_failed(step: &str, e: &tauri_plugin_updater::Error) -> updater::Failure {
    let f = updater::Failure::from(e);
    log(&format!("update: {step} failed ({}): {}", f.kind, f.detail));
    f
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
        return Err("すでに起動しています".to_string());
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

/// 入力待ちと、戻る時刻を過ぎた知らせの通知を出す。
/// 頁（UI）は、入力待ちになったときと、その問いの文が後から届いたとき、戻る時刻を過ぎたときに呼ぶ。
/// 種類（kind）は waiting か return で、種類ごとに通知の枠を分ける（notify::Kind）。渡さなければ入力待ちとみなす。
/// 問いの文の無い入力待ち（bare）は、問いの文が届くまで少し預かり、1 回にまとめて出す（notify::hold）。
/// 窓が前にあるかは、頁ではなくここで窓の実物の様子から、出す瞬間に決め、前にあれば出さない（notify::window_in_front）。
/// 値は頁から来るので、notify::waiting で確かめてから OS に渡す。
#[tauri::command]
fn notify_waiting(
    app: AppHandle,
    session_id: String,
    title: String,
    body: String,
    kind: Option<String>,
    bare: Option<bool>,
) -> Result<(), String> {
    let kind = notify::Kind::parse(kind.as_deref())?;
    deliver_notice(
        &app,
        kind,
        &session_id,
        &title,
        &body,
        bare.unwrap_or(false),
    )
}

/// 確かめてから、預かり（notify::hold）を通して出す。頁の `notify_waiting` と、サーバの並び（notify::feed）の両方が通る。
fn deliver_notice(
    app: &AppHandle,
    kind: notify::Kind,
    session_id: &str,
    title: &str,
    body: &str,
    bare: bool,
) -> Result<(), String> {
    // 題や本文が空のときの代わりの文は、殻の頁と同じ言語で書く。
    let lang = bootfail::page_language(&paths::hangar_home());
    let w = notify::waiting(kind, session_id, title, body, lang)?;
    let app = app.clone();
    let session_id = session_id.to_string();
    match notify::hold::offer(w, bare) {
        notify::hold::Offer::Show(w) => show_unless_in_front(&app, &w),
        notify::hold::Offer::Hold(token) => {
            // 頁の時計は絞られるので、殻のスレッドで待つ。
            std::thread::spawn(move || {
                std::thread::sleep(notify::hold::HOLD);
                if let Some(w) = notify::hold::due(&session_id, token) {
                    show_unless_in_front(&app, &w);
                }
            });
        }
        notify::hold::Offer::Wait => {}
        notify::hold::Offer::Late => {
            log("notification not shown again: the question came after the hold")
        }
    }
    Ok(())
}

/// 窓が前になければ通知を出す。
/// 預かった通知も、出す瞬間の窓の様子で決める。
fn show_unless_in_front(app: &AppHandle, w: &notify::Waiting) {
    if let Some(win) = app.get_webview_window("main") {
        let visible = win.is_visible().unwrap_or(false);
        let minimized = win.is_minimized().unwrap_or(false);
        let focused = win.is_focused().unwrap_or(false);
        // Windows では、フォーカスが WebView2 の子窓にあると is_focused が偽になるので、OS の前景の窓でも見る。
        #[cfg(windows)]
        let focused = focused || win.hwnd().is_ok_and(notify::window_owns_foreground);
        if notify::window_in_front(visible, minimized, focused) {
            log("notification skipped: the window is in front");
            return;
        }
    }
    notify::show(w);
}

/// もう待っていないセッションの知らせを、通知センターから外す。
/// 頁は、いま入力待ちのセッション（waiting）と、今日の戻る時刻を過ぎてまだ Paused のセッション（returning）と、使用制限でリセットを待っているセッション（limited）を渡す。
/// limited を渡さない前の版の頁では、使用制限の知らせは残さない。
/// 頁が呼ぶのは、その顔ぶれが変わったときと、起動して一覧を読み終えたときである。
/// 窓が前にあっても外す（答えた入力待ちの知らせを通知センターに残さない）。
#[tauri::command]
fn notify_prune(waiting: Vec<String>, returning: Vec<String>, limited: Option<Vec<String>>) {
    let keep = notify::Keep::new(&waiting, &returning).with_limited(&limited.unwrap_or_default());
    // 答えた入力待ちの、まだ出していない預かりも捨てる。
    notify::hold::prune(&keep);
    notify::prune(keep);
}

/// 利用者が通知を受け取ると選んでいるかを、頁が殻に伝える（設定のスイッチ、localStorage の `notify.waiting`）。
/// 頁は起動したときと、スイッチを変えたときに呼ぶ。サーバの並び（notify::feed）の通知は、これが真のときだけ出す。
#[tauri::command]
fn notify_feed(on: bool) {
    notify::feed::set_enabled(on);
}

/// サーバが組んだ通知（`GET /api/notify/feed`）を読み続け、窓が前になければ OS へ渡す（notify::feed）。
/// 長いポーリングで読むので、通知が無い間はサーバが応答を待たせ、殻は 25 秒に 1 回だけ聞き直す。
/// 読めなかったら（サーバが起き直している、止まっている）2 秒おいて読み直す。
/// 起動のやり直しで 2 本目を起こさない。
fn watch_notices(app: AppHandle, addr: SocketAddr, token: String) {
    if !notify::feed::start_once() {
        return;
    }
    std::thread::spawn(move || {
        let mut cursor = notify::feed::Cursor::default();
        let auth = format!("Bearer {token}");
        loop {
            let got = health::http_get_with(
                addr,
                &cursor.path(),
                &[("Authorization", auth.as_str())],
                notify::feed::READ_TIMEOUT,
            );
            let items = match got {
                Some((200, body)) => cursor.take(&body),
                _ => None,
            };
            let Some(items) = items else {
                std::thread::sleep(notify::feed::RETRY_AFTER);
                continue;
            };
            for i in items {
                if !notify::feed::enabled() {
                    continue;
                }
                if let Err(e) =
                    deliver_notice(&app, i.kind, &i.session_id, &i.title, &i.body, i.bare)
                {
                    log(&format!("notification from the server refused: {e}"));
                }
            }
        }
    });
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
        // 参加リクエストの知らせ（notify::JOIN_SESSION）は、セッションではなく設定のクラウド同期の節を貯める。
        apply_hash(app, notify::open_hash(session_id));
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

/// 二つ目の起動が降りる前に、最初の側で呼ばれる。
/// 渡された hangar:// は、deep-link のプラグインが先に `on_open_url` へ回している。
/// トーストの印（`-ToastActivated`）は中身を持たない。押されたセッションは COM の口が最初の側へ直に届ける（notify.rs）。
/// ここでは、最初の窓を前に出し、何が渡されたかをログに残す。
#[cfg(not(target_os = "macos"))]
fn second_launch(app: &AppHandle, args: &[String]) {
    log(&instance::describe(args));
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 最初の窓を、いるモニタの作業域（タスクバーを除いた範囲）に収める。
/// 収まっていれば動かさない。
/// macOS では呼ばない（窓の位置は OS に任せたままにする）。
#[cfg(not(target_os = "macos"))]
fn fit_main_window(app: &AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let monitor = match w.current_monitor() {
        Ok(Some(m)) => Some(m),
        _ => w.primary_monitor().ok().flatten(),
    };
    let (Some(m), Ok(pos), Ok(outer), Ok(inner)) =
        (monitor, w.outer_position(), w.outer_size(), w.inner_size())
    else {
        return;
    };
    let work = m.work_area();
    let window = placement::Rect {
        x: pos.x,
        y: pos.y,
        w: outer.width,
        h: outer.height,
    };
    let area = placement::Rect {
        x: work.position.x,
        y: work.position.y,
        w: work.size.width,
        h: work.size.height,
    };
    let Some(fitted) = placement::fit(window, area) else {
        return;
    };
    let (iw, ih) = placement::inner_size(
        fitted,
        (outer.width, outer.height),
        (inner.width, inner.height),
    );
    let _ = w.set_size(tauri::PhysicalSize::new(iw, ih));
    let _ = w.set_position(tauri::PhysicalPosition::new(fitted.x, fitted.y));
    log(&format!(
        "window fitted to the work area: {}x{} at {},{} (was {}x{} at {},{})",
        fitted.w, fitted.h, fitted.x, fitted.y, window.w, window.h, window.x, window.y
    ));
}

/// 「View」の「Reload」の項目の id。
#[cfg(target_os = "macos")]
const RELOAD_MENU_ID: &str = "hangar-reload";

/// macOS のメニュー。Tauri の既定のメニューの「View」の頭に「Reload」（⌘R）を足す。
/// 既定のメニューの項目名は英語なので、足す項目も英語でそろえる。
/// ⌘R は先に頁の keydown が受けて既定を止める（keys.ts の app.reload）ので、打鍵で二度は読み直さない。メニューから選んだときだけここが読み直す。
/// Windows と Linux の窓はメニューバーを持たないので、足さない（F5 と Ctrl+Shift+R は頁が受ける）。
#[cfg(target_os = "macos")]
fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let menu = Menu::default(app)?;
    for item in menu.items()? {
        let Some(sub) = item.as_submenu() else {
            continue;
        };
        if sub.text()? != "View" {
            continue;
        }
        let reload = MenuItem::with_id(app, RELOAD_MENU_ID, "Reload", true, Some("CmdOrCtrl+R"))?;
        sub.prepend_items(&[&reload, &PredefinedMenuItem::separator(app)?])?;
    }
    Ok(menu)
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu).on_menu_event(|app, event| {
        if event.id() == RELOAD_MENU_ID {
            log("reload from the menu");
            eval_main(app, "location.reload()");
        }
    });
    // 二つ目の起動を最初の殻へまとめる。プラグインの決まりで、ほかのプラグインより先に付ける。
    // 二つ目の殻は、窓を作る前にここで降りる。
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        second_launch(app, &args)
    }));
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        // 自動更新。目録の URL と公開鍵は tauri.conf.json の plugins.updater にあり、頁からは変えられない。
        // プラグインの JS の命令は capabilities で与えず、頁は上の update_* の 4 つだけを呼ぶ。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::UpdateSlot::default())
        .manage(AppState {
            server: Mutex::new(None),
            ui: Mutex::new(Ui::default()),
            booting: AtomicBool::new(false),
            child_started: Mutex::new(None),
            config_busy: AtomicBool::new(false),
            approve: Mutex::new(None),
            boot_probe: bootprobe::target(std::env::var_os(bootprobe::ENV)),
        })
        // 頁から呼べる殻の命令は、この 1 か所でまとめて登録する。
        // invoke_handler を 2 度呼ぶと後のものだけが残り、先に並べた命令が呼べなくなる。
        // 頁ごとに許す命令は capabilities/ の remote-shell.json、remote-notify.json、remote-pick-folder.json、remote-config-apply.json、remote-update.json、remote-cloud.json、remote-save-recovery-key.json、boot-screen.json で絞る。
        .invoke_handler(tauri::generate_handler![
            boot_state,
            boot_card_shown,
            boot_probe,
            open_link,
            open_log,
            pick_folder,
            pick_node,
            restart_app,
            retry_boot,
            notify_waiting,
            notify_prune,
            notify_feed,
            notify_request,
            notify_status,
            apply_config_sync,
            restore_config_sync,
            setup_integration,
            approve_view,
            approve_answer,
            cloud_join_check,
            cloud_join_request,
            cloud_join_poll,
            cloud_revoke,
            cloud_leave,
            save_recovery_key,
            update_status,
            update_check,
            update_download,
            update_install
        ])
        // 頁の読み込みが終わる前の評価は捨てられることがある。
        // 出しそこねた文言と、navigate の最中に届いたリンクをここで流す。
        .on_page_load(|webview, payload| {
            // 承認の窓（approve）の読み込みは、main の窓の段の数え方に混ぜない。
            if webview.label() != "main" {
                return;
            }
            if matches!(payload.event(), PageLoadEvent::Finished) {
                page_loaded(webview.app_handle(), is_server_page(payload.url()));
            }
        })
        .setup(|app| {
            log("setup");
            #[cfg(not(target_os = "macos"))]
            fit_main_window(app.handle());
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
            tempclean::sweep_in_background(app.package_info(), log);
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
            // ファイルを落とせるのは main の窓だけである。承認の窓に落とされたものは捨てる。
            RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Enter { position, .. }),
                ..
            } if label == "main" => file_dragged(app, Some(position)),
            RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Over { position }),
                ..
            } if label == "main" => file_dragged(app, Some(position)),
            RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Leave),
                ..
            } if label == "main" => file_dragged(app, None),
            RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }),
                ..
            } if label == "main" => {
                // 写している間も色は戻す。落とし先への添付は、写し終わってから hangar:drop で届く。
                file_dragged(app, None);
                file_dropped(app, paths, position)
            }
            RunEvent::ExitRequested { code, .. } => log(&match code {
                None => "exit requested by the user".to_string(),
                Some(c) => format!("exit requested with code {c}"),
            }),
            RunEvent::Exit => stop_server(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    // フォルダの選択のダイアログに親の窓を渡すのは Windows だけ。
    // macOS で渡すと窓に付くシートに変わって見た目が変わる。窓が取れなければ、どちらでも親なしで開く。
    #[test]
    fn the_folder_dialog_gets_a_parent_window_only_on_windows() {
        assert_eq!(dialog_parent(true, Some("w")), Some("w"));
        assert_eq!(dialog_parent(true, None::<&str>), None);
        assert_eq!(dialog_parent(false, Some("w")), None);
        assert_eq!(dialog_parent(false, None::<&str>), None);
    }

    fn boot_at(phase: health::Phase, done: u64, total: u64) -> health::Boot {
        health::Boot {
            ready: false,
            phase,
            done,
            total,
        }
    }

    // 起動画面の口（boot.js）が出来る前の評価は捨てられる。
    // macOS では、読み込みの合図（PageLoadEvent::Finished）の時点でもまだ口が無く、合図で渡し直した失敗も落ちた。
    // 殻は失敗を状態として持ち続け、頁が口を作り終えてから問い合わせたとき（boot_state）に渡す。
    #[test]
    fn a_failure_from_before_the_page_is_ready_is_kept_for_the_page_to_take() {
        let mut ui = Ui::default();
        assert_eq!(
            ui.boot_state(),
            serde_json::json!({ "failure": null, "progress": null, "finishing": false, "update": null })
        );
        ui.failure = Some(serde_json::json!({ "kind": "other", "detail": "Node" }));
        // 読み込みの合図が先に来ても、失敗は消さない。
        ui.page_loaded(false);
        let want = serde_json::json!({ "kind": "other", "detail": "Node" });
        assert_eq!(ui.boot_state()["failure"], want);
        // 頁が二度問い合わせても（読み込み直しなど）、同じ失敗を渡す。
        assert_eq!(ui.boot_state()["failure"], want);
    }

    // 進み具合と、読み込みが終わった合図も、頁が問い合わせたときに渡す。
    #[test]
    fn the_progress_and_the_finish_signal_are_kept_for_the_page_to_take() {
        let ui = Ui {
            last_progress: Some(boot_at(health::Phase::Indexing, 412, 987)),
            finishing: true,
            ..Default::default()
        };
        assert_eq!(
            ui.boot_state(),
            serde_json::json!({
                "failure": null,
                "progress": { "phase": "indexing", "done": 412, "total": 987 },
                "finishing": true,
                "update": null
            })
        );
    }

    // 起動に失敗したとき、殻は 1 度だけ自分で更新を確かめる。見つけた版は状態に置き、起動画面が問い合わせたときにも渡す。
    // 起動に失敗する版を入れた人が、UI まで届かなくても、起動画面から新しい版を受け取れるようにするためである。
    #[test]
    fn an_update_found_after_a_failure_is_kept_for_the_page_and_survives_a_retry() {
        let mut ui = Ui::default();
        ui.page_loaded(false);
        ui.failure = Some(serde_json::json!({ "kind": "server-exited" }));
        assert!(ui.update_found("0.2.1".into()));
        assert_eq!(
            ui.boot_state()["update"],
            serde_json::json!({ "version": "0.2.1" })
        );
        // やり直しても、新しい版があることは変わらない。読み込み直した頁の札にも出す。
        assert!(ui.retry());
        assert_eq!(
            ui.boot_state()["update"],
            serde_json::json!({ "version": "0.2.1" })
        );
    }

    // サーバの頁へ移った後に見つかった版は、起動画面へ渡さない（UI が自分で知らせる）。
    // 起動に失敗しても、殻はその場では更新を確かめない。札の最初の描画と、目録の取得や証明書の検証を重ねないためである。
    // 起動画面が札を描いたと知らせてから（boot_card_shown）、1 度だけ確かめる。やり直して読み込み直した頁が知らせても、重ねない。
    #[test]
    fn the_update_check_waits_for_the_card_and_runs_once() {
        let mut ui = Ui::default();
        ui.page_loaded(false);
        // 失敗の前（待っている間）に知らせが来ても確かめない。
        assert!(!ui.card_shown());
        ui.failure = Some(serde_json::json!({ "kind": "node-missing" }));
        assert!(ui.card_shown());
        assert!(!ui.card_shown());
        assert!(ui.retry());
        ui.page_loaded(false);
        ui.failure = Some(serde_json::json!({ "kind": "node-missing" }));
        assert!(!ui.card_shown());
    }

    // サーバの頁へ移った後は、札を描いた知らせが来ても確かめない（UI が自分で確かめる）。
    #[test]
    fn the_card_signal_after_the_server_page_does_not_check() {
        let mut ui = Ui {
            failure: Some(serde_json::json!({ "kind": "other" })),
            ..Default::default()
        };
        ui.navigating();
        assert!(!ui.card_shown());
    }

    #[test]
    fn an_update_found_after_the_server_page_is_not_passed_to_the_boot_screen() {
        let mut ui = Ui::default();
        ui.page_loaded(false);
        ui.navigating();
        assert!(!ui.update_found("0.2.1".into()));
        assert_eq!(ui.boot_state()["update"], serde_json::Value::Null);
    }

    // 見つけた版を起動画面へ渡す式。版は JSON の文字として埋め、式を壊す字が混じっても外へ出さない。
    #[test]
    fn the_update_signal_embeds_the_version_as_json() {
        assert_eq!(
            boot_update_js("0.2.1"),
            r#"window.__hangarBootUpdate && window.__hangarBootUpdate({"version":"0.2.1"})"#
        );
        assert_eq!(
            boot_update_js(r#"1");alert("x"#),
            r#"window.__hangarBootUpdate && window.__hangarBootUpdate({"version":"1\");alert(\"x"})"#
        );
    }

    // サーバの頁へ移った後は、起動画面の様子を渡さない。UI の DOM を書き換えないためである。
    #[test]
    fn the_server_page_gets_no_boot_state() {
        let mut ui = Ui {
            failure: Some(serde_json::json!({ "kind": "other" })),
            last_progress: Some(boot_at(health::Phase::Indexing, 1, 2)),
            finishing: true,
            ..Default::default()
        };
        ui.navigating();
        assert_eq!(
            ui.boot_state(),
            serde_json::json!({ "failure": null, "progress": null, "finishing": false, "update": null })
        );
    }

    // 起動と同時に届いたリンクは、最初の navigate の URL の末尾に載せる。
    #[test]
    fn the_first_hash_rides_on_the_entry_url() {
        let mut ui = Ui::default();
        ui.page_loaded(false);
        assert_eq!(ui.hash_to_eval("#/session/1".to_string()), None);
        assert_eq!(ui.navigating(), "#/session/1");
        // 取り出した後は残さない。
        assert_eq!(ui.page_loaded(true), None);
    }

    // ready を立ててから読み込みが終わるまでの窓で届いたリンクも落とさない。
    #[test]
    fn a_hash_arriving_while_navigating_is_flushed_after_the_load() {
        let mut ui = Ui::default();
        ui.page_loaded(false);
        assert_eq!(ui.navigating(), "");
        assert_eq!(ui.hash_to_eval("#/session/2".to_string()), None);
        assert_eq!(ui.page_loaded(true), Some("#/session/2".to_string()));
        // サーバの頁が出来た後は、その場で評価する。
        assert_eq!(
            ui.hash_to_eval("#/project/3".to_string()),
            Some("#/project/3".to_string())
        );
    }

    // navigate に至らなかったときは読み込み画面がそのまま残る。
    // その後の失敗は、残った起動画面が問い合わせれば受け取れる。
    #[test]
    fn a_failed_navigation_puts_the_loading_page_back() {
        let mut ui = Ui::default();
        ui.page_loaded(false);
        ui.navigating();
        ui.navigation_failed();
        ui.failure = Some(serde_json::json!({ "kind": "other" }));
        assert_eq!(
            ui.boot_state()["failure"],
            serde_json::json!({ "kind": "other" })
        );
        // ready は降りているので、次のリンクは貯める側へ回る。
        assert_eq!(ui.hash_to_eval("#/session/4".to_string()), None);
    }

    // 起動に失敗した後の「もう一度試す」。殻は読み込み画面を読み込み直してから起動をやり直す。
    // 前の失敗、進み具合、合図は、新しい頁へ持ち込まない。
    // やり直しの後の失敗は、読み込み直した頁が問い合わせたときに渡す。
    #[test]
    fn a_retry_reloads_the_loading_page_and_holds_new_failures_for_it() {
        let mut ui = Ui::default();
        ui.page_loaded(false);
        ui.failure = Some(serde_json::json!({ "kind": "server-exited" }));
        ui.last_progress = Some(boot_at(health::Phase::Scanning, 0, 0));
        ui.finishing = true;
        assert!(ui.retry());
        assert_eq!(
            ui.boot_state(),
            serde_json::json!({ "failure": null, "progress": null, "finishing": false, "update": null })
        );
        ui.failure = Some(serde_json::json!({ "kind": "other" }));
        assert_eq!(
            ui.boot_state()["failure"],
            serde_json::json!({ "kind": "other" })
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
        assert_eq!(ui.page_loaded(false), None);
        // サーバの頁の合図でだけ流れる。
        assert_eq!(ui.page_loaded(true), Some("#/session/5".to_string()));
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
            sep: "/",
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
                home: String::new(),
                sep: "/",
            }
        )
        .contains("abc123"));
    }

    // 頁へ渡す前に、鍵を伏せ、ホームを ~ に縮める。サーバが書いた params のパスも同じく縮める。
    #[test]
    fn the_failure_for_the_page_hides_the_token_and_the_user_name() {
        let f = bootfail::parse_boot_error(
            r#"{"kind":"db-too-old","params":{"file":"/Users/me/.agent-hangar/hangar.db","found":3},"detail":"open /Users/me/.agent-hangar/hangar.db?t=abc123"}"#,
        )
        .unwrap();
        let f = for_page(f, Some("abc123"), std::path::Path::new("/Users/me"));
        assert_eq!(f.params["file"], "~/.agent-hangar/hangar.db");
        assert!(!f.detail.contains("abc123"), "{}", f.detail);
        assert!(!f.detail.contains("/Users/me"), "{}", f.detail);
        let f = for_page(
            bootfail::BootFailure::other("x /Users/me/y"),
            None,
            std::path::Path::new("/Users/me"),
        );
        assert_eq!(f.detail, "x ~/y");
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
