//! Node の探索。PATH に頼らず、決まった候補を順に調べ、同梱したネイティブモジュールが読める Node を採る。
//! 同梱のネイティブモジュール（better-sqlite3、node-pty）は Node-API で作られていて、Node の ABI には縛られない。
//! 採るのは、Node-API が manifest.json の `nodeApi` 以上で、アーキテクチャが同じ Node である（上限は付けない）。
//! 規則の値は packages/server/src/config/nodeRule.ts の 1 か所で決め、束を作るときに manifest.json へ書く。
//! 規則が同梱の CLI と設定の確かめと同じであることは、見本の表（node-rule-cases.json）を各所の試験が読んで縛る。
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
/// `node_api` は要る Node-API の版、`node_min` はそれを持つ最初の Node の版（22.14。案内に出すだけで、比べるのには使わない）。
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(rename = "nodeApi")]
    pub node_api: u32,
    #[serde(rename = "nodeMin")]
    pub node_min: String,
    pub arch: String,
}

impl Manifest {
    /// 案内で入れる Node のメジャー版（brew install node@22、nvm install 22）。`node_min` の先頭の数である。
    pub fn lts_major(&self) -> String {
        self.node_min
            .split('.')
            .next()
            .unwrap_or(&self.node_min)
            .to_string()
    }
}

/// 候補の Node を起動して得た版（v を除いたもの）、Node-API の版、アーキテクチャ。
#[derive(Debug, Clone, PartialEq)]
pub struct NodeProbe {
    pub version: String,
    pub napi: u32,
    pub arch: String,
}

/// 候補に訊く式（`node -p` に渡す）。出力は `v<版> <アーキ> <Node-API の版>` の 1 行（例 `v22.14.0 arm64 10`）。
/// 設定の確かめ（nodeRule.ts の NODE_PROBE_EXPR）と hangar.sh と同じ式にする（試験が突き合わせる）。
pub const PROBE_EXPR: &str = r#"process.version+" "+process.arch+" "+(process.versions.napi||0)"#;

/// 候補が要るものに合うか。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Fit {
    Ok,
    /// Node-API が足りない（Node 22.14 より古い）。
    Version,
    /// Node-API は足りるが、アーキテクチャが違う。
    Arch,
}

