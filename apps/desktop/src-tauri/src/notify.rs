//! 入力待ち、戻る時刻、使用制限の OS の通知（macOS は UNUserNotificationCenter、Windows はトースト）。
//! 入力待ち（許可待ちとリセット済みも含む）と使用制限は、サーバが決めて並べ、殻が読みに行って出す（`feed`）。
//! 戻る時刻と、ブラウザの頁の通知は、今までどおり頁が `notify_waiting` を呼ぶ。
//! 通知を押されたら、窓を前に出し、頁の `__hangarOpenWaiting` でそのセッションを開く。
//! 押された通知からセッションを読み戻す入口（`session_of` と `install` に渡す受け口）は、どちらの OS でも同じである。
//! 頁の値はここで確かめてから OS に渡す。
//! 頁は remote の頁なので、中身をそのまま信じない。

use std::collections::HashSet;
use std::time::Duration;

pub mod feed;
pub mod hold;

/// 通知の識別子の頭。
/// 押されたときに、どのセッションの、どの種類の通知かをここから読み戻す。
/// 入力待ちの頭は前の版と同じにしてある。前の版が出した通知を押しても、同じセッションが開く。
const WAITING_PREFIX: &str = "hangar-waiting:";
const RETURN_PREFIX: &str = "hangar-return:";
const LIMIT_PREFIX: &str = "hangar-limit:";
const JOIN_PREFIX: &str = "hangar-join:";
const UNREAD_PREFIX: &str = "hangar-unread:";
/// 参加リクエストの知らせがセッションの id の代わりに載せる値（サーバの `JOIN_NOTICE_ID`）。
/// セッションの id（UUID）とは重ならない。
/// 押されたら、セッションではなく設定のクラウド同期を開く（`open_js`）。
pub const JOIN_SESSION: &str = "join-request";
/// 参加リクエストの知らせを押したときに移る頁の場所（設定のクラウド同期の節。shared の route.ts の `settings` と `at=cloud`）。
const JOIN_HASH: &str = "#/settings?at=cloud";
/// 題と本文の長さの上限（文字数）。
/// 通知は 2 行ほどしか見せないので、長い問いは切る。
const TITLE_MAX: usize = 120;
const BODY_MAX: usize = 240;
/// セッションの id の長さの上限。
/// hangar の id は UUID（36 文字）である。
const ID_MAX: usize = 64;

/// 知らせの種類。
/// 入力待ち（許可待ちとリセット済みも含む）と、Paused の戻る時刻を過ぎた知らせと、使用制限の知らせである。
/// 使用制限はアカウントごとに 1 通で、先に止まったセッションの id を枠の名前にする（押すとそのセッションを開く）。
/// 種類ごとに通知の枠（macOS の識別子、Windows のタグと組）を分ける。
/// 同じ枠に入れると、後から来た戻る時刻の知らせが、同じセッションの入力待ちの知らせを置き換えて問いの文を消すからである。
/// 参加リクエストの知らせ（Join）は、参加コードを発行した PC に、別の PC から参加リクエストを受信したことを知らせる。
/// id はいつも `JOIN_SESSION` で、押すと設定を開く。
/// 未読の知らせ（Unread、エージェントの notify_user）は、入力待ちとは別の枠に入り、押すとそのセッションを開く。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    Waiting,
    Return,
    Limit,
    Join,
    Unread,
}

impl Kind {
    /// 頁が渡す種類の名前を読む。
    /// 名前の無いもの（種類を渡さない前の版の頁）は入力待ちとみなす。
    pub fn parse(name: Option<&str>) -> Result<Kind, String> {
        match name {
            None | Some("waiting") => Ok(Kind::Waiting),
            Some("return") => Ok(Kind::Return),
            Some("limit") => Ok(Kind::Limit),
            Some("join") => Ok(Kind::Join),
            Some("unread") => Ok(Kind::Unread),
            Some(_) => Err("invalid notification kind".to_string()),
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Kind::Waiting => WAITING_PREFIX,
            Kind::Return => RETURN_PREFIX,
            Kind::Limit => LIMIT_PREFIX,
            Kind::Join => JOIN_PREFIX,
            Kind::Unread => UNREAD_PREFIX,
        }
    }

    const ALL: [Kind; 5] = [
        Kind::Waiting,
        Kind::Return,
        Kind::Limit,
        Kind::Join,
        Kind::Unread,
    ];
}

/// 確かめ終えた通知の中身。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Waiting {
    pub kind: Kind,
    pub session_id: String,
    pub title: String,
    pub body: String,
}

/// 通知センターに残してよい知らせ。
/// 頁が、いま入力待ちのセッションと、今日の戻る時刻を過ぎてまだ Paused のセッションと、使用制限でリセットを待っているセッションを渡す。
/// ここに無いセッションの知らせは、通知センターから外す（`prune`）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Keep {
    waiting: HashSet<String>,
    returning: HashSet<String>,
    limited: HashSet<String>,
}

/// id の並びから、id の形のものだけを集める。頁の値なので、形でないものは捨てる（そういう id の通知は出していない）。
fn plain_ids(ids: &[String]) -> HashSet<String> {
    ids.iter().filter(|id| valid_id(id)).cloned().collect()
}

impl Keep {
    /// 頁から届いた id の並びから作る。
    /// 頁の値なので、id の形でないものは捨てる（そういう id の通知は出していない）。
    pub fn new(waiting: &[String], returning: &[String]) -> Keep {
        Keep {
            waiting: plain_ids(waiting),
            returning: plain_ids(returning),
            limited: HashSet::new(),
        }
    }

    /// 使用制限でリセットを待っているセッション（その知らせを残す）を足す。
    /// 渡さない前の版の頁では空のままで、使用制限の知らせは次の顔ぶれで外れる。
    pub fn with_limited(mut self, limited: &[String]) -> Keep {
        self.limited = plain_ids(limited);
        self
    }

    /// その種類の、そのセッションの知らせを残すか。
    /// 参加リクエストの知らせは頁の一覧に載らないので、いつも残す（利用者が通知センターから消す）。
    pub fn holds(&self, kind: Kind, session_id: &str) -> bool {
        match kind {
            Kind::Waiting => self.waiting.contains(session_id),
            Kind::Return => self.returning.contains(session_id),
            Kind::Limit => self.limited.contains(session_id),
            Kind::Join | Kind::Unread => true,
        }
    }

    /// 出したばかりの知らせを、次の一覧が届くまで残すものに足す。
    pub fn insert(&mut self, kind: Kind, session_id: &str) {
        let set = match kind {
            Kind::Waiting => &mut self.waiting,
            Kind::Return => &mut self.returning,
            Kind::Limit => &mut self.limited,
            Kind::Join | Kind::Unread => return,
        };
        set.insert(session_id.to_string());
    }

    /// 出してあるトーストの識別子を、残すものに足す。
    /// 外すのは別の糸で、頁が一覧を渡した後に出したトーストを、前の一覧で外さないためである。
    /// hangar の識別子でないものは足さない。
    pub fn extend_shown<'a>(&mut self, shown: impl IntoIterator<Item = &'a str>) {
        for id in shown {
            if let Some((kind, session_id)) = parse_identifier(id) {
                self.insert(kind, session_id);
            }
        }
    }
}

/// macOS の通知センターに届いている通知の識別子から、外すものを選ぶ。
/// hangar の識別子で、残すものに無いものだけを返す。
/// hangar の識別子でないものには触らない。
pub fn stale_identifiers(delivered: &[String], keep: &Keep) -> Vec<String> {
    delivered
        .iter()
        .filter(|id| parse_identifier(id).is_some_and(|(kind, s)| !keep.holds(kind, s)))
        .cloned()
        .collect()
}

/// セッションの id として受け取れるか。
/// 英数字とハイフンと下線だけにする。
/// 識別子にも JavaScript にも、そのまま載せられる形である。
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= ID_MAX
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 前後の空白を落とし、長ければ切って末尾に省略記号を付ける。
/// 空になったら fallback を使う。
fn tidy(text: &str, max: usize, fallback: &str) -> String {
    let t = text.trim();
    if t.is_empty() {
        return fallback.to_string();
    }
    if t.chars().count() <= max {
        return t.to_string();
    }
    let mut cut: String = t.chars().take(max - 1).collect();
    cut.push('…');
    cut
}

/// 題と本文が空のときの代わりの文。UI の辞書の言い方に合わせる（common.label.noName と home.card.noQuestion）。
/// 並びは（題、本文）。
fn fallbacks(lang: &str) -> (&'static str, &'static str) {
    if lang == "en" {
        ("(No name)", "Waiting for input")
    } else {
        ("（名前なし）", "入力待ちです")
    }
}

/// 頁から届いた値を、通知に出せる形に整える。
/// id が変なら断る。
/// 題が空なら名前の無いセッションとして、本文が空なら問いの取れなかった入力待ちとして出す。
/// 代わりの文の言語は殻の頁と同じ（`bootfail::page_language` の ja か en）。en のほかは日本語にする。
/// 戻る時刻の知らせは、頁がいつも本文（時刻とメモ）を入れて渡す。
pub fn waiting(
    kind: Kind,
    session_id: &str,
    title: &str,
    body: &str,
    lang: &str,
) -> Result<Waiting, String> {
    if !valid_id(session_id) {
        return Err("invalid session id".to_string());
    }
    let (no_title, no_body) = fallbacks(lang);
    Ok(Waiting {
        kind,
        session_id: session_id.to_string(),
        title: tidy(title, TITLE_MAX, no_title),
        body: tidy(body, BODY_MAX, no_body),
    })
}

