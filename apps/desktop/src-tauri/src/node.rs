//! Node の探索。PATH に頼らず、決まった候補を順に調べ、同梱したネイティブモジュールと ABI が合う版だけを採る。
use crate::bootmsg::Msg;
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 候補 1 つを調べてよい時間。
/// 実測では、実物の Node が答えるまで 77 ミリ秒、shell の包みを挟んだ偽の node でも 300 ミリ秒だった。
/// その 16 倍を上限に取る。
/// 初回起動時の署名の検査、冷えたディスクからの読み出し、混んだ機械での立ち上がりを見込んだ余裕である。
/// 一方で、候補が全部だんまりでも読み込み画面が固まったままにならない長さに収めてある。
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// 候補から読み取る標準出力の上限。
/// 期待する出力は 20 バイトほどなので、これを超えて出し続ける相手は Node ではない。
/// 上限に達したら読むのをやめるので、出し続ける相手でもメモリはここで頭打ちになる。
const PROBE_OUTPUT_LIMIT: u64 = 64 * 1024;

/// 子が終わったあと、読み手から出力を受け取るのを待つ時間。
const PROBE_DRAIN: Duration = Duration::from_millis(500);

/// 同梱サーバのビルド条件。`server-dist/manifest.json` の内容。
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(rename = "nodeMajor")]
    pub node_major: u32,
    pub arch: String,
}

/// 候補の Node を起動して得た版とアーキテクチャ。
#[derive(Debug, Clone, PartialEq)]
pub struct NodeProbe {
    pub major: u32,
    pub arch: String,
}

/// 候補 1 つを調べた結果。
/// 利用者に次の一手を示すため、駄目だった理由を分けて持つ。
#[derive(Debug, Clone, PartialEq)]
pub enum ProbeOutcome {
    /// 起動できて、版とアーキテクチャが読めた。
    Ok(NodeProbe),
    /// そのパスにファイルが無い。
    Missing,
    /// ファイルはあるが起動できない。実行権が無い、壊れている、など。
    NotExecutable,
    /// 起動はしたが Node として答えなかった。失敗終了、読めない出力。
    Failed,
    /// 期限までに答えなかった。打ち切って子を止めた。
    TimedOut,
}

/// 調べた候補と結果。
#[derive(Debug, Clone, PartialEq)]
pub struct Tried {
    pub path: PathBuf,
    pub outcome: ProbeOutcome,
}

#[derive(Debug, Clone, PartialEq)]
pub enum NodeError {
    NotFound {
        manifest: Manifest,
        tried: Vec<Tried>,
    },
}

/// 同梱の `manifest.json` を読む。
/// 読めないときの文は、呼び手が頁の言語で作る（bootmsg.rs）。
pub fn read_manifest(server_dir: &Path) -> Result<Manifest, Msg> {
    let file = server_dir.join("manifest.json");
    let text = std::fs::read_to_string(&file).map_err(|e| Msg::ManifestUnreadable {
        file: file.display().to_string(),
        err: e.to_string(),
    })?;
    serde_json::from_str(&text).map_err(|e| Msg::ManifestBroken {
        file: file.display().to_string(),
        err: e.to_string(),
    })
}

