//! 入力待ちと戻る時刻の OS の通知（macOS は UNUserNotificationCenter、Windows はトースト）。
//! UI（サーバの頁）が窓の背面で入力待ちを見つけたら `notify_waiting` を呼び、殻が通知を出す。
//! 通知を押されたら、窓を前に出し、頁の `__hangarOpenWaiting` でそのセッションを開く。
//! 押された通知からセッションを読み戻す入口（`session_of` と `install` に渡す受け口）は、どちらの OS でも同じである。
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

/// 窓が利用者の目の前にあるか。
/// 見えていて、最小化しておらず、フォーカスがあるときだけ前にあるとみなし、入力待ちの通知を出さない（右下のカードで足りる）。
/// 頁の `document.visibilityState` と `hasFocus()` には頼らない。
/// WebView は最小化や背面で絞られ、その間の頁の答えは当てにならないためである。
pub fn window_in_front(visible: bool, minimized: bool, focused: bool) -> bool {
    visible && !minimized && focused
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

/// Windows のトーストの中身と、押されたトーストを殻へ戻すための登録の値。
/// OS を呼ばない純関数だけを置き、どの OS の試験でも同じ答えになるようにする。
/// 使うのは Windows の `win` だけなので、ほかの OS では使われない警告を黙らせる。
mod toast {
    #![cfg_attr(not(windows), allow(dead_code))]

    use super::{identifier, Waiting};
    use std::time::{Duration, Instant};

    /// トーストを出す相手のアプリの名前（AppUserModelID）。
    /// Tauri の NSIS のインストーラは、スタートメニューの近道にこの値（tauri.conf.json の identifier）を付ける。
    pub const APP_ID: &str = "dev.agent-hangar.hangar";
    /// トーストの頭に出るアプリの名前（tauri.conf.json の productName）。
    pub const DISPLAY_NAME: &str = "Hangar";
    /// hangar のトーストをまとめる組の名前。
    pub const TOAST_GROUP: &str = "hangar-waiting";
    /// アプリが閉じている間に押されたトーストを受け取る COM の口の CLSID。
    /// 値は一度だけ作って固定した。
    /// 変えると、前の版が出したトーストを押しても、この版へ届かなくなる。
    pub const ACTIVATOR_CLSID: u128 = 0x1ce6ab2a_d79d_49f4_88b0_5a9e624a75e4;
    /// 1 回の押下を Windows が 2 つの道（COM の口と、トーストの Activated）で知らせても、1 回だけ開くための間合い。
    const OPEN_AGAIN_AFTER: Duration = Duration::from_secs(2);

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
            xml_escape(&identifier(&w.session_id)),
            xml_escape(&w.title),
            xml_escape(&w.body)
        )
    }

    /// トーストのタグ。
    /// 同じセッションのトーストは同じタグになり、新しい方が古い方と置き換わる（macOS の識別子と同じ扱い）。
    /// Windows のタグは 64 文字までで、セッションの id は `ID_MAX`（64 文字）までなので、id をそのまま使う。
    pub fn toast_tag(session_id: &str) -> String {
        session_id.to_string()
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
pub use mac::{install, request, show, status};

#[cfg(windows)]
pub use win::{install, request, show, status};

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
        activator_clsid, app_id_key, first_open, installed_exe, server_command, server_key,
        setting_status, toast_tag, toast_xml, ACTIVATOR_CLSID, APP_ID, DISPLAY_NAME, TOAST_GROUP,
    };
    use super::{session_of, Waiting};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::{LazyLock, Mutex, OnceLock};
    use std::time::Instant;
    use windows::core::{
        implement, IInspectable, IUnknown, Interface, Ref, Result, BOOL, GUID, HSTRING, PCWSTR,
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
    /// Activated の受け口が生きているよう、セッションごとに最後の 1 つを持っておく。
    static TOASTS: LazyLock<Mutex<HashMap<String, ToastNotification>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
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
                crate::log(&format!("toast activator not registered: {e}"));
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
        toast.SetGroup(&HSTRING::from(TOAST_GROUP))?;
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
            toasts.insert(w.session_id.clone(), toast);
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
            Err(e) => crate::log(&format!("toast not shown: {e}")),
        }
    }
}

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
        UNNotificationResponse, UNNotificationSettings, UNNotificationSound,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::ptr::NonNull;
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
    use super::toast::*;
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
        let w = waiting("s1", name, question).unwrap();
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
        let w = waiting("s1", "a<b>&\"c'", "</text><text>x").unwrap();
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
        let w = waiting("s_1-A", "t", "b").unwrap();
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
        assert!(waiting(&longest, "t", "b").is_ok());
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
    fn the_open_script_calls_the_page_hook_or_falls_back_to_the_hash() {
        let js = open_js("s1");
        assert!(js.contains("var id=\"s1\""));
        assert!(js.contains("window.__hangarOpenWaiting(id)"));
        assert!(js.contains("location.hash=\"#/session/\"+id"));
    }
}
