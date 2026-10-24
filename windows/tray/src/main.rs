//! TinHatServer.exe — the Windows side of Tin Hat Server (the server itself runs in the WSL distribution "TinHatServer").
//!
//!   TinHatServer.exe [--tray]        the tray icon (started at logon)
//!   TinHatServer.exe --serve         keeps the server running (the scheduled task runs this at startup and logon)
//!   TinHatServer.exe --start | --pause | --stop | --status | --setup-code | --recovery-code | --wait-ready [SEC]
//!                    --open-setup | --hosts-set NAME | --hosts-clear | --version
#![windows_subsystem = "windows"]

mod cli;
mod control;
mod pcsetup;
mod serve;
mod status;
mod tray;
mod ui;
mod util;
mod wsl;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        None | Some("--tray") => tray::run(),
        Some("--serve") => serve::run(),
        Some(_) => cli::run(&args),
    };
    std::process::exit(code);
}
