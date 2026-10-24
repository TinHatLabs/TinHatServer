//! What state is the server in? Asked over plain HTTP on 127.0.0.1:80 (the manager's /admin/setup/status, through Caddy),
//! which is cheap and never starts a paused server. WSL's mirrored networking forwards 127.0.0.1 (not ::1) from Windows
//! to the server, so "localhost" is never used.
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Server {
    /// Answered on 127.0.0.1:80.
    pub up: bool,
    /// unconfigured | installing | failed | ready (the manager's phase)
    pub phase: String,
    /// e.g. crew.local or crew.tinhat.me, once set up
    pub name: Option<String>,
    /// lan | anywhere
    pub mode: String,
    pub version: String,
}

impl Server {
    pub fn ready(&self) -> bool {
        self.up && self.phase == "ready" && self.name.is_some()
    }
    pub fn dashboard_url(&self) -> String {
        match &self.name {
            Some(n) if self.ready() => format!("https://{n}/admin/"),
            _ => crate::util::SETUP_URL.to_string(),
        }
    }
}

/// GET http://127.0.0.1{path} → (status code, body). HTTP/1.0, so the body ends when the connection closes.
pub fn http_get(path: &str, timeout: Duration) -> Option<(u16, Vec<u8>)> {
    let addr: SocketAddr = "127.0.0.1:80".parse().ok()?;
    let mut s = TcpStream::connect_timeout(&addr, timeout).ok()?;
    s.set_read_timeout(Some(timeout)).ok()?;
    s.set_write_timeout(Some(timeout)).ok()?;
    let req = format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1\r\nUser-Agent: TinHatServer-tray\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let _ = s.take(4 * 1024 * 1024).read_to_end(&mut buf);
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&buf[..split]).to_string();
    let code = head.split_whitespace().nth(1)?.parse().ok()?;
    Some((code, buf[split + 4..].to_vec()))
}

pub fn probe() -> Server {
    let Some((200, body)) = http_get("/admin/setup/status", Duration::from_millis(2500)) else {
        return Server::default();
    };
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    Server {
        up: true,
        phase: s("phase").unwrap_or_else(|| "unconfigured".into()),
        name: s("serverName").filter(|n| !n.is_empty()),
        mode: s("mode").unwrap_or_else(|| "lan".into()),
        version: s("version").unwrap_or_default(),
    }
}
