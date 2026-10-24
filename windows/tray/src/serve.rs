//! `TinHatServer.exe --serve`: keeps the server running. Started by the scheduled task "\Tin Hat Server\Keep the server
//! running" when Windows starts (before anyone logs in: S4U, session 0) and at the owner's logon; one per Windows
//! user (a Global\ mutex named after the user's SID).
//!
//! Every 2 s it reads the owner's settings (HKCU\Software\Tin Hat Server, which the tray icon writes):
//!   Paused=1            → stop the server cleanly and keep it stopped
//!   Paused=0            → keep one `wsl.exe -d TinHatServer … hold` running (restarted with a back-off if it ends)
//!   KeepAwake=1         → while the server runs, Windows doesn't go to sleep (the screen may still turn off)
//!   StartWithWindows=0  → after a restart of the PC the server stays paused until the owner presses Start
//!
//! Windows shutting down: the hold runs in a job object that ends it together with this process (a wsl.exe left
//! behind in session 0 holds up the restart), and a hidden window hears Windows' "ending the session" notice, so the
//! server gets a few seconds to stop its database cleanly first.
use std::os::windows::io::AsRawHandle;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
use windows_sys::Win32::System::Threading::SetProcessShutdownParameters;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, TranslateMessage, MSG,
    WM_ENDSESSION, WM_QUERYENDSESSION, WNDCLASSW, WS_OVERLAPPED,
};

use crate::util::{self, Settings, DISTRO};
use crate::wsl;

const LOG: &str = "serve";
static JOB: AtomicPtr<core::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());
static ENDING: AtomicBool = AtomicBool::new(false);
static HOLD: Mutex<Option<Child>> = Mutex::new(None);

pub fn run() -> i32 {
    let (_mutex, exists) = util::create_user_mutex(&util::serve_mutex_name());
    if exists {
        return 0; // already running for this user (in this or another session)
    }
    util::log(LOG, &format!("keep-alive started (Tin Hat Server {}, user {})", env!("CARGO_PKG_VERSION"), util::user_sid()));
    unsafe {
        // Hear about shutdown early (applications get the notice in this order, highest first).
        SetProcessShutdownParameters(0x3FF, 0);
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if !job.is_null() {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const _,
                                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
            JOB.store(job, Ordering::SeqCst);
        }
    }

    // After a restart of the PC: "Start with Windows" off means the server waits for the owner, unless the tray
    // icon asked for exactly this start (StartRequested, set just before it starts the task).
    let requested = util::reg_get_dword(HKEY_CURRENT_USER, util::SETTINGS_KEY, "StartRequested").unwrap_or(0) != 0;
    util::reg_delete_value(HKEY_CURRENT_USER, util::SETTINGS_KEY, "StartRequested");
    if !Settings::load().start_with_windows && !requested {
        Settings::set("Paused", true);
        util::log(LOG, "Start with Windows is off: the server stays paused until Start server");
    }

    std::thread::spawn(keep_alive);
    message_loop();
    0
}

