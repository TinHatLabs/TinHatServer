//! Talking to WSL: run wsl.exe with a time limit, keep the server's distribution alive, stop it cleanly.
//!
//! Every wsl.exe that names the distribution STARTS it if it isn't running, so status checks first ask
//! `wsl.exe --list --running` (which never starts anything).
use std::io::Read;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::util::{self, DISTRO};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn command() -> Command {
    let mut c = Command::new(util::wsl_exe());
    // UTF-8 output instead of UTF-16 when not attached to a console.
    c.env("WSL_UTF8", "1").creation_flags(CREATE_NO_WINDOW).stdin(Stdio::null());
    c
}

/// Run wsl.exe with `args`; Err on timeout or if it can't start. Ok((exit code, stdout + stderr)).
pub fn run(args: &[&str], timeout: Duration) -> Result<(i32, String), String> {
    let mut child = command()
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("wsl.exe didn't start: {e}"))?;
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let t_out = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = out.read_to_end(&mut v);
        v
    });
    let t_err = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = err.read_to_end(&mut v);
        v
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut v = t_out.join().unwrap_or_default();
                v.extend(t_err.join().unwrap_or_default());
                return Ok((status.code().unwrap_or(-1), clean(&v)));
            }
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("wsl.exe {} took longer than {} s", args.join(" "), timeout.as_secs()));
            }
        }
    }
}

/// wsl.exe output as text: UTF-8 with WSL_UTF8=1, but older builds still answer some commands in UTF-16.
fn clean(v: &[u8]) -> String {
    let utf16 = v.len() >= 2 && v.len() % 2 == 0 && v.iter().skip(1).step_by(2).filter(|&&b| b == 0).count() * 2 >= v.len() / 2;
    let s = if utf16 {
        let w: Vec<u16> = v.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&w)
    } else {
        String::from_utf8_lossy(v).into_owned()
    };
    s.replace('\0', "").replace('\r', "").trim().to_string()
}

/// Is the server's distribution registered with WSL for this Windows user?
pub fn installed() -> bool {
    matches!(run(&["--list", "--quiet"], Duration::from_secs(30)), Ok((0, out)) if out.lines().any(|l| l.trim() == DISTRO))
}

/// Is it running right now? (Never starts it.)
pub fn running() -> bool {
    matches!(run(&["--list", "--running", "--quiet"], Duration::from_secs(30)), Ok((0, out)) if out.lines().any(|l| l.trim() == DISTRO))
}

/// Ask the server something through /usr/local/lib/tinhat-wsl/ctl. Starts the server if it isn't running, so callers
/// check `running()` first when that matters.
pub fn ctl(cmd: &str, timeout: Duration) -> Result<(i32, String), String> {
    run(&["-d", DISTRO, "-u", "root", "--exec", util::CTL, cmd], timeout)
}

/// The process that keeps the distribution running (WSL stops a distribution ~15 s after its last wsl.exe exits).
/// Its output goes to logs\wsl-hold.log.
pub fn spawn_hold() -> Result<Child, String> {
    let dir = util::data_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("wsl-hold.log"))
        .map_err(|e| format!("can't open the log: {e}"))?;
    let log2 = log.try_clone().map_err(|e| e.to_string())?;
    command()
        .args(["-d", DISTRO, "-u", "root", "--exec", util::HOLD])
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log2))
        .spawn()
        .map_err(|e| format!("wsl.exe didn't start: {e}"))
}

/// Stop the server cleanly: the services first (Docker stops the containers), then WSL ends the distribution.
pub fn stop_server(hold: &mut Option<Child>, who: &str) {
    if running() {
        match ctl("stop", Duration::from_secs(120)) {
            Ok((code, out)) => util::log(who, &format!("services stopped (exit {code}) {out}")),
            Err(e) => util::log(who, &format!("clean stop didn't finish: {e}")),
        }
    }
    if let Some(mut c) = hold.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    match run(&["--terminate", DISTRO], Duration::from_secs(60)) {
        Ok((code, out)) => util::log(who, &format!("wsl --terminate: exit {code} {out}")),
        Err(e) => util::log(who, &format!("wsl --terminate: {e}")),
    }
}
