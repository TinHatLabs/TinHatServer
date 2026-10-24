//! The tray icon (`TinHatServer.exe`, started at logon from HKCU\…\Run). It shows the server's state and offers:
//! Open dashboard (or the setup page), Pause/Start server, Keep this PC awake, Start with Windows, the setup code before
//! setup, the recovery code after it, and setting this PC up to open the server by name.
use std::cell::RefCell;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows_sys::Win32::System::Threading::{CreateMutexW, GetCurrentProcessId};
use windows_sys::Win32::UI::Controls::LoadIconMetric;
use windows_sys::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_SHOWTIP, NIF_TIP, NIIF_INFO, NIM_ADD, NIM_DELETE, NIM_MODIFY,
    NIM_SETVERSION, NIN_SELECT, NOTIFYICONDATAW, NOTIFYICON_VERSION_4,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu, DestroyWindow, DispatchMessageW,
    FindWindowW, GetCursorPos, GetMessageW, PostMessageW, PostQuitMessage, RegisterClassW, RegisterWindowMessageW,
    SetForegroundWindow, SetMenuDefaultItem, TrackPopupMenuEx, TranslateMessage, HICON, MF_CHECKED, MF_GRAYED,
    MF_SEPARATOR, MF_STRING, MSG, TPM_NONOTIFY, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_APP, WM_CONTEXTMENU, WM_DESTROY,
    WM_ENDSESSION, WM_LBUTTONDBLCLK, WM_NULL, WM_QUERYENDSESSION, WNDCLASSW, WS_OVERLAPPED,
};

use crate::status::{self, Server};
use crate::util::{self, wide, Settings};
use crate::{control, pcsetup, ui, wsl};

const WM_TRAY: u32 = WM_APP + 1;
const NIN_KEYSELECT: u32 = NIN_SELECT | 1;
const WM_STATUS: u32 = WM_APP + 2;
const WM_OPEN: u32 = WM_APP + 3;
const WM_REFRESH: u32 = WM_APP + 4;
const WM_PCSETUP: u32 = WM_APP + 5;
const WM_RECOVERY: u32 = WM_APP + 6;
const CLASS: &str = "TinHatServerTray";
const LOG: &str = "tray";

const ID_HEADER: usize = 99;
const ID_OPEN: usize = 100;
const ID_SETUP_CODE: usize = 101;
const ID_RECOVERY: usize = 102;
const ID_PAUSE: usize = 103;
const ID_START: usize = 104;
const ID_AWAKE: usize = 105;
const ID_AUTOSTART: usize = 106;
const ID_PCSETUP: usize = 107;
const ID_EXIT: usize = 108;

/// What the worker thread last saw.
#[derive(Clone, Default)]
struct View {
    installed: bool,
    settings: Option<Settings>,
    server: Server,
    recovery: Option<String>,
    pc_needs_setup: bool,
}

struct Ui {
    hwnd: HWND,
    view: View,
    shared: Arc<Mutex<View>>,
    poke: mpsc::Sender<()>,
    icons: [HICON; 3],
    shown_icon: usize,
    tip: String,
    down_since: Option<Instant>,
    saw_unready: bool,
    offered_pc_setup: bool,
    last_recovery: Option<String>,
    in_dialog: bool,
    taskbar_created: u32,
}

thread_local! {
    static UI: RefCell<Option<Ui>> = const { RefCell::new(None) };
}

fn with_ui<R>(f: impl FnOnce(&mut Ui) -> R) -> Option<R> {
    UI.with(|u| u.borrow_mut().as_mut().map(f))
}

