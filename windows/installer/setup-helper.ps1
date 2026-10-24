# setup-helper.ps1 — the installer's and uninstaller's work, one action per call.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup-helper.ps1 -Action <action> -Out <file> [options]
#
# Results go to -Out as key=value lines (simple for Inno Setup's Pascal Script to read). Exit code 0 = done.
# Which context each action needs:
#   as the signed-in user (Inno's ExecAsOriginalUser):  identity, user-check, import, wslconfig, wslconfig-revert,
#                                                        run-key, start, read-setup-code, user-uninstall
#   elevated (administrator):                            grant-out (first: lets the as-user steps write their
#                                                        answers into setup's temp folder), owner, check, install-wsl,
#                                                        firewall, firewall-remove, network-private, task,
#                                                        task-remove, stop-task, hosts-clear
#   the uninstaller (elevated, same person):             owner (first), user-uninstall (unless setup already ran
#                                                        it as the signed-in user), then the elevated clean-up actions
param(
  [Parameter(Mandatory)] [string] $Action,
  [string] $Out,
  [string] $Tar,
  [string] $Exe,
  [string] $User,
  [int] $InterfaceIndex = -1,
  [int] $Keep = 1,
  [string] $LogFile
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Distro = 'TinHatServer'
$WslCreatorId = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}'   # the Hyper-V firewall's id for WSL
$Ports = @(@('TCP', 80), @('TCP', 443), @('TCP', 7881), @('UDP', 7882), @('TCP', 8080))  # 8080: behind the owner's own reverse proxy (setup's "My own domain -> my own reverse proxy"); the server answers it only from home-network addresses
$TaskPath = '\Tin Hat Server\'
$TaskName = 'Keep the server running'
$SettingsKey = 'HKCU:\Software\Tin Hat Server'
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RunValue = 'Tin Hat Server'
# WSL, when it isn't installed: Microsoft's own package from github.com/microsoft/WSL (pinned, checked by SHA-256).
$WslMsiUrl = 'https://github.com/microsoft/WSL/releases/download/3.0.3/wsl.3.0.3.0.x64.msi'
$WslMsiSha256 = 'ae977286974255bd26bf925f00f40f5692c6b2084155cbc0563c09aea091f211'
# What the server needs from WSL (written into the user's .wslconfig, merged with what's there).
$WslSettings = [ordered]@{
  'wsl2.networkingMode'              = 'mirrored'  # the server gets the PC's own network address
  'wsl2.memory'                      = '3GB'       # a cap, so games keep their memory (shared by all WSL distributions)
  'experimental.hostAddressLoopback' = 'true'      # this PC can reach its own server by its network address (calls)
}

