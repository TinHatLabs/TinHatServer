# build.ps1 — runs on the Windows build machine; build-windows.sh on the Linux side stages everything
# and calls it. Builds TinHatServer.exe (Rust, MSVC) and the installer (Inno Setup 6), optionally signed.
#
#   powershell -ExecutionPolicy Bypass -File build.ps1 -Stage C:\th-build\stage -Version 0.2.7 [-Sign -SignArgs "..."]
#
# Code signing is OFF unless -Sign is given. -SignArgs are signtool's certificate options, for example:
#   a certificate in the store:      /sha1 <thumbprint>
#   Microsoft Trusted Signing:       /dlib <path>\Azure.CodeSigning.Dlib.dll /dmdf <path>\metadata.json
param(
  [Parameter(Mandatory)] [string] $Stage,
  [Parameter(Mandatory)] [string] $Version,
  [switch] $Sign,
  [string] $SignArgs = '',
  [string] $TimestampUrl = 'http://timestamp.digicert.com'
)
$ErrorActionPreference = 'Stop'
function Step($m) { Write-Output ""; Write-Output "== $m" }
# Native tools print progress on stderr; in Windows PowerShell 5.1 that becomes an error record when merged with 2>&1,
# so run them through cmd and judge them by their exit code only.
function Native([string]$cmdline) {
  cmd /c "$cmdline 2>&1" | ForEach-Object { "$_" } | Where-Object { $_ -notmatch '^\s+(Compiling|Downloaded|Downloading) ' }
  return $LASTEXITCODE
}

$cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not (Test-Path $cargo)) { throw "cargo not found ($cargo)" }
if (-not $iscc) { throw 'Inno Setup 6 (ISCC.exe) not found' }

Step "TinHatServer.exe $Version"
$env:TINHAT_ICON_DIR = Join-Path $Stage 'icons'
$env:CARGO_TARGET_DIR = Join-Path $Stage 'target'
# The build machine's paths never go into the binary (panic messages name source files, crates included): the cargo
# home (inside the Windows user's profile) and the stage folder become neutral names. CARGO_ENCODED_RUSTFLAGS
# (0x1f-separated) keeps paths with spaces whole. The check after the build refuses a binary that still names them.
$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
$env:RUSTFLAGS = $null
$env:CARGO_ENCODED_RUSTFLAGS = "--remap-path-prefix=$cargoHome=C:\cargo" + [char]0x1f + "--remap-path-prefix=$Stage=C:\build"
Push-Location (Join-Path $Stage 'tray')
$out = Native "`"$cargo`" build --release --locked"
$rc = $out[-1]; $out | Select-Object -SkipLast 1
Pop-Location
if ($rc -ne 0) { throw "cargo build failed ($rc)" }
$bin = Join-Path $Stage 'target\release\TinHatServer.exe'
$v = (Get-Item $bin).VersionInfo.ProductVersion
if ($v -ne $Version) { throw "TinHatServer.exe says version $v, expected $Version" }
$raw = [System.IO.File]::ReadAllBytes($bin)
$texts = @([System.Text.Encoding]::UTF8.GetString($raw), [System.Text.Encoding]::Unicode.GetString($raw),
           [System.Text.Encoding]::Unicode.GetString($raw, 1, $raw.Length - 1))
$needles = @($env:USERPROFILE, $cargoHome, $Stage, $(if ($env:USERNAME.Length -ge 4) { "\$($env:USERNAME)\" })) |
  Where-Object { $_ } | ForEach-Object { $_; $_.Replace('\', '/') }
foreach ($p in $needles) {
  foreach ($t in $texts) {
    if ($t.IndexOf($p, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { throw "TinHatServer.exe names a build machine path ($p)" }
  }
}

$isccArgs = @("/DAppVersion=$Version", "/DBinDir=$(Split-Path $bin)", "/DIconDir=$(Join-Path $Stage 'icons')",
              "/DRootfsTar=$(Join-Path $Stage "tinhat-server-$Version-wsl.tar.gz")", "/O$(Join-Path $Stage 'out')")
if ($Sign) {
  # OPTIONAL. Off by default: nothing is signed unless -Sign is passed (see windows/README.md, "Code signing").
  if (-not $signtool) { throw 'signtool.exe not found (Windows SDK)' }
  if (-not $SignArgs) { throw '-Sign needs -SignArgs (the certificate: /sha1 <thumbprint>, or Trusted Signing /dlib … /dmdf …)' }
  Step 'signing TinHatServer.exe'
  $out = Native "`"$signtool`" sign /fd sha256 /tr $TimestampUrl /td sha256 $SignArgs `"$bin`""
  $out | Select-Object -SkipLast 1
  if ($out[-1] -ne 0) { throw 'signing TinHatServer.exe failed' }
  $isccArgs += '/DSign'
  $isccArgs += "/Stinhat=`"$signtool`" sign /fd sha256 /tr $TimestampUrl /td sha256 $SignArgs `$f"
}

Step 'installer'
$q = ($isccArgs | ForEach-Object { '"' + ($_ -replace '"', '""') + '"' }) -join ' '
$out = Native "`"$iscc`" /Q $q `"$(Join-Path $Stage 'installer\TinHatServer.iss')`""
$out | Select-Object -SkipLast 1
if ($out[-1] -ne 0) { throw "ISCC failed ($($out[-1]))" }
$setup = Join-Path $Stage "out\TinHatServer-Setup-$Version.exe"
if ($Sign) { $out = Native "`"$signtool`" verify /pa `"$setup`""; if ($out[-1] -ne 0) { throw 'the installer signature does not verify' } }
$h = (Get-FileHash $setup -Algorithm SHA256).Hash.ToLower()
Write-Output "built $setup ($([math]::Round((Get-Item $setup).Length / 1MB)) MB) sha256 $h"