pub fn run() -> i32 {
    // No desktop (session 0: started by a service, a scheduled task or a remote shell): nobody could see the icon or
    // answer its questions, and an unanswered question holds up Windows' shutdown.
    let mut session = 0u32;
    if unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) } != 0 && session == 0 {
        util::log(LOG, "no desktop session (session 0): the tray icon doesn't start");
        return 0;
    }
    let mname = wide("Local\\TinHatServer-tray");
    unsafe { CreateMutexW(std::ptr::null(), 0, mname.as_ptr()) };
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        // Already running in this session: ask it to open the dashboard (a second launch = "open it").
        let c = wide(CLASS);
        let h = unsafe { FindWindowW(c.as_ptr(), std::ptr::null()) };
        if !h.is_null() {
            unsafe { PostMessageW(h, WM_OPEN, 0, 0) };
        }
        return 0;
    }
    util::log(LOG, &format!("tray started (Tin Hat Server {})", env!("CARGO_PKG_VERSION")));

    let hinst = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class = wide(CLASS);
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
    unsafe { RegisterClassW(&wc) };
    let title = wide("Tin Hat Server");
    let hwnd = unsafe {
        CreateWindowExW(0, class.as_ptr(), title.as_ptr(), WS_OVERLAPPED, 0, 0, 0, 0, std::ptr::null_mut(), std::ptr::null_mut(), hinst, std::ptr::null())
    };
    if hwnd.is_null() {
        util::log(LOG, "couldn't create the tray window");
        return 1;
    }
    let mut icons: [HICON; 3] = [std::ptr::null_mut(); 3];
    for (i, id) in [2usize, 3, 4].iter().enumerate() {
        unsafe { LoadIconMetric(hinst, *id as *const u16, 0, &mut icons[i]) };
    }
    let tb = wide("TaskbarCreated");
    let taskbar_created = unsafe { RegisterWindowMessageW(tb.as_ptr()) };

    let shared = Arc::new(Mutex::new(View::default()));
    let (tx, rx) = mpsc::channel::<()>();
    UI.with(|u| {
        *u.borrow_mut() = Some(Ui {
            hwnd,
            view: View::default(),
            shared: shared.clone(),
            poke: tx,
            icons,
            shown_icon: 0,
            tip: "Tin Hat Server: starting…".into(),
            down_since: Some(Instant::now()),
            saw_unready: false,
            offered_pc_setup: false,
            last_recovery: None,
            in_dialog: false,
            taskbar_created,
        })
    });
    add_icon();
    let hwnd_v = hwnd as isize;
    std::thread::spawn(move || worker(hwnd_v, shared, rx));

    let mut msg: MSG = unsafe { std::mem::zeroed() };
    while unsafe { GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) } > 0 {
        unsafe {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    util::log(LOG, "tray closed");
    0
}

// ---- the worker: looks at the server every few seconds -----------------------------------------------------------

fn worker(hwnd: isize, shared: Arc<Mutex<View>>, rx: mpsc::Receiver<()>) {
    let mut installed_checked: Option<Instant> = None;
    let mut installed = true;
    let mut last_recovery_check = Instant::now() - Duration::from_secs(60);
    let mut recovery: Option<String> = None;
    let mut needs_cache: Option<(String, bool, Instant)> = None;
    loop {
        if installed_checked.map(|t| t.elapsed() > Duration::from_secs(120)).unwrap_or(true) {
            installed = wsl::installed();
            installed_checked = Some(Instant::now());
        }
        let settings = Settings::load();
        let server = if settings.paused { Server::default() } else { status::probe() };
        if server.ready() && !settings.paused {
            if last_recovery_check.elapsed() >= Duration::from_secs(5) {
                last_recovery_check = Instant::now();
                recovery = match wsl::ctl("recovery-code", Duration::from_secs(20)) {
                    Ok((0, out)) => Some(out.trim().to_string()).filter(|c| c.len() >= 8 && c.len() <= 32),
                    _ => recovery.clone(),
                };
            }
        } else {
            recovery = None;
        }
        // Does this PC still need the hosts line / the certificate? (cheap, but not every 3 s)
        let pc_needs_setup = match (&server.name, server.ready()) {
            (Some(n), true) => match &needs_cache {
                Some((name, v, t)) if name == n && t.elapsed() < Duration::from_secs(30) => *v,
                _ => {
                    let need = pcsetup::needs(&server);
                    let v = need.hosts || need.ca.is_some();
                    needs_cache = Some((n.clone(), v, Instant::now()));
                    v
                }
            },
            _ => false,
        };
        *shared.lock().unwrap() =
            View { installed, settings: Some(settings), server, recovery: recovery.clone(), pc_needs_setup };
        unsafe { PostMessageW(hwnd as HWND, WM_STATUS, 0, 0) };
        match rx.recv_timeout(Duration::from_secs(3)) {
            Ok(()) => needs_cache = None,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
    }
}

// ---- the window procedure ----------------------------------------------------------------------------------------

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_TRAY => {
            match (lp & 0xffff) as u32 {
                WM_CONTEXTMENU => show_menu(),
                NIN_SELECT | NIN_KEYSELECT | WM_LBUTTONDBLCLK => open_main(),
                _ => {}
            }
            0
        }
        WM_STATUS => {
            on_status();
            0
        }
        WM_OPEN => {
            open_main();
            0
        }
        WM_REFRESH => {
            with_ui(|u| {
                let _ = u.poke.send(());
            });
            0
        }
        WM_PCSETUP => {
            pc_setup(false);
            0
        }
        WM_RECOVERY => {
            show_recovery(false);
            0
        }
        WM_QUERYENDSESSION => 1,
        WM_ENDSESSION => {
            if wp != 0 {
                remove_icon();
                // Windows shutting down or restarting (not just signing out: then the server keeps running): give the
                // server a few seconds to stop its database cleanly. The keep-alive in session 0 isn't told (Task
                // Scheduler just ends it), so this is the clean path whenever someone is signed in.
                const ENDSESSION_LOGOFF: isize = 0x8000_0000u32 as isize;
                let paused = Settings::load().paused;
                if lp & ENDSESSION_LOGOFF == 0 && !paused && wsl::running() {
                    util::log(LOG, "Windows is shutting down: stopping the server's services");
                    let r = wsl::run(&["-d", util::DISTRO, "-u", "root", "--exec", util::CTL, "stop"], Duration::from_secs(4));
                    util::log(LOG, &format!("shutdown stop: {r:?}"));
                }
            }
            0
        }
        WM_DESTROY => {
            remove_icon();
            PostQuitMessage(0);
            0
        }
        m if Some(m) == with_ui(|u| u.taskbar_created) => {
            add_icon(); // Explorer restarted: the icon must be added again
            0
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

fn nid(u: &Ui) -> NOTIFYICONDATAW {
    let mut n: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    n.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    n.hWnd = u.hwnd;
    n.uID = 1;
    n
}

fn add_icon() {
    with_ui(|u| {
        let mut n = nid(u);
        n.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
        n.uCallbackMessage = WM_TRAY;
        n.hIcon = u.icons[u.shown_icon];
        util::fill_wide(&mut n.szTip, &u.tip);
        unsafe {
            Shell_NotifyIconW(NIM_ADD, &n);
            n.Anonymous.uVersion = NOTIFYICON_VERSION_4;
            Shell_NotifyIconW(NIM_SETVERSION, &n);
        }
    });
}

fn remove_icon() {
    with_ui(|u| {
        let n = nid(u);
        unsafe { Shell_NotifyIconW(NIM_DELETE, &n) };
    });
}

fn balloon(title: &str, text: &str) {
    with_ui(|u| {
        let mut n = nid(u);
        n.uFlags = NIF_INFO;
        n.dwInfoFlags = NIIF_INFO;
        util::fill_wide(&mut n.szInfoTitle, title);
        util::fill_wide(&mut n.szInfo, text);
        unsafe { Shell_NotifyIconW(NIM_MODIFY, &n) };
    });
}

fn state_text(v: &View, down_for: Option<Duration>) -> String {
    let s = v.settings.unwrap_or(Settings { paused: false, keep_awake: false, start_with_windows: true });
    if !v.installed {
        return "not installed (run the installer again)".into();
    }
    if s.paused {
        return "paused".into();
    }
    if v.server.ready() {
        return format!("running ({})", v.server.name.clone().unwrap_or_default());
    }
    if v.server.up {
        return match v.server.phase.as_str() {
            "installing" => "setting up…".into(),
            "failed" => "setup didn't finish: open the setup page".into(),
            _ => "waiting for you to set it up".into(),
        };
    }
    match down_for {
        Some(d) if d > Duration::from_secs(180) => "not answering (see the logs)".into(),
        _ => "starting…".into(),
    }
}

fn on_status() {
    let mut post_pcsetup = false;
    let mut post_recovery = false;
    with_ui(|u| {
        let v = u.shared.lock().unwrap().clone();
        let paused = v.settings.map(|s| s.paused).unwrap_or(false);
        if v.server.up || paused {
            u.down_since = None;
        } else if u.down_since.is_none() {
            u.down_since = Some(Instant::now());
        }
        let down_for = u.down_since.map(|t| t.elapsed());
        let icon = if paused {
            1
        } else if v.server.ready() {
            0
        } else if v.server.up || !v.installed || down_for.map(|d| d > Duration::from_secs(180)).unwrap_or(false) {
            2
        } else {
            0
        };
        let tip = format!("Tin Hat Server: {}", state_text(&v, down_for));
        if icon != u.shown_icon || tip != u.tip {
            u.shown_icon = icon;
            u.tip = tip;
            let mut n = nid(u);
            n.uFlags = NIF_ICON | NIF_TIP | NIF_SHOWTIP;
            n.hIcon = u.icons[icon];
            util::fill_wide(&mut n.szTip, &u.tip);
            unsafe { Shell_NotifyIconW(NIM_MODIFY, &n) };
        }
        if v.server.ready() && !u_ready_before() {
            util::reg_set_dword(windows_sys::Win32::System::Registry::HKEY_CURRENT_USER, util::SETTINGS_KEY, "SetUp", 1);
        }
        // Setup just finished while we watched: offer to set this PC up to open the server.
        if v.server.up && !v.server.ready() {
            u.saw_unready = true;
        }
        if v.server.ready() && u.saw_unready && !u.offered_pc_setup && v.pc_needs_setup {
            u.offered_pc_setup = true;
            post_pcsetup = true;
        }
        // A recovery code appeared (someone pressed "Forgot your password?"): show it, once per code.
        if let Some(code) = &v.recovery {
            if u.last_recovery.as_ref() != Some(code) {
                u.last_recovery = Some(code.clone());
                post_recovery = true;
            }
        }
        u.view = v;
    });
    let hwnd = with_ui(|u| u.hwnd).unwrap_or(std::ptr::null_mut());
    if post_pcsetup {
        unsafe { PostMessageW(hwnd, WM_PCSETUP, 0, 0) };
    }
    if post_recovery {
        unsafe { PostMessageW(hwnd, WM_RECOVERY, 0, 0) };
    }
}

/// Was this server seen set up (so a paused one still says "Open dashboard")? Remembered across restarts.
fn u_ready_before() -> bool {
    util::reg_get_dword(windows_sys::Win32::System::Registry::HKEY_CURRENT_USER, util::SETTINGS_KEY, "SetUp").unwrap_or(0) != 0
}

fn append(menu: *mut core::ffi::c_void, flags: u32, id: usize, text: &str) {
    let t = wide(text);
    unsafe { AppendMenuW(menu, flags, id, t.as_ptr()) };
}

fn show_menu() {
    let Some((hwnd, v, down_for)) = with_ui(|u| (u.hwnd, u.view.clone(), u.down_since.map(|t| t.elapsed()))) else { return };
    let s = v.settings.unwrap_or(Settings { paused: false, keep_awake: false, start_with_windows: true });
    unsafe {
        let m = CreatePopupMenu();
        append(m, MF_STRING | MF_GRAYED, ID_HEADER, &format!("Tin Hat Server: {}", state_text(&v, down_for)));
        append(m, MF_SEPARATOR, 0, "");
        if v.server.ready() || (s.paused && u_ready_before()) {
            append(m, MF_STRING | if s.paused { MF_GRAYED } else { 0 }, ID_OPEN, "Open dashboard");
        } else {
            append(m, MF_STRING | if v.server.up { 0 } else { MF_GRAYED }, ID_OPEN, "Open setup page");
        }
        SetMenuDefaultItem(m, ID_OPEN as u32, 0);
        if v.server.up && !v.server.ready() {
            append(m, MF_STRING, ID_SETUP_CODE, "Show setup code");
        }
        if v.server.ready() {
            append(m, MF_STRING, ID_RECOVERY, "Show recovery code");
        }
        append(m, MF_SEPARATOR, 0, "");
        if s.paused {
            append(m, MF_STRING, ID_START, "Start server");
        } else {
            append(m, MF_STRING, ID_PAUSE, "Pause server");
        }
        append(m, MF_STRING | if s.keep_awake { MF_CHECKED } else { 0 }, ID_AWAKE, "Keep this PC awake while the server runs");
        append(m, MF_STRING | if s.start_with_windows { MF_CHECKED } else { 0 }, ID_AUTOSTART, "Start with Windows");
        append(m, MF_SEPARATOR, 0, "");
        if v.server.ready() && v.pc_needs_setup {
            append(m, MF_STRING, ID_PCSETUP, "Set up this PC to open your server…");
        }
        append(m, MF_STRING, ID_EXIT, "Close this icon (the server keeps running)");
        let mut pt = POINT { x: 0, y: 0 };
        GetCursorPos(&mut pt);
        SetForegroundWindow(hwnd);
        let cmd = TrackPopupMenuEx(m, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, pt.x, pt.y, hwnd, std::ptr::null()) as usize;
        PostMessageW(hwnd, WM_NULL, 0, 0);
        DestroyMenu(m);
        command(cmd, &v, s);
    }
}

fn command(cmd: usize, v: &View, s: Settings) {
    let hwnd = with_ui(|u| u.hwnd).unwrap_or(std::ptr::null_mut());
    match cmd {
        ID_OPEN => open_main(),
        ID_SETUP_CODE => show_setup_code(),
        ID_RECOVERY => show_recovery(true),
        ID_PAUSE => {
            if ui::ask(hwnd, "Pause the server?\n\nYour group can't chat or call until you start it again. Messages they type meanwhile wait in their apps.") {
                background(|| control::pause(LOG));
            }
        }
        ID_START => background(|| {
            control::start(LOG);
        }),
        ID_AWAKE => {
            Settings::set("KeepAwake", !s.keep_awake);
            util::log(LOG, &format!("keep awake: {}", !s.keep_awake));
            refresh();
        }
        ID_AUTOSTART => {
            Settings::set("StartWithWindows", !s.start_with_windows);
            util::log(LOG, &format!("start with Windows: {}", !s.start_with_windows));
            refresh();
        }
        ID_PCSETUP => pc_setup(true),
        ID_EXIT => {
            let _ = v;
            unsafe { DestroyWindow(hwnd) };
        }
        _ => {}
    }
}

fn refresh() {
    with_ui(|u| {
        let _ = u.poke.send(());
    });
}

/// Run `f` off the UI thread, then refresh.
fn background(f: impl FnOnce() + Send + 'static) {
    let hwnd = with_ui(|u| u.hwnd as isize).unwrap_or(0);
    refresh();
    std::thread::spawn(move || {
        f();
        unsafe { PostMessageW(hwnd as HWND, WM_REFRESH, 0, 0) };
    });
}

/// Left click / "Open": the dashboard once set up, else the setup page (and the setup code).
fn open_main() {
    let Some((hwnd, v, busy)) = with_ui(|u| (u.hwnd, u.view.clone(), u.in_dialog)) else { return };
    if busy {
        return;
    }
    let paused = v.settings.map(|s| s.paused).unwrap_or(false);
    if paused {
        if ui::ask(hwnd, "The server is paused. Start it now?") {
            background(|| {
                control::start(LOG);
            });
        }
        return;
    }
    if v.server.ready() {
        if v.pc_needs_setup {
            pc_setup(false);
        } else {
            ui::open_url(&v.server.dashboard_url());
        }
    } else if v.server.up {
        open_setup();
    } else {
        ui::info(hwnd, "The server is still starting. This takes up to a minute after Windows starts; try again shortly.");
    }
}

fn dialog(f: impl FnOnce(HWND)) {
    let Some((hwnd, busy)) = with_ui(|u| (u.hwnd, u.in_dialog)) else { return };
    if busy {
        return;
    }
    with_ui(|u| u.in_dialog = true);
    f(hwnd);
    with_ui(|u| u.in_dialog = false);
}

/// The setup page with its code already filled in; without a code, the plain page and the code in a dialog.
fn open_setup() {
    match wsl::ctl("setup-code", Duration::from_secs(30)) {
        Ok((0, code)) if !code.trim().is_empty() => ui::open_url(&util::setup_url_with(code.trim())),
        _ => {
            ui::open_url(util::SETUP_URL);
            show_setup_code();
        }
    }
}

fn show_setup_code() {
    dialog(|hwnd| match wsl::ctl("setup-code", Duration::from_secs(30)) {
        Ok((0, code)) if !code.trim().is_empty() => {
            let code = code.trim().to_string();
            let copied = ui::copy(hwnd, &code);
            ui::info(hwnd, &format!(
                "Your setup code:\n\n        {code}\n\n{}Type it into the setup page ({}), then follow the steps there.",
                if copied { "It's on the clipboard. " } else { "" },
                util::SETUP_URL
            ));
        }
        _ => ui::info(hwnd, "There's no setup code: this server is already set up (or still starting)."),
    });
}

fn show_recovery(from_menu: bool) {
    dialog(|hwnd| {
        let code = match wsl::ctl("recovery-code", Duration::from_secs(30)) {
            Ok((0, c)) => c.trim().to_string(),
            _ => String::new(),
        };
        if code.is_empty() {
            if from_menu {
                ui::info(hwnd, "No recovery code is showing right now.\n\nForgot the admin password? On the dashboard's sign-in page choose “Forgot your password?”. A code then appears here (it works for 10 minutes).");
            }
            return;
        }
        if !from_menu {
            balloon("Recovery code", &format!("{code}  (works for 10 minutes)"));
        }
        let copied = ui::copy(hwnd, &code);
        ui::info(hwnd, &format!(
            "Your recovery code:\n\n        {code}\n\n{}Type it on the sign-in page with a new password. It works for 10 minutes.\n\nDidn't ask for one? Someone pressed “Forgot your password?” on your server's sign-in page. Without this code, nothing changes.",
            if copied { "It's on the clipboard. " } else { "" }
        ));
    });
}

/// Let this PC open https://<name>: a hosts line (Windows asks for permission) and, at home, trusting the server's
/// certificate (Windows asks to confirm).
fn pc_setup(from_menu: bool) {
    let Some(v) = with_ui(|u| u.view.clone()) else { return };
    let Some(name) = v.server.name.clone() else { return };
    let url = v.server.dashboard_url();
    dialog(|hwnd| {
        let need = pcsetup::needs(&v.server);
        if !need.hosts && need.ca.is_none() {
            if from_menu {
                ui::info(hwnd, &format!("This PC is all set: it opens https://{name} directly."));
            }
            ui::open_url(&url);
            return;
        }
        let mut steps = String::new();
        if need.hosts {
            steps.push_str(&format!("\n•  This PC learns where {name} is. Windows asks for permission."));
        }
        if need.ca.is_some() {
            steps.push_str(&format!("\n•  This PC trusts your server's certificate. Windows shows a security warning: check that it names “Tin Hat server {name}”, then choose Yes."));
        }
        if !ui::ask(hwnd, &format!("Your server {name} is ready.\n\nTo use it on this PC as well:{steps}\n\nSet up this PC now?")) {
            util::log(LOG, "PC setup: not now");
            return;
        }
        if need.hosts {
            match pcsetup::run_elevated(hwnd, &format!("--hosts-set {name}")) {
                Ok(0) => util::log(LOG, &format!("hosts: {name} → 127.0.0.1")),
                Ok(c) => {
                    util::log(LOG, &format!("hosts: helper exit {c}"));
                    ui::error(hwnd, "Windows couldn't save the change. Try again from the tray icon: “Set up this PC to open your server…”.");
                    return;
                }
                Err(e) => {
                    util::log(LOG, &format!("hosts: {e}"));
                    ui::warn(hwnd, &format!("This PC can't open {name} yet ({e}). Try again from the tray icon: “Set up this PC to open your server…”."));
                    return;
                }
            }
        }
        if let Some(der) = &need.ca {
            match pcsetup::trust_ca(der) {
                Ok(true) => util::log(LOG, "certificate trusted"),
                Ok(false) => {
                    util::log(LOG, "certificate: declined");
                    ui::info(hwnd, "Fine. Your browser will warn about the server's certificate until this PC trusts it (tray icon → “Set up this PC to open your server…”).");
                }
                Err(e) => {
                    util::log(LOG, &format!("certificate: {e}"));
                    ui::warn(hwnd, &format!("The certificate wasn't added: {e}."));
                }
            }
        }
        ui::open_url(&url);
    });
    refresh();
}
