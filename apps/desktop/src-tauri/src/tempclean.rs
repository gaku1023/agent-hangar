//! 自動更新が `%TEMP%` に残すインストーラの置き場を、次の起動で片付ける（Windows）。
//! Tauri の updater は、落としたインストーラを `<アプリ名>-<版>-updater-<英数字 6 字>` の置き場に書き、
//! インストーラを起こしてすぐ終わるので、置き場は消されないまま更新のたびに 1 つずつ増える。
//! 消すのは名前の形が完全に合い、版が今の版より新しくなく、中身がふつうのファイルだけの置き場に限る。
//! 今の版の置き場は、今の版を入れたインストーラのものである（更新の目録は今より新しい版しか出さない）。

use semver::Version;
use std::path::{Path, PathBuf};

/// updater が置き場の名前の後ろに付ける乱数の長さ（tempfile の既定、英数字）。
const RAND_LEN: usize = 6;

/// 置き場の名前の形 `<app_name>-<版>-updater-<英数字 6 字>` に完全に合えば、その版を返す。
pub fn updater_dir_version(name: &str, app_name: &str) -> Option<Version> {
    let rest = name.strip_prefix(app_name)?.strip_prefix('-')?;
    let (version, rand) = rest.rsplit_once("-updater-")?;
    if rand.len() != RAND_LEN || !rand.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    let parsed = Version::parse(version).ok()?;
    // 書き方の揺れ（前に付いた v など）を受け入れないよう、読んだ版を書き戻して同じになるものだけにする。
    (parsed.to_string() == version).then_some(parsed)
}

/// 中身がふつうのファイルだけか。置き場の中に入れ子の置き場やリンクがあれば、updater のものとみなさない。
fn holds_only_files(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries
        .map(|e| e.and_then(|e| e.file_type()))
        .all(|t| t.is_ok_and(|t| t.is_file()))
}

/// `temp` の直下で、消してよい置き場（今の版より新しくないもの）を並べる。
pub fn stale_updater_dirs(temp: &Path, app_name: &str, current: &Version) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(temp) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| {
            e.file_name()
                .to_str()
                .and_then(|n| updater_dir_version(n, app_name))
                .is_some_and(|v| &v <= current)
        })
        .map(|e| e.path())
        .filter(|p| holds_only_files(p))
        .collect()
}

/// 消してよい置き場を消し、消せたものを返す。
/// ファイルを 1 つずつ消してから空の置き場を消すので、リンクの先をたどって消すことは無い。
/// まだ動いているインストーラのように消せないものがあれば、その置き場は残し、次の起動に任せる。
pub fn sweep(temp: &Path, app_name: &str, current: &Version) -> Vec<PathBuf> {
    stale_updater_dirs(temp, app_name, current)
        .into_iter()
        .filter(|dir| {
            let files_gone = std::fs::read_dir(dir).is_ok_and(|entries| {
                entries
                    .filter_map(Result::ok)
                    .all(|e| std::fs::remove_file(e.path()).is_ok())
            });
            files_gone && std::fs::remove_dir(dir).is_ok()
        })
        .collect()
}

