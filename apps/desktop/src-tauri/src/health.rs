//! サーバの `/health` を待つ。
//! 依存を増やさず、生の HTTP を TcpStream で書く。
//!
//! 宛先は信用できない。
//! 4177 に別のプログラムがいるかもしれず、その相手が何を返すかは分からない。
//! そのため、あふれない算術、応答全体の締め切り、本文の上限の 3 つを必ず守る。

use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

/// 応答全体（ヘッダと本文）に許す最大の大きさ。
/// 実物の `/health` は 100 バイトに満たないので、これで十分に余裕がある。
const MAX_RESPONSE: usize = 64 * 1024;

/// 1 回の probe に許す時間。
/// 接続から応答を読み終えるまでの全体に効く。
const PROBE_TIMEOUT: Duration = Duration::from_secs(1);

/// `wait_until` の試行回数の上限。
/// 進まない時計を渡されても必ず終わるための歯止めである。
const MAX_TRIES: u32 = 10_000;

/// 殻が名乗る互換の版。同梱するサーバと同じ版である。
/// 正本は `packages/shared/src/compat.ts` の `COMPAT_VERSION` で、ここはその写しである。
/// 片方だけ変えると `apps/desktop/test/config.test.ts` の「殻が名乗る互換の版」が落ちる。
/// 殻は 4177 で動いている既存のサーバを、この版と同じ版を名乗るときだけ採る（`judge_existing`）。
pub const COMPAT_VERSION: u64 = 1;

/// chunked 転送のボディを連結する。
/// 境界はバイト単位で扱う。
/// 終端の `0` の塊まで正しく読めたときだけ `Some` を返す。
/// サイズ欄があふれる、上限を超える、途中で切れている場合は `None` にする。
pub fn decode_chunked(body: &[u8]) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    let mut rest = body;
    loop {
        let nl = rest.windows(2).position(|w| w == b"\r\n")?;
        let line = String::from_utf8_lossy(&rest[..nl]);
        let size_text = line.split(';').next().unwrap_or("").trim().to_string();
        if size_text.is_empty() || !size_text.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        // 16 進が u64 に収まらない場合も、収まっても大きすぎる場合も弾く。
        // これで `start + size` はあふれない。
        let size = u64::from_str_radix(&size_text, 16).ok()?;
        if size > MAX_RESPONSE as u64 {
            return None;
        }
        let size = size as usize;
        let start = nl + 2;
        if size == 0 {
            // 終端の塊に達した。
            return Some(out);
        }
        let end = start.checked_add(size)?;
        if rest.len() < end {
            return None;
        }
        out.extend_from_slice(&rest[start..end]);
        if out.len() > MAX_RESPONSE {
            return None;
        }
        rest = &rest[end..];
        if !rest.starts_with(b"\r\n") {
            return None;
        }
        rest = &rest[2..];
    }
}

/// `timeout` までの残り時間。
/// 使い切っていれば None。
fn left(start: Instant, timeout: Duration) -> Option<Duration> {
    let rest = timeout.checked_sub(start.elapsed())?;
    if rest.is_zero() {
        None
    } else {
        Some(rest)
    }
}

/// 1 回の GET。
/// 状態コードとボディを返す。
/// 接続できない、期限切れ、形が壊れている、大きすぎれば None。
///
/// `timeout` は 1 回の read の上限ではなく、接続から応答を読み終えるまでの全体の締め切りである。
/// 少しずつ永遠に垂れ流す相手に対しても、この時間で諦める。
/// `Connection: close` を送るので、相手が閉じるまでを応答として読む。
pub fn http_get(addr: SocketAddr, path: &str, timeout: Duration) -> Option<(u16, String)> {
    let start = Instant::now();
    let mut s = TcpStream::connect_timeout(&addr, left(start, timeout)?).ok()?;

    let request = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    s.set_write_timeout(Some(left(start, timeout)?)).ok()?;
    // 1 回の write_all で送る。
    // 断片に分けると、要求を 1 回だけ read して閉じる相手から RST を受けうる。
    s.write_all(request.as_bytes()).ok()?;
    s.flush().ok()?;

    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        // 読むたびに残り時間を計り直す。
        // これが全体の締め切りである。
        s.set_read_timeout(Some(left(start, timeout)?)).ok()?;
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() + n > MAX_RESPONSE {
                    // 常識外れに大きい応答は健康と見なさず、読むのをやめる。
                    return None;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return None,
        }
    }

    let sep = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&buf[..sep]).to_string();
    let status: u16 = head
        .lines()
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()?;
    let chunked = head.lines().any(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("transfer-encoding:") && l.contains("chunked")
    });
    let body = &buf[sep + 4..];
    let body = if chunked {
        decode_chunked(body)?
    } else {
        body.to_vec()
    };
    Some((status, String::from_utf8_lossy(&body).to_string()))
}