/// The hidden window: only there to hear WM_QUERYENDSESSION / WM_ENDSESSION.
fn message_loop() {
    unsafe {
        let hinst = GetModuleHandleW(std::ptr::null());
        let class = util::wide("TinHatServerKeepAlive");
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinst,
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class.as_ptr(),
        };
        RegisterClassW(&wc);
        let title = util::wide("Tin Hat Server keep-alive");
        CreateWindowExW(0, class.as_ptr(), title.as_ptr(), WS_OVERLAPPED, 0, 0, 0, 0, std::ptr::null_mut(), std::ptr::null_mut(), hinst, std::ptr::null());
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_QUERYENDSESSION => 1,
        WM_ENDSESSION => {
            if wp != 0 && !ENDING.swap(true, Ordering::SeqCst) {
                util::log(LOG, "Windows is shutting down: stopping the server");
                // A few seconds for the database to stop cleanly, then whatever is left goes with the job object.
                if wsl::running() {
                    match wsl::run(&["-d", DISTRO, "-u", "root", "--exec", util::CTL, "stop"], Duration::from_secs(8)) {
                        Ok((code, _)) => util::log(LOG, &format!("services stopped for shutdown (exit {code})")),
                        Err(e) => util::log(LOG, &format!("shutdown stop: {e}")),
                    }
                }
                end_hold();
                let _ = wsl::run(&["--terminate", DISTRO], Duration::from_secs(5));
            }
            0
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

fn end_hold() {
    if let Some(mut c) = HOLD.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    let job = JOB.load(Ordering::SeqCst);
    if !job.is_null() {
        unsafe { TerminateJobObject(job, 0) };
    }
}

fn spawn_hold() -> Result<u32, String> {
    let c = wsl::spawn_hold()?;
    let id = c.id();
    let job = JOB.load(Ordering::SeqCst);
    if !job.is_null() {
        unsafe { AssignProcessToJobObject(job, c.as_raw_handle() as HANDLE) };
    }
    *HOLD.lock().unwrap() = Some(c);
    Ok(id)
}

/// Tell the server the real free space of the Windows drive that holds its disk (inside WSL it only sees the
/// virtual disk, which can be far bigger than what's actually free).
fn report_host_disk() {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let dir = util::wide(&util::data_dir().display().to_string());
    let (mut free, mut total) = (0u64, 0u64);
    if unsafe { GetDiskFreeSpaceExW(dir.as_ptr(), &mut free, &mut total, std::ptr::null_mut()) } == 0 {
        return;
    }
    let (f, t) = (free.to_string(), total.to_string());
    if let Err(e) = wsl::run(&["-d", DISTRO, "-u", "root", "--exec", util::CTL, "host-disk", &f, &t], Duration::from_secs(60)) {
        util::log(LOG, &format!("host disk report: {e}"));
    }
}

fn keep_alive() {
    let mut started_at = Instant::now();
    let mut disk_reported: Option<Instant> = None;
    let mut quick_fails = 0u32;
    let mut next_try = Instant::now();
    let mut was_paused: Option<bool> = None;
    let mut awake = false;
    loop {
        if ENDING.load(Ordering::SeqCst) {
            return;
        }
        let s = Settings::load();
        if s.paused {
            if was_paused != Some(true) {
                util::log(LOG, "paused: stopping the server");
                let mut hold = HOLD.lock().unwrap().take();
                wsl::stop_server(&mut hold, LOG);
            }
        } else {
            if was_paused == Some(true) {
                util::log(LOG, "starting the server");
                quick_fails = 0;
                next_try = Instant::now();
            }
            // Is the hold still there?
            let ended = {
                let mut h = HOLD.lock().unwrap();
                match h.as_mut().map(|c| c.try_wait()) {
                    Some(Ok(Some(status))) => {
                        *h = None;
                        Some(status)
                    }
                    _ => None,
                }
            };
            if let Some(status) = ended {
                let ran = started_at.elapsed();
                if ran < Duration::from_secs(30) {
                    quick_fails += 1;
                } else {
                    quick_fails = 0;
                }
                // 2 s, then 5, 15, 30, 60 s while it keeps ending right away (WSL being updated, a broken start).
                let wait = [2, 5, 15, 30, 60][(quick_fails as usize).min(4)];
                next_try = Instant::now() + Duration::from_secs(wait);
                util::log(LOG, &format!("the server's WSL session ended ({status}) after {} s; again in {wait} s", ran.as_secs()));
            }
            let none = HOLD.lock().unwrap().is_none();
            if none && Instant::now() >= next_try && !ENDING.load(Ordering::SeqCst) {
                match spawn_hold() {
                    Ok(pid) => {
                        util::log(LOG, &format!("holding the server (wsl.exe pid {pid})"));
                        started_at = Instant::now();
                    }
                    Err(e) => {
                        util::log(LOG, &format!("couldn't start the server: {e}"));
                        next_try = Instant::now() + Duration::from_secs(30);
                    }
                }
            }
        }
        was_paused = Some(s.paused);

        let holding = HOLD.lock().unwrap().is_some();
        // Every 10 minutes while running (and 20 s after a start, once the server is up).
        if holding && !s.paused && started_at.elapsed() > Duration::from_secs(20)
            && disk_reported.map(|t| t.elapsed() > Duration::from_secs(600) || t < started_at).unwrap_or(true)
        {
            report_host_disk();
            disk_reported = Some(Instant::now());
        }
        let want_awake = s.keep_awake && !s.paused && holding;
        if want_awake != awake {
            unsafe {
                SetThreadExecutionState(if want_awake { ES_CONTINUOUS | ES_SYSTEM_REQUIRED } else { ES_CONTINUOUS });
            }
            awake = want_awake;
            util::log(LOG, if awake { "keeping the PC awake while the server runs" } else { "the PC may sleep again" });
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}
