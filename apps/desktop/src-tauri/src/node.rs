//! Node の探索。PATH に頼らず、決まった候補を順に調べ、同梱したネイティブモジュールと ABI が合う版だけを採る。
use std::path::{Path, PathBuf};
use std::process::Command;

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

/// 調べた候補と結果。`None` は起動できなかった（無い、実行不可）ことを表す。
#[derive(Debug, Clone, PartialEq)]
pub struct Tried {
    pub path: PathBuf,
    pub probe: Option<NodeProbe>,
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
pub fn nvm_node_paths(user_home: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(user_home.join(".nvm/versions/node")) else {
        return Vec::new();
    };
    let mut found: Vec<((u32, u32, u32), PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            parse_version(&e.file_name().to_string_lossy()).map(|v| (v, e.path().join("bin/node")))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
}

/// 探索の順序。Settings の明示、Homebrew、/usr/local、nvm（新しい版が先）。
pub fn candidate_paths(user_home: &Path, hangar_home: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(p) = settings_node_path(hangar_home) {
        out.push(p);
    }
    out.push(PathBuf::from("/opt/homebrew/bin/node"));
    out.push(PathBuf::from("/usr/local/bin/node"));
    out.extend(nvm_node_paths(user_home));
    out
}

/// `node -e "console.log(process.version, process.arch)"` の出力（例 `v22.14.0 arm64`）を読む。
pub fn parse_probe(output: &str) -> Option<NodeProbe> {
    let mut it = output.split_whitespace();
    let version = it.next()?;
    let arch = it.next()?;
    let (major, _, _) = parse_version(version)?;
    Some(NodeProbe {
        major,
        arch: arch.to_string(),
    })
}

pub fn probe_node(path: &Path) -> Option<NodeProbe> {
    if !path.is_file() {
        return None;
    }
    let out = Command::new(path)
        .args(["-e", "console.log(process.version, process.arch)"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_probe(&String::from_utf8_lossy(&out.stdout))
}

/// 候補を順に調べ、manifest と同じメジャー版かつ同じアーキテクチャの最初の Node を返す。
pub fn choose_node(
    candidates: &[PathBuf],
    manifest: &Manifest,
    probe: impl Fn(&Path) -> Option<NodeProbe>,
) -> Result<PathBuf, NodeError> {
    let mut tried = Vec::new();
    for c in candidates {
        let p = probe(c);
        if let Some(pr) = &p {
            if pr.major == manifest.node_major && pr.arch == manifest.arch {
                return Ok(c.clone());
            }
        }
        tried.push(Tried {
            path: c.clone(),
            probe: p,
        });
    }
    Err(NodeError::NotFound {
        manifest: manifest.clone(),
        tried,
    })
}

/// 利用者に見せる文言。読み込み画面にそのまま出す。
pub fn describe_error(e: &NodeError) -> String {
    let NodeError::NotFound { manifest, tried } = e;
    let mut lines = vec![
        format!("Node {}（{}）が見つかりません。", manifest.node_major, manifest.arch),
        format!(
            "nvm install {} を実行するか、~/.agent-hangar/settings.json の nodePath で場所を指定してください。",
            manifest.node_major
        ),
        "調べた場所:".to_string(),
    ];
    for t in tried {
        let what = match &t.probe {
            Some(p) => format!("v{} {}", p.major, p.arch),
            None => "無し".to_string(),
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

    #[test]
    fn nvm_versions_are_sorted_newest_first() {
        let home = tempfile::tempdir().unwrap();
        for v in ["v20.1.0", "v22.14.0", "v22.9.0", "junk"] {
            std::fs::create_dir_all(home.path().join(".nvm/versions/node").join(v).join("bin"))
                .unwrap();
        }
        let base = home.path().join(".nvm/versions/node");
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
        std::fs::create_dir_all(user.path().join(".nvm/versions/node/v22.14.0/bin")).unwrap();
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

    #[test]
    fn choose_node_takes_first_compatible_and_reports_tried() {
        let probes: HashMap<PathBuf, NodeProbe> = HashMap::from([
            (
                PathBuf::from("/a/node"),
                NodeProbe {
                    major: 24,
                    arch: "arm64".into(),
                },
            ),
            (
                PathBuf::from("/c/node"),
                NodeProbe {
                    major: 22,
                    arch: "arm64".into(),
                },
            ),
            (
                PathBuf::from("/d/node"),
                NodeProbe {
                    major: 22,
                    arch: "arm64".into(),
                },
            ),
        ]);
        let probe = |p: &Path| probes.get(p).cloned();
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
                probe: None
            }
        );
        let text = describe_error(&err);
        assert!(
            text.starts_with("Node 22（x64）が見つかりません。"),
            "{text}"
        );
        assert!(text.contains("/a/node: v24 arm64"), "{text}");
        assert!(text.contains("/b/node: 無し"), "{text}");
        assert!(text.contains("nvm install 22"), "{text}");
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
    fn probe_node_is_none_for_missing_binary() {
        assert_eq!(probe_node(Path::new("/nonexistent/node")), None);
    }
}