/// hangar の `/health` の応答か。
/// 200 であること、ボディが真偽値の `ok` を真で持つ JSON であること、
/// さらに `version` を文字列で持つことを求める。
/// 実物は `{"ok":true,"version":"0.3.0"}` を返すのでこれを満たす。
/// `{"ok":true}` を返すだけの別のプログラムはここで弾く。
pub fn is_healthy(status: u16, body: &str) -> bool {
    if status != 200 {
        return false;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
    let versioned = v.get("version").map(|x| x.is_string()).unwrap_or(false);
    ok && versioned
}

/// 宛先を 1 回だけ叩いて健康かを返す。
/// 全体の締め切りを差し替えられる形。
pub fn probe_health_with_timeout(addr: SocketAddr, timeout: Duration) -> bool {
    http_get(addr, "/health", timeout)
        .map(|(s, b)| is_healthy(s, &b))
        .unwrap_or(false)
}

/// 宛先を 1 回だけ叩いて健康かを返す。
pub fn probe_health(addr: SocketAddr) -> bool {
    probe_health_with_timeout(addr, PROBE_TIMEOUT)
}

/// 4177 で応えた相手をどう扱うか。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Existing {
    /// hangar のサーバは居ない。誰も応えないか、hangar の応答ではない。
    Absent,
    /// 互換の版の合う hangar のサーバが居る。子を起こさずに採る。
    Adopt,
    /// 互換の版の合わない hangar のサーバが居る。採らない。
    /// `theirs` はその版で、`compat` を載せない古いサーバは 0 である。
    Mismatch { theirs: u64 },
}

/// `/health` の応答から、既存のサーバを採るかを決める。
/// hangar の応答（`is_healthy`）でなければ、版を問わずに「居ない」とする。
/// `compat` が無いか、0 以上の整数として読めない応答は、版 0 として読む（`packages/shared/src/compat.ts` の `parseCompat` と同じ）。
/// 比べ方は一致である。版の違うサーバの UI を出すと、殻とサーバの合図（起動の進み具合、殻の命令）が食い違っても気付けない。
pub fn judge_existing(status: u16, body: &str, ours: u64) -> Existing {
    if !is_healthy(status, body) {
        return Existing::Absent;
    }
    let theirs = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("compat").and_then(|x| x.as_u64()))
        .unwrap_or(0);
    if theirs == ours {
        Existing::Adopt
    } else {
        Existing::Mismatch { theirs }
    }
}

/// 宛先を 1 回だけ叩いて、既存のサーバを採るかを決める。応えなければ「居ない」。
pub fn probe_existing(addr: SocketAddr, ours: u64) -> Existing {
    http_get(addr, "/health", PROBE_TIMEOUT)
        .map(|(s, b)| judge_existing(s, &b, ours))
        .unwrap_or(Existing::Absent)
}

/// 索引づけの段階。サーバの `index.phase` を写す。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Scanning,
    Indexing,
    Rebuilding,
}

impl Phase {
    /// 起動画面へ渡す名前。サーバが返した文字列そのものは使わず、決まった名前だけを返す。
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Scanning => "scanning",
            Phase::Indexing => "indexing",
            Phase::Rebuilding => "rebuilding",
        }
    }
}

