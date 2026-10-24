//! Command-line modes, for the installer, the uninstaller and support. Output goes to the console that started us
//! (or to the redirected stdout), so `TinHatServer.exe --status` works from cmd, PowerShell and SSH.
use std::time::{Duration, Instant};

use windows_sys::Win32::System::Console::{AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_OUTPUT_HANDLE};

use crate::util::{self, Settings};
use crate::{control, pcsetup, status, ui, wsl};

const LOG: &str = "cli";

pub fn run(args: &[String]) -> i32 {
    // A windows-subsystem program has no console. If whoever started us passed an output handle (a pipe, a file),
    // print there; otherwise borrow the parent's console (cmd, PowerShell).
    unsafe {
        let h = GetStdHandle(STD_OUTPUT_HANDLE);
        if h.is_null() || h as isize == -1 {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
    let arg = |i: usize| args.get(i).map(String::as_str);
    match arg(0).unwrap_or("") {
        "--version" => {
            println!("Tin Hat Server for Windows {}", env!("CARGO_PKG_VERSION"));
            0
        }
        "--status" => {
            let s = Settings::load();
            let srv = status::probe();
            let v = serde_json::json!({
                "installed": wsl::installed(),
                "running": wsl::running(),
                "keepAlive": control::serve_running(),
                "paused": s.paused, "keepAwake": s.keep_awake, "startWithWindows": s.start_with_windows,
                "answering": srv.up, "phase": srv.phase, "serverName": srv.name, "mode": srv.mode, "version": srv.version,
                "hostsEntry": srv.name.as_deref().map(pcsetup::hosts_has),
            });
            println!("{v}");
            0
        }
        "--start" => {
            println!("{}", control::start(LOG));
            0
        }
        "--pause" => {
            control::pause(LOG);
            println!("paused");
            0
        }
        "--stop" => {
            // For the uninstaller: stop now, whatever the keep-alive does, and leave it paused.
            Settings::set("Paused", true);
            wsl::stop_server(&mut None, LOG);
            println!("stopped");
            0
        }
        "--setup-code" | "--recovery-code" => {
            if !wsl::running() {
                eprintln!("the server isn't running");
                return 1;
            }
            let cmd = if arg(0) == Some("--setup-code") { "setup-code" } else { "recovery-code" };
            match wsl::ctl(cmd, Duration::from_secs(60)) {
                Ok((0, out)) => {
                    println!("{}", out.trim());
                    0
                }
                Ok((c, out)) => {
                    eprintln!("{out}");
                    c.max(1)
                }
                Err(e) => {
                    eprintln!("{e}");
                    1
                }
            }
        }
        "--wait-ready" => {
            let secs: u64 = arg(1).and_then(|s| s.parse().ok()).unwrap_or(300);
            let end = Instant::now() + Duration::from_secs(secs);
            while Instant::now() < end {
                if status::probe().up {
                    println!("ready");
                    return 0;
                }
                std::thread::sleep(Duration::from_secs(2));
            }
            eprintln!("the server didn't answer within {secs} s");
            1
        }
        "--open-setup" => {
            // The installer's last step: open the setup page and show the setup code (copied to the clipboard).
            let code = wsl::ctl("setup-code", Duration::from_secs(60)).ok().map(|(_, c)| c.trim().to_string()).unwrap_or_default();
            ui::open_url(&util::setup_url_with(&code));
            if !code.is_empty() {
                let copied = ui::copy(std::ptr::null_mut(), &code);
                ui::info(std::ptr::null_mut(), &format!(
                    "Your server is running. Finish setting it up in your browser.\n\nYour setup code:\n\n        {code}\n\n{}The setup page asks for it to make sure it's you.",
                    if copied { "It's on the clipboard. " } else { "" }
                ));
            }
            0
        }
        "--hosts-set" | "--hosts-clear" => {
            let name = if arg(0) == Some("--hosts-set") { arg(1) } else { None };
            if arg(0) == Some("--hosts-set") && name.is_none() {
                eprintln!("--hosts-set NAME");
                return 2;
            }
            match pcsetup::hosts_write(name) {
                Ok(()) => {
                    util::log(LOG, &format!("hosts file: {}", name.map(|n| format!("{n} → 127.0.0.1")).unwrap_or("our line removed".into())));
                    0
                }
                Err(e) => {
                    util::log(LOG, &format!("hosts file: {e}"));
                    eprintln!("{e}");
                    3
                }
            }
        }
        other => {
            eprintln!("unknown option {other:?}\nTinHatServer.exe [--tray] | --serve | --start | --pause | --stop | --status | --setup-code | --recovery-code | --wait-ready [SEC] | --open-setup | --hosts-set NAME | --hosts-clear | --version");
            2
        }
    }
}
