//! サーバの `/health` を待つ。
//! 依存を増やさず、生の HTTP を TcpStream で書く。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

/// chunked 転送のボディを連結する。
/// 境界はバイト単位で扱う。
pub fn decode_chunked(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut rest = body;
    loop {
        let Some(nl) = rest.windows(2).position(|w| w == b"\r\n") else {
            break;
        };
        let size_text = String::from_utf8_lossy(&rest[..nl]);
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .unwrap_or(0);
        if size == 0 {
            break;
        }
        let start = nl + 2;
        if rest.len() < start + size {
            break;
        }
        out.extend_from_slice(&rest[start..start + size]);
        rest = &rest[start + size..];
        if rest.starts_with(b"\r\n") {
            rest = &rest[2..];
        }
    }
    out
}

/// 1 回の GET。
/// 状態コードとボディを返す。
/// 接続できない、期限切れ、形が壊れていれば None。
/// `Connection: close` を送るので応答全体を read_to_end で読める。
pub fn http_get(addr: SocketAddr, path: &str, timeout: Duration) -> Option<(u16, String)> {
    let mut s = TcpStream::connect_timeout(&addr, timeout).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).ok()?;
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
        decode_chunked(body)
    } else {
        body.to_vec()
    };
    Some((status, String::from_utf8_lossy(&body).to_string()))
}

/// hangar の `/health` の応答か。
/// 200 であることと、ボディが真偽値の `ok` を真で持つ JSON であることを求める。
/// 4177 に別のプログラムがいて 200 を返しても、この形でなければ弾く。
pub fn is_healthy(status: u16, body: &str) -> bool {
    status == 200
        && serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("ok")?.as_bool())
            .unwrap_or(false)
}

/// 宛先を 1 回だけ叩いて健康かを返す。
pub fn probe_health(addr: SocketAddr) -> bool {
    http_get(addr, "/health", Duration::from_secs(1))
        .map(|(s, b)| is_healthy(s, &b))
        .unwrap_or(false)
}

/// `probe` が真を返すまで `interval` ごとに試す。
/// `deadline` を過ぎたら偽。
/// 時計と待ちは差し替えられるので、試験は実時間を使わずに済む。
pub fn wait_until(
    deadline: Duration,
    interval: Duration,
    mut probe: impl FnMut() -> bool,
    mut sleep: impl FnMut(Duration),
    mut elapsed: impl FnMut() -> Duration,
) -> bool {
    loop {
        if probe() {
            return true;
        }
        if elapsed() >= deadline {
            return false;
        }
        sleep(interval);
    }
}

/// `wait_until` を 250 ミリ秒間隔と実時計で包む。
pub fn wait_for_health(addr: SocketAddr, deadline: Duration) -> bool {
    let t0 = Instant::now();
    wait_until(
        deadline,
        Duration::from_millis(250),
        || probe_health(addr),
        std::thread::sleep,
        || t0.elapsed(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::net::TcpListener;

    /// 1 接続だけ受けて固定の応答を返す。
    fn serve_once(response: &'static str) -> SocketAddr {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf);
            s.write_all(response.as_bytes()).unwrap();
        });
        addr
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
        assert!(!is_healthy(500, "{\"ok\":true}"));
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

    #[test]
    fn decode_chunked_joins_pieces() {
        assert_eq!(
            decode_chunked(b"3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n"),
            b"abcde"
        );
        assert_eq!(decode_chunked(b"garbage"), b"");
    }
}