/// 合うかを決める。Node-API が足りなければ、アーキが違っても版を言う（nodeRule.ts の nodeFit と同じ順）。
pub fn fit(p: &NodeProbe, m: &Manifest) -> Fit {
    if p.napi < m.node_api {
        Fit::Version
    } else if p.arch != m.arch {
        Fit::Arch
    } else {
        Fit::Ok
    }
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
fn versioned_node_paths(parent: &Path, leaf: impl AsRef<Path>) -> Vec<PathBuf> {
    let leaf = leaf.as_ref();
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

/// macOS（と Linux）の探索先。この順に調べ、manifest に合う（`fit`）最初の Node を採る。
/// Homebrew の `node@22` は、今の Homebrew（7.0.9 で確かめた）では `/opt/homebrew/bin` にもリンクされるが、前の版では keg-only でリンクされなかった。
/// どちらの場合も拾えるよう、`bin/node` に加えて keg の場所（`opt/node@N`）も見る。
/// 版の管理ツールは、PATH を切り替える仕掛け（fnm の multishells、nvm の current など）ではなく、版ごとの実体の場所を見る。
/// GUI のアプリの PATH は launchd の最小のものなので、PATH は見ない。
/// 利用者のログインシェルに PATH を訊く案は採らない（理由は docs/design.md の「プロセスと通信」）。
/// 同梱の CLI（`scripts/hangar.sh` の `node-places` の印の間）も同じ並びで探す。並びの一致は試験で縛る。
pub const UNIX_NODE_PLACES: &[Place] = &[
    Place::Fixed("/opt/homebrew/bin/node"),
    Place::Fixed("/usr/local/bin/node"),
    // Homebrew の node@N の入れ先。bin にリンクされていなくても、ここで見つける。Apple silicon と Intel。
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
    /// `LOCALAPPDATA`。ユーザー単位のインストーラの入れ先（`Programs\nodejs\node.exe`）と、Volta の既定の置き場（`Volta`）の親。
    pub local_app_data: Option<PathBuf>,
    /// `APPDATA`。fnm の既定の置き場（`fnm`）の親。
    pub app_data: Option<PathBuf>,
    /// `USERPROFILE`。scoop の既定の置き場（`scoop`）の親。
    pub user_profile: Option<PathBuf>,
    /// `NVM_SYMLINK`。nvm-windows が選んだ版を指すリンクの場所。
    pub nvm_symlink: Option<PathBuf>,
    /// `NVM_HOME`。nvm-windows が版ごとの Node を置く場所。
    pub nvm_home: Option<PathBuf>,
    /// `FNM_DIR`。fnm の置き場を移したときの場所。
    pub fnm_dir: Option<PathBuf>,
    /// `VOLTA_HOME`。Volta の置き場を移したときの場所。
    pub volta_home: Option<PathBuf>,
    /// `SCOOP`。scoop の置き場を移したときの場所。
    pub scoop: Option<PathBuf>,
    /// `PATH` の各項目。
    pub path_dirs: Vec<PathBuf>,
}

impl WindowsEnv {
    pub fn from_process_env() -> Self {
        let var = |k: &str| {
            std::env::var_os(k)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        Self {
            program_files: var("ProgramFiles"),
            local_app_data: var("LOCALAPPDATA"),
            app_data: var("APPDATA"),
            user_profile: var("USERPROFILE"),
            nvm_symlink: var("NVM_SYMLINK"),
            nvm_home: var("NVM_HOME"),
            fnm_dir: var("FNM_DIR"),
            volta_home: var("VOLTA_HOME"),
            scoop: var("SCOOP"),
            path_dirs: std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).collect())
                .unwrap_or_default(),
        }
    }
}

/// scoop で Node を入れるアプリの名前か。`nodejs`、`nodejs-lts`、versions の桶の `nodejs22` などを採る。
fn is_scoop_node_app(name: &str) -> bool {
    match name.strip_prefix("nodejs") {
        Some("") | Some("-lts") => true,
        Some(rest) => rest.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

/// Windows の探索先。公式のインストーラの入れ先、nvm-windows（新しい版が先）、fnm、Volta、scoop（それぞれ新しい版が先）、PATH の順。
/// fnm、Volta、scoop は、PATH を切り替える仕掛け（fnm の multishells、Volta と scoop の shim）ではなく、版ごとの実体の場所を見る。
/// 置き場は、環境変数（`FNM_DIR`、`VOLTA_HOME`、`SCOOP`）があればそれ、無ければ既定の場所である。
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
    let fnm = env
        .fnm_dir
        .clone()
        .or_else(|| env.app_data.as_ref().map(|d| d.join("fnm")));
    if let Some(fnm) = fnm {
        all.extend(versioned_node_paths(
            &fnm.join("node-versions"),
            Path::new("installation").join("node.exe"),
        ));
    }
    let volta = env
        .volta_home
        .clone()
        .or_else(|| env.local_app_data.as_ref().map(|d| d.join("Volta")));
    if let Some(volta) = volta {
        all.extend(versioned_node_paths(
            &volta.join("tools").join("image").join("node"),
            "node.exe",
        ));
    }
    let scoop = env
        .scoop
        .clone()
        .or_else(|| env.user_profile.as_ref().map(|d| d.join("scoop")));
    if let Some(apps) = scoop.map(|d| d.join("apps")) {
        let mut names: Vec<String> = std::fs::read_dir(&apps)
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.file_name().to_string_lossy().to_string())
                    .filter(|n| is_scoop_node_app(n))
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        for n in names {
            all.extend(versioned_node_paths(&apps.join(n), "node.exe"));
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

/// `node -p PROBE_EXPR` の出力（例 `v22.14.0 arm64 10`）を読む。
/// 候補は利用者が指定した任意のパスなので、期待した 1 行だけが出るとは限らない。
/// 前置きや後書きの行が混ざっても、`v<版> <アーキ> <Node-API の版>` の形をした行を探し当てる。
/// 後ろの行から見るのは、答えが最後に出るためである。
pub fn parse_probe(output: &str) -> Option<NodeProbe> {
    output.lines().rev().find_map(parse_probe_line)
}

/// 1 行が `v<版> <アーキ> <Node-API の版>` ちょうどの形かを見る。
/// 語が 4 つ以上並ぶ行は、Node の答えと見なさない。
/// `process.arch` の値はどれも英小文字と数字だけなので、それ以外を含む語も退ける。
fn parse_probe_line(line: &str) -> Option<NodeProbe> {
    let mut it = line.split_whitespace();
    let version = it.next()?;
    let arch = it.next()?;
    let napi = it.next()?;
    if it.next().is_some() {
        return None;
    }
    if arch.is_empty()
        || !arch
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    {
        return None;
    }
    if napi.is_empty() || !napi.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (a, b, c) = parse_version(version)?;
    Some(NodeProbe {
        version: format!("{a}.{b}.{c}"),
        napi: napi.parse().ok()?,
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
    // 名前や相対のパスは、殻の作業ディレクトリしだいで指す先が変わる（Command は名前を PATH からも引く）。
    // `nodePath` は絶対パスだけを受けるので、そうでない値は無いものとして扱う。
    if !path.is_absolute() || !path.is_file() {
        return ProbeOutcome::Missing;
    }
    let mut cmd = Command::new(path);
    cmd.args(["-p", PROBE_EXPR])
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

/// 候補を順に調べ、manifest に合う（Node-API が足りて、アーキテクチャが同じ）最初の Node を返す。
pub fn choose_node(
    candidates: &[PathBuf],
    manifest: &Manifest,
    probe: impl Fn(&Path) -> ProbeOutcome,
) -> Result<PathBuf, NodeError> {
    let mut tried = Vec::new();
    for c in candidates {
        let outcome = probe(c);
        if let ProbeOutcome::Ok(pr) = &outcome {
            if fit(pr, manifest) == Fit::Ok {
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

/// 見つからなかった理由の見立て。
/// 要る Node-API を持つ別のアーキの Node があれば `Arch`、Node として答えた候補があれば `Version`（最初に見つけたもの）、
/// 無ければ `Missing`。
/// 要る作りの別のアーキを先に言うのは、入れ直すものがその作りだからである。
enum Found<'a> {
    Missing,
    Version(&'a NodeProbe),
    Arch(&'a NodeProbe),
}

fn found_of(e: &NodeError) -> Found<'_> {
    let NodeError::NotFound { manifest, tried } = e;
    let probes: Vec<&NodeProbe> = tried
        .iter()
        .filter_map(|t| match &t.outcome {
            ProbeOutcome::Ok(pr) => Some(pr),
            _ => None,
        })
        .collect();
    if let Some(p) = probes.iter().find(|p| fit(p, manifest) == Fit::Arch) {
        Found::Arch(p)
    } else if let Some(p) = probes.first() {
        Found::Version(p)
    } else {
        Found::Missing
    }
}

/// 起動の失敗の種類（ログの `boot failed (<種類>)` と頁の札）。
/// 見つからない（`node-missing`）、版が古い（`node-version-mismatch`）、アーキテクチャが違う（`node-arch-mismatch`）を分ける。
/// 0.6.0 までは、Node 24 だけがある PC でも `node-missing` と「見つかりません」を出していた（2026-10-13 の報告）。
pub fn failure_kind(e: &NodeError) -> &'static str {
    match found_of(e) {
        Found::Missing => "node-missing",
        Found::Version(_) => "node-version-mismatch",
        Found::Arch(_) => "node-arch-mismatch",
    }
}

/// 起動の失敗の札に渡す数と短い名前。
/// `min`、`napi`、`arch` は要るもの、`found` と `foundArch` は見つけた Node の版と作り（見つからないときは持たない）。
pub fn failure_params(e: &NodeError) -> serde_json::Map<String, serde_json::Value> {
    let NodeError::NotFound { manifest, .. } = e;
    let mut p = serde_json::Map::new();
    p.insert("min".into(), manifest.node_min.clone().into());
    p.insert("napi".into(), manifest.node_api.into());
    p.insert("arch".into(), manifest.arch.clone().into());
    if let Found::Version(f) | Found::Arch(f) = found_of(e) {
        p.insert("found".into(), f.version.clone().into());
        p.insert("foundArch".into(), f.arch.clone().into());
    }
    p
}

/// 起動の失敗の札の「node を選ぶ…」で選んだ 1 つを確かめた結果。
#[derive(Debug, Clone, PartialEq)]
pub enum Picked {
    /// 合う。設定の nodePath に書いてよい。
    Ok,
    /// Node として答えない（無い、起動できない、答えが読めない、時間切れ）。
    NotNode,
    /// Node-API が足りない。
    Version { found: String },
    /// アーキテクチャが違う。
    Arch { found_arch: String },
}

/// 選んだ 1 つを、設定の欄（packages/server の nodeBuildIssue）と同じ条件で確かめる。
pub fn check_picked(
    path: &Path,
    manifest: &Manifest,
    probe: impl Fn(&Path) -> ProbeOutcome,
) -> Picked {
    match probe(path) {
        ProbeOutcome::Ok(p) => match fit(&p, manifest) {
            Fit::Ok => Picked::Ok,
            Fit::Version => Picked::Version { found: p.version },
            Fit::Arch => Picked::Arch { found_arch: p.arch },
        },
        _ => Picked::NotNode,
    }
}

/// 頁（loading/boot-fail.js の pickText）へ返す形。
pub fn pick_answer(path: &Path, picked: &Picked, manifest: &Manifest) -> serde_json::Value {
    let path = path.display().to_string();
    match picked {
        Picked::Ok => serde_json::json!({ "result": "ok", "path": path }),
        Picked::NotNode => serde_json::json!({ "result": "notNode", "path": path }),
        Picked::Version { found } => serde_json::json!({
            "result": "version", "path": path, "found": found, "min": manifest.node_min, "arch": manifest.arch,
        }),
        Picked::Arch { found_arch } => serde_json::json!({
            "result": "arch", "path": path, "foundArch": found_arch, "min": manifest.node_min, "arch": manifest.arch,
        }),
    }
}

/// 利用者だけが読める形（0600）でファイルを書き、ディスクへ流してから戻る。
fn write_private(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    let mut f = open.open(file)?;
    std::io::Write::write_all(&mut f, bytes)?;
    f.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// 設定（`<HANGAR_HOME>/settings.json`）の `nodePath` を書く。ほかの項目は残す。
/// 設定が無ければ作る。読めない設定は上書きしない（ほかの項目を消さないため）。
/// サーバの保存（paths.ts の saveSettings）と同じく、利用者だけが読める形（0600）にする。
/// 一時のファイルに書いてから名前を替え、書きかけの設定を残さない。
pub fn save_node_path(hangar_home: &Path, node: &Path) -> Result<(), String> {
    let file = hangar_home.join("settings.json");
    let mut obj = match std::fs::read_to_string(&file) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(serde_json::Value::Object(o)) => o,
            Ok(_) => return Err(format!("{} is not a JSON object", file.display())),
            Err(e) => return Err(format!("{}: {e}", file.display())),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::Map::new(),
        Err(e) => return Err(format!("{}: {e}", file.display())),
    };
    obj.insert(
        "nodePath".into(),
        node.to_string_lossy().into_owned().into(),
    );
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(obj))
        .map_err(|e| e.to_string())?
        + "\n";
    std::fs::create_dir_all(hangar_home).map_err(|e| e.to_string())?;
    let tmp = hangar_home.join(format!("settings.json.tmp-{}", std::process::id()));
    if let Err(e) = write_private(&tmp, text.as_bytes()).and_then(|()| std::fs::rename(&tmp, &file))
    {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{}: {e}", file.display()));
    }
    Ok(())
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
    /// macOS。何も無ければ `brew install node`、古い Node があれば既定の node を置き換えない `brew install node@22`（殻は keg の場所も探す）。
    Homebrew,
    /// Windows。何も無ければ `winget install -e --id OpenJS.NodeJS.LTS`（公式のインストーラで `%ProgramFiles%\nodejs` に入り、殻はそこを先に探す）。
    /// 古い Node があれば、winget は今の Node を置き換えるので、公式の zip を別のフォルダに展開して選ぶ道を先に案内する。
    Winget,
    /// Linux。nvm で入れる。
    Nvm,
}

impl InstallHint {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            InstallHint::Homebrew
        } else if cfg!(windows) {
            InstallHint::Winget
        } else {
            InstallHint::Nvm
        }
    }
}

/// Windows で、何も無いときに Node（いまの LTS）を入れる命令。頁（boot-fail.js）、launch-cli.ts、hangar.cmd、README と同じ形にする。
pub const WINGET_LTS: &str = "winget install -e --id OpenJS.NodeJS.LTS";

/// 詳細の文に埋める値。
struct Words {
    min: String,
    napi: u32,
    arch: String,
    lts: String,
    settings: String,
    /// 起動の失敗の札の「node を選ぶ…」の名前（Windows は node.exe）。
    pick: &'static str,
}

/// 同上。案内する入れ方を引数で受け取る形。どの OS の上でも、両方の文を試験できるようにする。
/// 1 行目は何が起きたか（見つからない、版が古い、アーキテクチャが違う）、2 行目は理由、続けて入れ方、指し方、調べた場所の順に並べる。
/// 古い Node があるときは、今の Node を置き換えない入れ方を先に案内する。
fn describe_error_for(e: &NodeError, hangar_home: &Path, lang: &str, hint: InstallHint) -> String {
    let NodeError::NotFound { manifest, tried } = e;
    let en = lang == "en";
    let w = Words {
        min: manifest.node_min.clone(),
        napi: manifest.node_api,
        arch: manifest.arch.clone(),
        lts: manifest.lts_major(),
        settings: hangar_home.join("settings.json").display().to_string(),
        pick: match (en, hint) {
            (false, InstallHint::Winget) => "「node.exe を選ぶ…」",
            (false, _) => "「node を選ぶ…」",
            (true, InstallHint::Winget) => "\"Choose node.exe…\"",
            (true, _) => "\"Choose node…\"",
        },
    };
    let found = found_of(e);
    let has_node = !matches!(found, Found::Missing);
    let mut lines = vec![
        if en {
            headline_en(&found, &w)
        } else {
            headline_ja(&found, &w)
        },
        if en { why_en(&w) } else { why_ja(&w) },
    ];
    lines.extend(if en {
        ways_en(hint, has_node, &w)
    } else {
        ways_ja(hint, has_node, &w)
    });
    lines.push(if en {
        "Places checked:".to_string()
    } else {
        "調べた場所:".to_string()
    });
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
fn headline_ja(found: &Found, w: &Words) -> String {
    match found {
        Found::Missing => format!("Node {} 以上（{}）が見つかりません。", w.min, w.arch),
        Found::Version(p) => format!("Node {} は見つかりましたが、Hangar は Node {} 以上（{}）が要ります。", p.version, w.min, w.arch),
        Found::Arch(p) => format!("{} 用の Node {} は見つかりましたが、Hangar は {} 用の Node {} 以上が要ります。", p.arch, p.version, w.arch, w.min),
    }
}

#[rustfmt::skip]
fn headline_en(found: &Found, w: &Words) -> String {
    match found {
        Found::Missing => format!("Node {} or later ({}) was not found.", w.min, w.arch),
        Found::Version(p) => format!("Node {} was found, but Hangar needs Node {} or later ({}).", p.version, w.min, w.arch),
        Found::Arch(p) => format!("Node {} for {} was found, but Hangar needs Node {} or later for {}.", p.version, p.arch, w.min, w.arch),
    }
}

#[rustfmt::skip]
fn why_ja(w: &Words) -> String {
    format!("Hangar のデータベースと端末の部品は Node-API {} を使うため、Node {} 以上が要ります。", w.napi, w.min)
}

#[rustfmt::skip]
fn why_en(w: &Words) -> String {
    format!("Hangar's database and terminal parts use Node-API {}, so Node {} or later is needed.", w.napi, w.min)
}

/// 入れ方と指し方の行。古い Node があるとき（has_node）は、今の Node を置き換えない入れ方を先に置く。
#[rustfmt::skip]
fn ways_ja(hint: InstallHint, has_node: bool, w: &Words) -> Vec<String> {
    let nvm_windows = format!("nvm-windows を使うなら、nvm install {} で入れた版も見つけます（fnm、Volta、scoop で入れた版と、PATH にある版も探します）。", w.lts);
    let elsewhere = format!("ほかの場所に入れたなら、{}で選ぶか、{} の nodePath で場所を指定してください。", w.pick, w.settings);
    let mut v = match (hint, has_node) {
        (InstallHint::Homebrew, false) => vec![
            "brew install node で入れれば、次に開いたときに見つけます（nvm、fnm、Volta、mise、asdf、nodenv で入れた版も探します）。".to_string(),
        ],
        (InstallHint::Homebrew, true) => vec![
            format!("今の Node を置き換えずに入れるなら、brew install node@{0}（既定の node を置き換えません）か nvm install {0} で入れれば、次に開いたときに見つけます（fnm、Volta、mise、asdf、nodenv で入れた版も探します）。", w.lts),
        ],
        (InstallHint::Winget, false) => vec![
            format!("PowerShell で {WINGET_LTS} を実行して入れれば、次に開いたときに見つけます。"),
            nvm_windows,
        ],
        (InstallHint::Winget, true) => vec![
            format!("今の Node を置き換えずに入れるなら、nodejs.org から Node {0} の Windows 用 zip（{1}）を取得して、別のフォルダ（例 %LOCALAPPDATA%\\Programs\\node{0}）に展開し、その node.exe を指定してください。", w.lts, w.arch),
            nvm_windows,
            format!("PowerShell で {WINGET_LTS} を実行しても入れられますが、公式のインストーラで入れた今の Node は置き換わります。"),
        ],
        (InstallHint::Nvm, false) => vec!["nvm install --lts を実行すれば、次に開いたときに見つけます。".to_string()],
        (InstallHint::Nvm, true) => vec![format!("今の Node を置き換えずに入れるなら、nvm install {} を実行すれば、次に開いたときに見つけます。", w.lts)],
    };
    v.push(elsewhere);
    v
}

#[rustfmt::skip]
fn ways_en(hint: InstallHint, has_node: bool, w: &Words) -> Vec<String> {
    let nvm_windows = format!("With nvm-windows, a version installed with nvm install {} is found too (Hangar also looks in fnm, Volta, scoop, and PATH).", w.lts);
    let elsewhere = format!("If it is installed somewhere else, choose it with {} or set nodePath in {} to its location.", w.pick, w.settings);
    let mut v = match (hint, has_node) {
        (InstallHint::Homebrew, false) => vec![
            "Install it with brew install node and Hangar finds it the next time it opens (it also looks for versions installed with nvm, fnm, Volta, mise, asdf, and nodenv).".to_string(),
        ],
        (InstallHint::Homebrew, true) => vec![
            format!("To keep your current Node, install brew install node@{0} (it does not replace the default node) or nvm install {0}, and Hangar finds it the next time it opens (it also looks in fnm, Volta, mise, asdf, and nodenv).", w.lts),
        ],
        (InstallHint::Winget, false) => vec![
            format!("Install it with {WINGET_LTS} in PowerShell and Hangar finds it the next time it opens."),
            nvm_windows,
        ],
        (InstallHint::Winget, true) => vec![
            format!("To keep your current Node, get the Windows zip of Node {0} ({1}) from nodejs.org, extract it to a separate folder (for example %LOCALAPPDATA%\\Programs\\node{0}), and choose its node.exe.", w.lts, w.arch),
            nvm_windows,
            format!("{WINGET_LTS} in PowerShell also installs it, but it replaces a Node installed with the official installer."),
        ],
        (InstallHint::Nvm, false) => vec!["Run nvm install --lts and Hangar finds it the next time it opens.".to_string()],
        (InstallHint::Nvm, true) => vec![format!("To keep your current Node, run nvm install {} and Hangar finds it the next time it opens.", w.lts)],
    };
    v.push(elsewhere);
    v
}

#[rustfmt::skip]
fn outcome_ja(o: &ProbeOutcome, m: &Manifest) -> String {
    match o {
        ProbeOutcome::Ok(p) => match fit(p, m) {
            Fit::Version => format!("v{} {}（Node-API {}。Node {} 以上が要ります）", p.version, p.arch, p.napi, m.node_min),
            Fit::Arch => format!("v{} {}（{} 用が要ります）", p.version, p.arch, m.arch),
            Fit::Ok => format!("v{} {}", p.version, p.arch),
        },
        ProbeOutcome::Missing => "ありません".to_string(),
        ProbeOutcome::NotExecutable => "起動できません（実行権を確かめてください）".to_string(),
        ProbeOutcome::Failed => "Node ではありません（別の実行ファイルのようです）".to_string(),
        ProbeOutcome::TimedOut => format!("{} 秒のあいだ応答しません（打ち切りました）", PROBE_TIMEOUT.as_secs()),
    }
}

#[rustfmt::skip]
fn outcome_en(o: &ProbeOutcome, m: &Manifest) -> String {
    match o {
        ProbeOutcome::Ok(p) => match fit(p, m) {
            Fit::Version => format!("v{} {} (Node-API {}; Node {} or later is needed)", p.version, p.arch, p.napi, m.node_min),
            Fit::Arch => format!("v{} {} ({} is needed)", p.version, p.arch, m.arch),
            Fit::Ok => format!("v{} {}", p.version, p.arch),
        },
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
            node_api: 10,
            node_min: "22.14".into(),
            arch: "arm64".into(),
        }
    }

    fn probe(version: &str, arch: &str, napi: u32) -> NodeProbe {
        NodeProbe {
            version: version.into(),
            napi,
            arch: arch.into(),
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
            ..WindowsEnv::default()
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

    /// fnm、Volta、scoop が版ごとに置く Node も、nvm-windows のあと PATH の前に探す（新しい版から）。
    /// 置き場は、環境変数（FNM_DIR、VOLTA_HOME、SCOOP）があればそれ、無ければ既定の場所（%APPDATA%\fnm、%LOCALAPPDATA%\Volta、%USERPROFILE%\scoop）。
    #[test]
    fn windows_candidates_include_fnm_volta_and_scoop_versions() {
        let root = tempfile::tempdir().unwrap();
        let roaming = root.path().join("Roaming");
        let local = root.path().join("Local");
        let profile = root.path().join("me");
        let nvm = root.path().join("nvm");
        touch(&nvm.join("v22.1.0").join("node.exe"));
        let fnm = roaming.join("fnm").join("node-versions");
        for v in ["v20.5.0", "v22.14.0"] {
            touch(&fnm.join(v).join("installation").join("node.exe"));
        }
        let volta = local.join("Volta").join("tools").join("image").join("node");
        for v in ["22.9.0", "24.1.0"] {
            touch(&volta.join(v).join("node.exe"));
        }
        let scoop = profile.join("scoop").join("apps");
        touch(&scoop.join("nodejs-lts").join("22.11.0").join("node.exe"));
        // current は版の実体へのリンクなので、版と読まない。
        touch(&scoop.join("nodejs-lts").join("current").join("node.exe"));
        touch(&scoop.join("nodejs").join("24.0.0").join("node.exe"));
        // Node 以外のアプリは見ない。
        touch(&scoop.join("python").join("3.12.0").join("node.exe"));
        let on_path = root.path().join("tools");
        touch(&on_path.join("node.exe"));

        let got = windows_node_paths(&WindowsEnv {
            local_app_data: Some(local.clone()),
            app_data: Some(roaming.clone()),
            user_profile: Some(profile.clone()),
            nvm_home: Some(nvm.clone()),
            path_dirs: vec![on_path.clone()],
            ..WindowsEnv::default()
        });
        assert_eq!(
            got,
            vec![
                local.join("Programs").join("nodejs").join("node.exe"),
                nvm.join("v22.1.0").join("node.exe"),
                fnm.join("v22.14.0").join("installation").join("node.exe"),
                fnm.join("v20.5.0").join("installation").join("node.exe"),
                volta.join("24.1.0").join("node.exe"),
                volta.join("22.9.0").join("node.exe"),
                scoop.join("nodejs").join("24.0.0").join("node.exe"),
                scoop.join("nodejs-lts").join("22.11.0").join("node.exe"),
                on_path.join("node.exe"),
            ]
        );

        // 環境変数で置き場を移していれば、そちらを見る。
        let fnm_dir = root.path().join("my-fnm");
        touch(
            &fnm_dir
                .join("node-versions")
                .join("v22.2.0")
                .join("installation")
                .join("node.exe"),
        );
        let volta_home = root.path().join("my-volta");
        touch(
            &volta_home
                .join("tools")
                .join("image")
                .join("node")
                .join("22.3.0")
                .join("node.exe"),
        );
        let scoop_root = root.path().join("my-scoop");
        touch(
            &scoop_root
                .join("apps")
                .join("nodejs22")
                .join("22.4.0")
                .join("node.exe"),
        );
        let got = windows_node_paths(&WindowsEnv {
            app_data: Some(roaming.clone()),
            local_app_data: Some(local.clone()),
            user_profile: Some(profile.clone()),
            fnm_dir: Some(fnm_dir.clone()),
            volta_home: Some(volta_home.clone()),
            scoop: Some(scoop_root.clone()),
            ..WindowsEnv::default()
        });
        assert_eq!(
            got,
            vec![
                local.join("Programs").join("nodejs").join("node.exe"),
                fnm_dir
                    .join("node-versions")
                    .join("v22.2.0")
                    .join("installation")
                    .join("node.exe"),
                volta_home
                    .join("tools")
                    .join("image")
                    .join("node")
                    .join("22.3.0")
                    .join("node.exe"),
                scoop_root
                    .join("apps")
                    .join("nodejs22")
                    .join("22.4.0")
                    .join("node.exe"),
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
    fn parse_probe_reads_version_arch_and_node_api() {
        assert_eq!(
            parse_probe("v22.14.0 arm64 10\n"),
            Some(probe("22.14.0", "arm64", 10))
        );
        assert_eq!(parse_probe("garbage"), None);
        assert_eq!(parse_probe(""), None);
        // 0.6.0 までの答えの形（Node-API の版が無い）は読まない。
        assert_eq!(parse_probe("v22.14.0 arm64"), None);
    }

    // 前置きの 1 行を出す環境（NODE_OPTIONS の警告、包みの script）でも、健全な Node を取り逃がさない。
    // 逆に、答えの行に余計な語が続く出力は Node の答えと見なさない。
    #[test]
    fn parse_probe_looks_past_the_lines_around_the_answer() {
        let v22 = Some(probe("22.14.0", "arm64", 10));
        assert_eq!(
            parse_probe("(node:1) ExperimentalWarning: x\nv22.14.0 arm64 10\n"),
            v22
        );
        assert_eq!(parse_probe("v22.14.0 arm64 10\nbye\n"), v22);
        assert_eq!(parse_probe("v22.14.0 arm64 10 extra"), None);
        assert_eq!(parse_probe("v1.2.3 v4.5.6 7"), None);
        assert_eq!(parse_probe("not a node\nnot a node either\n"), None);
    }

    /// 見本の表（packages/server/src/config/node-rule-cases.json）。
    /// 設定の確かめ（nodeRule.ts）、launch-cli.ts、hangar.sh の試験も同じ表を読み、同じ答えを出すことを確かめる。
    // CI の rustfmt は日本語の幅を手元と違って数えるので、整形を止めて書いたままにする。
    #[rustfmt::skip]
    #[test]
    fn the_rule_follows_the_shared_table() {
        let table: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../packages/server/src/config/node-rule-cases.json"
        ))
        .unwrap();
        let need = &table["need"];
        let m = Manifest {
            version: "0".into(),
            node_api: need["napi"].as_u64().unwrap() as u32,
            node_min: need["min"].as_str().unwrap().into(),
            arch: need["arch"].as_str().unwrap().into(),
        };
        let cases = table["cases"].as_array().unwrap();
        assert!(cases.len() >= 10);
        for c in cases {
            let answer = c["answer"].as_str().unwrap();
            let got = parse_probe(answer);
            match c["fit"].as_str() {
                None => assert_eq!(got, None, "{answer:?}"),
                Some(want) => {
                    let p = got.unwrap_or_else(|| panic!("{answer:?} を読めない"));
                    assert_eq!(p.version, c["version"].as_str().unwrap(), "{answer:?}");
                    assert_eq!(p.napi as u64, c["napi"].as_u64().unwrap(), "{answer:?}");
                    assert_eq!(p.arch, c["arch"].as_str().unwrap(), "{answer:?}");
                    let f = match fit(&p, &m) {
                        Fit::Ok => "ok",
                        Fit::Version => "version",
                        Fit::Arch => "arch",
                    };
                    assert_eq!(f, want, "{answer:?}");
                }
            }
        }
    }

    /// 候補に訊く式は、設定の確かめ（nodeRule.ts の NODE_PROBE_EXPR）と hangar.sh と同じ。
    #[test]
    fn the_probe_expression_is_the_same_as_the_server_and_hangar_sh() {
        let rule = include_str!("../../../../packages/server/src/config/nodeRule.ts");
        assert!(
            rule.contains(&format!("NODE_PROBE_EXPR = '{PROBE_EXPR}'")),
            "{PROBE_EXPR}"
        );
        let sh = include_str!("../../scripts/hangar.sh");
        assert!(sh.contains(&format!("-p '{PROBE_EXPR}'")), "{PROBE_EXPR}");
    }

    #[test]
    fn choose_node_takes_first_fitting_and_reports_tried() {
        let probes: HashMap<PathBuf, ProbeOutcome> = HashMap::from([
            (
                PathBuf::from("/a/node"),
                ProbeOutcome::Ok(probe("20.18.0", "arm64", 9)),
            ),
            (PathBuf::from("/b/node"), ProbeOutcome::Missing),
            (
                PathBuf::from("/c/node"),
                ProbeOutcome::Ok(probe("24.21.0", "arm64", 10)),
            ),
            (
                PathBuf::from("/d/node"),
                ProbeOutcome::Ok(probe("22.14.0", "arm64", 10)),
            ),
        ]);
        let probe_of = |p: &Path| probes.get(p).cloned().unwrap_or(ProbeOutcome::Missing);
        let cands = ["/a/node", "/b/node", "/c/node", "/d/node"].map(PathBuf::from);
        // 上限は付けない。Node 24 も採る。
        assert_eq!(
            choose_node(&cands, &manifest(), probe_of),
            Ok(PathBuf::from("/c/node"))
        );

        let x64 = Manifest {
            arch: "x64".into(),
            ..manifest()
        };
        let err = choose_node(&cands, &x64, probe_of).unwrap_err();
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
                outcome: ProbeOutcome::Ok(probe("20.18.0", "x64", 9)),
            },
            Tried {
                path: PathBuf::from("/f/node"),
                outcome: ProbeOutcome::Ok(probe("24.21.0", "arm64", 10)),
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

    fn not_found(tried: Vec<(&str, ProbeOutcome)>) -> NodeError {
        NodeError::NotFound {
            manifest: manifest(),
            tried: tried
                .into_iter()
                .map(|(p, outcome)| Tried {
                    path: PathBuf::from(p),
                    outcome,
                })
                .collect(),
        }
    }

    fn ok(version: &str, arch: &str, napi: u32) -> ProbeOutcome {
        ProbeOutcome::Ok(probe(version, arch, napi))
    }

    fn no_kana(text: &str) -> bool {
        !text.chars().any(|c| {
            matches!(c, '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{9fff}' | '\u{ff08}' | '\u{ff09}')
        })
    }

    // 見つからない理由ごとに、ログの種類と頁の札を分ける（Node 24 だけの Windows で node-missing と出ていた、2026-10-13）。
    // 要る作りの別のアーキの Node があればそれを先に言う。入れ直すものがその作りだからである。
    #[test]
    fn failure_kind_says_missing_version_or_arch() {
        let missing = not_found(vec![
            ("/a/node", ProbeOutcome::Missing),
            ("/b/node", ProbeOutcome::Failed),
        ]);
        assert_eq!(failure_kind(&missing), "node-missing");
        assert_eq!(failure_kind(&not_found(vec![])), "node-missing");
        let old = not_found(vec![
            ("/a/node", ProbeOutcome::Missing),
            ("/b/node", ok("20.18.0", "arm64", 9)),
        ]);
        assert_eq!(failure_kind(&old), "node-version-mismatch");
        let arch = not_found(vec![
            ("/a/node", ok("20.18.0", "arm64", 9)),
            ("/b/node", ok("24.18.0", "x64", 10)),
        ]);
        assert_eq!(failure_kind(&arch), "node-arch-mismatch");
        // 種類は頁の表（bootfail.rs の KINDS）にあるものである。
        for e in [&missing, &old, &arch] {
            assert!(crate::bootfail::KINDS.contains(&failure_kind(e)));
        }
    }

    #[test]
    fn failure_params_carry_the_need_and_what_was_found() {
        let need = serde_json::json!({"min": "22.14", "napi": 10, "arch": "arm64"});
        let p = failure_params(&not_found(vec![("/a/node", ProbeOutcome::Missing)]));
        assert_eq!(serde_json::Value::Object(p), need);
        let p = failure_params(&not_found(vec![
            ("/a/node", ProbeOutcome::Missing),
            ("/b/node", ok("20.18.0", "arm64", 9)),
            ("/c/node", ok("18.20.0", "arm64", 9)),
        ]));
        assert_eq!(
            serde_json::Value::Object(p),
            serde_json::json!({"min": "22.14", "napi": 10, "arch": "arm64", "found": "20.18.0", "foundArch": "arm64"})
        );
        let p = failure_params(&not_found(vec![
            ("/a/node", ok("20.18.0", "arm64", 9)),
            ("/b/node", ok("24.18.0", "x64", 10)),
        ]));
        assert_eq!(
            serde_json::Value::Object(p),
            serde_json::json!({"min": "22.14", "napi": 10, "arch": "arm64", "found": "24.18.0", "foundArch": "x64"})
        );
    }

    /// 理由の 1 文（利用者が決めた文言）。
    #[rustfmt::skip]
    const WHY_JA: &str =
        "Hangar のデータベースと端末の部品は Node-API 10 を使うため、Node 22.14 以上が要ります。";
    #[rustfmt::skip]
    const WHY_EN: &str =
        "Hangar's database and terminal parts use Node-API 10, so Node 22.14 or later is needed.";

    // CI の rustfmt は日本語の幅を手元と違って数えるので、整形を止めて書いたままにする。
    #[rustfmt::skip]
    #[test]
    fn describe_error_names_the_real_settings_file_and_each_reason() {
        let err = every_reason();
        let text = describe_error_for(&err, Path::new("/elsewhere/hangar"), "ja", InstallHint::Nvm);
        // Node が見つかっているので、見つからないとは言わない。要る版を持つ別のアーキの Node を先に言う。
        assert!(
            text.starts_with(
                "arm64 用の Node 24.21.0 は見つかりましたが、Hangar は x64 用の Node 22.14 以上が要ります。"
            ),
            "{text}"
        );
        assert!(text.contains(WHY_JA), "{text}");
        assert!(text.contains("nvm install 22"), "{text}");
        // HANGAR_HOME を使っていれば、その場所を案内する。
        let settings = Path::new("/elsewhere/hangar").join("settings.json");
        assert!(text.contains(&settings.display().to_string()), "{text}");
        assert!(!text.contains("~/.agent-hangar"), "{text}");
        // 「無し」の理由が読み分けられる。
        assert!(
            text.contains("/a/node: v20.18.0 x64（Node-API 9。Node 22.14 以上が要ります）"),
            "{text}"
        );
        assert!(
            text.contains("/f/node: v24.21.0 arm64（x64 用が要ります）"),
            "{text}"
        );
        assert!(text.contains("/b/node: ありません"), "{text}");
        assert!(text.contains("/c/node: 起動できません"), "{text}");
        assert!(text.contains("/d/node: Node ではありません"), "{text}");
        assert!(text.contains("/e/node: 5 秒のあいだ応答しません"), "{text}");
    }

    // 英語の設定では、見つからない理由も調べた場所も英語で出す（Windows の実機で、ここだけ日本語のまま出ていた）。
    // CI の rustfmt は日本語の幅を手元と違って数えるので、整形を止めて書いたままにする。
    #[rustfmt::skip]
    #[test]
    fn describe_error_follows_the_page_language() {
        let err = every_reason();
        let text = describe_error_for(&err, Path::new("/elsewhere/hangar"), "en", InstallHint::Nvm);
        assert!(
            text.starts_with(
                "Node 24.21.0 for arm64 was found, but Hangar needs Node 22.14 or later for x64."
            ),
            "{text}"
        );
        assert!(text.contains(WHY_EN), "{text}");
        assert!(text.contains("nvm install 22"), "{text}");
        let settings = Path::new("/elsewhere/hangar").join("settings.json");
        assert!(text.contains(&settings.display().to_string()), "{text}");
        assert!(text.contains("Places checked:"), "{text}");
        assert!(
            text.contains("/a/node: v20.18.0 x64 (Node-API 9; Node 22.14 or later is needed)"),
            "{text}"
        );
        assert!(
            text.contains("/f/node: v24.21.0 arm64 (x64 is needed)"),
            "{text}"
        );
        assert!(text.contains("/b/node: not found"), "{text}");
        assert!(text.contains("/c/node: cannot run it"), "{text}");
        assert!(text.contains("/d/node: not Node"), "{text}");
        assert!(text.contains("/e/node: no answer for 5 seconds"), "{text}");
        assert!(no_kana(&text), "{text}");
    }

    // 見つからないときは見つからないと言い、何も無いときの一般の入れ方を案内する。
    // CI の rustfmt は日本語の幅を手元と違って数えるので、整形を止めて書いたままにする。
    #[rustfmt::skip]
    #[test]
    fn describe_error_without_any_node_says_not_found_and_how_to_install() {
        let err = not_found(vec![("/a/node", ProbeOutcome::Missing)]);
        let home = Path::new("/elsewhere/hangar");
        let ja = describe_error_for(&err, home, "ja", InstallHint::Homebrew);
        assert!(
            ja.starts_with("Node 22.14 以上（arm64）が見つかりません。"),
            "{ja}"
        );
        assert!(ja.contains(WHY_JA), "{ja}");
        assert!(ja.contains("brew install node で入れれば"), "{ja}");
        let win = describe_error_for(&err, home, "ja", InstallHint::Winget);
        assert!(win.contains(WINGET_LTS), "{win}");
        assert!(win.contains("nvm-windows"), "{win}");
        assert!(!win.contains("zip"), "{win}");
        let en = describe_error_for(&err, home, "en", InstallHint::Winget);
        assert!(
            en.starts_with("Node 22.14 or later (arm64) was not found."),
            "{en}"
        );
        assert!(en.contains(WINGET_LTS), "{en}");
        assert!(no_kana(&en), "{en}");
        let nvm = describe_error_for(&err, home, "ja", InstallHint::Nvm);
        assert!(nvm.contains("nvm install --lts"), "{nvm}");
    }

    // macOS で古い Node があるときは、既定の node を置き換えない Homebrew の node@22 と nvm を案内する。
    // CI の rustfmt は日本語の幅を手元と違って数えるので、整形を止めて書いたままにする。
    #[rustfmt::skip]
    #[test]
    fn describe_error_on_macos_with_an_old_node_says_brew_node_at_22() {
        let err = every_reason();
        let home = Path::new("/elsewhere/hangar");
        let settings = home.join("settings.json").display().to_string();
        let ja = describe_error_for(&err, home, "ja", InstallHint::Homebrew);
        let lines: Vec<&str> = ja.lines().collect();
        assert!(lines[2].contains("brew install node@22"), "{ja}");
        assert!(lines[2].contains("置き換えません"), "{ja}");
        assert!(lines[2].contains("nvm install 22"), "{ja}");
        assert!(lines[3].contains(&settings), "{ja}");
        assert!(lines[3].contains("「node を選ぶ…」"), "{ja}");
        assert_eq!(lines[4], "調べた場所:", "{ja}");
        assert!(!ja.contains("brew link"), "{ja}");
        let en = describe_error_for(&err, home, "en", InstallHint::Homebrew);
        assert!(en.contains("brew install node@22"), "{en}");
        assert!(en.contains("\"Choose node…\""), "{en}");
        assert!(no_kana(&en), "{en}");
    }

    // Windows で古い Node があるときは、今の Node を置き換えない公式の zip を先に、nvm-windows を添え、
    // 今の Node を置き換える winget は最後に、置き換わると添えて案内する。
    // CI の rustfmt は日本語の幅を手元と違って数えるので、整形を止めて書いたままにする。
    #[rustfmt::skip]
    #[test]
    fn describe_error_on_windows_with_an_old_node_says_zip_first_and_winget_last() {
        let err = every_reason();
        let home = Path::new("/elsewhere/hangar");
        let settings = home.join("settings.json").display().to_string();
        let ja = describe_error_for(&err, home, "ja", InstallHint::Winget);
        let lines: Vec<&str> = ja.lines().collect();
        assert!(lines[2].contains("zip（x64）"), "{ja}");
        assert!(
            lines[2].contains("%LOCALAPPDATA%\\Programs\\node22"),
            "{ja}"
        );
        assert!(lines[3].contains("nvm-windows"), "{ja}");
        assert!(lines[3].contains("nvm install 22"), "{ja}");
        assert!(lines[4].contains(WINGET_LTS), "{ja}");
        assert!(lines[4].contains("置き換わります"), "{ja}");
        assert!(lines[5].contains(&settings), "{ja}");
        assert!(lines[5].contains("「node.exe を選ぶ…」"), "{ja}");
        assert!(!ja.contains("brew"), "{ja}");
        assert_eq!(lines[6], "調べた場所:", "{ja}");
        let en = describe_error_for(&err, home, "en", InstallHint::Winget);
        let en_lines: Vec<&str> = en.lines().collect();
        assert!(en_lines[2].contains("zip"), "{en}");
        assert!(en_lines[3].contains("nvm-windows"), "{en}");
        assert!(en_lines[4].contains(WINGET_LTS), "{en}");
        assert!(en_lines[5].contains("\"Choose node.exe…\""), "{en}");
        assert!(no_kana(&en), "{en}");
    }

    /// 何も無いときに案内する、winget で Node の LTS を入れる命令。頁（boot-fail.js）、launch-cli.ts、hangar.cmd、README と同じ。
    const WINGET_LTS: &str = "winget install -e --id OpenJS.NodeJS.LTS";

    // 「node を選ぶ…」で選んだ 1 つを、設定の欄と同じ条件で確かめる。
    #[test]
    fn a_picked_node_is_checked_with_the_same_rule() {
        let m = manifest();
        let p = Path::new("/picked/node");
        let answer = |o: ProbeOutcome| check_picked(p, &m, |_| o.clone());
        assert_eq!(answer(ok("24.21.0", "arm64", 10)), Picked::Ok);
        assert_eq!(
            answer(ok("20.18.0", "arm64", 9)),
            Picked::Version {
                found: "20.18.0".into()
            }
        );
        assert_eq!(
            answer(ok("22.14.0", "x64", 10)),
            Picked::Arch {
                found_arch: "x64".into()
            }
        );
        for o in [
            ProbeOutcome::Missing,
            ProbeOutcome::NotExecutable,
            ProbeOutcome::Failed,
            ProbeOutcome::TimedOut,
        ] {
            assert_eq!(answer(o), Picked::NotNode);
        }
        // 頁（boot-fail.js の pickText）が読む形。
        let path = p.display().to_string();
        assert_eq!(
            pick_answer(
                p,
                &Picked::Version {
                    found: "20.18.0".into()
                },
                &m
            ),
            serde_json::json!({"result": "version", "path": path, "found": "20.18.0", "min": "22.14", "arch": "arm64"})
        );
        assert_eq!(
            pick_answer(
                p,
                &Picked::Arch {
                    found_arch: "x64".into()
                },
                &m
            ),
            serde_json::json!({"result": "arch", "path": path, "foundArch": "x64", "min": "22.14", "arch": "arm64"})
        );
        assert_eq!(pick_answer(p, &Picked::NotNode, &m)["result"], "notNode");
        assert_eq!(pick_answer(p, &Picked::Ok, &m)["result"], "ok");
    }

    // 合った Node は設定の nodePath に書く。ほかの項目は残し、ファイルは利用者だけが読める形（0600）にする。
    #[test]
    fn save_node_path_keeps_the_other_settings() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join("settings.json");
        std::fs::write(
            &file,
            r#"{ "language": "en", "nodePath": "/old/node", "workspaceRoot": "/w" }"#,
        )
        .unwrap();
        save_node_path(home.path(), Path::new("/new/node")).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "language": "en", "nodePath": "/new/node", "workspaceRoot": "/w" })
        );
        assert_eq!(
            settings_node_path(home.path()),
            Some(PathBuf::from("/new/node"))
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // 設定が無ければ作る。
        let fresh = tempfile::tempdir().unwrap();
        save_node_path(fresh.path(), Path::new("/n/node")).unwrap();
        assert_eq!(
            settings_node_path(fresh.path()),
            Some(PathBuf::from("/n/node"))
        );
        // 読めない設定は上書きしない（ほかの項目を消さない）。
        std::fs::write(&file, "{ broken").unwrap();
        assert!(save_node_path(home.path(), Path::new("/x/node")).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ broken");
    }

    #[test]
    fn install_hint_is_homebrew_on_macos_winget_on_windows_and_nvm_elsewhere() {
        let want = if cfg!(target_os = "macos") {
            InstallHint::Homebrew
        } else if cfg!(windows) {
            InstallHint::Winget
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
            r#"{ "version": "0.1.0", "nodeApi": 10, "nodeMin": "22.14", "arch": "arm64", "builtAt": "x" }"#,
        )
        .unwrap();
        assert_eq!(read_manifest(dir.path()).unwrap(), manifest());
        // 0.6.0 までの形（メジャー版だけ）は壊れているとみなす。殻と束は同じ版で配るので、混ざらない。
        std::fs::write(
            dir.path().join("manifest.json"),
            r#"{ "version": "0.1.0", "nodeMajor": 22, "arch": "arm64" }"#,
        )
        .unwrap();
        assert!(read_manifest(dir.path()).is_err());
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

    // nodePath は絶対パスだけを受ける（設定の画面も保存のときに断る）。
    // 名前や相対のパスは、殻の作業ディレクトリしだいで指す先が変わるので、そこにファイルがあっても起こさない。
    #[test]
    fn probe_node_is_missing_for_a_relative_path_even_if_it_exists_here() {
        let cwd = std::env::current_dir().unwrap();
        let name = "Cargo.toml";
        assert!(cwd.join(name).is_file());
        assert_eq!(probe_node(Path::new(name)), ProbeOutcome::Missing);
    }

    #[cfg(unix)]
    #[test]
    fn probe_node_runs_the_child_and_reads_its_answer() {
        let dir = tempfile::tempdir().unwrap();
        let ok = fake_node(dir.path(), "echo v22.14.0 arm64 10");
        assert_eq!(
            probe_node(&ok),
            ProbeOutcome::Ok(probe("22.14.0", "arm64", 10))
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
        std::fs::write(&p, "#!/bin/sh\necho v22.14.0 arm64 10\n").unwrap();
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
