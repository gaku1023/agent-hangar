//! 試験のための書き出しの口。
//! 起動画面が実際に描いた様子（札が出たか、印、種類、見出し、詳細）を、殻がファイルへ書く。
//! CI の「Node の無い機械で、読み込み画面が失敗の札に切り替わる」段が、それを読んで確かめる。
//! 殻が `HANGAR_BOOT_PROBE`（書き出す先のファイル）を持って起きたときだけ働き、ふだんの起動では何もしない。
//! 頁も、殻が `boot_state` で `probe` を真で返したときだけ書き出しを頼む（loading/boot.js の report）。
use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// 書き出す先のファイルを渡す環境変数。
pub const ENV: &str = "HANGAR_BOOT_PROBE";

/// 書き出す様子の大きさの上限（バイト）。頁が渡すのは短い文の 6 つだけなので、これを越えたら書かない。
pub const LIMIT: usize = 16 * 1024;

/// 環境変数の値から、書き出す先を決める。無いか空なら書き出さない。
pub fn target_from(v: Option<OsString>) -> Option<PathBuf> {
    v.filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// `boot_state` の答えに、書き出しを頼むかどうか（`probe`）を添える。
pub fn mark(mut state: Value, on: bool) -> Value {
    if let Some(o) = state.as_object_mut() {
        o.insert("probe".into(), Value::Bool(on));
    }
    state
}

/// 頁が描いた様子を書き出す。中身は JSON のオブジェクトだけを受け取り、上限を越えたら書かない。
/// 読む側が書きかけを読まないよう、隣の一時のファイルに書いてから名前を替える。
pub fn write(path: &Path, drawn: &Value) -> Result<(), String> {
    if !drawn.is_object() {
        return Err("the drawn state is not an object".into());
    }
    let text = serde_json::to_string(drawn).map_err(|e| e.to_string())?;
    if text.len() > LIMIT {
        return Err(format!("the drawn state is over {LIMIT} bytes"));
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_target_is_taken_only_from_a_non_empty_value() {
        assert_eq!(target_from(None), None);
        assert_eq!(target_from(Some(OsString::new())), None);
        assert_eq!(
            target_from(Some(OsString::from("/tmp/probe.json"))),
            Some(PathBuf::from("/tmp/probe.json"))
        );
    }

    #[test]
    fn the_boot_state_says_whether_to_report() {
        let s = json!({ "failure": null, "progress": null, "finishing": false });
        assert_eq!(mark(s.clone(), false)["probe"], json!(false));
        let on = mark(s, true);
        assert_eq!(on["probe"], json!(true));
        assert_eq!(on["finishing"], json!(false));
    }

    #[test]
    fn what_the_page_drew_is_written_as_json_and_replaced_by_the_next_report() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("probe.json");
        write(&file, &json!({ "level": null, "card": false })).unwrap();
        let drawn = json!({ "level": "error", "card": true, "kind": "other", "title": "t", "detail": "Node 22" });
        write(&file, &drawn).unwrap();
        let got: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(got, drawn);
        // 一時のファイルを残さない。
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![OsString::from("probe.json")]);
    }

    #[test]
    fn anything_but_a_small_object_is_not_written() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("probe.json");
        assert!(write(&file, &json!("text")).is_err());
        assert!(write(&file, &json!([1, 2])).is_err());
        assert!(write(&file, &json!({ "detail": "x".repeat(LIMIT) })).is_err());
        assert!(!file.exists());
    }
}