/// `settings.json` の `nodePath`。空文字と null は無しとみなす。
pub fn settings_node_path(hangar_home: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(hangar_home.join("settings.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let s = v.get("nodePath")?.as_str()?.trim();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

fn parse_version(name: &str) -> Option<(u32, u32, u32)> {
    let mut it = name
        .strip_prefix('v')?
        .split('.')
        .map(|s| s.parse::<u32>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

/// 版ごとのディレクトリの名前から版を読む。
/// Homebrew の keg（`node@22`）はメジャー版だけ、版の管理ツールのもの（`v22.14.0`、`22.14.0`）は 3 つ組で読む。
/// mise の別名（`22`、`lts`、`latest`）は実体の版と重なるので、版と読まない。
/// 同梱の CLI（`scripts/hangar.sh` の `versions`）も同じ形だけを採る。
pub fn parse_dir_version(name: &str) -> Option<(u32, u32, u32)> {
    let digits = |s: &str| -> Option<u32> {
        if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        s.parse().ok()
    };
    if let Some(major) = name.strip_prefix("node@") {
        return Some((digits(major)?, 0, 0));
    }
    let mut it = name.strip_prefix('v').unwrap_or(name).split('.');
    let v = (
        digits(it.next()?)?,
        digits(it.next()?)?,
        digits(it.next()?)?,
    );
    if it.next().is_some() {
        return None;
    }
    Some(v)
}

/// `parent` の下の版ごとのディレクトリから、`leaf` にある Node を新しい版から順に並べる。
/// 実在するものだけを返す。
/// 実在しないパスを候補に混ぜると、`describe_error` の「調べた場所」が読みにくくなる。
fn versioned_node_paths(parent: &Path, leaf: &str) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut found: Vec<((u32, u32, u32), PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            parse_dir_version(&e.file_name().to_string_lossy()).map(|v| (v, e.path().join(leaf)))
        })
        .filter(|(_, p)| p.is_file())
        .collect();
    found.sort_by_key(|a| std::cmp::Reverse(a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// nvm が入れた Node を新しい版から順に並べる。
pub fn nvm_node_paths(user_home: &Path) -> Vec<PathBuf> {
    versioned_node_paths(&user_home.join(".nvm/versions/node"), "bin/node")
}

/// macOS（と Linux）の探索先の 1 行。
/// `~/` で始まるものは利用者のホームから、`/` で始まるものはファイルシステムの根から読む。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Place {
    /// 決まった 1 か所。実在しなくても調べた場所に挙げる。
    Fixed(&'static str),
    /// `parent` の下の版ごとのディレクトリ（`parse_dir_version` で読めるもの）の `leaf`。新しい版から並べる。
    Versions {
        parent: &'static str,
        leaf: &'static str,
    },
}

/// macOS（と Linux）の探索先。この順に調べ、manifest と同じメジャー版とアーキテクチャの最初の Node を採る。
/// Homebrew の `node@22` は keg-only で `/opt/homebrew/bin` にリンクされないので、keg の場所（`opt/node@N`）も見る。
/// 版の管理ツールは、PATH を切り替える仕掛け（fnm の multishells、nvm の current など）ではなく、版ごとの実体の場所を見る。
/// GUI のアプリの PATH は launchd の最小のものなので、PATH は見ない。
/// 利用者のログインシェルに PATH を訊く案は採らない（理由は docs/design.md の「プロセスと通信」）。
/// 同梱の CLI（`scripts/hangar.sh` の `node-places` の印の間）も同じ並びで探す。並びの一致は試験で縛る。
pub const UNIX_NODE_PLACES: &[Place] = &[
    Place::Fixed("/opt/homebrew/bin/node"),
    Place::Fixed("/usr/local/bin/node"),
    // Homebrew の keg-only の node@N。Apple silicon と Intel。
    Place::Versions {
        parent: "/opt/homebrew/opt",
        leaf: "bin/node",
    },
    Place::Versions {
        parent: "/usr/local/opt",
        leaf: "bin/node",
    },
    Place::Versions {
        parent: "~/.nvm/versions/node",
        leaf: "bin/node",
    },
    // fnm の既定の置き場は、macOS では Application Support、XDG を使う設定では .local/share、古い版では ~/.fnm。
    Place::Versions {
        parent: "~/Library/Application Support/fnm/node-versions",
        leaf: "installation/bin/node",
    },
    Place::Versions {
        parent: "~/.local/share/fnm/node-versions",
        leaf: "installation/bin/node",
    },
    Place::Versions {
        parent: "~/.fnm/node-versions",
        leaf: "installation/bin/node",
    },
    Place::Versions {
        parent: "~/.volta/tools/image/node",
        leaf: "bin/node",
    },
    Place::Versions {
        parent: "~/.local/share/mise/installs/node",
        leaf: "bin/node",
    },
    Place::Versions {
        parent: "~/.asdf/installs/nodejs",
        leaf: "bin/node",
    },
    Place::Versions {
        parent: "~/.nodenv/versions",
        leaf: "bin/node",
    },
];

/// 表の場所を実際のパスにする。`root` は試験で根を差し替えるためのもので、本番では `/`。
fn resolve_place(at: &str, root: &Path, user_home: &Path) -> PathBuf {
    match at.strip_prefix("~/") {
        Some(rest) => user_home.join(rest),
        None => root.join(at.trim_start_matches('/')),
    }
}

/// `UNIX_NODE_PLACES` を順に実際の候補へ広げる。
pub fn unix_node_paths(root: &Path, user_home: &Path) -> Vec<PathBuf> {
    UNIX_NODE_PLACES
        .iter()
        .flat_map(|place| match place {
            Place::Fixed(at) => vec![resolve_place(at, root, user_home)],
            Place::Versions { parent, leaf } => {
                versioned_node_paths(&resolve_place(parent, root, user_home), leaf)
            }
        })
        .collect()
}

/// Windows で Node を探す手掛かり。環境変数の値を引数で受け取る形にして、試験が環境を書き換えずに済むようにする。
#[derive(Debug, Default, Clone)]
pub struct WindowsEnv {
    /// `ProgramFiles`。公式のインストーラの入れ先（`nodejs\node.exe`）の親。
    pub program_files: Option<PathBuf>,
    /// `LOCALAPPDATA`。ユーザー単位のインストーラの入れ先（`Programs\nodejs\node.exe`）の親。
    pub local_app_data: Option<PathBuf>,
    /// `NVM_SYMLINK`。nvm-windows が選んだ版を指すリンクの場所。
    pub nvm_symlink: Option<PathBuf>,
    /// `NVM_HOME`。nvm-windows が版ごとの Node を置く場所。
    pub nvm_home: Option<PathBuf>,
    /// `PATH` の各項目。
    pub path_dirs: Vec<PathBuf>,
}

impl WindowsEnv {
    pub fn from_process_env() -> Self {
        let var = |k: &str| std::env::var_os(k).map(PathBuf::from);
        Self {
            program_files: var("ProgramFiles"),
            local_app_data: var("LOCALAPPDATA"),
            nvm_symlink: var("NVM_SYMLINK"),
            nvm_home: var("NVM_HOME"),
            path_dirs: std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).collect())
                .unwrap_or_default(),
        }
    }
}

/// Windows の探索先。公式のインストーラの入れ先、nvm-windows（新しい版が先）、PATH の順。
/// サーバ側の同梱 CLI の入口（`scripts/launch-cli.ts`）と同じ並びにそろえてある。
/// PATH は実在する `node.exe` だけを足す。実在しない項目を候補に混ぜると、`describe_error` の「調べた場所」が読みにくくなる。
pub fn windows_node_paths(env: &WindowsEnv) -> Vec<PathBuf> {
    let mut all = Vec::new();
    if let Some(pf) = &env.program_files {
        all.push(pf.join("nodejs").join("node.exe"));
    }
    if let Some(local) = &env.local_app_data {
        all.push(local.join("Programs").join("nodejs").join("node.exe"));
    }
    if let Some(link) = &env.nvm_symlink {
        all.push(link.join("node.exe"));
    }
    if let Some(home) = &env.nvm_home {
        if let Ok(rd) = std::fs::read_dir(home) {
            let mut found: Vec<((u32, u32, u32), PathBuf)> = rd
                .flatten()
                .filter_map(|e| {
                    parse_version(&e.file_name().to_string_lossy())
                        .map(|v| (v, e.path().join("node.exe")))
                })
                .filter(|(_, p)| p.is_file())
                .collect();
            found.sort_by_key(|a| std::cmp::Reverse(a.0));
            all.extend(found.into_iter().map(|(_, p)| p));
        }
    }
    all.extend(
        env.path_dirs
            .iter()
            .map(|d| d.join("node.exe"))
            .filter(|p| p.is_file()),
    );
    all
}

/// OS ごとの探索先。macOS と Linux は `UNIX_NODE_PLACES`、Windows は上の `windows_node_paths`。
/// `root` は macOS と Linux の固定の場所の根で、本番では `/`。
fn platform_node_paths(root: &Path, user_home: &Path) -> Vec<PathBuf> {
    if cfg!(windows) {
        let _ = (root, user_home);
        windows_node_paths(&WindowsEnv::from_process_env())
    } else {
        unix_node_paths(root, user_home)
    }
}

/// 探索の順序。Settings の明示、そのあとは OS ごとの場所（`platform_node_paths`）。
/// 同じ場所は一度しか調べない。
/// Settings の指定が探索先と重なることがあるためである。
pub fn candidate_paths(user_home: &Path, hangar_home: &Path) -> Vec<PathBuf> {
    candidate_paths_in(Path::new("/"), user_home, hangar_home)
}

/// 同上。固定の場所の根を引数で受け取る形。
/// 試験が、この機械に実際に入っている Homebrew の Node に左右されないようにするためである。
fn candidate_paths_in(root: &Path, user_home: &Path, hangar_home: &Path) -> Vec<PathBuf> {
    candidates_from(hangar_home, platform_node_paths(root, user_home))
}

/// Settings の明示を先頭に、与えられた場所を続けて、重複を除く。
fn candidates_from(hangar_home: &Path, fixed: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut all = Vec::new();
    if let Some(p) = settings_node_path(hangar_home) {
        all.push(p);
    }
    all.extend(fixed);
    let mut seen = HashSet::new();
    all.into_iter().filter(|p| seen.insert(p.clone())).collect()
}

/// `node -e "console.log(process.version, process.arch)"` の出力（例 `v22.14.0 arm64`）を読む。
/// 候補は利用者が指定した任意のパスなので、期待した 1 行だけが出るとは限らない。
/// 前置きや後書きの行が混ざっても、`v<版> <アーキ>` の形をした行を探し当てる。
/// 後ろの行から見るのは、答えが最後に出るためである。
pub fn parse_probe(output: &str) -> Option<NodeProbe> {
    output.lines().rev().find_map(parse_probe_line)
}

/// 1 行が `v<版> <アーキ>` ちょうどの形かを見る。
/// 語が 3 つ以上並ぶ行は、Node の答えと見なさない。
/// `process.arch` の値はどれも英小文字と数字だけなので、それ以外を含む語も退ける。
fn parse_probe_line(line: &str) -> Option<NodeProbe> {
    let mut it = line.split_whitespace();
    let version = it.next()?;
    let arch = it.next()?;
    if it.next().is_some() {
        return None;
    }
    if !arch
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    {
        return None;
    }
    let (major, _, _) = parse_version(version)?;
    Some(NodeProbe {
        major,
        arch: arch.to_string(),
    })
}

/// 打ち切った子を、その子が作った孫ごと止める。
/// 包みの shell を候補に据えられた場合、shell だけ止めても孫が残り、読み口を握ったままになる。
/// Windows では、ここで止めるのは子だけである。
/// 孫は、子を入れたジョブ（`probe_node_within` の `_job`）を落とすときに止まる。
fn kill_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    // `setsid` させてあるので、グループの番号は子の番号と同じである。
    // `setsid` に失敗していた場合、この番号はどのグループでもないので何も起きない。
    unsafe {
        libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// 候補を起動して版を訊く。
/// 既定の期限で打ち切る。
pub fn probe_node(path: &Path) -> ProbeOutcome {
    probe_node_within(path, PROBE_TIMEOUT)
}

/// 同上。期限を指定する形。
/// 候補には利用者が `settings.json` で指定した任意のパスが入るので、
/// 終わらない相手と出し続ける相手の両方から身を守る。
/// 標準出力は別のスレッドで上限つきに読む。
/// 読み手を本体に置くと、出し続ける相手で本体が戻らなくなるためである。
pub fn probe_node_within(path: &Path, timeout: Duration) -> ProbeOutcome {
    if !path.is_file() {
        return ProbeOutcome::Missing;
    }
    let mut cmd = Command::new(path);
    cmd.args(["-e", "console.log(process.version, process.arch)"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 窓を持たない殻から起こすと、候補ごとに黒い窓が一瞬開く（CREATE_NO_WINDOW）。
        cmd.creation_flags(crate::winjob::CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        // 子を新しいセッションの長にする。
        // 打ち切るときに、子が作った孫まで含めて止められるようにするためである。
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let Ok(mut child) = cmd.spawn() else {
        return ProbeOutcome::NotExecutable;
    };
    // Windows では子をジョブに入れる。この関数を出るときにジョブが落ち、残った孫ごと止まる。
    // unix の setsid と killpg に当たる。
    #[cfg(windows)]
    let _job = crate::winjob::contain(&child);
    let Some(stdout) = child.stdout.take() else {
        kill_group(&mut child);
        return ProbeOutcome::Failed;
    };
    let (tx, rx) = std::sync::mpsc::channel();
    // 上限に達したら読むのをやめ、読み口を閉じる。
    // 出し続ける相手はその時点で書き込みに失敗して倒れるか、詰まったまま期限に掛かって止められる。
    // どちらにしても、こちらが抱えるのは上限までである。
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.take(PROBE_OUTPUT_LIMIT).read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return ProbeOutcome::Failed;
                }
                break;
            }
            Ok(None) => {}
            Err(_) => return ProbeOutcome::Failed,
        }
        if Instant::now() >= deadline {
            kill_group(&mut child);
            // 読み手は待たない。
            // 書き口はすべて閉じたので、読み手はじきに EOF を見て終わる。
            return ProbeOutcome::TimedOut;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let Ok(buf) = rx.recv_timeout(PROBE_DRAIN) else {
        return ProbeOutcome::TimedOut;
    };
    match parse_probe(&String::from_utf8_lossy(&buf)) {
        Some(p) => ProbeOutcome::Ok(p),
        None => ProbeOutcome::Failed,
    }
}

/// 候補を順に調べ、manifest と同じメジャー版かつ同じアーキテクチャの最初の Node を返す。
pub fn choose_node(
    candidates: &[PathBuf],
    manifest: &Manifest,
    probe: impl Fn(&Path) -> ProbeOutcome,
) -> Result<PathBuf, NodeError> {
    let mut tried = Vec::new();
    for c in candidates {
        let outcome = probe(c);
        if let ProbeOutcome::Ok(pr) = &outcome {
            if pr.major == manifest.node_major && pr.arch == manifest.arch {
                return Ok(c.clone());
            }
        }
        tried.push(Tried {
            path: c.clone(),
            outcome,
        });
    }
    Err(NodeError::NotFound {
        manifest: manifest.clone(),
        tried,
    })
}

/// 利用者に見せる文言。読み込み画面の詳細にそのまま出す。
/// `lang` は頁の言語（`bootfail::page_language` の ja か en）である。
pub fn describe_error(e: &NodeError, lang: &str) -> String {
    describe_error_in(e, &crate::paths::hangar_home(), lang)
}

/// 同上。設定の置き場所を引数で受け取る形。
/// `HANGAR_HOME` を使っている利用者に、存在しない場所を直せと案内しないためである。
/// 英語の設定でも日本語のまま出ていた（2026-10-11、Windows の実機の確かめで見つけた）ので、文は頁の言語で作る。
pub fn describe_error_in(e: &NodeError, hangar_home: &Path, lang: &str) -> String {
    describe_error_for(e, hangar_home, lang, InstallHint::current())
}

/// 見つからないときに案内する入れ方。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum InstallHint {
    /// macOS。`brew install node@22` で入れれば、keg の場所を探すのでそのまま見つかる。
    Homebrew,
    /// Windows と Linux。nvm（Windows は nvm-windows）で入れる。
    Nvm,
}

impl InstallHint {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            InstallHint::Homebrew
        } else {
            InstallHint::Nvm
        }
    }
}

/// 同上。案内する入れ方を引数で受け取る形。どの OS の上でも、両方の文を試験できるようにする。
fn describe_error_for(e: &NodeError, hangar_home: &Path, lang: &str, hint: InstallHint) -> String {
    let NodeError::NotFound { manifest, tried } = e;
    let settings = hangar_home.join("settings.json").display().to_string();
    let en = lang == "en";
    let mut lines = match (en, hint) {
        (false, InstallHint::Nvm) => not_found_ja(manifest, &settings),
        (true, InstallHint::Nvm) => not_found_en(manifest, &settings),
        (false, InstallHint::Homebrew) => not_found_brew_ja(manifest, &settings),
        (true, InstallHint::Homebrew) => not_found_brew_en(manifest, &settings),
    };
    for t in tried {
        let what = if en {
            outcome_en(&t.outcome, manifest)
        } else {
            outcome_ja(&t.outcome, manifest)
        };
        lines.push(format!("  {}: {}", t.path.display(), what));
    }
    lines.join("\n")
}

// CI の rustfmt は日本語の幅を手元と違って数えるので、文の表は整形を止めて書いたままにする。
#[rustfmt::skip]
fn not_found_ja(m: &Manifest, settings: &str) -> Vec<String> {
    vec![
        format!("Node {}（{}）が見つかりません。", m.node_major, m.arch),
        format!("nvm install {} を実行するか、{} の nodePath で場所を指定してください。", m.node_major, settings),
        "調べた場所:".to_string(),
    ]
}

#[rustfmt::skip]
fn not_found_en(m: &Manifest, settings: &str) -> Vec<String> {
    vec![
        format!("Node {} ({}) was not found.", m.node_major, m.arch),
        format!("Run nvm install {}, or set nodePath in {} to its location.", m.node_major, settings),
        "Places checked:".to_string(),
    ]
}

#[rustfmt::skip]
fn not_found_brew_ja(m: &Manifest, settings: &str) -> Vec<String> {
    vec![
        format!("Node {}（{}）が見つかりません。", m.node_major, m.arch),
        format!("brew install node@{} で入れれば、次に開いたときに見つけます（nvm、fnm、Volta、mise、asdf、nodenv で入れた版も探します）。", m.node_major),
        format!("ほかの場所に入れたなら、{} の nodePath で場所を指定してください。", settings),
        "調べた場所:".to_string(),
    ]
}

#[rustfmt::skip]
fn not_found_brew_en(m: &Manifest, settings: &str) -> Vec<String> {
    vec![
        format!("Node {} ({}) was not found.", m.node_major, m.arch),
        format!("Install it with brew install node@{} and Hangar finds it the next time it opens (it also looks for versions installed with nvm, fnm, Volta, mise, asdf, and nodenv).", m.node_major),
        format!("If it is installed somewhere else, set nodePath in {} to its location.", settings),
        "Places checked:".to_string(),
    ]
}

#[rustfmt::skip]
fn outcome_ja(o: &ProbeOutcome, m: &Manifest) -> String {
    match o {
        ProbeOutcome::Ok(p) => format!("v{} {}（要る版は {} {}）", p.major, p.arch, m.node_major, m.arch),
        ProbeOutcome::Missing => "ありません".to_string(),
        ProbeOutcome::NotExecutable => "起動できません（実行権を確かめてください）".to_string(),
        ProbeOutcome::Failed => "Node ではありません（別の実行ファイルのようです）".to_string(),
        ProbeOutcome::TimedOut => format!("{} 秒のあいだ応答しません（打ち切りました）", PROBE_TIMEOUT.as_secs()),
    }
}

#[rustfmt::skip]
fn outcome_en(o: &ProbeOutcome, m: &Manifest) -> String {
    match o {
        ProbeOutcome::Ok(p) => format!("v{} {} (needs {} {})", p.major, p.arch, m.node_major, m.arch),
        ProbeOutcome::Missing => "not found".to_string(),
        ProbeOutcome::NotExecutable => "cannot run it (check that it is executable)".to_string(),
        ProbeOutcome::Failed => "not Node (it looks like another program)".to_string(),
        ProbeOutcome::TimedOut => format!("no answer for {} seconds (gave up)", PROBE_TIMEOUT.as_secs()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn manifest() -> Manifest {
        Manifest {
            version: "0.1.0".into(),
            node_major: 22,
            arch: "arm64".into(),
        }
    }

    /// `#!/bin/sh` の偽の node を一時ディレクトリに置く。
    /// 実在の Node に頼らずに、子プロセスを起こす経路を試験するために使う。
    #[cfg(unix)]
    fn fake_node(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join("node");
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn nvm_versions_are_sorted_newest_first() {
        let home = tempfile::tempdir().unwrap();
        let base = home.path().join(".nvm/versions/node");
        for v in ["v20.1.0", "v22.14.0", "v22.9.0", "junk"] {
            touch(&base.join(v).join("bin/node"));
        }
        // bin/node を置かない版は候補に入れない。
        std::fs::create_dir_all(base.join("v21.0.0/bin")).unwrap();
        assert_eq!(
            nvm_node_paths(home.path()),
            vec![
                base.join("v22.14.0/bin/node"),
                base.join("v22.9.0/bin/node"),
                base.join("v20.1.0/bin/node")
            ]
        );
        assert!(nvm_node_paths(Path::new("/nonexistent")).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn candidates_put_settings_first_then_fixed_then_nvm() {
        let root = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        let hangar = tempfile::tempdir().unwrap();
        touch(&user.path().join(".nvm/versions/node/v22.14.0/bin/node"));
        std::fs::write(
            hangar.path().join("settings.json"),
            r#"{ "workspaceRoot": "/w", "nodePath": "/custom/node" }"#,
        )
        .unwrap();
        let got = candidate_paths_in(root.path(), user.path(), hangar.path());
        assert_eq!(
            got,
            vec![
                PathBuf::from("/custom/node"),
                root.path().join("opt/homebrew/bin/node"),
                root.path().join("usr/local/bin/node"),
                user.path().join(".nvm/versions/node/v22.14.0/bin/node"),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn candidates_drop_duplicates() {
        let root = tempfile::tempdir().unwrap();
        let user = tempfile::tempdir().unwrap();
        let hangar = tempfile::tempdir().unwrap();
        let nvm = user.path().join(".nvm/versions/node/v22.14.0/bin/node");
        touch(&nvm);
        let usr_local = root.path().join("usr/local/bin/node");
        // 探索先と同じ場所を Settings で指定しても、候補は 1 つにまとまる。
        let settings_with = |p: &Path| {
            std::fs::write(
                hangar.path().join("settings.json"),
                format!("{{ \"nodePath\": {} }}", serde_json::to_string(p).unwrap()),
            )
            .unwrap();
        };
        settings_with(&usr_local);
        assert_eq!(
            candidate_paths_in(root.path(), user.path(), hangar.path()),
            vec![
                usr_local.clone(),
                root.path().join("opt/homebrew/bin/node"),
                nvm.clone(),
            ]
        );
        settings_with(&nvm);
        assert_eq!(
            candidate_paths_in(root.path(), user.path(), hangar.path()),
            vec![nvm, root.path().join("opt/homebrew/bin/node"), usr_local]
        );
    }

    #[test]
    fn dir_version_reads_homebrew_kegs_and_full_versions_only() {
        assert_eq!(parse_dir_version("node@22"), Some((22, 0, 0)));
        assert_eq!(parse_dir_version("v22.14.0"), Some((22, 14, 0)));
        assert_eq!(parse_dir_version("22.14.0"), Some((22, 14, 0)));
        // mise の別名（22、lts、latest）は実体の版と重なるので採らない。
        for name in [
            "22",
            "22.14",
            "lts",
            "latest",
            "node",
            "node@",
            "node@x",
            "openssl@3",
            "v22.14.0.1",
            "22.14.0-rc.1",
            "v",
            "",
        ] {
            assert_eq!(parse_dir_version(name), None, "{name}");
        }
    }

    /// macOS の探索先の並び。
    /// 固定の 2 か所、Homebrew の keg（版つきの node@N）、版の管理ツールの順で、各々は新しい版から並ぶ。
    /// 版の管理ツールと keg は、実在する node だけを足す。
    #[cfg(unix)]
    #[test]
    fn unix_places_follow_fixed_then_kegs_then_version_managers_newest_first() {
        let root = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let r = |p: &str| root.path().join(p);
        let h = |p: &str| home.path().join(p);
        for p in [
            "opt/homebrew/opt/node@20/bin/node",
            "opt/homebrew/opt/node@24/bin/node",
            "opt/homebrew/opt/node@22/bin/node",
            // node@ でない keg は見ない。
            "opt/homebrew/opt/openssl@3/bin/node",
            "usr/local/opt/node@22/bin/node",
        ] {
            touch(&r(p));
        }
        // bin/node の無い keg は足さない。
        std::fs::create_dir_all(r("opt/homebrew/opt/node@23/bin")).unwrap();
        for p in [
            ".nvm/versions/node/v22.14.0/bin/node",
            "Library/Application Support/fnm/node-versions/v22.9.0/installation/bin/node",
            "Library/Application Support/fnm/node-versions/v22.10.0/installation/bin/node",
            ".local/share/fnm/node-versions/v22.1.0/installation/bin/node",
            ".fnm/node-versions/v22.2.0/installation/bin/node",
            ".volta/tools/image/node/22.9.0/bin/node",
            ".volta/tools/image/node/24.1.0/bin/node",
            ".local/share/mise/installs/node/22.14.0/bin/node",
            // mise の別名のディレクトリは、実体と重なるので足さない。
            ".local/share/mise/installs/node/22/bin/node",
            ".asdf/installs/nodejs/22.3.0/bin/node",
            ".nodenv/versions/22.4.0/bin/node",
        ] {
            touch(&h(p));
        }
        assert_eq!(
            unix_node_paths(root.path(), home.path()),
            vec![
                r("opt/homebrew/bin/node"),
                r("usr/local/bin/node"),
                r("opt/homebrew/opt/node@24/bin/node"),
                r("opt/homebrew/opt/node@22/bin/node"),
                r("opt/homebrew/opt/node@20/bin/node"),
                r("usr/local/opt/node@22/bin/node"),
                h(".nvm/versions/node/v22.14.0/bin/node"),
                h("Library/Application Support/fnm/node-versions/v22.10.0/installation/bin/node"),
                h("Library/Application Support/fnm/node-versions/v22.9.0/installation/bin/node"),
                h(".local/share/fnm/node-versions/v22.1.0/installation/bin/node"),
                h(".fnm/node-versions/v22.2.0/installation/bin/node"),
                h(".volta/tools/image/node/24.1.0/bin/node"),
                h(".volta/tools/image/node/22.9.0/bin/node"),
                h(".local/share/mise/installs/node/22.14.0/bin/node"),
                h(".asdf/installs/nodejs/22.3.0/bin/node"),
                h(".nodenv/versions/22.4.0/bin/node"),
            ]
        );
        // 何も入っていなければ、固定の 2 か所だけを調べる。
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(
            unix_node_paths(empty.path(), empty.path()),
            vec![
                empty.path().join("opt/homebrew/bin/node"),
                empty.path().join("usr/local/bin/node"),
            ]
        );
    }

    /// 同梱の CLI（`scripts/hangar.sh`）の探索先は、殻の `UNIX_NODE_PLACES` と同じ並びでなければならない。
    /// 片方だけ足すと、アプリは起動するのに `hangar` コマンドだけが Node を見失う（またはその逆）。
    /// hangar.sh の印の間の行を読み、表と 1 行ずつ突き合わせる。
    #[test]
    fn hangar_sh_searches_the_same_places_in_the_same_order() {
        let script = include_str!("../../scripts/hangar.sh");
        let begin = script
            .find("# node-places: begin")
            .expect("hangar.sh に node-places: begin の印が無い");
        let end = script
            .find("# node-places: end")
            .expect("hangar.sh に node-places: end の印が無い");
        let unquote = |s: &str| s.trim_matches('"').replace("$HOME/", "~/");
        let listed: Vec<NodePlace> = script[begin..end]
            .lines()
            .skip(1)
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .map(|l| {
                if let Some(rest) = l.strip_prefix("printf '%s\\n' ") {
                    NodePlace::Fixed(unquote(rest))
                } else if let Some(rest) = l.strip_prefix("versions ") {
                    // 親は空白を含むことがあるので、引用符で括った 1 語として読む。
                    let (parent, leaf) = if let Some(q) = rest.strip_prefix('"') {
                        let close = q.find('"').expect("引用符が閉じていない");
                        (&q[..close], q[close + 1..].trim())
                    } else {
                        rest.split_once(' ').expect("versions の引数が 2 つでない")
                    };
                    NodePlace::Versions {
                        parent: unquote(parent),
                        leaf: leaf.to_string(),
                    }
                } else {
                    panic!("hangar.sh の node-places に読めない行がある: {l}")
                }
            })
            .collect();
        let table: Vec<NodePlace> = UNIX_NODE_PLACES.iter().map(NodePlace::from).collect();
        assert_eq!(listed, table);
    }

    /// Windows の探索先を、環境変数に頼らず組み立てる関数の試験。
    /// 置き場は実在のディレクトリで作る。パスの区切りは OS のものなので、期待値も join で組む。
    #[test]
    fn windows_candidates_follow_installer_then_nvm_then_path() {
        let root = tempfile::tempdir().unwrap();
        let pf = root.path().join("Program Files");
        let local = root.path().join("Local");
        let symlink = root.path().join("nvm-link");
        let nvm = root.path().join("nvm");
        for v in ["v20.1.0", "v22.14.0", "v22.9.0", "junk"] {
            touch(&nvm.join(v).join("node.exe"));
        }
        // node.exe を置かない版は候補に入れない。
        std::fs::create_dir_all(nvm.join("v21.0.0")).unwrap();
        let on_path = root.path().join("tools");
        touch(&on_path.join("node.exe"));
        let empty_dir = root.path().join("no-node-here");
        std::fs::create_dir_all(&empty_dir).unwrap();

        let got = windows_node_paths(&WindowsEnv {
            program_files: Some(pf.clone()),
            local_app_data: Some(local.clone()),
            nvm_symlink: Some(symlink.clone()),
            nvm_home: Some(nvm.clone()),
            path_dirs: vec![empty_dir, on_path.clone()],
        });
        assert_eq!(
            got,
            vec![
                pf.join("nodejs").join("node.exe"),
                local.join("Programs").join("nodejs").join("node.exe"),
                symlink.join("node.exe"),
                nvm.join("v22.14.0").join("node.exe"),
                nvm.join("v22.9.0").join("node.exe"),
                nvm.join("v20.1.0").join("node.exe"),
                // PATH は、実在する node.exe だけを後ろに足す。
                on_path.join("node.exe"),
            ]
        );
    }

    #[test]
    fn windows_candidates_are_empty_without_any_environment() {
        assert!(windows_node_paths(&WindowsEnv::default()).is_empty());
    }

    // Windows の PATH は、公式の入れ先と同じ場所を指すことが多い。同じ場所は 1 つにまとめる。
    #[test]
    fn candidates_with_a_platform_list_drop_duplicates_and_keep_settings_first() {
        let hangar = tempfile::tempdir().unwrap();
        std::fs::write(
            hangar.path().join("settings.json"),
            r#"{ "nodePath": "C:/mine/node.exe" }"#,
        )
        .unwrap();
        let a = PathBuf::from("C:/a/node.exe");
        let b = PathBuf::from("C:/b/node.exe");
        assert_eq!(
            candidates_from(hangar.path(), vec![a.clone(), b.clone(), a.clone()]),
            vec![PathBuf::from("C:/mine/node.exe"), a, b]
        );
    }

    #[test]
    fn settings_node_path_ignores_missing_empty_and_null() {
        let hangar = tempfile::tempdir().unwrap();
        let file = hangar.path().join("settings.json");
        assert_eq!(settings_node_path(hangar.path()), None);
        std::fs::write(&file, r#"{ "nodePath": "" }"#).unwrap();
        assert_eq!(settings_node_path(hangar.path()), None);
        std::fs::write(&file, r#"{ "nodePath": null }"#).unwrap();
        assert_eq!(settings_node_path(hangar.path()), None);
        std::fs::write(&file, r#"{ "nodePath": " /x/node " }"#).unwrap();
        assert_eq!(
            settings_node_path(hangar.path()),
            Some(PathBuf::from("/x/node"))
        );
    }

    #[test]
    fn parse_probe_reads_version_and_arch() {
        assert_eq!(
            parse_probe("v22.14.0 arm64\n"),
            Some(NodeProbe {
                major: 22,
                arch: "arm64".into()
            })
        );
        assert_eq!(parse_probe("garbage"), None);
        assert_eq!(parse_probe(""), None);
    }

    // 前置きの 1 行を出す環境（NODE_OPTIONS の警告、包みの script）でも、健全な Node を取り逃がさない。
    // 逆に、答えの行に余計な語が続く出力は Node の答えと見なさない。
    #[test]
    fn parse_probe_looks_past_the_lines_around_the_answer() {
        let v22 = Some(NodeProbe {
            major: 22,
            arch: "arm64".into(),
        });
        assert_eq!(
            parse_probe("(node:1) ExperimentalWarning: x\nv22.14.0 arm64\n"),
            v22
        );
        assert_eq!(parse_probe("v22.14.0 arm64\nbye\n"), v22);
        assert_eq!(parse_probe("v22.14.0 arm64 extra"), None);
        assert_eq!(parse_probe("v1.2.3 v4.5.6"), None);
        assert_eq!(parse_probe("not a node\nnot a node either\n"), None);
    }

    #[test]
    fn choose_node_takes_first_compatible_and_reports_tried() {
        let probes: HashMap<PathBuf, ProbeOutcome> = HashMap::from([
            (
                PathBuf::from("/a/node"),
                ProbeOutcome::Ok(NodeProbe {
                    major: 24,
                    arch: "arm64".into(),
                }),
            ),
            (PathBuf::from("/b/node"), ProbeOutcome::Missing),
            (
                PathBuf::from("/c/node"),
                ProbeOutcome::Ok(NodeProbe {
                    major: 22,
                    arch: "arm64".into(),
                }),
            ),
            (
                PathBuf::from("/d/node"),
                ProbeOutcome::Ok(NodeProbe {
                    major: 22,
                    arch: "arm64".into(),
                }),
            ),
        ]);
        let probe = |p: &Path| probes.get(p).cloned().unwrap_or(ProbeOutcome::Missing);
        let cands = ["/a/node", "/b/node", "/c/node", "/d/node"].map(PathBuf::from);
        assert_eq!(
            choose_node(&cands, &manifest(), probe),
            Ok(PathBuf::from("/c/node"))
        );

        let x64 = Manifest {
            arch: "x64".into(),
            ..manifest()
        };
        let err = choose_node(&cands, &x64, probe).unwrap_err();
        let NodeError::NotFound { tried, .. } = &err;
        assert_eq!(tried.len(), 4);
        assert_eq!(
            tried[1],
            Tried {
                path: PathBuf::from("/b/node"),
                outcome: ProbeOutcome::Missing
            }
        );
    }

    fn every_reason() -> NodeError {
        let tried = vec![
            Tried {
                path: PathBuf::from("/a/node"),
                outcome: ProbeOutcome::Ok(NodeProbe {
                    major: 24,
                    arch: "arm64".into(),
                }),
            },
            Tried {
                path: PathBuf::from("/b/node"),
                outcome: ProbeOutcome::Missing,
            },
            Tried {
                path: PathBuf::from("/c/node"),
                outcome: ProbeOutcome::NotExecutable,
            },
            Tried {
                path: PathBuf::from("/d/node"),
                outcome: ProbeOutcome::Failed,
            },
            Tried {
                path: PathBuf::from("/e/node"),
                outcome: ProbeOutcome::TimedOut,
            },
        ];
        NodeError::NotFound {
            manifest: Manifest {
                arch: "x64".into(),
                ..manifest()
            },
            tried,
        }
    }

    #[test]
    fn describe_error_names_the_real_settings_file_and_each_reason() {
        let err = every_reason();
        let text = describe_error_for(&err, Path::new("/elsewhere/hangar"), "ja", InstallHint::Nvm);
        assert!(
            text.starts_with("Node 22（x64）が見つかりません。"),
            "{text}"
        );
        assert!(text.contains("nvm install 22"), "{text}");
        // HANGAR_HOME を使っていれば、その場所を案内する。
        let settings = Path::new("/elsewhere/hangar").join("settings.json");
        assert!(text.contains(&settings.display().to_string()), "{text}");
        assert!(!text.contains("~/.agent-hangar"), "{text}");
        // 「無し」の理由が読み分けられる。
        assert!(
            text.contains("/a/node: v24 arm64（要る版は 22 x64）"),
            "{text}"
        );
        assert!(text.contains("/b/node: ありません"), "{text}");
        assert!(text.contains("/c/node: 起動できません"), "{text}");
        assert!(text.contains("/d/node: Node ではありません"), "{text}");
        assert!(text.contains("/e/node: 5 秒のあいだ応答しません"), "{text}");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 8, "{text}");
    }

    // 英語の設定では、見つからない理由も調べた場所も英語で出す（Windows の実機で、ここだけ日本語のまま出ていた）。
    #[test]
    fn describe_error_follows_the_page_language() {
        let err = every_reason();
        let text = describe_error_for(&err, Path::new("/elsewhere/hangar"), "en", InstallHint::Nvm);
        assert!(text.starts_with("Node 22 (x64) was not found."), "{text}");
        assert!(text.contains("nvm install 22"), "{text}");
        let settings = Path::new("/elsewhere/hangar").join("settings.json");
        assert!(text.contains(&settings.display().to_string()), "{text}");
        assert!(text.contains("Places checked:"), "{text}");
        assert!(text.contains("/a/node: v24 arm64 (needs 22 x64)"), "{text}");
        assert!(text.contains("/b/node: not found"), "{text}");
        assert!(text.contains("/c/node: cannot run it"), "{text}");
        assert!(text.contains("/d/node: not Node"), "{text}");
        assert!(text.contains("/e/node: no answer for 5 seconds"), "{text}");
        assert!(
            !text
                .chars()
                .any(|c| matches!(c, '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{9fff}' | '\u{ff08}' | '\u{ff09}')),
            "{text}"
        );
        assert_eq!(text.lines().count(), 8, "{text}");
    }

    // macOS では、Homebrew の node@22 を入れるだけで足りることを案内する。
    // 調べた場所はそのまま並べる。
    #[test]
    fn describe_error_on_macos_says_brew_install_is_enough() {
        let err = every_reason();
        let home = Path::new("/elsewhere/hangar");
        let settings = home.join("settings.json").display().to_string();
        let ja = describe_error_for(&err, home, "ja", InstallHint::Homebrew);
        assert!(ja.starts_with("Node 22（x64）が見つかりません。"), "{ja}");
        assert!(ja.contains("brew install node@22"), "{ja}");
        assert!(!ja.contains("nvm install"), "{ja}");
        assert!(!ja.contains("brew link"), "{ja}");
        assert!(ja.contains(&settings), "{ja}");
        assert!(ja.contains("調べた場所:"), "{ja}");
        assert!(ja.contains("/b/node: ありません"), "{ja}");
        assert_eq!(ja.lines().count(), 9, "{ja}");

        let en = describe_error_for(&err, home, "en", InstallHint::Homebrew);
        assert!(en.starts_with("Node 22 (x64) was not found."), "{en}");
        assert!(en.contains("brew install node@22"), "{en}");
        assert!(!en.contains("nvm install"), "{en}");
        assert!(en.contains(&settings), "{en}");
        assert!(en.contains("Places checked:"), "{en}");
        assert!(en.contains("/b/node: not found"), "{en}");
        assert!(
            !en.chars()
                .any(|c| matches!(c, '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{9fff}')),
            "{en}"
        );
        assert_eq!(en.lines().count(), 9, "{en}");
    }

    #[test]
    fn install_hint_is_homebrew_only_on_macos() {
        let want = if cfg!(target_os = "macos") {
            InstallHint::Homebrew
        } else {
            InstallHint::Nvm
        };
        assert_eq!(InstallHint::current(), want);
    }

    /// 探索先の表の 1 行を、試験で突き合わせるために持ち主のある形にしたもの。
    #[derive(Debug, PartialEq)]
    enum NodePlace {
        Fixed(String),
        Versions { parent: String, leaf: String },
    }

    impl From<&Place> for NodePlace {
        fn from(p: &Place) -> Self {
            match p {
                Place::Fixed(at) => NodePlace::Fixed(at.to_string()),
                Place::Versions { parent, leaf } => NodePlace::Versions {
                    parent: parent.to_string(),
                    leaf: leaf.to_string(),
                },
            }
        }
    }

    #[test]
    fn read_manifest_parses_and_reports_errors() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            read_manifest(dir.path()).unwrap_err(),
            crate::bootmsg::Msg::ManifestUnreadable { .. }
        ));
        std::fs::write(
            dir.path().join("manifest.json"),
            r#"{ "version": "0.1.0", "nodeMajor": 22, "arch": "arm64", "builtAt": "x" }"#,
        )
        .unwrap();
        assert_eq!(read_manifest(dir.path()).unwrap(), manifest());
        std::fs::write(dir.path().join("manifest.json"), "{").unwrap();
        let broken = read_manifest(dir.path()).unwrap_err();
        assert!(
            matches!(broken, crate::bootmsg::Msg::ManifestBroken { .. }),
            "{broken:?}"
        );
        assert!(broken.text("ja").contains("壊れています"));
        assert!(broken.text("en").contains("is broken"));
    }

    #[test]
    fn probe_node_is_missing_for_absent_path_and_directories() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            probe_node(Path::new("/nonexistent/node")),
            ProbeOutcome::Missing
        );
        assert_eq!(probe_node(dir.path()), ProbeOutcome::Missing);
    }

    #[cfg(unix)]
    #[test]
    fn probe_node_runs_the_child_and_reads_its_answer() {
        let dir = tempfile::tempdir().unwrap();
        let ok = fake_node(dir.path(), "echo v22.14.0 arm64");
        assert_eq!(
            probe_node(&ok),
            ProbeOutcome::Ok(NodeProbe {
                major: 22,
                arch: "arm64".into()
            })
        );

        let bad = tempfile::tempdir().unwrap();
        let failing = fake_node(bad.path(), "exit 3");
        assert_eq!(probe_node(&failing), ProbeOutcome::Failed);

        let noisy = tempfile::tempdir().unwrap();
        let not_node = fake_node(noisy.path(), "echo hello");
        assert_eq!(probe_node(&not_node), ProbeOutcome::Failed);
    }

    #[cfg(unix)]
    #[test]
    fn probe_node_reports_a_file_it_cannot_run() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("node");
        std::fs::write(&p, "#!/bin/sh\necho v22.14.0 arm64\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(probe_node(&p), ProbeOutcome::NotExecutable);
    }

    /// 終わらない候補で固まらないことを、実際に固まる入力で確かめる。
    #[cfg(unix)]
    #[test]
    fn probe_node_gives_up_on_a_candidate_that_never_answers() {
        let dir = tempfile::tempdir().unwrap();
        let hang = fake_node(dir.path(), "sleep 120");
        let started = std::time::Instant::now();
        assert_eq!(probe_node(&hang), ProbeOutcome::TimedOut);
        let took = started.elapsed();
        assert!(took >= PROBE_TIMEOUT, "{took:?}");
        assert!(took < PROBE_TIMEOUT + Duration::from_secs(5), "{took:?}");
    }

    /// 出し続ける候補でも、読み取りは上限で止まり、抱え込まずにすぐ返る。
    /// 上限で読み口を閉じるので、相手は書き込みに失敗して倒れるか、詰まって期限に掛かる。
    /// どちらになるかは時の運なので、ここでは「採らない」ことと「すぐ返る」ことを主張する。
    #[cfg(unix)]
    #[test]
    fn probe_node_gives_up_on_a_candidate_that_never_stops_talking() {
        let dir = tempfile::tempdir().unwrap();
        let noisy = fake_node(
            dir.path(),
            "while :; do echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done",
        );
        let started = std::time::Instant::now();
        let got = probe_node_within(&noisy, Duration::from_millis(400));
        let took = started.elapsed();
        assert!(
            matches!(got, ProbeOutcome::Failed | ProbeOutcome::TimedOut),
            "{got:?}"
        );
        assert!(took < Duration::from_secs(5), "{took:?}");
    }
}