/// 殻の起動で呼ぶ。Windows でだけ、`%TEMP%` の片付けを別の糸で行い、消したものを 1 行ずつ記録する。
pub fn sweep_in_background(info: &tauri::PackageInfo, log: fn(&str)) {
    if !cfg!(windows) {
        return;
    }
    let (name, version) = (info.name.clone(), info.version.clone());
    std::thread::spawn(move || {
        for dir in sweep(&std::env::temp_dir(), &name, &version) {
            if let Some(n) = dir.file_name() {
                log(&format!(
                    "removed the updater leftovers {}",
                    n.to_string_lossy()
                ));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn reads_the_version_only_from_the_exact_shape() {
        assert_eq!(
            updater_dir_version("Hangar-0.2.0-rc.3-updater-Ab12Cd", "Hangar"),
            Some(v("0.2.0-rc.3"))
        );
        assert_eq!(
            updater_dir_version("Hangar-1.4.0-updater-zzzzzz", "Hangar"),
            Some(v("1.4.0"))
        );
        for name in [
            // 名前が違う、乱数の長さが違う、乱数に英数字でない字がある。
            "Other-0.2.0-updater-Ab12Cd",
            "hangar-0.2.0-updater-Ab12Cd",
            "Hangar-0.2.0-updater-Ab12C",
            "Hangar-0.2.0-updater-Ab12Cde",
            "Hangar-0.2.0-updater-Ab_2Cd",
            "Hangar-0.2.0-updater-",
            // 版でないもの、版の書き方が崩れたもの。
            "Hangar-latest-updater-Ab12Cd",
            "Hangar-0.2-updater-Ab12Cd",
            "Hangar-v0.2.0-updater-Ab12Cd",
            "Hangar--updater-Ab12Cd",
            // 後ろに何か付いたもの、前に何か付いたもの。
            "Hangar-0.2.0-updater-Ab12Cd.old",
            "xHangar-0.2.0-updater-Ab12Cd",
            "Hangar-0.2.0-installer.exe",
        ] {
            assert_eq!(updater_dir_version(name, "Hangar"), None, "{name}");
        }
    }

    /// updater と同じ形の置き場を作り、中にインストーラを置く。
    fn updater_dir(temp: &Path, name: &str) -> PathBuf {
        let dir = temp.join(name);
        fs::create_dir(&dir).unwrap();
        fs::write(dir.join("Hangar-x-installer.exe"), b"MZ").unwrap();
        dir
    }

    #[test]
    fn removes_only_matching_folders_not_newer_than_the_running_version() {
        let temp = tempfile::tempdir().unwrap();
        let t = temp.path();
        let older = updater_dir(t, "Hangar-0.2.0-rc.2-updater-AAAAAA");
        let same = updater_dir(t, "Hangar-0.2.0-rc.4-updater-BBBBBB");
        let newer = updater_dir(t, "Hangar-0.2.0-updater-CCCCCC");
        let other_app = updater_dir(t, "Other-0.1.0-updater-DDDDDD");
        let unlike = updater_dir(t, "Hangar-0.1.0-updater-EEEEEE-keep");
        // 名前が合っても、ファイルなら触らない。
        fs::write(t.join("Hangar-0.1.0-updater-FFFFFF"), b"x").unwrap();

        let mut removed = sweep(t, "Hangar", &v("0.2.0-rc.4"));
        removed.sort();
        let mut expected = vec![older.clone(), same.clone()];
        expected.sort();
        assert_eq!(removed, expected);
        assert!(!older.exists());
        assert!(!same.exists());
        assert!(newer.join("Hangar-x-installer.exe").exists());
        assert!(other_app.exists());
        assert!(unlike.exists());
        assert!(t.join("Hangar-0.1.0-updater-FFFFFF").is_file());
    }

    #[test]
    fn leaves_folders_that_hold_anything_but_plain_files() {
        let temp = tempfile::tempdir().unwrap();
        let t = temp.path();
        let nested = updater_dir(t, "Hangar-0.1.0-updater-GGGGGG");
        fs::create_dir(nested.join("inner")).unwrap();
        fs::write(nested.join("inner").join("keep.txt"), b"x").unwrap();
        assert!(stale_updater_dirs(t, "Hangar", &v("0.2.0")).is_empty());
        assert!(sweep(t, "Hangar", &v("0.2.0")).is_empty());
        assert!(nested.join("inner").join("keep.txt").exists());
        assert!(nested.join("Hangar-x-installer.exe").exists());
    }

    #[test]
    fn a_missing_temp_folder_is_not_an_error() {
        let temp = tempfile::tempdir().unwrap();
        let gone = temp.path().join("gone");
        assert!(sweep(&gone, "Hangar", &v("0.2.0")).is_empty());
    }
}