/// 窓が利用者の目の前にあるか。
/// 見えていて、最小化しておらず、フォーカスがあるときだけ前にあるとみなし、入力待ちの通知を出さない（右下のカードで足りる）。
/// 頁の `document.visibilityState` と `hasFocus()` には頼らない。
/// WebView は最小化や背面で絞られ、その間の頁の答えは当てにならないためである。
pub fn window_in_front(visible: bool, minimized: bool, focused: bool) -> bool {
    visible && !minimized && focused
}

/// 通知を出さずに済ませるか。窓が前にあれば出さないが、項目が前でも出す印（`even_in_front`、決まりの whileFocused）を持てば出す。
pub fn skip_in_front(in_front: bool, even_in_front: bool) -> bool {
    in_front && !even_in_front
}

/// Windows で、前景の窓が hangar の窓（`ours`）か、その子孫か、hangar の窓が持ち主の窓（ダイアログなど）か。
/// tao の `is_focused` は、最上位の窓そのものがフォーカスを持つときだけ真になる。
/// hangar の窓では、フォーカスはふだん中の WebView2 の子窓（Chrome_WidgetWin_1）にあるので、窓が前にあっても偽になる。
/// そこで Windows では、OS の前景の窓（GetForegroundWindow）とその根（GetAncestor の GA_ROOTOWNER）で見て、`window_in_front` の focused に足す。
/// GA_ROOTOWNER は親と持ち主をたどるので、hangar の窓が持ち主のダイアログ（ファイルの選択など）が前にあるときも、利用者は hangar を見ているとみなせる。
/// macOS の `is_focused` は NSWindow の isKeyWindow で、中の WKWebView がフォーカスを持っていても真なので、この穴は無い。
#[cfg(windows)]
pub fn window_owns_foreground(ours: windows::Win32::Foundation::HWND) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    owns_foreground_window(unsafe { GetForegroundWindow() }, ours)
}

/// 前景の窓 `foreground` が、`ours` そのものか、親と持ち主をたどった根が `ours` か。
/// 前景が無い（ほかのアプリへ移る途中など）ときは偽。
#[cfg(windows)]
fn owns_foreground_window(
    foreground: windows::Win32::Foundation::HWND,
    ours: windows::Win32::Foundation::HWND,
) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GA_ROOTOWNER};
    if foreground.is_invalid() || ours.is_invalid() {
        return false;
    }
    foreground == ours || unsafe { GetAncestor(foreground, GA_ROOTOWNER) } == ours
}

/// 通知の識別子。
/// 同じセッションの同じ種類の通知は同じ識別子になり、新しい方が古い方と置き換わる。
/// 種類が違えば識別子も違うので、戻る時刻の知らせが入力待ちの知らせを消さない。
pub fn identifier(kind: Kind, session_id: &str) -> String {
    format!("{}{session_id}", kind.prefix())
}

/// 通知の識別子から、種類とセッションの id を読み戻す。
/// hangar の通知でなければ `None`。
pub fn parse_identifier(identifier: &str) -> Option<(Kind, &str)> {
    Kind::ALL.into_iter().find_map(|kind| {
        identifier
            .strip_prefix(kind.prefix())
            .filter(|id| valid_id(id))
            .map(|id| (kind, id))
    })
}

/// 押された通知の識別子から、セッションの id を読み戻す。
/// どちらの種類の通知でも、そのセッションを開く。
/// hangar の通知でなければ `None`。
pub fn session_of(identifier: &str) -> Option<&str> {
    parse_identifier(identifier).map(|(_, id)| id)
}

/// 押された通知のセッションを頁で開く JavaScript。
/// 頁が受け口を持っていれば、それでセッションを開いてターミナルにフォーカスする。
/// 受け口が無ければ（読み込みの途中など）、ハッシュでそのセッションへ移るだけにする。
/// 参加リクエストの知らせ（`JOIN_SESSION`）は、頁の `__hangarOpenJoin` で設定のクラウド同期を開き、受け口が無ければ `open_hash` の場所へ移る。
pub fn open_js(session_id: &str) -> String {
    if session_id == JOIN_SESSION {
        let lit = serde_json::to_string(JOIN_HASH).unwrap_or_else(|_| "\"\"".to_string());
        return format!(
            "(function(){{if(window.__hangarOpenJoin){{window.__hangarOpenJoin();}}\
             else{{location.hash={lit};}}}})();"
        );
    }
    let lit = serde_json::to_string(session_id).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(function(){{var id={lit};\
         if(window.__hangarOpenWaiting){{window.__hangarOpenWaiting(id);}}\
         else{{location.hash=\"#/session/\"+id;}}}})();"
    )
}

/// 頁がまだ出来上がっていないときに、押された通知の行き先として貯めるハッシュ。
/// セッションの知らせはそのセッション、参加リクエストの知らせは設定のクラウド同期の節である。
pub fn open_hash(session_id: &str) -> String {
    if session_id == JOIN_SESSION {
        JOIN_HASH.to_string()
    } else {
        format!("#/session/{session_id}")
    }
}

/// macOS に通知の許可を断られたときに、殻のログへ書く 1 行。
/// 署名の壊れた .app（署名せずに入れた手元の build）では、システム設定で許可していても、macOS はダイアログを出さずにエラーで断る。
/// 通知が黙って消えると気づけないので、理由を残す。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn refused_line(reason: Option<&str>) -> String {
    format!(
        "notifications refused by macOS: {}",
        reason.unwrap_or("no reason given")
    )
}

/// 通知の許可の状態（UNAuthorizationStatus の値）を、頁に返す名前にする。
/// `None` は OS に尋ねられないこと（.app の外で動いているとき）を表す。
/// 仮の許可（Provisional）と一時の許可（Ephemeral）は、通知を出せるので許可とみなす。
pub fn status_name(raw: Option<isize>) -> &'static str {
    match raw {
        None => "unsupported",
        Some(1) => "denied",
        Some(2..=4) => "granted",
        Some(_) => "undetermined",
    }
}

/// 断られた許可の求めのあと、許可の状態を読み直す間隔と回数（合わせて 5 秒）。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const RECHECK_EVERY: Duration = Duration::from_millis(500);
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const RECHECK_TRIES: u32 = 10;

/// 許可の求めが断られたと答えたあと、許可が後から書かれたかを読み直す。
/// macOS 27 では、札の「許可」を押しても求めの答えは断られた（エラー付き）になり、許可が書かれるのは約 2 秒後である（2026-10-30 に VM で確かめた）。
/// 読み直さないと、札を出させた最初の通知を捨て、頁の「許可する」から求めたときは断られたと知らせてしまう。
/// read は許可の状態（UNAuthorizationStatus の値）を読み、wait は間を置く。OS に尋ねられなければ（`None`）すぐやめる。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn granted_after_refusal(
    mut read: impl FnMut() -> Option<isize>,
    mut wait: impl FnMut(Duration),
) -> bool {
    for _ in 0..RECHECK_TRIES {
        wait(RECHECK_EVERY);
        match status_name(read()) {
            "granted" => return true,
            "unsupported" => return false,
            _ => {}
        }
    }
    false
}

/// Windows のトーストの中身と、押されたトーストを殻へ戻すための登録の値。
/// OS を呼ばない純関数だけを置き、どの OS の試験でも同じ答えになるようにする。
/// 使うのは Windows の `win` だけなので、ほかの OS では使われない警告を黙らせる。
mod toast {
    #![cfg_attr(not(windows), allow(dead_code))]

    use super::{identifier, Keep, Kind, Waiting};
    use std::time::{Duration, Instant};

    /// トーストを出す相手のアプリの名前（AppUserModelID）。
    /// Tauri の NSIS のインストーラは、スタートメニューの近道にこの値（tauri.conf.json の identifier）を付ける。
    pub const APP_ID: &str = "dev.agent-hangar.hangar";
    /// トーストの頭に出るアプリの名前（tauri.conf.json の productName）。
    pub const DISPLAY_NAME: &str = "Hangar";
    /// hangar のトーストをまとめる組の名前。種類ごとに分ける。
    /// 入力待ちの組は前の版と同じ名前で、前の版は戻る時刻の知らせもこの組に入れていた。
    const WAITING_GROUP: &str = "hangar-waiting";
    const RETURN_GROUP: &str = "hangar-return";
    const LIMIT_GROUP: &str = "hangar-limit";
    const JOIN_GROUP: &str = "hangar-join";
    const UNREAD_GROUP: &str = "hangar-unread";
    /// アプリが閉じている間に押されたトーストを受け取る COM の口の CLSID。
    /// 値は一度だけ作って固定した。
    /// 変えると、前の版が出したトーストを押しても、この版へ届かなくなる。
    pub const ACTIVATOR_CLSID: u128 = 0x1ce6ab2a_d79d_49f4_88b0_5a9e624a75e4;
    /// 1 回の押下を Windows が 2 つの道（COM の口と、トーストの Activated）で知らせても、1 回だけ開くための間合い。
    const OPEN_AGAIN_AFTER: Duration = Duration::from_secs(2);

    /// Windows の呼び出しの失敗を、ログの 1 行の形にする。
    /// 文は、コード（HRESULT）から OS が引いた文だけを使い、コードを 16 進で添える。
    /// windows の Error の表示は、糸に残った前の失敗の説明（IErrorInfo）を拾うことがある。
    /// そのため、コードと合わない文（0x8001010D に「クラスが登録されていません」）や、化けた文が出た。
    pub fn hresult_line(code: i32, message: &str) -> String {
        let code = format!("0x{:08X}", code as u32);
        let message = message.trim();
        if message.is_empty() {
            code
        } else {
            format!("{message} ({code})")
        }
    }

    /// XML の本文と属性に入れられるよう、特別な 5 文字を置き換える。
    fn xml_escape(text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        for c in text.chars() {
            match c {
                '&' => out.push_str("&amp;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                '"' => out.push_str("&quot;"),
                '\'' => out.push_str("&apos;"),
                _ => out.push(c),
            }
        }
        out
    }

    /// トーストの XML。
    /// 題と本文は整え終えた値を、XML の文字として入れる。
    /// launch には macOS の通知の識別子と同じ値を入れ、押されたら `session_of` でセッションへ読み戻す。
    /// 押したら前に出る種類（foreground）にする。
    /// アプリが閉じていれば、Windows が COM の口を通してアプリを起こしてから渡す。
    pub fn toast_xml(w: &Waiting) -> String {
        format!(
            "<toast launch=\"{}\" activationType=\"foreground\">\
             <visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual>\
             </toast>",
            xml_escape(&identifier(w.kind, &w.session_id)),
            xml_escape(&w.title),
            xml_escape(&w.body)
        )
    }

    /// トーストのタグ。
    /// Windows はタグと組の対が同じトーストを置き換える。
    /// 同じセッションの同じ種類のトーストは同じ対になり、新しい方が古い方と置き換わる（macOS の識別子と同じ扱い）。
    /// Windows のタグは 64 文字までで、セッションの id は `ID_MAX`（64 文字）までなので、id をそのまま使う。
    pub fn toast_tag(session_id: &str) -> String {
        session_id.to_string()
    }

    /// トーストの組。
    /// 種類ごとに組を分け、戻る時刻のトーストが同じセッションの入力待ちのトーストを置き換えないようにする。
    pub fn toast_group(kind: Kind) -> &'static str {
        match kind {
            Kind::Waiting => WAITING_GROUP,
            Kind::Return => RETURN_GROUP,
            Kind::Limit => LIMIT_GROUP,
            Kind::Join => JOIN_GROUP,
            Kind::Unread => UNREAD_GROUP,
        }
    }

    fn kind_of_group(group: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|k| toast_group(*k) == group)
    }

    /// 通知センターの履歴（タグと組の対）から、外すトーストを選ぶ。
    /// 履歴は hangar の AppUserModelID のものだけなので、知らない組のトーストも hangar の古い版が出したものとして外す。
    pub fn stale_toasts(history: &[(String, String)], keep: &Keep) -> Vec<(String, String)> {
        history
            .iter()
            .filter(|(tag, group)| !matches!(kind_of_group(group), Some(k) if keep.holds(k, tag)))
            .cloned()
            .collect()
    }

    /// アプリの名前と、押されたトーストを受け取る COM の口を Windows に知らせる登録の場所（HKEY_CURRENT_USER の下）。
    pub fn app_id_key() -> String {
        format!(r"Software\Classes\AppUserModelId\{APP_ID}")
    }

    /// COM の口の CLSID を、登録に書く `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}` の形にする。
    pub fn activator_clsid() -> String {
        let v = ACTIVATOR_CLSID;
        format!(
            "{{{:08X}-{:04X}-{:04X}-{:04X}-{:012X}}}",
            (v >> 96) as u32,
            (v >> 80) as u16,
            (v >> 64) as u16,
            (v >> 48) as u16,
            v & 0xFFFF_FFFF_FFFF
        )
    }

    /// アプリが閉じているときに、COM が起こす実行ファイルを書く場所（HKEY_CURRENT_USER の下）。
    pub fn server_key() -> String {
        format!(
            r"Software\Classes\CLSID\{}\LocalServer32",
            activator_clsid()
        )
    }

    /// COM が起こす実行ファイルの行。
    /// 印の引数は起きた理由をログで見分けるためだけにあり、殻は読まない。
    pub fn server_command(exe: &str) -> String {
        format!("\"{exe}\" -ToastActivated")
    }

    /// 入れたアプリとして動いているか。
    /// 組み上げたままの実行ファイル（target の下の debug や release）は、入れた版の登録を書き換えないよう、トーストを出さない。
    /// macOS で .app の外では通知を出さないのと同じ扱いである。
    pub fn installed_exe(exe: &str) -> bool {
        let parts: Vec<&str> = exe.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
        let n = parts.len();
        if n < 3 {
            return true;
        }
        let dir = parts[n - 2];
        let built = dir.eq_ignore_ascii_case("debug") || dir.eq_ignore_ascii_case("release");
        !(built
            && parts[..n - 2]
                .iter()
                .any(|p| p.eq_ignore_ascii_case("target")))
    }

    /// Windows の通知の設定（NotificationSetting）を、macOS の許可の状態の値に読み替える。
    /// こうすると `status_name` が両方の OS で同じ名前を返す。
    /// Enabled（0）は許可、切られている 4 通り（アプリ、利用者、グループポリシー、マニフェスト）は拒否、ほかは未決とみなす。
    pub fn setting_status(setting: i32) -> isize {
        match setting {
            0 => 2,
            1..=4 => 1,
            _ => 0,
        }
    }

    /// 押されたトーストのセッションを、いま開くか。
    /// 同じセッションを `OPEN_AGAIN_AFTER` の間に 2 度知らされたら、2 度目は開かない。
    pub fn first_open(last: &mut Option<(String, Instant)>, id: &str, now: Instant) -> bool {
        if let Some((prev, at)) = last {
            if prev == id && now.saturating_duration_since(*at) < OPEN_AGAIN_AFTER {
                return false;
            }
        }
        *last = Some((id.to_string(), now));
        true
    }
}