/// `/health` に載る起動の進み具合。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Boot {
    /// 最初の索引づけと紐づけが済んだか。
    pub ready: bool,
    pub phase: Phase,
    pub done: u64,
    pub total: u64,
}

/// `/health` の応答から起動の進み具合を読む。hangar の応答でなければ None。
/// `ready` を真偽値で持たない応答も None にする。殻が採るのは互換の版の合うサーバだけで、それは必ず `ready` を持つ。
/// 数は信用せず、整数でなければ 0、済んだ数が全体を超えれば全体に丸める。知らない段階は Idle にする。
pub fn boot_state(status: u16, body: &str) -> Option<Boot> {
    if !is_healthy(status, body) {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let ready = v.get("ready").and_then(|x| x.as_bool())?;
    let index = v.get("index");
    let num = |k: &str| {
        index
            .and_then(|i| i.get(k))
            .and_then(|x| x.as_u64())
            .unwrap_or(0)
    };
    let phase = match index.and_then(|i| i.get("phase")).and_then(|x| x.as_str()) {
        Some("scanning") => Phase::Scanning,
        Some("indexing") => Phase::Indexing,
        Some("rebuilding") => Phase::Rebuilding,
        _ => Phase::Idle,
    };
    let total = num("total");
    Some(Boot {
        ready,
        phase,
        done: num("done").min(total),
        total,
    })
}

/// 宛先を 1 回だけ叩いて起動の進み具合を返す。
pub fn probe_boot(addr: SocketAddr) -> Option<Boot> {
    http_get(addr, "/health", PROBE_TIMEOUT).and_then(|(s, b)| boot_state(s, &b))
}

/// `probe` が真を返すまで `interval` ごとに試す。
/// `deadline` を過ぎたら偽。
/// 時計と待ちは差し替えられるので、試験は実時間を使わずに済む。
/// 進まない時計や間隔 0 を渡されても、試行回数の歯止めで必ず終わる。
pub fn wait_until(
    deadline: Duration,
    interval: Duration,
    mut probe: impl FnMut() -> bool,
    mut sleep: impl FnMut(Duration),
    mut elapsed: impl FnMut() -> Duration,
) -> bool {
    let cap = max_tries(deadline, interval);
    let mut tries: u32 = 0;
    loop {
        if probe() {
            return true;
        }
        tries += 1;
        if elapsed() >= deadline || tries >= cap {
            return false;
        }
        sleep(interval);
    }
}

/// 時計が進む場合に必要な回数より必ず多く、しかし有限な上限を決める。
fn max_tries(deadline: Duration, interval: Duration) -> u32 {
    if interval.is_zero() {
        return 1;
    }
    let n = deadline.as_nanos() / interval.as_nanos();
    let n = n.min(u128::from(MAX_TRIES)) as u32;
    n.saturating_add(2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::sync::Arc;

    /// 試験で使う短い締め切り。
    /// 全体の締め切りが効いていれば、意地悪な相手でもこの程度で終わる。
    const T: Duration = Duration::from_millis(300);

    /// 1 接続だけ受けて固定の応答を返す。
    fn serve_once(response: &'static str) -> SocketAddr {
        serve_with(move |mut s| {
            read_request(&mut s);
            let _ = s.write_all(response.as_bytes());
        })
    }

    /// 1 接続だけ受けて、渡した手順で応じる。
    fn serve_with(f: impl FnOnce(TcpStream) + Send + 'static) -> SocketAddr {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((s, _)) = l.accept() {
                f(s);
            }
        });
        addr
    }

    /// 1 接続だけ受けて、渡した JSON を 200 で返す。長さは本文から数える。
    fn serve_json(body: &str) -> SocketAddr {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        serve_with(move |mut s| {
            read_request(&mut s);
            let _ = s.write_all(response.as_bytes());
        })
    }

    /// 要求を `\r\n\r\n` まで読む。
    /// 読めたバイト数を返す。
    fn read_request(s: &mut TcpStream) -> usize {
        let mut got = Vec::new();
        let mut chunk = [0u8; 512];
        let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
        while !got.windows(4).any(|w| w == b"\r\n\r\n") {
            match s.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => got.extend_from_slice(&chunk[..n]),
            }
        }
        got.len()
    }

    /// 番人つきで走らせる。
    /// 固まったら None、panic でも None になる。
    fn guarded<T: Send + 'static>(
        limit: Duration,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Option<T> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        rx.recv_timeout(limit).ok()
    }

    #[test]
    fn http_get_reads_status_and_body() {
        let addr = serve_once("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 29\r\nConnection: close\r\n\r\n{\"ok\":true,\"version\":\"0.3.0\"}");
        let (status, body) = http_get(addr, "/health", Duration::from_secs(2)).unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, "{\"ok\":true,\"version\":\"0.3.0\"}");
    }

    #[test]
    fn http_get_decodes_chunked_bodies() {
        let addr = serve_once(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nb\r\n{\"ok\":true}\r\n0\r\n\r\n",
        );
        let (_, body) = http_get(addr, "/health", Duration::from_secs(2)).unwrap();
        assert_eq!(body, "{\"ok\":true}");
    }

    #[test]
    fn http_get_returns_none_when_nothing_listens() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        assert_eq!(http_get(addr, "/health", Duration::from_millis(500)), None);
    }

    #[test]
    fn is_healthy_requires_200_and_ok_true() {
        assert!(is_healthy(200, "{\"ok\":true,\"version\":\"0.3.0\"}"));
        assert!(!is_healthy(200, "{\"ok\":false}"));
        assert!(!is_healthy(200, "<html>"));
        assert!(!is_healthy(500, "{\"ok\":true,\"version\":\"0.3.0\"}"));
    }

    /// 4177 に別のプログラムがいる場合を弾く。
    /// 200 を返しても hangar の形でなければ健康ではない。
    #[test]
    fn is_healthy_rejects_another_program_on_the_port() {
        assert!(!is_healthy(200, "{\"status\":\"ok\"}"));
        assert!(!is_healthy(200, "OK"));
        assert!(!is_healthy(200, ""));
        assert!(!is_healthy(200, "{\"ok\":\"true\"}"));
    }

    /// `ok` だけでは足りない。
    /// 実物が必ず返す `version` が文字列であることまで求める。
    #[test]
    fn is_healthy_requires_a_version_string() {
        assert!(!is_healthy(200, "{\"ok\":true}"));
        assert!(!is_healthy(200, "{\"ok\":true,\"version\":1}"));
        assert!(!is_healthy(200, "{\"ok\":true,\"version\":null}"));
        assert!(is_healthy(200, "{\"ok\":true,\"version\":\"0.3.0\"}"));
    }

    #[test]
    fn boot_state_reads_ready_and_the_index_progress() {
        let body = r#"{"ok":true,"version":"0.3.0","ready":false,"index":{"phase":"indexing","done":412,"total":987}}"#;
        assert_eq!(
            boot_state(200, body),
            Some(Boot {
                ready: false,
                phase: Phase::Indexing,
                done: 412,
                total: 987
            })
        );
        let done = r#"{"ok":true,"version":"0.3.0","ready":true,"index":{"phase":"idle","done":987,"total":987}}"#;
        assert_eq!(boot_state(200, done).map(|b| b.ready), Some(true));
        for (name, phase) in [
            ("scanning", Phase::Scanning),
            ("rebuilding", Phase::Rebuilding),
        ] {
            let b = format!(
                r#"{{"ok":true,"version":"v","ready":false,"index":{{"phase":"{name}","done":0,"total":0}}}}"#
            );
            assert_eq!(boot_state(200, &b).map(|b| b.phase), Some(phase));
        }
    }

    /// `ready` を真偽値で持たない応答（進み具合を載せる前の古いサーバなど）は読まない。
    /// 殻は互換の版の合うサーバだけを採り、それは必ず `ready` を持つ。
    #[test]
    fn boot_state_does_not_read_a_response_without_ready() {
        assert_eq!(boot_state(200, r#"{"ok":true,"version":"0.2.0"}"#), None);
        assert_eq!(
            boot_state(200, r#"{"ok":true,"version":"0.2.0","ready":"no"}"#),
            None
        );
        assert_eq!(
            boot_state(200, r#"{"ok":true,"version":"0.2.0","ready":null}"#),
            None
        );
    }

    /// 宛先は信用できない。hangar でなければ読まず、変な数や段階は丸める。
    #[test]
    fn boot_state_does_not_trust_the_numbers_or_the_phase() {
        assert_eq!(boot_state(200, r#"{"status":"ok"}"#), None);
        assert_eq!(
            boot_state(500, r#"{"ok":true,"version":"v","ready":false}"#),
            None
        );
        let odd = r#"{"ok":true,"version":"v","ready":false,"index":{"phase":"<script>","done":-3,"total":2.5}}"#;
        assert_eq!(
            boot_state(200, odd),
            Some(Boot {
                ready: false,
                phase: Phase::Idle,
                done: 0,
                total: 0
            })
        );
        let over = r#"{"ok":true,"version":"v","ready":false,"index":{"phase":"indexing","done":50,"total":10}}"#;
        assert_eq!(
            boot_state(200, over).map(|b| (b.done, b.total)),
            Some((10, 10))
        );
    }

    /// `{"ok":true}` だけを返す別のプログラムを、ソケット越しにも弾く。
    #[test]
    fn probe_health_rejects_a_bare_ok_body() {
        let addr = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
        );
        assert_eq!(
            guarded(Duration::from_secs(5), move || {
                probe_health_with_timeout(addr, T)
            }),
            Some(false)
        );
    }

    #[test]
    fn probe_health_is_true_only_for_a_hangar_response() {
        let addr = serve_once("HTTP/1.1 200 OK\r\nContent-Length: 29\r\nConnection: close\r\n\r\n{\"ok\":true,\"version\":\"0.3.0\"}");
        assert!(probe_health(addr));

        let addr = serve_once(
            "HTTP/1.1 200 OK\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"status\":\"ok\"}",
        );
        assert!(!probe_health(addr));
    }

    #[test]
    fn wait_until_retries_then_succeeds_or_gives_up() {
        let calls = Cell::new(0);
        let clock = Cell::new(Duration::ZERO);
        let ok = wait_until(
            Duration::from_secs(20),
            Duration::from_millis(250),
            || {
                calls.set(calls.get() + 1);
                calls.get() == 3
            },
            |d| clock.set(clock.get() + d),
            || clock.get(),
        );
        assert!(ok);
        assert_eq!(calls.get(), 3);
        assert_eq!(clock.get(), Duration::from_millis(500));

        let tries = Cell::new(0);
        let clock = Cell::new(Duration::ZERO);
        let ok = wait_until(
            Duration::from_secs(1),
            Duration::from_millis(250),
            || {
                tries.set(tries.get() + 1);
                false
            },
            |d| clock.set(clock.get() + d),
            || clock.get(),
        );
        assert!(!ok);
        assert_eq!(tries.get(), 5);
    }

    /// 進まない時計や間隔 0 に対しても止まる。
    #[test]
    fn wait_until_stops_even_when_the_clock_does_not_move() {
        let tries = Cell::new(0);
        let ok = wait_until(
            Duration::from_secs(1),
            Duration::from_millis(250),
            || {
                tries.set(tries.get() + 1);
                false
            },
            |_| {},
            || Duration::ZERO,
        );
        assert!(!ok);
        assert!(
            tries.get() >= 5 && tries.get() <= 20,
            "試行回数: {}",
            tries.get()
        );

        let tries = Cell::new(0);
        let ok = wait_until(
            Duration::from_secs(1),
            Duration::ZERO,
            || {
                tries.set(tries.get() + 1);
                false
            },
            |_| {},
            || Duration::ZERO,
        );
        assert!(!ok);
        assert_eq!(tries.get(), 1);
    }

    #[test]
    fn decode_chunked_joins_pieces() {
        assert_eq!(
            decode_chunked(b"3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"),
            Some(b"abcde".to_vec())
        );
        assert_eq!(decode_chunked(b"garbage"), None);
    }

    /// サイズ欄が `ffffffffffffffff` でもあふれない。
    /// 常識外れの大きさは弾く。
    #[test]
    fn decode_chunked_survives_an_absurd_size_field() {
        assert_eq!(
            decode_chunked(b"ffffffffffffffff\r\nabc\r\n0\r\n\r\n"),
            None
        );
        assert_eq!(
            decode_chunked(b"7fffffffffffffff\r\nabc\r\n0\r\n\r\n"),
            None
        );
        assert_eq!(
            decode_chunked(b"fffffffffffffffff\r\nabc\r\n0\r\n\r\n"),
            None
        );
        assert_eq!(decode_chunked(b"100000\r\nabc\r\n0\r\n\r\n"), None);
    }

    /// 終端の塊が来ないまま切れた chunked は健康と見なさない。
    #[test]
    fn decode_chunked_requires_the_final_chunk() {
        assert_eq!(decode_chunked(b"b\r\n{\"ok\":true}\r\n5\r\nab"), None);
        assert_eq!(decode_chunked(b"b\r\n{\"ok\":true}\r\n"), None);
        assert_eq!(
            decode_chunked(b"b\r\n{\"ok\":true}\r\n0\r\n\r\n"),
            Some(b"{\"ok\":true}".to_vec())
        );
    }

    /// サイズ欄が `ffffffffffffffff` の相手を、ソケット越しに確かめる。
    /// 落ちずに偽を返す。
    #[test]
    fn probe_health_survives_an_absurd_chunk_size_over_a_socket() {
        let addr = serve_once("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nffffffffffffffff\r\nabc\r\n0\r\n\r\n");
        assert_eq!(
            guarded(Duration::from_secs(5), move || {
                probe_health_with_timeout(addr, T)
            }),
            Some(false)
        );
    }

    /// chunked を始めて終端を送らずに切る相手。
    #[test]
    fn probe_health_rejects_a_truncated_chunked_body() {
        let addr = serve_once("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n1d\r\n{\"ok\":true,\"version\":\"0.3.0\"}\r\n5\r\nab");
        assert_eq!(
            guarded(Duration::from_secs(5), move || {
                probe_health_with_timeout(addr, T)
            }),
            Some(false)
        );
    }

    /// 少しずつ永遠に垂れ流す相手に対して、全体の締め切りで諦める。
    #[test]
    fn http_get_gives_up_on_a_slow_trickle() {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let addr = serve_with(move |mut s| {
            read_request(&mut s);
            if s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n")
                .is_err()
            {
                return;
            }
            while !flag.load(Ordering::Relaxed) {
                if s.write_all(b"x").is_err() {
                    return;
                }
                let _ = s.flush();
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        let t0 = Instant::now();
        let got = guarded(Duration::from_secs(10), move || {
            http_get(addr, "/health", T)
        });
        let took = t0.elapsed();
        stop.store(true, Ordering::Relaxed);
        assert_eq!(got, Some(None), "全体の締め切りを過ぎても戻らなかった");
        assert!(
            took < Duration::from_secs(3),
            "締め切りを大きく超えた: {took:?}"
        );
    }

    /// 何も返さずに黙る相手にも、全体の締め切りで諦める。
    #[test]
    fn http_get_gives_up_on_a_silent_server() {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let addr = serve_with(move |s| {
            while !flag.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(20));
            }
            drop(s);
        });
        let t0 = Instant::now();
        let got = guarded(Duration::from_secs(10), move || {
            http_get(addr, "/health", T)
        });
        let took = t0.elapsed();
        stop.store(true, Ordering::Relaxed);
        assert_eq!(got, Some(None));
        assert!(
            took < Duration::from_secs(3),
            "締め切りを大きく超えた: {took:?}"
        );
    }

    /// 数百 MB を送りつける相手は、本文の上限で打ち切る。
    #[test]
    fn http_get_stops_reading_a_huge_body() {
        let addr = serve_with(|mut s| {
            read_request(&mut s);
            if s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 268435456\r\n\r\n")
                .is_err()
            {
                return;
            }
            let block = vec![b'x'; 64 * 1024];
            // 256MB 送ろうとする。
            // 読み手が打ち切れば write が失敗して終わる。
            for _ in 0..4096 {
                if s.write_all(&block).is_err() {
                    return;
                }
            }
        });
        let got = guarded(Duration::from_secs(10), move || {
            http_get(addr, "/health", Duration::from_secs(5))
        });
        assert_eq!(got, Some(None));
    }

    /// 要求を 1 回だけ read して即座に応答し、閉じる相手。
    /// 要求を 1 回の write_all で送っていれば、最初の read で全部が読める。
    #[test]
    fn http_get_works_with_a_server_that_reads_once_and_closes() {
        for _ in 0..20 {
            let (tx, rx) = mpsc::channel();
            let addr = serve_with(move |mut s| {
                let mut buf = [0u8; 1024];
                let n = s.read(&mut buf).unwrap_or(0);
                let _ = tx.send(n);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 29\r\nConnection: close\r\n\r\n{\"ok\":true,\"version\":\"0.3.0\"}");
            });
            assert!(probe_health_with_timeout(addr, Duration::from_secs(2)));
            let n = rx.recv_timeout(Duration::from_secs(2)).unwrap_or(0);
            assert!(n > 4, "最初の read が要求の一部しか読めていない: {n}");
        }
    }
    /// 版の合うサーバだけを採る。合わなければ、相手の版を添えて採らない。
    #[test]
    fn judge_existing_adopts_only_a_server_of_the_same_compat() {
        let body =
            |c: &str| format!(r#"{{"ok":true,"version":"0.4.0","compat":{c},"ready":true}}"#);
        assert_eq!(judge_existing(200, &body("1"), 1), Existing::Adopt);
        assert_eq!(
            judge_existing(200, &body("2"), 1),
            Existing::Mismatch { theirs: 2 }
        );
        assert_eq!(
            judge_existing(200, &body("1"), 2),
            Existing::Mismatch { theirs: 1 }
        );
    }

    /// `compat` を載せない古いサーバと、0 以上の整数として読めない値は、版 0 として読む。
    /// 端末の `parseCompat`（packages/shared/src/compat.ts）と同じ読み方である。
    #[test]
    fn judge_existing_reads_a_missing_or_broken_compat_as_zero() {
        assert_eq!(
            judge_existing(200, r#"{"ok":true,"version":"0.3.0","ready":true}"#, 1),
            Existing::Mismatch { theirs: 0 }
        );
        for c in ["-1", "1.5", "\"1\"", "null", "1e3", "{}"] {
            let b = format!(r#"{{"ok":true,"version":"v","compat":{c}}}"#);
            assert_eq!(
                judge_existing(200, &b, 1),
                Existing::Mismatch { theirs: 0 },
                "{c}"
            );
        }
    }

    /// hangar でない相手は、版を問う前に「居ない」とする。殻は採らずに、同梱のサーバを起こしにいく。
    #[test]
    fn judge_existing_treats_another_program_as_absent() {
        assert_eq!(
            judge_existing(200, r#"{"status":"ok"}"#, 1),
            Existing::Absent
        );
        assert_eq!(
            judge_existing(200, r#"{"ok":true,"compat":1}"#, 1),
            Existing::Absent
        );
        assert_eq!(
            judge_existing(500, r#"{"ok":true,"version":"v","compat":1}"#, 1),
            Existing::Absent
        );
        assert_eq!(judge_existing(200, "<html>", 1), Existing::Absent);
    }

    /// ソケット越しにも同じに決める。誰も待ち受けていなければ「居ない」。
    #[test]
    fn probe_existing_decides_over_a_socket() {
        let same = serve_json(r#"{"ok":true,"version":"0.4.0","compat":1,"ready":true}"#);
        assert_eq!(probe_existing(same, 1), Existing::Adopt);
        let older = serve_json(r#"{"ok":true,"version":"0.3.0"}"#);
        assert_eq!(probe_existing(older, 1), Existing::Mismatch { theirs: 0 });
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let nobody = l.local_addr().unwrap();
        drop(l);
        assert_eq!(probe_existing(nobody, 1), Existing::Absent);
    }
}
