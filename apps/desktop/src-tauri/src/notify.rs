//! 入力待ちの macOS の通知。
//! UI（サーバの頁）が窓の背面で入力待ちを見つけたら `notify_waiting` を呼び、殻が通知を出す。
//! 通知を押されたら、窓を前に出し、頁の `__hangarOpenWaiting` でそのセッションを開く。
//! 頁の値はここで確かめてから OS に渡す。
//! 頁は remote の頁なので、中身をそのまま信じない。

/// 通知の識別子の頭。
/// 押されたときに、どのセッションの通知かをここから読み戻す。
const ID_PREFIX: &str = "hangar-waiting:";
/// 題と本文の長さの上限（文字数）。
/// 通知は 2 行ほどしか見せないので、長い問いは切る。
const TITLE_MAX: usize = 120;
const BODY_MAX: usize = 240;
/// セッションの id の長さの上限。
/// hangar の id は UUID（36 文字）である。
const ID_MAX: usize = 64;

/// 確かめ終えた通知の中身。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Waiting {
    pub session_id: String,
    pub title: String,
    pub body: String,
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

/// 頁から届いた値を、通知に出せる形に整える。
/// id が変なら断る。
/// 題が空なら名前の無いセッションとして、本文が空なら問いの取れなかった入力待ちとして出す（UI の言い方に合わせる）。
pub fn waiting(session_id: &str, title: &str, body: &str) -> Result<Waiting, String> {
    if !valid_id(session_id) {
        return Err("invalid session id".to_string());
    }
    Ok(Waiting {
        session_id: session_id.to_string(),
        title: tidy(title, TITLE_MAX, "（名前なし）"),
        body: tidy(body, BODY_MAX, "入力を待っています"),
    })
}

/// 通知の識別子。
/// 同じセッションの通知は同じ識別子になり、新しい方が古い方と置き換わる。
pub fn identifier(session_id: &str) -> String {
    format!("{ID_PREFIX}{session_id}")
}

/// 押された通知の識別子から、セッションの id を読み戻す。
/// hangar の通知でなければ `None`。
pub fn session_of(identifier: &str) -> Option<&str> {
    identifier.strip_prefix(ID_PREFIX).filter(|id| valid_id(id))
}

/// 押された通知のセッションを頁で開く JavaScript。
/// 頁が受け口を持っていれば、それでセッションを開いてターミナルにフォーカスする。
/// 受け口が無ければ（読み込みの途中など）、ハッシュでそのセッションへ移るだけにする。
pub fn open_js(session_id: &str) -> String {
    let lit = serde_json::to_string(session_id).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(function(){{var id={lit};\
         if(window.__hangarOpenWaiting){{window.__hangarOpenWaiting(id);}}\
         else{{location.hash=\"#/session/\"+id;}}}})();"
    )
}

#[cfg(target_os = "macos")]
pub use mac::{install, request, show};

/// macOS の外では通知を出さない。
/// 殻は macOS 向けにしか作らないが、型を揃えておく。
#[cfg(not(target_os = "macos"))]
pub fn install(_on_open: impl Fn(String) + Send + Sync + 'static) {}
#[cfg(not(target_os = "macos"))]
pub fn request(done: impl FnOnce(bool) + Send + 'static) {
    done(false);
}
#[cfg(not(target_os = "macos"))]
pub fn show(_w: &Waiting) {}

/// UNUserNotificationCenter で通知を出し、押されたものを受け取る。
/// tauri-plugin-notification はデスクトップでは押された通知を知らせてくれないので、ここで直に呼ぶ。
#[cfg(target_os = "macos")]
mod mac {
    use super::{identifier, session_of, Waiting};
    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread};
    use objc2_foundation::{NSBundle, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest,
        UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };
    use std::sync::{Mutex, OnceLock};

    type OnOpen = Box<dyn Fn(String) + Send + Sync>;
    /// 押された通知のセッションを渡す先。
    /// install で一度だけ決まる。
    static ON_OPEN: OnceLock<OnOpen> = OnceLock::new();

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
        let block = RcBlock::new(move |granted: Bool, _err: *mut NSError| {
            if let Some(f) = done.lock().unwrap().take() {
                f(granted.as_bool());
            }
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                &block,
            );
    }

    /// 通知を出す。
    /// まだ許可を尋ねていなければ先に尋ね、許されたときだけ出す（許されていなければ OS が黙って捨てる）。
    pub fn show(w: &Waiting) {
        if !bundled() {
            return;
        }
        let w = w.clone();
        let deliver = move |granted: bool| {
            if !granted {
                return;
            }
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&w.title));
            content.setBody(&NSString::from_str(&w.body));
            content.setSound(Some(&UNNotificationSound::defaultSound()));
            let req = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSString::from_str(&identifier(&w.session_id)),
                &content,
                None,
            );
            UNUserNotificationCenter::currentNotificationCenter()
                .addNotificationRequest_withCompletionHandler(&req, None);
        };
        request(deliver);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_waiting_notification_keeps_the_name_and_question() {
        let w = waiting(
            "0192f0a1-7c3e-7b2d-9f00-aa11bb22cc33",
            "請求書の書き出し",
            "向きはどちらにしますか",
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
            assert!(waiting(bad, "t", "b").is_err(), "{bad:?}");
        }
        assert!(waiting("s_1-A", "t", "b").is_ok());
    }

    #[test]
    fn empty_texts_fall_back_to_the_words_the_ui_uses() {
        let w = waiting("s1", "  ", "").unwrap();
        assert_eq!(w.title, "（名前なし）");
        assert_eq!(w.body, "入力を待っています");
    }

    #[test]
    fn long_texts_are_cut_by_characters_with_an_ellipsis() {
        let long = "あ".repeat(300);
        let w = waiting("s1", &long, &long).unwrap();
        assert_eq!(w.title.chars().count(), TITLE_MAX);
        assert!(w.title.ends_with('…'));
        assert_eq!(w.body.chars().count(), BODY_MAX);
        assert!(w.body.ends_with('…'));
    }

    #[test]
    fn the_identifier_round_trips_to_the_session() {
        assert_eq!(session_of(&identifier("s1")), Some("s1"));
        assert_eq!(session_of("other:s1"), None);
        assert_eq!(session_of("hangar-waiting:x\"y"), None);
    }

    #[test]
    fn the_open_script_calls_the_page_hook_or_falls_back_to_the_hash() {
        let js = open_js("s1");
        assert!(js.contains("var id=\"s1\""));
        assert!(js.contains("window.__hangarOpenWaiting(id)"));
        assert!(js.contains("location.hash=\"#/session/\"+id"));
    }
}