$script:result = [ordered]@{}
function Put([string]$k, $v) { $script:result[$k] = "$v" }
function Log([string]$m) {
  if (-not $LogFile) { return }
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) -ErrorAction SilentlyContinue | Out-Null
    Add-Content -Path $LogFile -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') [$Action] $m" -Encoding UTF8
  } catch {}
}
function Finish([int]$code = 0) {
  if ($Out) {
    $text = ($script:result.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value -replace "`r?`n", ' | ')" }) -join "`r`n"
    Set-Content -Path $Out -Value $text -Encoding UTF8
  }
  exit $code
}
function WslPresent {
  # The WSL package (Store or MSI) runs WSLService. Without it, wsl.exe is the inbox stub, which in a desktop session
  # offers to install WSL and waits for a key press: never call it then.
  return [bool](Get-Service -Name WSLService -ErrorAction SilentlyContinue)
}
function Run([string]$file, [string[]]$a, [int]$timeoutSec = 600) {
  # A program with UTF-8 output, a closed stdin and a time limit; returns @(exitcode, text)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $file
  $psi.Arguments = ($a | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' '
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8; $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
  $p = [Diagnostics.Process]::Start($psi)
  $p.StandardInput.Close()
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($timeoutSec * 1000)) { try { $p.Kill() } catch {} ; return @(-1, "timed out after $timeoutSec s") }
  $p.WaitForExit()
  return @($p.ExitCode, (($o.Result + $e.Result) -replace "`0", '').Trim())
}
function Wsl([string[]]$a, [int]$timeoutSec = 600) {
  # wsl.exe; returns @(exitcode, text)
  if (-not (WslPresent)) { return @(-2, 'WSL is not installed') }
  $env:WSL_UTF8 = '1'
  return Run (Join-Path $env:SystemRoot 'System32\wsl.exe') $a $timeoutSec
}
function DataDir { Join-Path $env:LOCALAPPDATA 'Tin Hat Server' }
function Ensure-Key([string]$k) {
  # Never New-Item -Force on a registry key that exists: that recreates it and wipes its values (for the Run key,
  # every other program's autostart).
  if (-not (Test-Path $k)) { New-Item -Path $k | Out-Null }
}
function DistroReg {
  # The server's WSL registration (HKCU\...\Lxss\{id}: DistributionName, BasePath, VhdFileName), or $null.
  # Throws when the registry can't be read: callers never take that for "not there".
  $base = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
  if (-not (Test-Path $base)) { return $null }
  foreach ($k in @(Get-ChildItem -Path $base -ErrorAction Stop)) {
    $p = Get-ItemProperty -Path $k.PSPath -ErrorAction Stop
    if ($p.DistributionName -eq $Distro) { return $p }
  }
  return $null
}
function DistroInstalled {
  # The registry is the authority (WSL keeps every registration there); wsl.exe can only add a "yes". A registry that
  # can't be read throws, so "not installed" always means a successful lookup.
  if (DistroReg) { return $true }
  $r = Wsl @('--list', '--quiet') 60
  return ($r[0] -eq 0) -and (($r[1] -split "`r?`n" | ForEach-Object { $_.Trim() }) -contains $Distro)
}
function DistroDisk {
  # The server's disk where WSL has it registered (normally %LOCALAPPDATA%\Tin Hat Server\server\ext4.vhdx).
  $p = DistroReg
  if (-not $p -or -not $p.BasePath) { return $null }
  $name = if ($p.VhdFileName) { $p.VhdFileName } else { 'ext4.vhdx' }
  return (Join-Path ($p.BasePath -replace '^\\\\\?\\', '') $name)
}
function DistroRunning {
  # The same test as the app's (wsl --list --running exits non-zero when nothing runs).
  $r = Wsl @('--list', '--running', '--quiet') 60
  return ($r[0] -eq 0) -and (($r[1] -split "`r?`n" | ForEach-Object { $_.Trim() }) -contains $Distro)
}
function Move-KeptAside([string]$keptDir, [string]$why) {
  # A server kept earlier is never overwritten: it moves into kept\earlier-<date>, next to the new one.
  $old = Join-Path $keptDir 'ext4.vhdx'
  if (-not (Test-Path $old)) { return }
  $stamp = (Get-Item $old).LastWriteTime.ToString('yyyyMMdd-HHmmss')
  $dest = Join-Path $keptDir "earlier-$stamp"
  for ($n = 2; (Test-Path $dest); $n++) { $dest = Join-Path $keptDir "earlier-$stamp-$n" }
  New-Item -ItemType Directory -Path $dest | Out-Null
  Move-Item -Path $old -Destination (Join-Path $dest 'ext4.vhdx') -ErrorAction Stop
  $readme = Join-Path $keptDir 'README.txt'
  if (Test-Path $readme) { Move-Item -Path $readme -Destination (Join-Path $dest 'README.txt') -ErrorAction SilentlyContinue }
  Log "kept server from $stamp moved to $dest ($why)"
}
function WslReady {
  # The WSL package (2.x/3.x, from the Store or the MSI) is installed and works.
  $r = Wsl @('--version') 60
  if ($r[0] -ne 0) { return $null }
  if ($r[1] -match 'WSL[^:\r\n]*:\s*([0-9]+)\.([0-9]+)\.([0-9]+)') { return [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])" }
  return $null
}

# ---- .wslconfig: an ini file shared by every WSL distribution of this user ------------------------------------------
function Read-Ini([string]$path) {
  # (Not `$x = if (...) {...} else { @() }`: an empty array assigned that way becomes $null.)
  $list = [Collections.Generic.List[string]]::new()
  if (Test-Path $path) { foreach ($l in [IO.File]::ReadAllLines($path)) { $list.Add($l) } }
  return , $list
}
function Ini-Find($lines, [string]$section, [string]$key) {
  # returns @(lineIndex, value) or @(-1, $null); section/key match case-insensitively
  $cur = ''
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $l = $lines[$i].Trim()
    if ($l -match '^\[(.+)\]$') { $cur = $Matches[1].Trim(); continue }
    if ($l -match '^[#;]' -or $l -notmatch '=') { continue }
    $k, $v = $l.Split('=', 2)
    if ($cur -ieq $section -and $k.Trim() -ieq $key) { return @($i, ($v -replace '\s[#;].*$', '').Trim()) }
  }
  return @(-1, $null)
}
function Ini-Set($lines, [string]$section, [string]$key, [string]$value) {
  $f = Ini-Find $lines $section $key
  $entry = "$key=$value  # added by Tin Hat Server"
  if ($f[0] -ge 0) { $lines[$f[0]] = $entry; return }
  # append at the end of the section, or a new section at the end of the file
  $cur = ''; $insertAt = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $l = $lines[$i].Trim()
    if ($l -match '^\[(.+)\]$') { if ($cur -ieq $section) { break }; $cur = $Matches[1].Trim(); if ($cur -ieq $section) { $insertAt = $i + 1 }; continue }
    if ($cur -ieq $section -and $l -ne '') { $insertAt = $i + 1 }
  }
  if ($insertAt -ge 0) { $lines.Insert($insertAt, $entry) }
  else {
    if ($lines.Count -gt 0 -and $lines[$lines.Count - 1].Trim() -ne '') { $lines.Add('') }
    $lines.Add("[$section]"); $lines.Add($entry)
  }
}
function WslConfig-Plan {
  # For each setting: what's there now and what we'd do (add / change / keep).
  $path = Join-Path $env:USERPROFILE '.wslconfig'
  $lines = Read-Ini $path
  $plan = @()
  foreach ($kv in $WslSettings.GetEnumerator()) {
    $section, $key = $kv.Key.Split('.', 2)
    $f = Ini-Find $lines $section $key
    if ($f[0] -lt 0 -and $key -eq 'networkingMode') { $f = Ini-Find $lines 'experimental' 'networkingMode' }
    $now = $f[1]
    if ($null -eq $now) { $do = 'add' }
    elseif ($key -eq 'memory') { $do = 'keep' }   # the owner chose a memory size: theirs wins
    elseif ($now -ieq $kv.Value) { $do = 'keep' }
    else { $do = 'change' }
    $plan += [pscustomobject]@{ Section = $section; Key = $key; Want = $kv.Value; Now = $now; Do = $do }
  }
  return @{ Path = $path; Exists = (Test-Path $path); Plan = $plan }
}