#[cfg(target_os = "macos")]
pub use mac::{install, prune, request, show, status};

#[cfg(windows)]
pub use win::{install, prune, request, show, status};

/// macOS と Windows の外では通知を出さない。
/// 殻はこの 2 つの OS 向けにしか作らないが、型を揃えておく。
#[cfg(not(any(target_os = "macos", windows)))]
pub fn install(_on_open: impl Fn(String) + Send + Sync + 'static) {}
#[cfg(not(any(target_os = "macos", windows)))]
pub fn request(done: impl FnOnce(bool) + Send + 'static) {
    done(false);
}
#[cfg(not(any(target_os = "macos", windows)))]
pub fn status(done: impl FnOnce(Option<isize>) + Send + 'static) {
    done(None);
}
#[cfg(not(any(target_os = "macos", windows)))]
pub fn show(_w: &Waiting) {}
#[cfg(not(any(target_os = "macos", windows)))]
pub fn prune(_keep: Keep) {}

/// Windows のトーストを WinRT（Windows.UI.Notifications）で出し、押されたものを受け取る。
/// tauri-plugin-notification は Windows でも押されたトーストを返さない（出した後の受け口を捨てる）ので、ここで直に呼ぶ。
///
/// 押されたトーストは 2 つの道で届く。
/// アプリが動いている間は、出したトーストの Activated で届く。
/// アプリが閉じた後に通知センターで押されたときは、Windows が登録の COM の口（`LocalServer32`）でアプリを起こし、
/// 起きたアプリが `install` で口を開くと `INotificationActivationCallback::Activate` で届く。
/// どちらも launch の値から `session_of` でセッションを読み戻し、macOS と同じ受け口（`install` に渡したもの）へ渡す。
#[cfg(windows)]
mod win {
    use super::toast::{
        activator_clsid, app_id_key, first_open, hresult_line, installed_exe, server_command,
        server_key, setting_status, stale_toasts, toast_group, toast_tag, toast_xml,
        ACTIVATOR_CLSID, APP_ID, DISPLAY_NAME,
    };
    use super::{identifier, parse_identifier, session_of, Keep, Waiting};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::{LazyLock, Mutex, OnceLock};
    use std::time::Instant;
    use windows::core::{
        implement, Error, IInspectable, IUnknown, Interface, Ref, Result, BOOL, GUID, HSTRING,
        PCWSTR,
    };
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::Win32::Foundation::{CLASS_E_NOAGGREGATION, ERROR_SUCCESS};
    use windows::Win32::System::Com::{
        CoInitializeEx, CoRegisterClassObject, IClassFactory, IClassFactory_Impl,
        CLSCTX_LOCAL_SERVER, COINIT_MULTITHREADED, REGCLS_MULTIPLEUSE,
    };
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };
    use windows::Win32::UI::Notifications::{
        INotificationActivationCallback, INotificationActivationCallback_Impl,
        NOTIFICATION_USER_INPUT_DATA,
    };
    use windows::UI::Notifications::{
        NotificationSetting, ToastActivatedEventArgs, ToastNotification, ToastNotificationManager,
        ToastNotifier,
    };

    type OnOpen = Box<dyn Fn(String) + Send + Sync>;
    /// 押されたトーストのセッションを渡す先。
    /// install で一度だけ決まる。
    static ON_OPEN: OnceLock<OnOpen> = OnceLock::new();
    /// 最後に開いたセッションと時刻（同じ押下を 2 度開かないため）。
    static LAST_OPEN: Mutex<Option<(String, Instant)>> = Mutex::new(None);
    /// 出したトースト。
    /// Activated の受け口が生きているよう、セッションと種類ごと（識別子ごと）に最後の 1 つを持っておく。
    static TOASTS: LazyLock<Mutex<HashMap<String, ToastNotification>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    /// 通知センターから外す糸へ、残すものの一覧を渡す口（`prune`）。
    static PRUNER: OnceLock<Mutex<Sender<Keep>>> = OnceLock::new();
    /// 通知センターの頭に出す絵。
    /// 登録の IconUri は画像のファイルを指す決まりなので、hangar の置き場に書き出して指す。
    static ICON_PNG: &[u8] = include_bytes!("../icons/128x128.png");

    fn exe_path() -> Option<String> {
        // トーストの登録（LocalServer32）に書く。verbatim の形で起こされたときも、普通の形で書く。
        std::env::current_exe()
            .ok()
            .map(|p| crate::paths::plain(&p).to_string_lossy().into_owned())
    }

    fn installed() -> bool {
        exe_path().is_some_and(|exe| installed_exe(&exe))
    }

    /// 押されたトーストの launch の値を受け取る。
    /// hangar のトーストでなければ何もしない。
    fn opened(launch: &str) {
        let Some(id) = session_of(launch) else {
            return;
        };
        let fresh = match LAST_OPEN.lock() {
            Ok(mut last) => first_open(&mut last, id, Instant::now()),
            Err(_) => true,
        };
        if let (true, Some(open)) = (fresh, ON_OPEN.get()) {
            open(id.to_string());
        }
    }

    /// アプリが閉じていた間に押されたトーストを、COM から受け取る口。
    #[implement(INotificationActivationCallback)]
    struct Activator;

    impl INotificationActivationCallback_Impl for Activator_Impl {
        fn Activate(
            &self,
            _app_id: &PCWSTR,
            invoked_args: &PCWSTR,
            _data: *const NOTIFICATION_USER_INPUT_DATA,
            _count: u32,
        ) -> Result<()> {
            // SAFETY: OS が渡す文字列は、この呼び出しの間は生きている。
            let launch = unsafe { invoked_args.to_string() }.unwrap_or_default();
            opened(&launch);
            Ok(())
        }
    }

    /// COM が口を作るときに呼ぶ工場。
    #[implement(IClassFactory)]
    struct Factory;

    impl IClassFactory_Impl for Factory_Impl {
        fn CreateInstance(
            &self,
            outer: Ref<'_, IUnknown>,
            iid: *const GUID,
            object: *mut *mut c_void,
        ) -> Result<()> {
            if !outer.is_null() {
                return Err(CLASS_E_NOAGGREGATION.into());
            }
            let callback: INotificationActivationCallback = Activator.into();
            // SAFETY: iid と object は COM が渡すもので、query がその決まりどおりに埋める。
            unsafe { callback.query(iid, object).ok() }
        }

        fn LockServer(&self, _lock: BOOL) -> Result<()> {
            Ok(())
        }
    }

    /// HKEY_CURRENT_USER の下に文字列の値を書く。
    /// 鍵が無ければ作る。
    /// 名前が None なら、その鍵の既定の値に書く。
    fn set_value(key: &str, name: Option<&str>, value: &str) -> bool {
        let mut hkey = HKEY::default();
        // SAFETY: hkey はこの関数の中で開いて閉じる。
        let created = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                &HSTRING::from(key),
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                None,
                &mut hkey,
                None,
            )
        };
        if created != ERROR_SUCCESS {
            return false;
        }
        let name = name.map(HSTRING::from);
        let name = name.as_ref().map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr()));
        // REG_SZ は、終わりの 0 を含む UTF-16 のバイト列で渡す。
        let data: Vec<u8> = value
            .encode_utf16()
            .chain(Some(0))
            .flat_map(u16::to_le_bytes)
            .collect();
        // SAFETY: hkey は上で開いたもので、data は呼び出しの間生きている。
        let set = unsafe { RegSetValueExW(hkey, name, None, REG_SZ, Some(&data)) };
        // SAFETY: 開いた鍵を一度だけ閉じる。
        let _ = unsafe { RegCloseKey(hkey) };
        set == ERROR_SUCCESS
    }

    /// アプリの名前、絵、COM の口を、利用者の登録（管理者の権限は要らない）へ書く。
    /// 起動のたびに書き直すので、入れ直して場所が変わっても追いつく。
    fn register(exe: &str) -> bool {
        let icon = crate::paths::hangar_home().join("notify-icon.png");
        let icon_ok = std::fs::create_dir_all(icon.parent().unwrap_or(&icon)).is_ok()
            && std::fs::write(&icon, ICON_PNG).is_ok();
        let app = app_id_key();
        let mut ok = set_value(&app, Some("DisplayName"), DISPLAY_NAME)
            && set_value(&app, Some("CustomActivator"), &activator_clsid())
            && set_value(&server_key(), None, &server_command(exe));
        if icon_ok {
            ok &= set_value(&app, Some("IconUri"), &icon.to_string_lossy());
        }
        ok
    }

    /// COM の口を開き、アプリが終わるまで持ち続ける。
    /// 呼び出しは COM の糸から来るので、窓の糸の流れを止めない。
    fn serve() {
        // SAFETY: この糸で COM を一度だけ始め、終わりまで抜けない。
        let registered = unsafe {
            if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
                crate::log("toast activator: COM did not start");
                return;
            }
            let factory: IClassFactory = Factory.into();
            CoRegisterClassObject(
                &GUID::from_u128(ACTIVATOR_CLSID),
                &factory,
                CLSCTX_LOCAL_SERVER,
                REGCLS_MULTIPLEUSE,
            )
        };
        match registered {
            Ok(_) => crate::log("toast activator registered"),
            Err(e) => {
                crate::log(&format!("toast activator not registered: {}", describe(&e)));
                return;
            }
        }
        loop {
            std::thread::park();
        }
    }

    /// 押されたトーストを受け取る口を付ける。
    /// 起動の途中で一度だけ呼ぶ。
    /// 閉じている間に押されたトーストで COM がアプリを起こしたときは、ここで口を開くと Windows が押されたトーストを渡してくる。
    /// 頁が出来上がる前に届いたものは、受け口（`open_waiting`）がハッシュとして貯める。
    pub fn install(on_open: impl Fn(String) + Send + Sync + 'static) {
        let Some(exe) = exe_path() else {
            return;
        };
        if !installed_exe(&exe) || ON_OPEN.set(Box::new(on_open)).is_err() {
            return;
        }
        if !register(&exe) {
            crate::log("toast registration incomplete");
        }
        let _ = std::thread::Builder::new()
            .name("toast-activator".into())
            .spawn(serve);
    }

    fn notifier() -> Result<ToastNotifier> {
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))
    }

    /// 通知の設定を読む。
    /// 入れたアプリでなければ None。
    fn setting() -> Option<Result<NotificationSetting>> {
        installed().then(|| notifier().and_then(|n| n.Setting()))
    }

    /// 通知を出せるかを返す。
    /// Windows には許可を尋ねるダイアログが無いので、設定で切られていないかだけを答える。
    pub fn request(done: impl FnOnce(bool) + Send + 'static) {
        done(matches!(setting(), Some(Ok(s)) if s == NotificationSetting::Enabled));
    }

    /// 通知の設定を、macOS の許可の状態の値に読み替えて返す。
    /// 入れたアプリでなければ None（尋ねられない）、読めなければ未決とする。
    pub fn status(done: impl FnOnce(Option<isize>) + Send + 'static) {
        done(setting().map(|r| r.map_or(0, |s| setting_status(s.0))));
    }

    fn deliver(w: &Waiting) -> Result<()> {
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(toast_xml(w)))?;
        let toast = ToastNotification::CreateToastNotification(&doc)?;
        toast.SetTag(&HSTRING::from(toast_tag(&w.session_id)))?;
        toast.SetGroup(&HSTRING::from(toast_group(w.kind)))?;
        toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
            |_sender, args: Ref<'_, IInspectable>| {
                if let Some(args) = args.as_ref() {
                    let launch = args.cast::<ToastActivatedEventArgs>()?.Arguments()?;
                    opened(&launch.to_string());
                }
                Ok(())
            },
        ))?;
        notifier()?.Show(&toast)?;
        if let Ok(mut toasts) = TOASTS.lock() {
            toasts.insert(identifier(w.kind, &w.session_id), toast);
        }
        Ok(())
    }

    /// トーストを出す。
    /// 設定で切られていれば、Windows が黙って捨てる。
    /// 出せたかどうかを 1 行ずつ残す。
    /// 出なかったときに、頁が呼ばなかったのか、OS が捨てたのかを殻のログから見分けるためである。
    pub fn show(w: &Waiting) {
        if !installed() {
            crate::log("toast skipped: not an installed build");
            return;
        }
        match deliver(w) {
            Ok(()) => crate::log("toast handed to Windows"),
            Err(e) => crate::log(&format!("toast not shown: {}", describe(&e))),
        }
    }

    /// 通知センターの履歴から、残すものに無いトーストを外す。
    /// 履歴は hangar の AppUserModelID のものだけを読む。
    /// 外した数を 1 行残す。
    fn remove_stale(keep: &Keep) -> Result<usize> {
        let app = HSTRING::from(APP_ID);
        let history = ToastNotificationManager::History()?;
        let mut shown = Vec::new();
        for toast in &history.GetHistoryWithId(&app)? {
            shown.push((toast.Tag()?.to_string(), toast.Group()?.to_string()));
        }
        let stale = stale_toasts(&shown, keep);
        for (tag, group) in &stale {
            history.RemoveGroupedTagWithId(&HSTRING::from(tag), &HSTRING::from(group), &app)?;
        }
        Ok(stale.len())
    }

    /// 失敗をログの 1 行の文にする。
    /// Error の表示は糸に残った前の失敗の説明を拾うことがあるので、コードとコードから引いた文だけを使う（`hresult_line`）。
    fn describe(e: &Error) -> String {
        hresult_line(e.code().0, &e.code().message())
    }

    /// もう待っていないセッションのトーストを、通知センターから外す。
    /// 頁は、入力待ちの顔ぶれか今日の戻る時刻を過ぎた顔ぶれが変わるたびと、起動して一覧を読み終えたときに呼ぶ。
    /// 起動のときは前の起動の間に出したトーストが残っているので、ここで外す。今も待っているものは残し、出し直しはしない。
    /// 通知センターの履歴は別のプロセスにあり、読むと外への呼び出しになる。
    /// 頁の命令は窓の糸で、WebView2 の知らせを配っている途中に呼ばれるので、そこから外へ呼ぶと Windows が断る（0x8001010D、RPC_E_CANTCALLOUT_ININPUTSYNCCALL）。
    /// なので、外すのは COM を自分で始めた別の糸（`prune_loop`）に任せ、ここは覚えておくトーストを絞って一覧を渡すだけにする。
    pub fn prune(keep: Keep) {
        if !installed() {
            return;
        }
        if let Ok(mut toasts) = TOASTS.lock() {
            toasts.retain(|id, _| parse_identifier(id).is_some_and(|(k, s)| keep.holds(k, s)));
        }
        let sent = PRUNER
            .get_or_init(|| {
                let (tx, rx) = channel();
                let _ = std::thread::Builder::new()
                    .name("toast-prune".into())
                    .spawn(move || prune_loop(rx));
                Mutex::new(tx)
            })
            .lock()
            .map(|tx| tx.send(keep).is_ok())
            .unwrap_or(false);
        if !sent {
            crate::log("toasts not removed: the removing thread is not running");
        }
    }

    /// 通知センターから外す糸。
    /// 一覧は届いた順に扱い、溜まっていれば、いちばん新しいものだけを使う。
    /// 頁が一覧を渡した後に出したトーストは、出したもの（TOASTS）に入っているので、残すものに足してから外す。
    fn prune_loop(rx: Receiver<Keep>) {
        // SAFETY: この糸で COM を一度だけ始め、終わりまで抜けない。
        if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
            crate::log("toasts not removed: COM did not start");
            return;
        }
        while let Ok(mut keep) = rx.recv() {
            while let Ok(newer) = rx.try_recv() {
                keep = newer;
            }
            if let Ok(toasts) = TOASTS.lock() {
                keep.extend_shown(toasts.keys().map(String::as_str));
            }
            match remove_stale(&keep) {
                Ok(0) => {}
                Ok(n) => crate::log(&format!("toasts removed: {n}")),
                Err(e) => crate::log(&format!("toasts not removed: {}", describe(&e))),
            }
        }
    }
}

