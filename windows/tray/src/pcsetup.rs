//! Letting the PC that runs the server open it by name too.
//!
//! Other devices find <name>.local over mDNS, but Windows doesn't hear the answers its own WSL server sends, so this PC
//! gets one line in its hosts file: `127.0.0.1 <name>  # Tin Hat Server` (an elevated `TinHatServer.exe --hosts-set`;
//! the uninstaller removes it with --hosts-clear). In home-network mode the server's own certificate authority is also
//! added to the user's trusted roots; Windows shows its own confirmation for that.
use std::time::Duration;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HWND};
use windows_sys::Win32::Security::Cryptography::{
    CertAddCertificateContextToStore, CertCloseStore, CertCreateCertificateContext, CertFindCertificateInStore,
    CertFreeCertificateContext, CertOpenStore, CryptStringToBinaryA, CERT_CONTEXT,
};
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

use crate::status;
use crate::util::wide;

const MARK: &str = "# Tin Hat Server";
const X509_ASN_ENCODING: u32 = 1;
const PKCS_7_ASN_ENCODING: u32 = 0x10000;
const CERT_STORE_PROV_SYSTEM_W: usize = 10;
const CERT_SYSTEM_STORE_CURRENT_USER: u32 = 1 << 16;
const CERT_SYSTEM_STORE_LOCAL_MACHINE: u32 = 2 << 16;
const CERT_STORE_READONLY_FLAG: u32 = 0x8000;
const CERT_STORE_OPEN_EXISTING_FLAG: u32 = 0x4000;
const CERT_FIND_EXISTING: u32 = 13 << 16;
const CERT_STORE_ADD_USE_EXISTING: u32 = 2;
const CRYPT_STRING_BASE64HEADER: u32 = 0;

pub fn hosts_path() -> std::path::PathBuf {
    let mut buf = [0u16; 260];
    let n = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
    let sys = String::from_utf16_lossy(&buf[..n.min(buf.len())]);
    std::path::PathBuf::from(sys).join("drivers").join("etc").join("hosts")
}