function WslConfig-Revert {
  # Undo what the 'wslconfig' action added: by its record, and in any case every line still marked "added by Tin Hat
  # Server" (an earlier value comes back from the backup made at install, .wslconfig.before-tinhat-server).
  $path = Join-Path $env:USERPROFILE '.wslconfig'
  $bak = "$path.before-tinhat-server"
  $added = (Get-ItemProperty -Path $SettingsKey -Name 'WslConfigAdded' -ErrorAction SilentlyContinue).WslConfigAdded
  $created = (Get-ItemProperty -Path $SettingsKey -Name 'WslConfigCreated' -ErrorAction SilentlyContinue).WslConfigCreated
  if ($null -eq $created) { $created = [int](-not (Test-Path $bak)) }
  if (-not (Test-Path $path)) { return 'nothing' }
  $lines = Read-Ini $path
  $backup = Read-Ini $bak
  $changed = $false
  if ($added) {
    foreach ($a in ($added -split "`n")) {
      $setting, $before = $a.Split('|', 2)
      $sk, $val = $setting.Split('=', 2)
      $section, $key = $sk.Split('.', 2)
      $f = Ini-Find $lines $section $key
      if ($f[0] -ge 0 -and $f[1] -ieq $val -and $lines[$f[0]] -match 'added by Tin Hat Server') {
        if ($before) { $lines[$f[0]] = "$key=$before" } else { $lines.RemoveAt($f[0]) }
        $changed = $true
      }
    }
  }
  $cur = ''
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $l = $lines[$i].Trim()
    if ($l -match '^\[(.+)\]$') { $cur = $Matches[1].Trim(); continue }
    if ($l -match '^([^=#;]+)=.*#\s*added by Tin Hat Server') {
      $key = $Matches[1].Trim()
      $old = Ini-Find $backup $cur $key
      if ($old[0] -ge 0) { $lines[$i] = "$key=$($old[1])" } else { $lines.RemoveAt($i); $i-- }
      $changed = $true
    }
  }
  if (-not $changed) { return 'nothing' }
  # drop the sections that are now empty
  $clean = [Collections.Generic.List[string]]::new()
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i].Trim() -match '^\[.+\]$') {
      $j = $i + 1; while ($j -lt $lines.Count -and $lines[$j].Trim() -eq '') { $j++ }
      if ($j -ge $lines.Count -or $lines[$j].Trim() -match '^\[.+\]$') { $i = $j - 1; continue }
    }
    $clean.Add($lines[$i])
  }
  while ($clean.Count -gt 0 -and $clean[$clean.Count - 1].Trim() -eq '') { $clean.RemoveAt($clean.Count - 1) }
  Remove-Item $bak -Force -ErrorAction SilentlyContinue
  if ($created -eq 1 -and $clean.Count -eq 0) { Remove-Item $path -Force; return 'file removed' }
  [IO.File]::WriteAllLines($path, $clean)
  return 'lines removed'
}