/// UNUserNotificationCenter で通知を出し、押されたものを受け取る。
/// tauri-plugin-notification はデスクトップでは押された通知を知らせてくれないので、ここで直に呼ぶ。
#[cfg(target_os = "macos")]
mod mac {
    use super::{identifier, session_of, stale_identifiers, Keep, Waiting};
    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread};
    use objc2_foundation::{NSArray, NSBundle, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationRequest, UNNotificationResponse, UNNotificationSettings, UNNotificationSound,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::ptr::NonNull;
    use std::sync::{LazyLock, Mutex, OnceLock};

    type OnOpen = Box<dyn Fn(String) + Send + Sync>;
    /// 押された通知のセッションを渡す先。
    /// install で一度だけ決まる。
    static ON_OPEN: OnceLock<OnOpen> = OnceLock::new();
    /// 通知センターに残してよい知らせ。
    /// 頁が最後に渡した一覧に、その後に出した知らせを足したもの。
    /// 届いている通知の一覧は OS が後から答えるので、その間に出した知らせを、古い一覧で外さないためである。
    static KEEP: LazyLock<Mutex<Keep>> = LazyLock::new(|| Mutex::new(Keep::default()));

    define_class!(
        // SAFETY: NSObject には派生の決まりが無く、この型は Drop を持たない。
        #[unsafe(super(NSObject))]
        #[name = "HangarNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &DynBlock<dyn Fn()>,
            ) {
                let id = response.notification().request().identifier().to_string();
                if let (Some(session), Some(open)) = (session_of(&id), ON_OPEN.get()) {
                    open(session.to_string());
                }
                completion_handler.call(());
            }
        }
    );

    impl Delegate {
        fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            unsafe { msg_send![super(this), init] }
        }
    }

    /// .app の中で動いているか。
    /// UNUserNotificationCenter は .app の外（`tauri dev` の素の実行ファイル）で呼ぶと例外で落ちるので、そのときは何もしない。
    fn bundled() -> bool {
        let bundle = NSBundle::mainBundle();
        bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
    }

    /// 押された通知を受け取る口を付ける。
    /// 起動の途中で一度だけ呼ぶ。
    /// 押された通知でアプリが起きたときも受け取れるよう、窓より先に付ける。
    pub fn install(on_open: impl Fn(String) + Send + Sync + 'static) {
        if !bundled() || ON_OPEN.set(Box::new(on_open)).is_err() {
            return;
        }
        let delegate = Delegate::new();
        let center = UNUserNotificationCenter::currentNotificationCenter();
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // 通知の受け口は弱い参照でしか持たれないので、アプリが終わるまで手放さない。
        std::mem::forget(delegate);
    }

    /// 通知の許可を求める。
    /// まだ決まっていなければ OS が尋ね、決まっていれば黙ってその答えを返す。
    pub fn request(done: impl FnOnce(bool) + Send + 'static) {
        if !bundled() {
            done(false);
            return;
        }
        let done = Mutex::new(Some(done));
        let block = RcBlock::new(move |granted: Bool, err: *mut NSError| {
            let Some(f) = done.lock().unwrap().take() else {
                return;
            };
            if granted.as_bool() {
                f(true);
                return;
            }
            // SAFETY: OS が渡すエラーは、この呼び出しの間は生きている（無ければ null）。
            let reason = unsafe { err.as_ref() }.map(|e| e.localizedDescription().to_string());
            // 札の「許可」でも断られたと答えることがあるので、OS の答えの口を塞がないよう別のスレッドで読み直す（granted_after_refusal）。
            std::thread::spawn(move || {
                let granted = super::granted_after_refusal(read_status, std::thread::sleep);
                if granted {
                    crate::log("notifications allowed after the answer said refused");
                } else {
                    crate::log(&super::refused_line(reason.as_deref()));
                }
                f(granted);
            });
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .requestAuthorizationWithOptions_completionHandler(authorization_options(), &block);
    }

    /// 求める許可。
    /// Dock のバッジ（set_badge_count）も macOS の通知の設定の「バッジ」に従うので、バッジも求める。
    /// 求めないと、システム設定にバッジの項目が出ず、入力待ちの数が Dock に出ない。
    pub fn authorization_options() -> UNAuthorizationOptions {
        UNAuthorizationOptions::Alert
            | UNAuthorizationOptions::Sound
            | UNAuthorizationOptions::Badge
    }

    /// 通知の許可の状態を読む。
    /// 尋ねはしないので、OS のダイアログは出ない。
    /// システム設定で切られていれば Denied が返る。
    /// .app の外では OS に尋ねられないので `None` を返す。
    pub fn status(done: impl FnOnce(Option<isize>) + Send + 'static) {
        if !bundled() {
            done(None);
            return;
        }
        let done = Mutex::new(Some(done));
        let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            // SAFETY: OS が渡す設定は、この呼び出しの間は生きている。
            let raw = unsafe { settings.as_ref() }.authorizationStatus().0;
            if let Some(f) = done.lock().unwrap().take() {
                f(Some(raw));
            }
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .getNotificationSettingsWithCompletionHandler(&block);
    }

    /// 許可の状態を待って読む。答えが来なければ（10 秒）まだ決まっていないとみなす。
    fn read_status() -> Option<isize> {
        let (tx, rx) = std::sync::mpsc::channel();
        status(move |raw| {
            let _ = tx.send(raw);
        });
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .unwrap_or(Some(0))
    }

    /// 通知を出す。
    /// まだ許可を尋ねていなければ先に尋ね、許されたときだけ出す（許されていなければ OS が黙って捨てる）。
    pub fn show(w: &Waiting) {
        if !bundled() {
            return;
        }
        let w = w.clone();
        if let Ok(mut keep) = KEEP.lock() {
            keep.insert(w.kind, &w.session_id);
        }
        let deliver = move |granted: bool| {
            if !granted {
                return;
            }
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&w.title));
            content.setBody(&NSString::from_str(&w.body));
            content.setSound(Some(&UNNotificationSound::defaultSound()));
            let req = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSString::from_str(&identifier(w.kind, &w.session_id)),
                &content,
                None,
            );
            UNUserNotificationCenter::currentNotificationCenter()
                .addNotificationRequest_withCompletionHandler(&req, None);
            // Windows の「toast handed to Windows」と同じく、出した回数を殻のログで数えられるようにする。
            crate::log("notification handed to macOS");
        };
        request(deliver);
    }

    /// もう待っていないセッションの知らせを、通知センターから外す。
    /// 頁は、入力待ちの顔ぶれか今日の戻る時刻を過ぎた顔ぶれが変わるたびと、起動して一覧を読み終えたときに呼ぶ。
    /// 外すのは hangar の識別子の通知だけである。
    pub fn prune(keep: Keep) {
        if !bundled() {
            return;
        }
        if let Ok(mut k) = KEEP.lock() {
            *k = keep;
        }
        let block = RcBlock::new(|delivered: NonNull<NSArray<UNNotification>>| {
            // SAFETY: OS が渡す一覧は、この呼び出しの間は生きている。
            let delivered = unsafe { delivered.as_ref() };
            let ids: Vec<String> = (0..delivered.count())
                .map(|i| {
                    delivered
                        .objectAtIndex(i)
                        .request()
                        .identifier()
                        .to_string()
                })
                .collect();
            let stale = match KEEP.lock() {
                Ok(keep) => stale_identifiers(&ids, &keep),
                Err(_) => return,
            };
            if stale.is_empty() {
                return;
            }
            let stale: Vec<_> = stale.iter().map(|id| NSString::from_str(id)).collect();
            UNUserNotificationCenter::currentNotificationCenter()
                .removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(&stale));
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .getDeliveredNotificationsWithCompletionHandler(&block);
    }
}

