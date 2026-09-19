//! agent-hangar のデスクトップシェル。
//! 起動時に同梱サーバを子プロセスとして立て、`/health` が通ったらウィンドウをサーバの URL へ移す。
//! `hangar://` のディープリンクは UI のハッシュ経路に変換して webview に流す。

pub mod deeplink;
pub mod health;
pub mod node;
pub mod paths;
pub mod server;

use std::io::Write;
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_deep_link::DeepLinkExt;

/// アプリ全体で共有する状態。
struct AppState {
    server: Mutex<Option<server::ServerProcess>>,
    /// ウィンドウがサーバの URL を表示しているか。偽の間に届いたディープリンクは pending に貯める。
    ready: Mutex<bool>,
    pending_hash: Mutex<Option<String>>,
}

/// `~/.agent-hangar/desktop.log` に 1 行追記する。サーバの標準出力も同じファイルに流れる。
/// 入場の鍵は決してここへ書かない。
fn log(line: &str) {
    let home = paths::hangar_home();
    let _ = std::fs::create_dir_all(&home);
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

/// 読み込み画面の文言を差し替える。サーバへ移る前だけ意味を持つ。
fn set_status(app: &AppHandle, text: &str, error: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let js = format!(
            "(function(){{var s=document.getElementById('status');if(!s)return;s.textContent={};s.dataset.level={};}})();",
            serde_json::to_string(text).unwrap_or_default(),
            if error { "'error'" } else { "''" }
        );
        let _ = w.eval(&js);
    }
}

fn fail(app: &AppHandle, msg: &str) {
    log(msg);
    set_status(app, msg, true);
}

/// ディープリンクをハッシュとして適用する。準備前なら保持して、最初のナビゲーションに乗せる。
/// 読み込みの最中に `location.hash` を評価で書くと、その読み込みでハッシュごと捨てられることがある。
/// なので一件目は navigate する URL の末尾に付け、二件目以降だけを評価で渡す。
fn apply_hash(app: &AppHandle, hash: String) {
    let state = app.state::<AppState>();
    let ready = state.ready.lock().unwrap();
    if *ready {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.eval(&deeplink::hash_to_js(&hash));
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    } else {
        *state.pending_hash.lock().unwrap() = Some(hash);
    }
}

/// 届いた URL をハッシュに直して流す。起動時の取りこぼしを防ぐため、
/// `on_open_url` と `get_current` の両方からここへ来る。
fn handle_urls(app: &AppHandle, urls: &[url::Url]) {
    for u in urls {
        log(&format!("deep link {u}"));
        match deeplink::deep_link_to_hash(u.as_str()) {
            Some(hash) => apply_hash(app, hash),
            None => log("deep link ignored"),
        }
    }
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
    if !health::wait_for_health(addr, Duration::from_secs(20)) {
        return Err(
            "サーバが 20 秒以内に応答しませんでした。~/.agent-hangar/desktop.log を確認してください。"
                .to_string(),
        );
    }
    Ok(())
}

/// 起動の本体。別スレッドで走り、ウィンドウはその間読み込み画面を出している。
fn boot(app: AppHandle) {
    let hangar_home = paths::hangar_home();
    let _ = std::fs::create_dir_all(&hangar_home);
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

    // ready の切り替えと pending の取り出しは同じロックの下で行い、その隙に届いたリンクを落とさない。
    let url = {
        let state = app.state::<AppState>();
        let mut ready = state.ready.lock().unwrap();
        let hash = state
            .pending_hash
            .lock()
            .unwrap()
            .take()
            .unwrap_or_default();
        *ready = true;
        server::entry_url(server::PORT, &token, &hash)
    };
    // 鍵は URL に載るので、ログには載せない。行き先はハッシュだけを残して書く。
    log("navigating to the server");
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(u) = tauri::Url::parse(&url) {
            let _ = w.navigate(u);
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .manage(AppState {
            server: Mutex::new(None),
            ready: Mutex::new(false),
            pending_hash: Mutex::new(None),
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
