//! Pause and start, shared by the tray icon and the command line. The background keep-alive (`--serve`, run by the
//! scheduled task) does the work when it is running; these set the owner's wish and make sure someone acts on it.
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::Duration;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED};
use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
use windows_sys::Win32::System::Threading::OpenMutexW;

use crate::util::{self, Settings};
use crate::wsl;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const SYNCHRONIZE: u32 = 0x0010_0000;
const DETACHED_PROCESS: u32 = 0x0000_0008;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// Is this user's keep-alive running (in any session)?
pub fn serve_running() -> bool {
    let name = util::wide(&util::serve_mutex_name());
    let h = unsafe { OpenMutexW(SYNCHRONIZE, 0, name.as_ptr()) };
    if h.is_null() {
        // Access denied means it exists (an older keep-alive created it with a stricter default DACL).
        return unsafe { GetLastError() } == ERROR_ACCESS_DENIED;
    }
    unsafe { CloseHandle(h) };
    true
}

fn run_task() -> bool {
    let tn = format!("{}{}", util::TASK_PATH, util::TASK_NAME);
    Command::new("schtasks.exe")
        .args(["/Run", "/TN", &tn])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Start the server: clear Paused, and if no keep-alive is running, start the scheduled task (or, failing that, a
/// keep-alive of our own in this session).
pub fn start(who: &str) -> String {
    Settings::set("Paused", false);
    if serve_running() {
        util::log(who, "start: the keep-alive picks it up");
        return "starting".into();
    }
    util::reg_set_dword(HKEY_CURRENT_USER, util::SETTINGS_KEY, "StartRequested", 1);
    if run_task() {
        for _ in 0..20 {
            if serve_running() {
                util::log(who, "start: scheduled task started the keep-alive");
                return "starting (scheduled task)".into();
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    // No inherited handles: whoever ran `--start` (the installer reads its output) must not wait for this child.
    match std::env::current_exe().and_then(|exe| {
        Command::new(exe)
            .arg("--serve")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .spawn()
    }) {
        Ok(_) => {
            util::log(who, "start: no scheduled task; started a keep-alive in this session");
            "starting (this session)".into()
        }
        Err(e) => {
            util::log(who, &format!("start failed: {e}"));
            format!("couldn't start: {e}")
        }
    }
}

/// Pause: set Paused; the keep-alive stops the server. Without one, stop it here (blocking, up to ~2 min).
pub fn pause(who: &str) {
    Settings::set("Paused", true);
    if serve_running() {
        util::log(who, "pause: the keep-alive stops the server");
        // Wait (bounded) so callers can report the truth.
        for _ in 0..90 {
            std::thread::sleep(Duration::from_secs(2));
            if !wsl::running() {
                return;
            }
        }
    } else {
        util::log(who, "pause: no keep-alive running, stopping the server here");
        wsl::stop_server(&mut None, who);
    }
}
