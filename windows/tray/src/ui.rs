//! Dialogs, the clipboard and the browser.
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_ICONQUESTION, MB_ICONWARNING, MB_OK, MB_SETFOREGROUND,
    MB_TOPMOST, MB_YESNO, SW_SHOWNORMAL,
};

use crate::util::wide;

pub const TITLE: &str = "Tin Hat Server";
const CF_UNICODETEXT: u32 = 13;

fn boxed(hwnd: HWND, text: &str, flags: u32) -> i32 {
    let (t, c) = (wide(text), wide(TITLE));
    unsafe { MessageBoxW(hwnd, t.as_ptr(), c.as_ptr(), flags | MB_SETFOREGROUND | MB_TOPMOST) }
}

pub fn info(hwnd: HWND, text: &str) {
    boxed(hwnd, text, MB_OK | MB_ICONINFORMATION);
}

pub fn warn(hwnd: HWND, text: &str) {
    boxed(hwnd, text, MB_OK | MB_ICONWARNING);
}

pub fn error(hwnd: HWND, text: &str) {
    boxed(hwnd, text, MB_OK | MB_ICONERROR);
}

pub fn ask(hwnd: HWND, text: &str) -> bool {
    boxed(hwnd, text, MB_YESNO | MB_ICONQUESTION) == IDYES
}

pub fn open_url(url: &str) {
    let (op, u) = (wide("open"), wide(url));
    unsafe {
        ShellExecuteW(std::ptr::null_mut(), op.as_ptr(), u.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
    }
}

pub fn copy(hwnd: HWND, text: &str) -> bool {
    let w = wide(text);
    unsafe {
        if OpenClipboard(hwnd) == 0 {
            return false;
        }
        EmptyClipboard();
        let h = GlobalAlloc(GMEM_MOVEABLE, w.len() * 2);
        let ok = if !h.is_null() {
            let p = GlobalLock(h) as *mut u16;
            if !p.is_null() {
                std::ptr::copy_nonoverlapping(w.as_ptr(), p, w.len());
                GlobalUnlock(h);
                !SetClipboardData(CF_UNICODETEXT, h as _).is_null()
            } else {
                false
            }
        } else {
            false
        };
        CloseClipboard();
        ok
    }
}