/// A server name we are willing to put in the hosts file: lower-case DNS labels, at least two (crew.local).
pub fn valid_name(n: &str) -> bool {
    n.len() <= 253
        && n.split('.').count() >= 2
        && n.split('.').all(|l| {
            !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-')
                && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

fn read_hosts() -> String {
    std::fs::read(hosts_path()).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default()
}

/// Our line for `name` is in the hosts file.
pub fn hosts_has(name: &str) -> bool {
    read_hosts().lines().any(|l| {
        l.contains(MARK) && {
            let t: Vec<&str> = l.split_whitespace().collect();
            t.first() == Some(&"127.0.0.1") && t.get(1) == Some(&name)
        }
    })
}

/// Replace our lines in the hosts file with one for `name` (None: just remove ours). Needs administrator rights.
pub fn hosts_write(name: Option<&str>) -> Result<(), String> {
    if let Some(n) = name {
        if !valid_name(n) {
            return Err(format!("{n:?} isn't a server name"));
        }
    }
    let path = hosts_path();
    let text = read_hosts();
    let crlf = text.contains("\r\n") || text.is_empty();
    let nl = if crlf { "\r\n" } else { "\n" };
    let mut lines: Vec<&str> = text.lines().filter(|l| !l.contains(MARK)).collect();
    while lines.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        lines.pop();
    }
    let mut out = lines.join(nl);
    if let Some(n) = name {
        if !out.is_empty() {
            out.push_str(nl);
        }
        out.push_str(&format!("127.0.0.1\t{n}\t{MARK}"));
    }
    out.push_str(nl);
    std::fs::write(&path, out.as_bytes()).map_err(|e| format!("couldn't write {}: {e}", path.display()))
}

/// Run `TinHatServer.exe <args>` elevated (Windows asks for permission). Ok(exit code).
pub fn run_elevated(hwnd: HWND, args: &str) -> Result<u32, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let (verb, file, params) = (wide("runas"), wide(&exe.display().to_string()), wide(args));
    unsafe {
        let mut sei: SHELLEXECUTEINFOW = std::mem::zeroed();
        sei.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        sei.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
        sei.hwnd = hwnd;
        sei.lpVerb = verb.as_ptr();
        sei.lpFile = file.as_ptr();
        sei.lpParameters = params.as_ptr();
        sei.nShow = SW_HIDE;
        if ShellExecuteExW(&mut sei) == 0 {
            return Err(if GetLastError() == 1223 { "Windows didn't get permission.".into() } else { format!("error {}", GetLastError()) });
        }
        if sei.hProcess.is_null() {
            return Err("no process".into());
        }
        WaitForSingleObject(sei.hProcess, 120_000);
        let mut code = 1u32;
        GetExitCodeProcess(sei.hProcess, &mut code);
        CloseHandle(sei.hProcess);
        Ok(code)
    }
}

// ---- the server's certificate authority (home-network mode) ------------------------------------------------------

/// The server's root certificate as DER, from http://127.0.0.1/admin/ca.crt (only there once set up in home mode).
pub fn fetch_ca() -> Option<Vec<u8>> {
    let (code, body) = status::http_get("/admin/ca.crt", Duration::from_secs(5))?;
    if code != 200 || !body.starts_with(b"-----BEGIN CERTIFICATE-----") {
        return None;
    }
    let mut len = 0u32;
    unsafe {
        if CryptStringToBinaryA(body.as_ptr(), body.len() as u32, CRYPT_STRING_BASE64HEADER, std::ptr::null_mut(), &mut len,
                                std::ptr::null_mut(), std::ptr::null_mut()) == 0 {
            return None;
        }
        let mut der = vec![0u8; len as usize];
        if CryptStringToBinaryA(body.as_ptr(), body.len() as u32, CRYPT_STRING_BASE64HEADER, der.as_mut_ptr(), &mut len,
                                std::ptr::null_mut(), std::ptr::null_mut()) == 0 {
            return None;
        }
        der.truncate(len as usize);
        Some(der)
    }
}

fn open_root(flags: u32) -> *mut core::ffi::c_void {
    let name = wide("Root");
    unsafe { CertOpenStore(CERT_STORE_PROV_SYSTEM_W as _, 0, 0, flags, name.as_ptr() as *const _) }
}

/// Is this certificate in the user's or the machine's trusted roots already?
pub fn ca_trusted(der: &[u8]) -> bool {
    unsafe {
        let ctx = CertCreateCertificateContext(X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, der.as_ptr(), der.len() as u32);
        if ctx.is_null() {
            return false;
        }
        let mut found = false;
        for flags in [CERT_SYSTEM_STORE_CURRENT_USER, CERT_SYSTEM_STORE_LOCAL_MACHINE] {
            let store = open_root(flags | CERT_STORE_READONLY_FLAG | CERT_STORE_OPEN_EXISTING_FLAG);
            if store.is_null() {
                continue;
            }
            let hit = CertFindCertificateInStore(store, X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, 0, CERT_FIND_EXISTING,
                                                 ctx as *const CERT_CONTEXT as *const _, std::ptr::null());
            if !hit.is_null() {
                CertFreeCertificateContext(hit);
                found = true;
            }
            CertCloseStore(store, 0);
            if found {
                break;
            }
        }
        CertFreeCertificateContext(ctx);
        found
    }
}

/// Add it to the user's trusted roots. Windows shows its own "Do you want to install this certificate?" warning;
/// Ok(false) if the person said No.
pub fn trust_ca(der: &[u8]) -> Result<bool, String> {
    unsafe {
        let ctx = CertCreateCertificateContext(X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, der.as_ptr(), der.len() as u32);
        if ctx.is_null() {
            return Err("the server's certificate couldn't be read".into());
        }
        let store = open_root(CERT_SYSTEM_STORE_CURRENT_USER);
        if store.is_null() {
            CertFreeCertificateContext(ctx);
            return Err("the certificate store couldn't be opened".into());
        }
        let ok = CertAddCertificateContextToStore(store, ctx, CERT_STORE_ADD_USE_EXISTING, std::ptr::null_mut());
        let err = GetLastError();
        CertCloseStore(store, 0);
        CertFreeCertificateContext(ctx);
        if ok != 0 {
            Ok(true)
        } else if err == 1223 || err == 0x8007_04C7 {
            Ok(false)
        } else {
            Err(format!("Windows refused (error {err:#x})"))
        }
    }
}

/// What this PC still needs to open the server by name.
pub struct Needs {
    pub hosts: bool,
    pub ca: Option<Vec<u8>>,
}

pub fn needs(server: &status::Server) -> Needs {
    let name = server.name.clone().unwrap_or_default();
    let hosts = !hosts_has(&name);
    let ca = if server.mode == "lan" { fetch_ca().filter(|d| !ca_trusted(d)) } else { None };
    Needs { hosts, ca }
}

