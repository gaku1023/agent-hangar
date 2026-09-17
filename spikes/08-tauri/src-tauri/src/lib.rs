use std::io::Write;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

struct Server(Mutex<Option<Child>>);

fn log(msg: &str) {
    let home = std::env::var("HOME").unwrap_or_default();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(format!("{home}/.agent-hangar-spike/tauri.log")) {
        let _ = writeln!(f, "{} {}", chrono_like_now(), msg);
    }
}
fn chrono_like_now() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
    format!("{}", d.as_millis())
}

fn find_node() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let mut candidates = vec!["/opt/homebrew/bin/node".to_string(), "/usr/local/bin/node".to_string()];
    if let Ok(rd) = std::fs::read_dir(format!("{home}/.nvm/versions/node")) {
        let mut vs: Vec<_> = rd.flatten().map(|e| e.path()).collect();
        vs.sort(); vs.reverse();                       // 新しい版を優先
        for p in vs { candidates.push(format!("{}/bin/node", p.display())); }
    }
    candidates.into_iter().map(std::path::PathBuf::from).find(|p| p.exists())
}

fn server_script() -> Option<String> {
    if let Ok(s) = std::env::var("HANGAR_SPIKE_SERVER") { return Some(s); }
    let home = std::env::var("HOME").ok()?;
    std::fs::read_to_string(format!("{home}/.agent-hangar-spike/server-path")).ok().map(|s| s.trim().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            log(&format!("setup: PATH={:?}", std::env::var("PATH").unwrap_or_default()));
            let node = find_node().expect("node not found");
            let script = server_script().expect("server script path missing");
            log(&format!("spawning {} {}", node.display(), script));
            let child = Command::new(&node).arg(&script)
                .env("HANGAR_TMUX_BIN", "/opt/homebrew/bin/tmux")
                .spawn()?;
            log(&format!("server pid {}", child.id()));
            app.manage(Server(Mutex::new(Some(child))));
            app.deep_link().on_open_url(|event| {
                log(&format!("deep link: {:?}", event.urls()));
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut c) = app.state::<Server>().0.lock().unwrap().take() {
                    let _ = c.kill();
                    log("server killed on exit");
                }
            }
        });
}
