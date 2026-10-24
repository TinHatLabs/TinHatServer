// Embeds the icons, the manifest and the version block (app.rc is generated so the version comes from Cargo.toml).
use std::{env, fs, path::PathBuf};

fn main() {
    let ver = env::var("CARGO_PKG_VERSION").unwrap();
    let mut n: Vec<u32> = ver.split(|c: char| !c.is_ascii_digit()).filter_map(|s| s.parse().ok()).collect();
    n.resize(4, 0);
    let dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let icons = env::var("TINHAT_ICON_DIR").map(PathBuf::from).unwrap_or_else(|_| dir.join("icons"));
    let esc = |p: PathBuf| p.display().to_string().replace('\\', "\\\\");
    let rc = format!(
        r#"#pragma code_page(65001)
1 ICON "{app}"
2 ICON "{run}"
3 ICON "{pause}"
4 ICON "{attn}"
1 24 "{manifest}"
1 VERSIONINFO
FILEVERSION {a},{b},{c},{d}
PRODUCTVERSION {a},{b},{c},{d}
FILEOS 0x40004
FILETYPE 0x1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904b0"
    BEGIN
      VALUE "CompanyName", "Tin Hat"
      VALUE "FileDescription", "Tin Hat Server"
      VALUE "FileVersion", "{ver}"
      VALUE "InternalName", "TinHatServer"
      VALUE "OriginalFilename", "TinHatServer.exe"
      VALUE "ProductName", "Tin Hat Server"
      VALUE "ProductVersion", "{ver}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#,
        app = esc(icons.join("app.ico")),
        run = esc(icons.join("tray-running.ico")),
        pause = esc(icons.join("tray-paused.ico")),
        attn = esc(icons.join("tray-attention.ico")),
        manifest = esc(dir.join("app.manifest")),
        a = n[0], b = n[1], c = n[2], d = n[3], ver = ver
    );
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("app.rc");
    fs::write(&out, rc).unwrap();
    println!("cargo:rerun-if-changed=app.manifest");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=TINHAT_ICON_DIR");
    embed_resource::compile(&out, embed_resource::NONE).manifest_required().unwrap();
}
