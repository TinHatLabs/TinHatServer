//! Small shared helpers: wide strings, paths, logging, the per-user settings in the registry, and the user's SID.
use std::ffi::OsStr;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
use windows_sys::Win32::System::Registry::{
    RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY, HKEY_CURRENT_USER, REG_DWORD, RRF_RT_REG_DWORD,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub const DISTRO: &str = "TinHatServer";
pub const SETTINGS_KEY: &str = "Software\\Tin Hat Server";
pub const TASK_PATH: &str = "\\Tin Hat Server\\";
pub const TASK_NAME: &str = "Keep the server running";
pub const CTL: &str = "/usr/local/lib/tinhat-wsl/ctl";
pub const HOLD: &str = "/usr/local/lib/tinhat-wsl/hold";
pub const SETUP_URL: &str = "http://127.0.0.1/";

/// The setup page with the code handed over after "#code=": the page fills it in, and a fragment never leaves the
/// browser (not sent to the server, not in any log). Anything but an 8-digit code opens the plain page.
pub fn setup_url_with(code: &str) -> String {
    let digits: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() == 8 && code.chars().all(|c| c.is_ascii_digit() || c == '-') {
        format!("{SETUP_URL}#code={}-{}", &digits[..4], &digits[4..])
    } else {
        SETUP_URL.to_string()
    }
}

pub fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// Copy `s` into a fixed UTF-16 buffer (NOTIFYICONDATA's tip/title/text), always 0-terminated.
pub fn fill_wide(dst: &mut [u16], s: &str) {
    let w: Vec<u16> = OsStr::new(s).encode_wide().collect();
    let n = w.len().min(dst.len() - 1);
    dst[..n].copy_from_slice(&w[..n]);
    dst[n] = 0;
}

/// %LOCALAPPDATA%\Tin Hat Server (the server's disk, logs and a kept copy after uninstall live here).
pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    base.join("Tin Hat Server")
}

pub fn wsl_exe() -> PathBuf {
    let root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows"));
    root.join("System32").join("wsl.exe")
}

pub fn now_utc() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rem) = (secs / 86400, secs % 86400);
    // civil-from-days (Howard Hinnant), enough for log timestamps
    let z = days as i64 + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Append a line to %LOCALAPPDATA%\Tin Hat Server\logs\<name>.log (kept under ~1 MB: one older copy, .1).
pub fn log(name: &str, msg: &str) {
    let dir = data_dir().join("logs");
    let _ = fs::create_dir_all(&dir);
    let path = dir.join(format!("{name}.log"));
    if fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join(format!("{name}.log.1")));
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} [{}] {}", now_utc(), std::process::id(), msg);
    }
}

// ---- per-user settings: HKCU\Software\Tin Hat Server ------------------------------------------------------------

pub fn reg_get_dword(root: HKEY, key: &str, name: &str) -> Option<u32> {
    let (k, n) = (wide(key), wide(name));
    let mut v: u32 = 0;
    let mut size = 4u32;
    let rc = unsafe {
        RegGetValueW(root, k.as_ptr(), n.as_ptr(), RRF_RT_REG_DWORD, std::ptr::null_mut(), &mut v as *mut u32 as *mut _, &mut size)
    };
    (rc == 0).then_some(v)
}

pub fn reg_set_dword(root: HKEY, key: &str, name: &str, v: u32) -> bool {
    let (k, n) = (wide(key), wide(name));
    unsafe { RegSetKeyValueW(root, k.as_ptr(), n.as_ptr(), REG_DWORD, &v as *const u32 as *const _, 4) == 0 }
}

pub fn reg_delete_value(root: HKEY, key: &str, name: &str) {
    let (k, n) = (wide(key), wide(name));
    unsafe {
        RegDeleteKeyValueW(root, k.as_ptr(), n.as_ptr());
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Settings {
    /// The owner paused the server (tray → Pause server). The background keep-alive stops it and keeps it stopped.
    pub paused: bool,
    /// Keep the PC from sleeping while the server runs (the screen may still turn off). Off by default.
    pub keep_awake: bool,
    /// Start the server when Windows starts. On by default.
    pub start_with_windows: bool,
}

impl Settings {
    pub fn load() -> Settings {
        let g = |n: &str, d: u32| reg_get_dword(HKEY_CURRENT_USER, SETTINGS_KEY, n).unwrap_or(d) != 0;
        Settings { paused: g("Paused", 0), keep_awake: g("KeepAwake", 0), start_with_windows: g("StartWithWindows", 1) }
    }
    pub fn set(name: &str, on: bool) -> bool {
        reg_set_dword(HKEY_CURRENT_USER, SETTINGS_KEY, name, on as u32)
    }
}

/// The current user's SID as a string (S-1-5-21-…), for per-user object names that work across sessions.
pub fn user_sid() -> String {
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return "unknown".into();
        }
        let mut len = 0u32;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
        let mut buf = vec![0u8; len as usize];
        let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr() as *mut _, len, &mut len);
        CloseHandle(token);
        if ok == 0 {
            return "unknown".into();
        }
        let tu = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut s: *mut u16 = std::ptr::null_mut();
        if ConvertSidToStringSidW(tu.User.Sid, &mut s) == 0 {
            return "unknown".into();
        }
        let mut n = 0;
        while *s.add(n) != 0 {
            n += 1;
        }
        let out = String::from_utf16_lossy(std::slice::from_raw_parts(s, n));
        LocalFree(s as *mut _);
        out
    }
}

/// The name of the keep-alive's single-instance mutex (Global\, so the tray in the user's desktop session can see
/// the one the scheduled task started in session 0).
pub fn serve_mutex_name() -> String {
    format!("Global\\TinHatServer-serve-{}", user_sid())
}

/// Create (or open) a named mutex that this user can open from any session and any token (elevated or not, S4U or
/// interactive): an explicit DACL for the user's SID, SYSTEM and Administrators. The default DACL of a scheduled
/// task's S4U token names only its own logon session, so the tray couldn't see the keep-alive's mutex.
/// Returns (handle, already existed).
pub fn create_user_mutex(name: &str) -> (HANDLE, bool) {
    use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, GetLastError};
    use windows_sys::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::System::Threading::CreateMutexW;
    let sddl = wide(&format!("D:P(A;;GA;;;{})(A;;GA;;;SY)(A;;GA;;;BA)", user_sid()));
    let n = wide(name);
    unsafe {
        let mut sd: *mut core::ffi::c_void = std::ptr::null_mut();
        let have_sd = ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut sd, std::ptr::null_mut()) != 0;
        let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd, bInheritHandle: 0 };
        let h = CreateMutexW(if have_sd { &sa } else { std::ptr::null() }, 0, n.as_ptr());
        let err = GetLastError();
        if have_sd {
            LocalFree(sd as _);
        }
        (h, err == ERROR_ALREADY_EXISTS || err == ERROR_ACCESS_DENIED)
    }
}