#[cfg(test)]
mod tests {
    use super::toast::*;
    use super::*;

    #[test]
    fn a_grant_written_after_the_refusal_counts_as_granted() {
        // macOS 27 では、札の「許可」を押しても答えは断られたで、許可は約 2 秒後に書かれる。
        let mut reads = vec![Some(0), Some(0), Some(0), Some(2)].into_iter();
        let mut waited = Duration::ZERO;
        assert!(granted_after_refusal(
            || reads.next().flatten(),
            |d| waited += d
        ));
        assert_eq!(waited, RECHECK_EVERY * 4);
    }

    #[test]
    fn a_refusal_that_stays_is_given_up_within_the_limit() {
        let mut n = 0;
        let mut waited = Duration::ZERO;
        assert!(!granted_after_refusal(
            || {
                n += 1;
                Some(1)
            },
            |d| waited += d
        ));
        assert_eq!(n, RECHECK_TRIES);
        assert_eq!(waited, RECHECK_EVERY * RECHECK_TRIES);
    }

    #[test]
    fn no_recheck_where_the_os_cannot_be_asked() {
        let mut n = 0;
        assert!(!granted_after_refusal(
            || {
                n += 1;
                None
            },
            |_| {}
        ));
        assert_eq!(n, 1);
    }

    #[test]
    fn a_refused_authorization_is_logged_with_the_reason() {
        assert_eq!(
            refused_line(Some("Notifications are not allowed for this application")),
            "notifications refused by macOS: Notifications are not allowed for this application"
        );
        assert_eq!(
            refused_line(None),
            "notifications refused by macOS: no reason given"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_authorization_asks_for_the_dock_badge_too() {
        use objc2_user_notifications::UNAuthorizationOptions;
        let o = super::mac::authorization_options();
        assert!(o.contains(UNAuthorizationOptions::Alert));
        assert!(o.contains(UNAuthorizationOptions::Sound));
        assert!(o.contains(UNAuthorizationOptions::Badge));
    }

    #[test]
    fn a_waiting_notification_keeps_the_name_and_question() {
        let w = waiting(
            Kind::Waiting,
            "0192f0a1-7c3e-7b2d-9f00-aa11bb22cc33",
            "請求書の書き出し",
            "向きはどちらにしますか",
            "ja",
        )
        .unwrap();
        assert_eq!(w.session_id, "0192f0a1-7c3e-7b2d-9f00-aa11bb22cc33");
        assert_eq!(w.title, "請求書の書き出し");
        assert_eq!(w.body, "向きはどちらにしますか");
    }

    #[test]
    fn a_session_id_that_is_not_plain_is_refused() {
        for bad in [
            "",
            "a b",
            "x\";alert(1);//",
            "../etc",
            "s1\n",
            &"a".repeat(65),
        ] {
            assert!(
                waiting(Kind::Waiting, bad, "t", "b", "ja").is_err(),
                "{bad:?}"
            );
        }
        assert!(waiting(Kind::Waiting, "s_1-A", "t", "b", "ja").is_ok());
    }

    #[test]
    fn empty_texts_fall_back_to_the_words_the_ui_uses() {
        let w = waiting(Kind::Waiting, "s1", "  ", "", "ja").unwrap();
        assert_eq!(w.title, "（名前なし）");
        assert_eq!(w.body, "入力待ちです");
    }

    #[test]
    fn empty_texts_fall_back_to_english_in_english() {
        let w = waiting(Kind::Waiting, "s1", "  ", "", "en").unwrap();
        assert_eq!(w.title, "(No name)");
        assert_eq!(w.body, "Waiting for input");
    }

    #[test]
    fn long_texts_are_cut_by_characters_with_an_ellipsis() {
        let long = "あ".repeat(300);
        let w = waiting(Kind::Waiting, "s1", &long, &long, "ja").unwrap();
        assert_eq!(w.title.chars().count(), TITLE_MAX);
        assert!(w.title.ends_with('…'));
        assert_eq!(w.body.chars().count(), BODY_MAX);
        assert!(w.body.ends_with('…'));
    }

    #[test]
    fn the_identifier_round_trips_to_the_session() {
        assert_eq!(session_of(&identifier(Kind::Waiting, "s1")), Some("s1"));
        assert_eq!(session_of("other:s1"), None);
        assert_eq!(session_of("hangar-waiting:x\"y"), None);
    }

    #[test]
    fn only_a_window_the_user_is_looking_at_skips_the_notification() {
        // 見えていて、最小化しておらず、フォーカスがあるときだけ、窓が前にあるとみなす。
        assert!(window_in_front(true, false, true));
        // 別のアプリを前に出した（macOS の Cmd+Tab、Windows の Alt+Tab）。
        assert!(!window_in_front(true, false, false));
        // 最小化した。フォーカスの答えに頼らず、最小化を先に見る。
        assert!(!window_in_front(true, true, true));
        // 隠した（macOS の Cmd+H、閉じるボタン）。
        assert!(!window_in_front(false, false, true));
    }

    #[test]
    fn a_window_in_front_skips_the_notification_unless_the_item_says_even_in_front() {
        assert!(skip_in_front(true, false));
        assert!(!skip_in_front(true, true));
        assert!(!skip_in_front(false, false));
        assert!(!skip_in_front(false, true));
    }

    /// OS の前景を取り合う試験を 1 本ずつにする錠。
    /// cargo test は試験を並列の糸で走らせ、前景は机に 1 つしかない。
    /// 錠が無いと、前に出してから確かめるまでのあいだに、もう一方の試験が前景を取って落ちる（CI の windows で起きた）。
    /// 錠を持ったまま落ちた試験があっても、残りは中身の無い錠をそのまま使う（毒を気にしない）。
    #[cfg(windows)]
    static FOREGROUND: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[cfg(windows)]
    fn hold_foreground() -> std::sync::MutexGuard<'static, ()> {
        FOREGROUND.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 前景を取り合う試験は、どちらも錠を持ってから窓を作る。
    /// Windows でない机でも、錠を使う試験の名前がそろっていることを確かめられるように、ここに挙げる。
    #[test]
    fn the_tests_that_take_the_foreground_hold_one_lock() {
        let src = include_str!("notify.rs");
        for name in [
            "fn a_focused_child_window_still_counts_as_the_window_in_front()",
            "fn a_dialog_owned_by_the_window_counts_as_the_window_in_front()",
        ] {
            let body = src.split(&format!("{name} {{\n")).nth(1).expect(name);
            let first = body.lines().next().unwrap_or_default().trim();
            assert_eq!(first, "let _front = hold_foreground();", "{name}");
        }
        // 錠を持たずに前景を取る試験を足さない（前景を取りに行くのは上の 2 つだけ）。
        // 呼び出しの形を 2 つに割って書くのは、この行そのものを数えないためである。
        let call = ["SetForeground", "Window("].concat();
        assert_eq!(src.matches(call.as_str()).count(), 2);
    }

    /// Windows では、フォーカスが WebView2 の子窓にあっても、hangar の窓が前景なら前にあるとみなす。
    /// 実物の窓（最上位の窓とその子）を作って、子にフォーカスを置いた形で確かめる。
    #[cfg(windows)]
    #[test]
    fn a_focused_child_window_still_counts_as_the_window_in_front() {
        let _front = hold_foreground();
        use windows::core::w;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetFocus, SetFocus};
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, GetForegroundWindow, SetForegroundWindow,
            WINDOW_EX_STYLE, WS_CHILD, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
        };
        unsafe {
            let top_level = |title: windows::core::PCWSTR| {
                CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("STATIC"),
                    title,
                    WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                    0,
                    0,
                    200,
                    200,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap()
            };
            let ours = top_level(w!("hangar-front-test"));
            let other = top_level(w!("hangar-front-other"));
            // WebView2 の子窓（Chrome_WidgetWin_1）の代わり。
            let child = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                w!("STATIC"),
                w!(""),
                WS_CHILD | WS_VISIBLE,
                0,
                0,
                50,
                50,
                Some(ours),
                None,
                None,
                None,
            )
            .unwrap();
            // 前景の窓を名指しして見る形は、OS の前景の取り合いに左右されない。
            assert!(owns_foreground_window(ours, ours));
            assert!(owns_foreground_window(child, ours));
            assert!(!owns_foreground_window(other, ours));
            assert!(!owns_foreground_window(HWND::default(), ours));
            // 実際に前に出せたときは、子にフォーカスを置いて、OS の前景から見ても前にあると答えることを確かめる。
            // CI の机では前景を取れないことがあるので、取れなかったときはここを飛ばす。
            let _ = SetForegroundWindow(ours);
            if GetForegroundWindow() == ours {
                let _ = SetFocus(Some(child));
                // 最上位の窓そのものにはフォーカスが無い（tao の is_focused が偽になる形）。
                assert_eq!(GetFocus(), child);
                assert!(window_owns_foreground(ours));
            } else {
                eprintln!(
                    "skipped the live foreground check: the test could not take the foreground"
                );
            }
            let _ = DestroyWindow(child);
            let _ = DestroyWindow(other);
            let _ = DestroyWindow(ours);
        }
    }

    /// Windows では、hangar の窓が持ち主のダイアログ（ファイルの選択など）が前景にあるときも、利用者は hangar を見ているので前にあるとみなす。
    /// 持ち主のある最上位の窓（owned window）とその中の子を、実物で作って確かめる。
    #[cfg(windows)]
    #[test]
    fn a_dialog_owned_by_the_window_counts_as_the_window_in_front() {
        let _front = hold_foreground();
        use windows::core::w;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, GetForegroundWindow, SetForegroundWindow,
            WINDOW_EX_STYLE, WINDOW_STYLE, WS_CHILD, WS_OVERLAPPEDWINDOW, WS_POPUP, WS_VISIBLE,
        };
        unsafe {
            // owner に Some を渡し WS_CHILD を付けなければ、親ではなく持ち主になる。
            let window = |style: WINDOW_STYLE, owner: Option<HWND>| {
                CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("STATIC"),
                    w!("hangar-owner-test"),
                    style | WS_VISIBLE,
                    0,
                    0,
                    200,
                    200,
                    owner,
                    None,
                    None,
                    None,
                )
                .unwrap()
            };
            let ours = window(WS_OVERLAPPEDWINDOW, None);
            let other = window(WS_OVERLAPPEDWINDOW, None);
            // hangar の窓が持ち主のダイアログと、その中のボタンなどの子。
            let dialog = window(WS_POPUP, Some(ours));
            let in_dialog = window(WS_CHILD, Some(dialog));
            // ほかのアプリの窓が持ち主のダイアログ。
            let foreign = window(WS_POPUP, Some(other));
            assert!(owns_foreground_window(dialog, ours));
            assert!(owns_foreground_window(in_dialog, ours));
            assert!(!owns_foreground_window(foreign, ours));
            assert!(!owns_foreground_window(other, ours));
            // 実際にダイアログを前に出せたときは、OS の前景から見ても前にあると答えることを確かめる。
            // CI の机では前景を取れないことがあるので、取れなかったときはここを飛ばす。
            let _ = SetForegroundWindow(dialog);
            if GetForegroundWindow() == dialog {
                assert!(window_owns_foreground(ours));
            } else {
                eprintln!(
                    "skipped the live foreground check: the test could not take the foreground"
                );
            }
            for h in [in_dialog, dialog, foreign, other, ours] {
                let _ = DestroyWindow(h);
            }
        }
    }

    #[test]
    fn the_authorization_status_is_named_for_the_page() {
        // 殻が .app の外で動いているときは、OS に尋ねられない。
        assert_eq!(status_name(None), "unsupported");
        assert_eq!(status_name(Some(0)), "undetermined");
        assert_eq!(status_name(Some(1)), "denied");
        // 許可、仮の許可、一時の許可は、どれも出せる。
        assert_eq!(status_name(Some(2)), "granted");
        assert_eq!(status_name(Some(3)), "granted");
        assert_eq!(status_name(Some(4)), "granted");
        // 知らない値は、まだ決まっていないとみなす（起動時に尋ね直せば OS が答える）。
        assert_eq!(status_name(Some(99)), "undetermined");
    }

    #[test]
    fn the_toast_carries_the_name_the_question_and_where_to_go() {
        let name = "請求書の書き出し";
        let question = "向きはどちらにしますか";
        let w = waiting(Kind::Waiting, "s1", name, question, "ja").unwrap();
        let xml = toast_xml(&w);
        assert!(
            xml.starts_with("<toast launch=\"hangar-waiting:s1\" activationType=\"foreground\">"),
            "{xml}"
        );
        let texts = format!("<text>{name}</text><text>{question}</text>");
        let binding = format!("<binding template=\"ToastGeneric\">{texts}</binding>");
        assert!(xml.contains(&binding), "{xml}");
    }

    #[test]
    fn the_toast_escapes_the_texts_so_the_page_cannot_change_its_shape() {
        let w = waiting(Kind::Waiting, "s1", "a<b>&\"c'", "</text><text>x", "ja").unwrap();
        let xml = toast_xml(&w);
        assert!(
            xml.contains("<text>a&lt;b&gt;&amp;&quot;c&apos;</text>"),
            "{xml}"
        );
        assert!(
            xml.contains("<text>&lt;/text&gt;&lt;text&gt;x</text>"),
            "{xml}"
        );
        assert_eq!(xml.matches("<text>").count(), 2);
    }

    #[test]
    fn a_click_on_the_toast_reads_back_the_same_session_as_on_macos() {
        // Windows は押されたトーストの launch の値を、そのまま殻へ返す。
        let w = waiting(Kind::Waiting, "s_1-A", "t", "b", "ja").unwrap();
        let xml = toast_xml(&w);
        let launch = xml.split('"').nth(1).unwrap();
        assert_eq!(session_of(launch), Some("s_1-A"));
    }

    #[test]
    fn the_tag_replaces_the_older_toast_of_the_same_session_and_fits_the_limit() {
        assert_eq!(toast_tag("s1"), toast_tag("s1"));
        assert_ne!(toast_tag("s1"), toast_tag("s2"));
        // Windows のタグは 64 文字まで。
        let longest = "a".repeat(ID_MAX);
        assert!(waiting(Kind::Waiting, &longest, "t", "b", "ja").is_ok());
        assert!(toast_tag(&longest).chars().count() <= 64);
    }

    #[test]
    fn the_app_id_is_the_one_the_installer_puts_on_the_shortcut() {
        // NSIS のインストーラは、スタートメニューの近道に identifier を AppUserModelID として付ける。
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], APP_ID);
        assert_eq!(conf["productName"], DISPLAY_NAME);
    }

    #[test]
    fn the_registry_points_windows_at_this_app_for_clicks_while_closed() {
        assert_eq!(
            app_id_key(),
            r"Software\Classes\AppUserModelId\dev.agent-hangar.hangar"
        );
        assert_eq!(activator_clsid(), "{1CE6AB2A-D79D-49F4-88B0-5A9E624A75E4}");
        assert_eq!(
            server_key(),
            r"Software\Classes\CLSID\{1CE6AB2A-D79D-49F4-88B0-5A9E624A75E4}\LocalServer32"
        );
        assert_eq!(
            server_command(r"C:\Users\u\AppData\Local\Hangar\hangar-desktop.exe"),
            r#""C:\Users\u\AppData\Local\Hangar\hangar-desktop.exe" -ToastActivated"#
        );
    }

    #[test]
    fn only_the_installed_app_takes_over_the_toasts() {
        assert!(installed_exe(
            r"C:\Users\u\AppData\Local\Hangar\hangar-desktop.exe"
        ));
        // 組み上げたままの実行ファイルは、入れた版の登録を書き換えない。
        for dev in [
            r"C:\src\apps\desktop\src-tauri\target\debug\hangar-desktop.exe",
            r"C:\src\apps\desktop\src-tauri\target\release\hangar-desktop.exe",
            r"C:\src\target\x86_64-pc-windows-msvc\release\hangar-desktop.exe",
            "/src/target/debug/hangar-desktop",
        ] {
            assert!(!installed_exe(dev), "{dev}");
        }
    }

    #[test]
    fn the_windows_setting_reads_as_the_same_states_as_on_macos() {
        // NotificationSetting の Enabled は 0、切られている 4 通りは 1 から 4。
        assert_eq!(status_name(Some(setting_status(0))), "granted");
        for off in 1..=4 {
            assert_eq!(status_name(Some(setting_status(off))), "denied");
        }
        assert_eq!(status_name(Some(setting_status(99))), "undetermined");
    }

    #[test]
    fn a_click_that_windows_reports_twice_opens_the_session_once() {
        use std::time::{Duration, Instant};
        let t0 = Instant::now();
        let mut last = None;
        assert!(first_open(&mut last, "s1", t0));
        assert!(!first_open(
            &mut last,
            "s1",
            t0 + Duration::from_millis(500)
        ));
        assert!(first_open(&mut last, "s2", t0 + Duration::from_millis(600)));
        assert!(first_open(&mut last, "s2", t0 + Duration::from_secs(5)));
    }

    #[test]
    fn the_page_names_the_kind_and_an_old_page_that_names_none_means_waiting() {
        assert_eq!(Kind::parse(None), Ok(Kind::Waiting));
        assert_eq!(Kind::parse(Some("waiting")), Ok(Kind::Waiting));
        assert_eq!(Kind::parse(Some("return")), Ok(Kind::Return));
        assert_eq!(Kind::parse(Some("limit")), Ok(Kind::Limit));
        assert!(Kind::parse(Some("other")).is_err());
        assert!(Kind::parse(Some("")).is_err());
    }

    /// 戻る時刻の知らせが、同じセッションの入力待ちの知らせを置き換えて問いの文を消さないこと。
    /// macOS は識別子、Windows はタグと組の対で置き換わる。
    #[test]
    fn a_return_notice_does_not_replace_the_waiting_notice_of_the_same_session() {
        assert_ne!(
            identifier(Kind::Waiting, "s1"),
            identifier(Kind::Return, "s1")
        );
        let waiting_slot = (toast_tag("s1"), toast_group(Kind::Waiting));
        let return_slot = (toast_tag("s1"), toast_group(Kind::Return));
        assert_ne!(waiting_slot, return_slot);
        // 同じ種類の 2 度目は、今までどおり同じ枠で置き換わる。
        assert_eq!(
            identifier(Kind::Waiting, "s1"),
            identifier(Kind::Waiting, "s1")
        );
        assert_eq!(waiting_slot, (toast_tag("s1"), toast_group(Kind::Waiting)));
        // 組の名前も、Windows の上限（64 文字）に収まる。
        assert!(toast_group(Kind::Return).len() <= 64);
    }

    #[test]
    fn the_waiting_identifier_stays_as_before_so_older_toasts_still_open() {
        // 前の版が出した入力待ちのトーストも、押せば同じセッションを開く。
        assert_eq!(identifier(Kind::Waiting, "s1"), "hangar-waiting:s1");
        assert_eq!(toast_group(Kind::Waiting), "hangar-waiting");
    }

    #[test]
    fn a_click_on_either_kind_reads_back_the_session() {
        assert_eq!(session_of(&identifier(Kind::Return, "s1")), Some("s1"));
        assert_eq!(
            parse_identifier(&identifier(Kind::Return, "s_1-A")),
            Some((Kind::Return, "s_1-A"))
        );
        assert_eq!(
            parse_identifier("hangar-waiting:s1"),
            Some((Kind::Waiting, "s1"))
        );
        assert_eq!(parse_identifier("hangar-return:x\"y"), None);
        assert_eq!(parse_identifier("hangar-other:s1"), None);
        let w = waiting(Kind::Return, "s1", "t", "b", "ja").unwrap();
        let launch = toast_xml(&w);
        let launch = launch.split('"').nth(1).unwrap();
        assert_eq!(launch, "hangar-return:s1");
        assert_eq!(session_of(launch), Some("s1"));
    }

    /// 使用制限の知らせは、アカウントごとの 1 通で、同じセッションの入力待ちや戻る時刻の知らせとは別の枠に入る。
    #[test]
    fn a_limit_notice_has_its_own_slot_and_reads_back_the_session() {
        assert_eq!(identifier(Kind::Limit, "s1"), "hangar-limit:s1");
        assert_ne!(
            identifier(Kind::Limit, "s1"),
            identifier(Kind::Waiting, "s1")
        );
        assert_eq!(
            parse_identifier("hangar-limit:s1"),
            Some((Kind::Limit, "s1"))
        );
        assert_eq!(session_of("hangar-limit:s1"), Some("s1"));
        assert_eq!(toast_group(Kind::Limit), "hangar-limit");
        assert_ne!(toast_group(Kind::Limit), toast_group(Kind::Waiting));
    }

    /// 参加リクエストの知らせは、セッションの知らせとは別の枠に入り、押すと設定を開く。
    #[test]
    fn a_join_notice_has_its_own_slot_and_opens_the_settings() {
        assert_eq!(Kind::parse(Some("join")), Ok(Kind::Join));
        assert_eq!(
            identifier(Kind::Join, JOIN_SESSION),
            "hangar-join:join-request"
        );
        assert_eq!(
            parse_identifier("hangar-join:join-request"),
            Some((Kind::Join, "join-request"))
        );
        assert_eq!(session_of("hangar-join:join-request"), Some(JOIN_SESSION));
        assert_eq!(toast_group(Kind::Join), "hangar-join");
        assert_ne!(toast_group(Kind::Join), toast_group(Kind::Waiting));
        let js = open_js(JOIN_SESSION);
        assert!(js.contains("__hangarOpenJoin"));
        assert!(js.contains("\"#/settings?at=cloud\""));
        assert!(!js.contains("#/session/"));
        // 頁が出来上がる前に押されたら、設定のクラウド同期の節を貯める。
        assert_eq!(open_hash(JOIN_SESSION), "#/settings?at=cloud");
        assert_eq!(open_hash("s1"), "#/session/s1");
        // セッションの知らせは今までどおりセッションを開く。
        assert!(open_js("s1").contains("__hangarOpenWaiting"));
    }

    /// 未読の知らせは入力待ちとは別の枠（識別子、タグの組）に入り、押すとそのセッションを開く。頁の顔ぶれの一覧に載らないので、一覧で外さない。
    #[test]
    fn an_unread_notice_has_its_own_slot_and_opens_the_session() {
        assert_eq!(Kind::parse(Some("unread")), Ok(Kind::Unread));
        assert_eq!(identifier(Kind::Unread, "s1"), "hangar-unread:s1");
        assert_ne!(
            identifier(Kind::Unread, "s1"),
            identifier(Kind::Waiting, "s1")
        );
        assert_eq!(
            parse_identifier("hangar-unread:s1"),
            Some((Kind::Unread, "s1"))
        );
        assert_eq!(session_of("hangar-unread:s1"), Some("s1"));
        assert_eq!(toast_group(Kind::Unread), "hangar-unread");
        assert_ne!(toast_group(Kind::Unread), toast_group(Kind::Waiting));
        assert!(open_js("s1").contains("#/session/"));
        let keep = Keep::new(&[], &[]);
        assert!(keep.holds(Kind::Unread, "s1"));
        assert!(stale_identifiers(&ids(&["hangar-unread:s1"]), &keep).is_empty());
    }

    /// 参加リクエストの知らせは、頁の顔ぶれの一覧に載らないので、一覧で外さない。
    #[test]
    fn the_keep_list_always_holds_join_notices() {
        let keep = Keep::new(&[], &[]);
        assert!(keep.holds(Kind::Join, JOIN_SESSION));
        assert!(stale_identifiers(&ids(&["hangar-join:join-request"]), &keep).is_empty());
        assert!(stale_toasts(
            &[(toast_tag(JOIN_SESSION), toast_group(Kind::Join).to_string())],
            &keep
        )
        .is_empty());
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_keep_list_holds_the_limited_sessions_apart() {
        let keep = Keep::new(&ids(&["s1"]), &[]).with_limited(&ids(&["s2", "x\"y"]));
        assert!(keep.holds(Kind::Limit, "s2"));
        assert!(!keep.holds(Kind::Limit, "x\"y"));
        assert!(!keep.holds(Kind::Limit, "s1"));
        assert!(!keep.holds(Kind::Waiting, "s2"));
        let mut empty = Keep::default();
        empty.insert(Kind::Limit, "s3");
        assert!(empty.holds(Kind::Limit, "s3"));
    }

    #[test]
    fn the_keep_list_drops_ids_that_are_not_plain() {
        let keep = Keep::new(&ids(&["s1", "x\"y", ""]), &ids(&["s2", "../etc"]));
        assert!(keep.holds(Kind::Waiting, "s1"));
        assert!(!keep.holds(Kind::Waiting, "x\"y"));
        assert!(!keep.holds(Kind::Waiting, "s2"));
        assert!(keep.holds(Kind::Return, "s2"));
        assert!(!keep.holds(Kind::Return, "s1"));
    }

    #[test]
    fn a_notice_shown_after_the_list_was_sent_is_kept_until_the_next_list() {
        // macOS は届いた通知の一覧を後から答えるので、その間に出した通知を古い一覧で消さない。
        let mut keep = Keep::new(&[], &[]);
        keep.insert(Kind::Waiting, "s1");
        assert!(keep.holds(Kind::Waiting, "s1"));
        assert!(!keep.holds(Kind::Return, "s1"));
    }

    /// Windows の通知センターの履歴（タグと組の対）から、外すトーストを選ぶ。
    #[test]
    fn the_toasts_of_sessions_that_no_longer_wait_are_removed() {
        let history: Vec<(String, String)> = [
            ("s1", "hangar-waiting"),
            ("s2", "hangar-waiting"),
            ("s1", "hangar-return"),
            ("s3", "hangar-return"),
            ("x", "something-else"),
        ]
        .iter()
        .map(|(t, g)| (t.to_string(), g.to_string()))
        .collect();
        let keep = Keep::new(&ids(&["s1"]), &ids(&["s3"]));
        let stale = stale_toasts(&history, &keep);
        let want: Vec<(String, String)> = [
            ("s2", "hangar-waiting"),
            ("s1", "hangar-return"),
            ("x", "something-else"),
        ]
        .iter()
        .map(|(t, g)| (t.to_string(), g.to_string()))
        .collect();
        assert_eq!(stale, want);
        // 何も待っていなければ（起動したときに古いトーストだけが残っていたら）、全部外す。
        assert_eq!(stale_toasts(&history, &Keep::new(&[], &[])), history);
    }

    /// macOS の通知センターに届いている通知の識別子から、外すものを選ぶ。
    /// hangar の識別子でないものには触らない。
    #[test]
    fn the_delivered_notifications_of_sessions_that_no_longer_wait_are_removed() {
        let delivered = ids(&[
            "hangar-waiting:s1",
            "hangar-waiting:s2",
            "hangar-return:s1",
            "hangar-return:s3",
            "something-else",
        ]);
        let keep = Keep::new(&ids(&["s1"]), &ids(&["s3"]));
        assert_eq!(
            stale_identifiers(&delivered, &keep),
            ids(&["hangar-waiting:s2", "hangar-return:s1"])
        );
        assert_eq!(
            stale_identifiers(&delivered, &Keep::new(&[], &[])),
            ids(&[
                "hangar-waiting:s1",
                "hangar-waiting:s2",
                "hangar-return:s1",
                "hangar-return:s3"
            ])
        );
    }

    #[test]
    fn the_open_script_calls_the_page_hook_or_falls_back_to_the_hash() {
        let js = open_js("s1");
        assert!(js.contains("var id=\"s1\""));
        assert!(js.contains("window.__hangarOpenWaiting(id)"));
        assert!(js.contains("location.hash=\"#/session/\"+id"));
    }

    /// 外す前に出したトーストは、外す時点の一覧になくても残す（外すのは別の糸で、出すのより後になることがある）。
    #[test]
    fn toasts_shown_before_the_removal_runs_are_kept() {
        let mut keep = Keep::new(&ids(&["s1"]), &[]);
        keep.extend_shown(["hangar-waiting:s2", "hangar-return:s3", "something-else"]);
        assert!(keep.holds(Kind::Waiting, "s1"));
        assert!(keep.holds(Kind::Waiting, "s2"));
        assert!(keep.holds(Kind::Return, "s3"));
        assert!(!keep.holds(Kind::Return, "s2"));
    }

    /// 失敗の 1 行は、コードと、コードから OS が引いた文だけで書く。
    /// 糸に残った前の失敗の説明は使わない（コードと合わない文や、化けた文が出た）。
    #[test]
    fn a_failure_line_names_the_code_in_hex_with_its_own_message() {
        let msg = "the call cannot be made now";
        assert_eq!(
            hresult_line(0x8001_010Du32 as i32, msg),
            "the call cannot be made now (0x8001010D)"
        );
        assert_eq!(hresult_line(0x8001_010Du32 as i32, "  \r\n"), "0x8001010D");
        assert_eq!(hresult_line(5, "x\r\n"), "x (0x00000005)");
    }
}