try {
  switch ($Action) {

    'grant-out' {
      # Elevated, before anything runs as the signed-in user: Inno Setup gives that user only read access to its temp
      # folder (so a program of theirs can't tamper with what runs elevated). The as-user steps write their answers
      # to the "out" folder inside it: give the same user (the one Inno's own ACL names) write access to that only.
      $outDir = Split-Path $LogFile
      $acl = Get-Acl (Split-Path $outDir)
      $ace = $acl.Access | Where-Object {
        $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notmatch 'SYSTEM$|\\Administrators$' } | Select-Object -First 1
      if (-not $ace) { Put 'error' 'no user in the temp folder ACL'; Finish 1 }
      $sid = $ace.IdentityReference.Translate([Security.Principal.SecurityIdentifier])
      $dacl = Get-Acl $outDir
      $dacl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
      Set-Acl -Path $outDir -AclObject $dacl
      Put 'granted' $sid.Value
    }

    'identity' {
      $id = [Security.Principal.WindowsIdentity]::GetCurrent()
      Put 'user' $id.Name
      Put 'sid' $id.User.Value
      Put 'localappdata' $env:LOCALAPPDATA
      Put 'userprofile' $env:USERPROFILE
      Put 'admin' ((New-Object Security.Principal.WindowsPrincipal $id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
    }

    'owner' {
      # Elevated: the Windows account the server belongs to (its startup task runs as that account), if any, and who
      # this runs as. Compared by SID (PC\alex and DOMAIN\alex are different people); names for the messages.
      $me = [Security.Principal.WindowsIdentity]::GetCurrent()
      Put 'me' $me.Name
      Put 'me.sid' $me.User.Value
      $t = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
      if ($t) {
        Put 'task.user' $t.Principal.UserId
        try {
          $u = $t.Principal.UserId
          $sid = if ($u -match '^S-1-') { $u } else { (New-Object Security.Principal.NTAccount $u).Translate([Security.Principal.SecurityIdentifier]).Value }
          Put 'task.sid' $sid
        } catch { Log "task owner $($t.Principal.UserId): no SID ($($_.Exception.Message))" }
      }
    }

    'leftovers' {
      # Elevated, after an uninstall: anything of Tin Hat Server's machine-wide part still there.
      $left = @()
      if (Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue) { $left += 'the startup task' }
      $n = @(Get-NetFirewallHyperVRule -Name 'TinHatServer-*' -ErrorAction SilentlyContinue).Count
      if ($n -gt 0) { $left += "$n firewall rules" }
      if ($Exe -and (Test-Path $Exe)) { $left += "the program ($Exe)" }
      Put 'left' ($left -join ', ')
    }

    'check' {
      # Windows, virtualization, memory, disk, WSL, ports, networks. Elevated (port owners need it).
      $os = Get-CimInstance Win32_OperatingSystem
      Put 'os.build' $os.BuildNumber
      Put 'os.caption' $os.Caption
      Put 'os.ok' ([int]$os.BuildNumber -ge 22621)
      $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
      $cs = Get-CimInstance Win32_ComputerSystem
      # With Hyper-V / VBS already running, Windows reports the firmware flag as False: a running hypervisor counts.
      Put 'virt.firmware' $cpu.VirtualizationFirmwareEnabled
      Put 'virt.hypervisor' $cs.HypervisorPresent
      Put 'virt.ok' ([bool]$cpu.VirtualizationFirmwareEnabled -or [bool]$cs.HypervisorPresent)
      Put 'mem.gb' ([int][math]::Round($cs.TotalPhysicalMemory / 1GB))
      $drive = (Get-Item $env:SystemDrive).PSDrive.Name
      Put 'disk.freegb' ([int][math]::Floor((Get-PSDrive $drive).Free / 1GB))
      $vmp = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
      Put 'wsl.vmp' ($vmp.State -eq 'Enabled')
      Put 'wsl.vmp.pending' ($vmp.State -eq 'EnablePending')
      $ver = WslReady
      Put 'wsl.version' $ver
      Put 'wsl.ok' (($null -ne $ver) -and ($ver -ge [version]'2.0.0') -and ($vmp.State -eq 'Enabled'))
      # Programs already using the server's ports on this PC.
      $busy = @()
      foreach ($p in $Ports) {
        $owners = if ($p[0] -eq 'TCP') { Get-NetTCPConnection -State Listen -LocalPort $p[1] -ErrorAction SilentlyContinue }
                  else { Get-NetUDPEndpoint -LocalPort $p[1] -ErrorAction SilentlyContinue }
        foreach ($o in $owners) {
          $proc = Get-Process -Id $o.OwningProcess -ErrorAction SilentlyContinue
          $name = if ($o.OwningProcess -eq 4) { 'Windows (System: IIS or another web service)' } elseif ($proc) { "$($proc.ProcessName) (process $($o.OwningProcess))" } else { "process $($o.OwningProcess)" }
          $busy += "$($p[0]) $($p[1]): $name"
        }
      }
      Put 'ports.busy' (($busy | Select-Object -Unique) -join '; ')
      # Port ranges Windows holds back (Hyper-V, WinNAT): the server couldn't use a port inside one.
      $excluded = @()
      foreach ($proto in 'tcp', 'udp') {
        $txt = cmd /c "netsh interface ipv4 show excludedportrange protocol=$proto 2>nul"
        foreach ($line in $txt) {
          if ($line -match '^\s*(\d+)\s+(\d+)') {
            foreach ($p in $Ports) {
              if ($p[0] -ieq $proto -and $p[1] -ge [int]$Matches[1] -and $p[1] -le [int]$Matches[2]) { $excluded += "$($p[0]) $($p[1])" }
            }
          }
        }
      }
      Put 'ports.reserved' (($excluded | Select-Object -Unique) -join '; ')
      # Networks: Tin Hat Server only accepts connections on networks Windows treats as Private (home).
      $nets = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.IPv4Connectivity -in 'Internet', 'LocalNetwork' })
      $i = 0
      foreach ($n in $nets) {
        Put "net.$i.name" $n.Name; Put "net.$i.alias" $n.InterfaceAlias; Put "net.$i.index" $n.InterfaceIndex; Put "net.$i.category" $n.NetworkCategory
        $i++
      }
      Put 'net.count' $i
      # One server per PC (it needs the PC's ports): is it already set up for another Windows account?
      $t = Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
      if ($t) { Put 'task.user' $t.Principal.UserId }
    }

    'user-check' {
      # As the signed-in user: their WSL distributions and .wslconfig.
      try { Put 'distro.installed' (DistroInstalled); Put 'distro.known' 'True' }
      catch { Put 'distro.known' 'False'; Log "distro lookup failed: $($_.Exception.Message)" }
      $kept = Join-Path (DataDir) 'kept\ext4.vhdx'
      Put 'kept' (Test-Path $kept)
      Put 'kept.path' $kept
      if (Test-Path $kept) { Put 'kept.date' (Get-Item $kept).LastWriteTime.ToString('d MMMM yyyy') }
      $w = WslConfig-Plan
      Put 'wslconfig.path' $w.Path
      Put 'wslconfig.exists' $w.Exists
      foreach ($p in $w.Plan) { Put "wslconfig.$($p.Key)" "$($p.Do)|$($p.Now)|$($p.Want)" }
      $others = @()
      $r = Wsl @('--list', '--quiet') 60
      if ($r[0] -eq 0) { $others = @($r[1] -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -ne $Distro }) }
      Put 'wsl.others' ($others -join ', ')
      $running = Wsl @('--list', '--running', '--quiet') 60
      Put 'wsl.running' ($running[0] -eq 0 -and $running[1].Trim() -ne '' -and $running[1] -notmatch 'no running')
    }

    'install-wsl' {
      # Elevated. Virtual Machine Platform + Microsoft's WSL package. Exit 3010 = restart needed.
      $restart = $false
      $vmp = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform
      if ($vmp.State -ne 'Enabled') {
        Log 'enabling Virtual Machine Platform'
        $p = Start-Process dism.exe -ArgumentList '/online', '/enable-feature', '/featurename:VirtualMachinePlatform', '/all', '/norestart', '/quiet' -Wait -PassThru -WindowStyle Hidden
        Log "dism exit $($p.ExitCode)"
        if ($p.ExitCode -eq 3010) { $restart = $true } elseif ($p.ExitCode -ne 0) { Put 'error' "Windows couldn't turn on Virtual Machine Platform (DISM error $($p.ExitCode))."; Finish 1 }
      }
      $ver = WslReady
      if ($null -eq $ver -or $ver -lt [version]'2.0.0') {
        $msi = Join-Path $env:TEMP 'tinhat-wsl.msi'
        Log "downloading $WslMsiUrl"
        try {
          [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
          Invoke-WebRequest -UseBasicParsing -Uri $WslMsiUrl -OutFile $msi
        } catch {
          Put 'error' "Downloading Windows' Linux support (WSL) from Microsoft didn't work: $($_.Exception.Message). Check the internet connection and try again."
          Finish 1
        }
        $h = (Get-FileHash $msi -Algorithm SHA256).Hash.ToLower()
        if ($h -ne $WslMsiSha256) { Remove-Item $msi -Force; Put 'error' "The WSL download didn't match its checksum ($h). Try again."; Finish 1 }
        Log 'installing the WSL package'
        $p = Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait -PassThru
        Log "msiexec exit $($p.ExitCode)"
        Remove-Item $msi -Force -ErrorAction SilentlyContinue
        if ($p.ExitCode -eq 3010) { $restart = $true } elseif ($p.ExitCode -ne 0) { Put 'error' "Installing WSL didn't work (error $($p.ExitCode))."; Finish 1 }
      }
      Put 'restart' $restart
      if ($restart) { Finish 3010 }
    }

    'import' {
      # As the signed-in user: the server becomes the WSL distribution "TinHatServer" in %LOCALAPPDATA%\Tin Hat Server\server.
      $dir = Join-Path (DataDir) 'server'
      if (DistroInstalled) { Put 'imported' 'already'; Finish 0 }
      # WSL opens a "Welcome to Windows Subsystem for Linux" window (Docker Desktop, VS Code, …) the first time it's
      # used. It means nothing to someone installing a chat server: mark it as seen, if WSL hasn't already.
      $lxss = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss'
      Ensure-Key $lxss
      if ($null -eq (Get-ItemProperty $lxss -Name OOBEComplete -ErrorAction SilentlyContinue)) {
        New-ItemProperty -Path $lxss -Name OOBEComplete -Value 1 -PropertyType DWord | Out-Null
        Log 'marked WSL welcome window as seen'
      }
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      $kept = Join-Path (DataDir) 'kept\ext4.vhdx'
      if ($Keep -eq 1 -and (Test-Path $kept)) {
        # the server kept at the last uninstall: put its disk back and register it as it is
        $disk = Join-Path $dir 'ext4.vhdx'
        if (Test-Path $disk) {
          # an unregistered disk left in the way (an earlier import that failed): set it aside, never overwrite it
          $aside = Join-Path (Split-Path $kept) ('earlier-' + (Get-Item $disk).LastWriteTime.ToString('yyyyMMdd-HHmmss') + '-unregistered')
          New-Item -ItemType Directory -Force -Path $aside | Out-Null
          Move-Item $disk (Join-Path $aside 'ext4.vhdx') -ErrorAction Stop
          Log "an unregistered disk was in the way: moved to $aside"
        }
        Move-Item $kept $disk -ErrorAction Stop
        $r = Wsl @('--import-in-place', $Distro, $disk) 600
        if ($r[0] -ne 0 -and -not (DistroInstalled)) {
          # back to where it was kept, so the next try (or a later install) still finds it
          try { Move-Item $disk $kept -ErrorAction Stop } catch { Log "couldn't move the disk back to kept: $($_.Exception.Message)" }
        }
        Put 'imported' 'kept'
      } else {
        if (-not (Test-Path $Tar)) { Put 'error' "The server's files are missing ($Tar)."; Finish 1 }
        $r = Wsl @('--import', $Distro, $dir, $Tar, '--version', '2') 1800
        Put 'imported' 'new'
      }
      Log "import: exit $($r[0]) $($r[1])"
      if ($r[0] -ne 0) { Put 'error' "WSL couldn't set up the server: $($r[1])"; Finish 1 }
    }

    'wslconfig' {
      # As the signed-in user: merge the server's settings into %USERPROFILE%\.wslconfig. Never replaces the file:
      # a backup first, the owner's lines and comments stay, our lines say "added by Tin Hat Server", and what we
      # added is remembered so uninstalling removes exactly that.
      $w = WslConfig-Plan
      $todo = @($w.Plan | Where-Object { $_.Do -ne 'keep' })
      if ($todo.Count -eq 0) { Put 'changed' 'False'; Finish 0 }
      if ($w.Exists) { Copy-Item $w.Path "$($w.Path).before-tinhat-server" -Force }
      $lines = Read-Ini $w.Path
      $added = @()
      foreach ($p in $todo) {
        if ($p.Key -eq 'networkingMode') {
          # an old [experimental] networkingMode would override nothing, but would confuse: replace it in place
          $old = Ini-Find $lines 'experimental' 'networkingMode'
          if ($old[0] -ge 0) { $lines.RemoveAt($old[0]) }
        }
        Ini-Set $lines $p.Section $p.Key $p.Want
        $added += "$($p.Section).$($p.Key)=$($p.Want)|$($p.Now)"
      }
      [IO.File]::WriteAllLines($w.Path, $lines)
      Ensure-Key $SettingsKey
      Set-ItemProperty -Path $SettingsKey -Name 'WslConfigAdded' -Value ($added -join "`n")
      Set-ItemProperty -Path $SettingsKey -Name 'WslConfigCreated' -Value ([int](-not $w.Exists))
      Put 'changed' 'True'
      Put 'added' ($added -join '; ')
      Log "wslconfig: $($added -join '; ')"
    }

    'wslconfig-revert' {
      Put 'reverted' (WslConfig-Revert)
    }

    'firewall' {
      # Elevated: let devices on PRIVATE (home) networks reach the server's ports. TCP 80 = setup page and the
      # certificate download for new devices; 443 = Tin Hat + dashboard; 7881 TCP + 7882 UDP = calls; 8080 = the owner's
      # reverse proxy on the home network (only answered in that mode).
      foreach ($p in $Ports) {
        $name = "TinHatServer-$($p[0])-$($p[1])"
        Remove-NetFirewallHyperVRule -Name $name -ErrorAction SilentlyContinue
        New-NetFirewallHyperVRule -Name $name -DisplayName "Tin Hat Server ($($p[0]) $($p[1]))" -Direction Inbound `
          -VMCreatorId $WslCreatorId -Protocol $p[0] -LocalPorts $p[1] -Action Allow -Profiles Private | Out-Null
      }
      Put 'rules' ((Get-NetFirewallHyperVRule -Name 'TinHatServer-*' | ForEach-Object Name) -join ', ')
    }

    'firewall-remove' {
      Get-NetFirewallHyperVRule -Name 'TinHatServer-*' -ErrorAction SilentlyContinue | ForEach-Object { Remove-NetFirewallHyperVRule -Name $_.Name }
      Put 'removed' 'True'
    }

    'network-private' {
      # Elevated: the owner said this network is their home: Windows treats it as Private.
      Set-NetConnectionProfile -InterfaceIndex $InterfaceIndex -NetworkCategory Private
      Put 'category' (Get-NetConnectionProfile -InterfaceIndex $InterfaceIndex).NetworkCategory
      Log "network $InterfaceIndex set to Private"
    }

    'task' {
      # Elevated: "\Tin Hat Server\Keep the server running" runs TinHatServer.exe --serve as the owner, without a stored
      # password (S4U), when Windows starts (before anyone signs in) and when the owner signs in.
      $a = New-ScheduledTaskAction -Execute $Exe -Argument '--serve'
      $p = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
      $t1 = New-ScheduledTaskTrigger -AtStartup
      $t2 = New-ScheduledTaskTrigger -AtLogOn -User $User
      $s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
      Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Action $a -Principal $p -Trigger @($t1, $t2) -Settings $s `
        -Description 'Keeps Tin Hat Server running in the background (the WSL distribution TinHatServer). Pause it from the tray icon.' -Force | Out-Null
      Put 'task' "$TaskPath$TaskName"
    }

    'stop-task' {
      Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
      if ($Exe) { Get-Process TinHatServer -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $Exe } | Stop-Process -Force }
      Put 'stopped' 'True'
    }

    'task-remove' {
      Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
      try { $svc = New-Object -ComObject Schedule.Service; $svc.Connect(); $svc.GetFolder('\').DeleteFolder('Tin Hat Server', 0) } catch {}
      Put 'removed' 'True'
    }

    'run-key' {
      # As the signed-in user: the tray icon starts when they sign in.
      Ensure-Key $RunKey
      Set-ItemProperty -Path $RunKey -Name $RunValue -Value "`"$Exe`" --tray"
      Ensure-Key $SettingsKey
      foreach ($k in 'Paused', 'KeepAwake') { if ($null -eq (Get-ItemProperty $SettingsKey -Name $k -ErrorAction SilentlyContinue)) { Set-ItemProperty $SettingsKey -Name $k -Value 0 -Type DWord } }
      if ($null -eq (Get-ItemProperty $SettingsKey -Name 'StartWithWindows' -ErrorAction SilentlyContinue)) { Set-ItemProperty $SettingsKey -Name 'StartWithWindows' -Value 1 -Type DWord }
      Set-ItemProperty -Path $SettingsKey -Name 'InstallDir' -Value (Split-Path $Exe)
      Put 'run' 'True'
    }

    'start' {
      # As the signed-in user: start (the scheduled task's keep-alive), then wait until the setup page answers.
      if (-not (DistroInstalled)) { Put 'error' 'The server is not installed.'; Finish 1 }
      Set-ItemProperty -Path $SettingsKey -Name 'Paused' -Value 0 -Type DWord
      $o = & $Exe --start | Out-String
      Log "start: $o"
      $w = & $Exe --wait-ready 420 | Out-String
      $ok = $LASTEXITCODE -eq 0
      Log "wait-ready: $w"
      if ($ok) {
        # Once set up, also wait for the chat server (the dashboard's sign-in needs it).
        $r = Wsl @('-d', $Distro, '-u', 'root', '--exec', '/usr/local/lib/tinhat-wsl/ctl', 'wait-ready', '300') 330
        Log "ctl wait-ready: exit $($r[0])"
      }
      Put 'ready' $ok
      if (-not $ok) { Put 'error' "The server didn't answer within 7 minutes. It may still be starting: the tray icon shows when it's ready."; Finish 1 }
    }

    'restart-distro' {
      # As the signed-in user (Repair): stop the server and its Linux side completely, so 'start' brings up a fresh one
      # (a server stuck half-started, or paused and forgotten, comes back clean). Its data stays.
      if ($Exe -and (Test-Path $Exe)) { $s = Run $Exe @('--stop') 240; Log "stop for repair: exit $($s[0]) $($s[1])" }
      $r = Wsl @('--terminate', $Distro) 120
      Log "terminate for repair: exit $($r[0]) $($r[1])"
      if ($r[0] -ne 0) { Put 'error' "WSL couldn't stop the server: $($r[1])"; Finish 1 }
      if (DistroRunning) { Put 'error' 'The server was still running after WSL was told to stop it.'; Finish 1 }
      Put 'restarted' 'True'
    }

    'read-setup-code' {
      # The setup code (before setup) and the server's phase, for the installer's last page.
      $st = (& $Exe --status | Out-String) | ConvertFrom-Json
      Put 'phase' $st.phase
      Put 'name' $st.serverName
      if ($st.phase -ne 'ready') { Put 'code' ((& $Exe --setup-code | Out-String).Trim()) }
    }

    'user-uninstall' {
      # The signed-in user's part of uninstalling: setup runs it as that user, the uninstaller (elevated, the same
      # person) when it's started from Windows' Settings. -Keep 1: the server's disk moves to
      # %LOCALAPPDATA%\Tin Hat Server\kept (a reinstall offers it back). Nothing is unregistered until that worked:
      # unregistering deletes the disk. Any failure stops here with exit 1, before the caller removes anything else.
      $data = DataDir
      $keptDir = Join-Path $data 'kept'
      $present = DistroInstalled          # throws (→ exit 1) when the registry can't be read
      $disk = DistroDisk
      if (-not $disk) { $disk = Join-Path $data 'server\ext4.vhdx' }
      Log "server registered: $present; disk: $disk"
      if ($Keep -eq 1 -and $present -and -not (Test-Path $disk)) {
        Put 'error' "Setup can't find the server's disk (WSL has it at $disk), so it can't keep your data. Nothing was removed."
        Finish 1
      }
      if ($Exe -and (Test-Path $Exe)) { $s = Run $Exe @('--stop') 240; Log "stop: exit $($s[0])" }
      Get-Process TinHatServer -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      $r = Wsl @('--terminate', $Distro) 60
      $moved = $false; $kept = $null
      if ($Keep -eq 1 -and (Test-Path $disk)) {
        New-Item -ItemType Directory -Force -Path $keptDir | Out-Null
        Move-KeptAside $keptDir 'a newer server is being kept'
        $kept = Join-Path $keptDir 'ext4.vhdx'
        # WSL keeps a stopped distribution's disk attached to its VM until the VM stops. With nothing else running,
        # stop WSL and move the disk (instant, no extra space); otherwise WSL copies it out (export), which works
        # while other distributions keep running.
        $running = Wsl @('--list', '--running', '--quiet') 60
        $others = @($running[1] -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -ne $Distro -and $running[0] -eq 0 })
        if ($others.Count -eq 0) { $r = Wsl @('--shutdown') 120; Log "wsl --shutdown: exit $($r[0])" }
        for ($i = 0; $i -lt 15 -and -not $moved; $i++) {
          try { Move-Item $disk $kept -ErrorAction Stop; $moved = $true } catch { Start-Sleep 2 }
        }
        if (-not $moved) {
          if (-not $present) { Put 'error' "Keeping the server's data didn't work: its disk ($disk) is in use. Nothing was removed."; Finish 1 }
          Log "the disk is in use (other distributions running: $($others -join ', ')); exporting a copy"
          $r = Wsl @('--export', $Distro, $kept, '--vhd') 3600
          if ($r[0] -ne 0 -or -not (Test-Path $kept)) {
            Remove-Item -Force $kept -ErrorAction SilentlyContinue
            Put 'error' "Keeping the server's data didn't work: $($r[1]). Nothing was removed."
            Finish 1
          }
        }
        Put 'kept.how' $(if ($moved) { 'moved' } else { 'copied' })
        try {
          Set-Content -Path (Join-Path $keptDir 'README.txt') -Encoding UTF8 -ErrorAction Stop -Value @(
            'This is your Tin Hat Server (accounts, rooms, messages and settings), kept when Tin Hat Server was uninstalled.',
            'Installing Tin Hat Server again offers to use it. To delete it for good, delete this folder.',
            'Servers kept at earlier uninstalls are in the earlier-<date> folders next to it (a reinstall offers only the newest).')
        } catch { Log "README.txt not written: $($_.Exception.Message)" }
        Put 'kept' $kept
      }
      if ($present) {
        $r = Wsl @('--unregister', $Distro) 300
        Log "unregister: exit $($r[0]) $($r[1])"
        if ($r[0] -ne 0 -or (DistroInstalled)) {
          # Still registered: the server stays as it was. A moved disk goes back where WSL expects it (otherwise the
          # registration points at nothing and neither Repair nor another Uninstall can use it); a copy is dropped, so
          # it can't later pass for a server kept on purpose.
          # Unregistering isn't atomic (WSL may have deleted the disk before failing), so the kept copy is only given up
          # when the server is positively still registered with its own disk intact; anything uncertain keeps it.
          $msg = "WSL couldn't remove the server: $($r[1])."
          $still = $false
          try { $still = DistroInstalled } catch { Log "after the failed unregister the registration can't be read: $($_.Exception.Message)" }
          if ($still -and $moved -and -not (Test-Path $disk)) {
            try {
              Move-Item $kept $disk -ErrorAction Stop
              Remove-Item -Force (Join-Path $keptDir 'README.txt') -ErrorAction SilentlyContinue
              Put 'kept' ''
              $msg += ' Its data is back in place.'
            } catch { $msg += " Its data is safe in $kept (move it back to $disk before using the server again)." }
          } elseif ($still -and -not $moved -and (Test-Path $disk)) {
            try {
              Remove-Item -Force $kept -ErrorAction Stop
              Remove-Item -Force (Join-Path $keptDir 'README.txt') -ErrorAction SilentlyContinue
              Put 'kept' ''
            } catch { $msg += " A copy of its data is in $kept." }
          } else {
            $msg += " Its data is safe in $kept."
          }
          Put 'error' $msg
          Finish 1
        }
      }
      Remove-ItemProperty -Path $RunKey -Name $RunValue -ErrorAction SilentlyContinue
      Put 'wslconfig' (WslConfig-Revert)
      Remove-Item -Path $SettingsKey -Recurse -Force -ErrorAction SilentlyContinue
      if ($Keep -eq 1) {
        Remove-Item -Recurse -Force (Join-Path $data 'server') -ErrorAction SilentlyContinue
      } else {
        # Everything of this server; a server that was kept at an earlier uninstall stays (it was kept on purpose).
        Get-ChildItem -Force -Path $data -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'kept' } |
          Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path (Join-Path $keptDir '*')) { Put 'kept.earlier' $keptDir }
        else { Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue }
      }
      Put 'done' 'True'
    }

    'hosts-clear' {
      if ($Exe -and (Test-Path $Exe)) { & $Exe --hosts-clear | Out-Null; Put 'hosts' $LASTEXITCODE }
    }

    default { Put 'error' "unknown action $Action"; Finish 2 }
  }
  Finish 0
} catch {
  Put 'error' $_.Exception.Message
  Log "error: $($_.Exception.Message)"
  Finish 1
}
