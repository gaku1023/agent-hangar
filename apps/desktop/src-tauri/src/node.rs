//! Node の探索。PATH に頼らず、決まった候補を順に調べ、同梱したネイティブモジュールと ABI が合う版だけを採る。
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

pub fn read_manifest(server_dir: &Path) -> Result<Manifest, String> {
    let file = server_dir.join("manifest.json");
    let text = std::fs::read_to_string(&file)
        .map_err(|e| format!("{} を読めません: {e}", file.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{} が壊れています: {e}", file.display()))
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

/// nvm が入れた Node を新しい版から順に並べる。
/// `bin/node` が実在するものだけを返す。
/// 実在しないパスを候補に混ぜると、`describe_error` の「調べた場所」が読みにくくなる。
pub fn nvm_node_paths(user_home: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(user_home.join(".nvm/versions/node")) else {
        return Vec::new();
    };
    let mut found: Vec<((u32, u32, u32), PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            parse_version(&e.file_name().to_string_lossy()).map(|v| (v, e.path().join("bin/node")))
        })
        .filter(|(_, p)| p.is_file())
        .collect();
    found.sort_by_key(|a| std::cmp::Reverse(a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// 探索の順序。Settings の明示、Homebrew、/usr/local、nvm（新しい版が先）。
/// 同じ場所は一度しか調べない。
/// Settings の指定が探索先と重なることがあるためである。
pub fn candidate_paths(user_home: &Path, hangar_home: &Path) -> Vec<PathBuf> {
    let mut all = Vec::new();
    if let Some(p) = settings_node_path(hangar_home) {
        all.push(p);
    }
    all.push(PathBuf::from("/opt/homebrew/bin/node"));
    all.push(PathBuf::from("/usr/local/bin/node"));
    all.extend(nvm_node_paths(user_home));
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

/// 利用者に見せる文言。読み込み画面にそのまま出す。
pub fn describe_error(e: &NodeError) -> String {
    describe_error_in(e, &crate::paths::hangar_home())
}

/// 同上。設定の置き場所を引数で受け取る形。
/// `HANGAR_HOME` を使っている利用者に、存在しない場所を直せと案内しないためである。
pub fn describe_error_in(e: &NodeError, hangar_home: &Path) -> String {
    let NodeError::NotFound { manifest, tried } = e;
    let mut lines = vec![
        format!(
            "Node {}（{}）が見つかりません。",
            manifest.node_major, manifest.arch
        ),
        format!(
            "nvm install {} を実行するか、{} の nodePath で場所を指定してください。",
            manifest.node_major,
            hangar_home.join("settings.json").display()
        ),
        "調べた場所:".to_string(),
    ];
    for t in tried {
        let what = match &t.outcome {
            ProbeOutcome::Ok(p) => format!(
                "v{} {}（要る版は {} {}）",
                p.major, p.arch, manifest.node_major, manifest.arch
            ),
            ProbeOutcome::Missing => "ありません".to_string(),
            ProbeOutcome::NotExecutable => "起動できません（実行権を確かめてください）".to_string(),
            ProbeOutcome::Failed => "Node ではありません（別の実行ファイルのようです）".to_string(),
            ProbeOutcome::TimedOut => format!(
                "{} 秒のあいだ応答しません（打ち切りました）",
                PROBE_TIMEOUT.as_secs()
            ),
        };
        lines.push(format!("  {}: {}", t.path.display(), what));
    }
    lines.join("\n")
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

    #[test]
    fn candidates_put_settings_first_then_fixed_then_nvm() {
        let user = tempfile::tempdir().unwrap();
        let hangar = tempfile::tempdir().unwrap();
        touch(&user.path().join(".nvm/versions/node/v22.14.0/bin/node"));
        std::fs::write(
            hangar.path().join("settings.json"),
            r#"{ "workspaceRoot": "/w", "nodePath": "/custom/node" }"#,
        )
        .unwrap();
        let got = candidate_paths(user.path(), hangar.path());
        assert_eq!(
            got,
            vec![
                PathBuf::from("/custom/node"),
                PathBuf::from("/opt/homebrew/bin/node"),
                PathBuf::from("/usr/local/bin/node"),
                user.path().join(".nvm/versions/node/v22.14.0/bin/node"),
            ]
        );
    }

    #[test]
    fn candidates_drop_duplicates() {
        let user = tempfile::tempdir().unwrap();
        let hangar = tempfile::tempdir().unwrap();
        let nvm = user.path().join(".nvm/versions/node/v22.14.0/bin/node");
        touch(&nvm);
        // 探索先と同じ場所を Settings で指定しても、候補は 1 つにまとまる。
        std::fs::write(
            hangar.path().join("settings.json"),
            r#"{ "nodePath": "/usr/local/bin/node" }"#,
        )
        .unwrap();
        assert_eq!(
            candidate_paths(user.path(), hangar.path()),
            vec![
                PathBuf::from("/usr/local/bin/node"),
                PathBuf::from("/opt/homebrew/bin/node"),
                nvm.clone(),
            ]
        );
        std::fs::write(
            hangar.path().join("settings.json"),
            format!(
                "{{ \"nodePath\": {} }}",
                serde_json::to_string(&nvm).unwrap()
            ),
        )
        .unwrap();
        assert_eq!(
            candidate_paths(user.path(), hangar.path()),
            vec![
                nvm,
                PathBuf::from("/opt/homebrew/bin/node"),
                PathBuf::from("/usr/local/bin/node"),
            ]
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

    #[test]
    fn describe_error_names_the_real_settings_file_and_each_reason() {
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
        let err = NodeError::NotFound {
            manifest: Manifest {
                arch: "x64".into(),
                ..manifest()
            },
            tried,
        };
        let text = describe_error_in(&err, Path::new("/elsewhere/hangar"));
        assert!(
            text.starts_with("Node 22（x64）が見つかりません。"),
            "{text}"
        );
        assert!(text.contains("nvm install 22"), "{text}");
        // HANGAR_HOME を使っていれば、その場所を案内する。
        assert!(text.contains("/elsewhere/hangar/settings.json"), "{text}");
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

    #[test]
    fn read_manifest_parses_and_reports_errors() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_manifest(dir.path())
            .unwrap_err()
            .contains("読めません"));
        std::fs::write(
            dir.path().join("manifest.json"),
            r#"{ "version": "0.1.0", "nodeMajor": 22, "arch": "arm64", "builtAt": "x" }"#,
        )
        .unwrap();
        assert_eq!(read_manifest(dir.path()).unwrap(), manifest());
        std::fs::write(dir.path().join("manifest.json"), "{").unwrap();
        assert!(read_manifest(dir.path())
            .unwrap_err()
            .contains("壊れています"));
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
