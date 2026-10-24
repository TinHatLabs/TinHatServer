; Tin Hat Server for Windows — the installer (Inno Setup 6). Saved as UTF-8 with a BOM (it has ✓ ✗ → … in it).
;
; Build: windows/build-windows.sh (it runs ISCC on the Windows build machine over SSH), or by hand:
;   ISCC /DAppVersion=0.2.7 /DBinDir=<dir with TinHatServer.exe> /DIconDir=<dir with app.ico> ^
;        /DRootfsTar=<tinhat-server-<ver>-wsl.tar.gz> /O<output dir> TinHatServer.iss
; Optional code signing (only with /DSign; see windows/README.md "Code signing"):
;   ISCC ... /DSign "/Stinhat=signtool.exe sign /fd sha256 /tr <timestamp url> /td sha256 <certificate options> $f"
;
; What it does (the work is in setup-helper.ps1, which can be tested on its own):
;   checks   Windows 11 22H2+, virtualization, memory, disk, ports 80/443/7881/7882, the network's profile
;   WSL      if missing: Virtual Machine Platform + Microsoft's WSL package, one restart, then setup resumes itself
;   server   the WSL distribution "TinHatServer" in %LOCALAPPDATA%\Tin Hat Server\server (as the signed-in user)
;   settings mirrored networking, a 3 GB memory cap, host-address loopback: merged into the user's .wslconfig
;   firewall Hyper-V firewall rules for TCP 80/443/7881 + UDP 7882, private networks only
;   startup  a scheduled task (the server starts with Windows, before anyone signs in) + the tray icon at sign-in
; Uninstall asks: keep the server's data (its disk moves to %LOCALAPPDATA%\Tin Hat Server\kept) or remove everything.
;
; It opens on a choice, like the Tin Hat app's installer (and in its dark look): Install (Update / Reinstall when one is
; there), Repair (the Windows side put back — WSL settings, firewall rules, the startup task, the tray icon — and the
; server restarted cleanly and checked; its data stays) and Uninstall (a page with "keep my server's data", then the
; installed uninstaller removes the rest). Setup's Uninstall does the server's part itself, as the signed-in person,
; and only then runs the uninstaller (/USERPARTDONE=1): if keeping or removing the server fails, nothing else goes.
;
; Command line: /VERYSILENT installs without questions (add /NETWORKPRIVATE=1 to set a Public network to Private,
; /CHANGEWSLNETWORK=1 to accept replacing another WSL network mode, /USEKEPT=0 to start a new server even when one
; was kept at an uninstall); /MODE=repair or /MODE=uninstall instead of
; installing (an error when Tin Hat Server isn't installed: never an install instead). Uninstall (here or the
; uninstaller's own): /VERYSILENT keeps the data unless /REMOVEDATA=1.
; Exit codes besides Inno's own: 11 = installed or repaired, but the server didn't start; 12 = uninstalled, but the
; check afterwards found the server still there or its data not kept (the log says which).
; Needs Inno Setup 6.6 or newer (the dark wizard style and command-link buttons).

#if Ver < EncodeVer(6, 6, 0)
  #error Tin Hat Server's installer needs Inno Setup 6.6 or newer
#endif
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef BinDir
  #define BinDir "..\tray\target\release"
#endif
#ifndef IconDir
  #define IconDir "icons"
#endif
#ifndef RootfsTar
  #define RootfsTar "tinhat-server-wsl.tar.gz"
#endif

[Setup]
AppId={{6A0C3E1B-5E8F-4B7A-9C11-2D7F0B9E4A21}
AppName=Tin Hat Server
AppVersion={#AppVersion}
AppVerName=Tin Hat Server {#AppVersion}
AppPublisher=Tin Hat
AppPublisherURL=https://tinhat.dev/
VersionInfoVersion={#AppVersion}
VersionInfoDescription=Tin Hat Server setup
DefaultDirName={autopf}\Tin Hat Server
; The first page is the Install / Repair / Uninstall choice.
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=TinHatServer-Setup-{#AppVersion}
SetupIconFile={#IconDir}\app.ico
UninstallDisplayIcon={app}\TinHatServer.exe
UninstallDisplayName=Tin Hat Server
; Tin Hat is a dark app, and its installer is dark: Tin Hat Server's matches it.
WizardStyle=modern dark includetitlebar
WizardSizePercent=120
WizardImageFile=assets\tinhat-server-wizard.png
WizardImageBackColor=#000000
WizardSmallImageFile=assets\tinhat-wizard-small.png
Compression=lzma2/max
SolidCompression=no
SetupLogging=yes
CloseApplications=no
RestartApplications=no
UsedUserAreasWarning=no
; "Uninstall" from this setup leaves nothing to uninstall later.
Uninstallable=not IsUninstallMode
CreateUninstallRegKey=not IsUninstallMode
#ifdef Sign
SignTool=tinhat
SignedUninstaller=yes
#endif

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Messages]
WelcomeLabel2=This sets up Tin Hat Server on this PC: your group's own chat and call server, running quietly in the background.%n%nIt uses Windows' built-in Linux support (WSL). If that isn't switched on yet, setup switches it on. That needs one restart, and setup carries on by itself afterwards.%n%nIt takes 5 to 10 minutes.
ReadyLabel2a=Setup is ready. When it's done, your browser opens the server's setup page.
PrepareToInstallNeedsRestart=Restart now? When you sign in again, setup carries on by itself.
ConfirmUninstall=Remove Tin Hat Server from this PC?%n%nNext you choose whether to keep your server's data (accounts, rooms and messages).
UninstalledAll=Tin Hat Server was removed from this PC.%n%nWindows' Linux support (WSL) stays installed; other programs may use it. You can remove "Windows Subsystem for Linux" in Settings → Apps if nothing else needs it.

[Files]
Source: "{#BinDir}\TinHatServer.exe"; DestDir: "{app}"; Flags: ignoreversion; Check: not IsUninstallMode
Source: "setup-helper.ps1"; DestDir: "{app}"; Flags: ignoreversion; Check: not IsUninstallMode
Source: "setup-helper.ps1"; Flags: dontcopy
Source: "{#RootfsTar}"; DestName: "tinhat-server-wsl.tar.gz"; Flags: dontcopy nocompression

[Icons]
Name: "{userprograms}\Tin Hat Server"; Filename: "{app}\TinHatServer.exe"; Comment: "Open your Tin Hat server's dashboard (the tray icon has the rest)"; Check: not IsUninstallMode

[Code]
const
  SetupUrl = 'http://127.0.0.1/';
  UninstKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{6A0C3E1B-5E8F-4B7A-9C11-2D7F0B9E4A21}_is1';
  ModeInstall = 0;
  ModeRepair = 1;
  ModeUninstall = 2;

var
  Helper, OutDir, HelperLog, PowerShell, DataDir, ResumeFile: String;
  IdUser, IdSid, IdLocalAppData: String;
  Resume, UserMismatch, ChecksDone, ChecksOk, NeedWsl, HasDistro, ServerOk, AlreadySetUp: Boolean;
  ChecksPage: TWizardPage;
  ChecksText: TNewStaticText;
  RetryButton: TNewButton;
  NetCheck, KeptCheck: TNewCheckBox;
  NetIndex: Integer;
  WslPage: TOutputMsgMemoWizardPage;
  WslAgree: TNewCheckBox;
  WslNeedsAgree, WslPageNeeded: Boolean;
  OpenCheck: TNewCheckBox;
  SetupCode, ServerError, KeptDate: String;
  KeepData, UserPartDone: Boolean;
  R: TArrayOfString;
  // The first page: Install / Repair / Uninstall
  Mode: Integer;
  InstalledVer, UninstExe, UninstallError, KeptEarlier: String;
  ChoicePage, UninstallPage: TWizardPage;
  InstallButton, RepairButton, UninstallButton: TNewButton;
  KeepDataCheck: TNewCheckBox;
  UninstallText: TNewStaticText;

function IsUninstallMode: Boolean;
begin
  Result := Mode = ModeUninstall;
end;

function IsRepairMode: Boolean;
begin
  Result := Mode = ModeRepair;
end;

// Is Tin Hat Server installed (by any version of this setup)? Its version, and its uninstaller.
procedure ReadInstalled;
var S: String;
begin
  InstalledVer := '';
  UninstExe := '';
  if RegQueryStringValue(HKLM, UninstKey, 'DisplayVersion', S) then InstalledVer := S;
  if RegQueryStringValue(HKLM, UninstKey, 'UninstallString', S) then UninstExe := RemoveQuotes(S);
  if (UninstExe <> '') and not FileExists(UninstExe) then UninstExe := '';
end;

// ---- the helper: setup-helper.ps1, results as key=value lines -------------------------------------------------

function RV(Key: String): String;
var I: Integer; P, L: String;
begin
  Result := '';
  P := Key + '=';
  for I := 0 to GetArrayLength(R) - 1 do begin
    L := R[I];
    if (I = 0) and (Length(L) > 0) and (Ord(L[1]) = $FEFF) then L := Copy(L, 2, MaxInt);
    if Copy(L, 1, Length(P)) = P then begin
      Result := Copy(L, Length(P) + 1, MaxInt);
      Exit;
    end;
  end;
end;

function RTrue(Key: String): Boolean;
begin
  Result := CompareText(RV(Key), 'True') = 0;
end;

function RunHelper(Action, Args: String; AsUser: Boolean): Integer;
var OutFile, Params: String; Code: Integer; Ok: Boolean;
begin
  OutFile := OutDir + '\' + Action + '.txt';
  DeleteFile(OutFile);
  Params := '-NoProfile -ExecutionPolicy Bypass -File "' + Helper + '" -Action ' + Action + ' -Out "' + OutFile +
    '" -LogFile "' + HelperLog + '" ' + Args;
  Log('helper ' + Action + ' ' + Args + ' (as the signed-in user: ' + IntToStr(Ord(AsUser)) + ')');
  if AsUser then
    Ok := ExecAsOriginalUser(PowerShell, Params, '', SW_HIDE, ewWaitUntilTerminated, Code)
  else
    Ok := Exec(PowerShell, Params, '', SW_HIDE, ewWaitUntilTerminated, Code);
  if not Ok then Code := -1;
  SetArrayLength(R, 0);
  if FileExists(OutFile) then LoadStringsFromFile(OutFile, R);
  Log('helper ' + Action + ' exit ' + IntToStr(Code) + ', ' + IntToStr(GetArrayLength(R)) + ' results; error=' + RV('error'));
  Result := Code;
end;

procedure Status(Text: String);
begin
  WizardForm.StatusLabel.Caption := Text;
  WizardForm.FilenameLabel.Caption := '';
  WizardForm.ProgressGauge.Style := npbstMarquee;
end;

function Mark(Ok: Boolean; Text: String): String;
begin
  if Ok then Result := '✓  ' + Text + #13#10 else Result := '✗  ' + Text + #13#10;
end;

function Before(S: String): String;   // "add|old|new" → "add"
begin
  if Pos('|', S) > 0 then Result := Copy(S, 1, Pos('|', S) - 1) else Result := S;
end;

// ---- remembering the choices across the restart ---------------------------------------------------------------

procedure SaveResume;
var S: String;
begin
  S := 'mode=' + IntToStr(Mode) + #13#10 + 'netindex=' + IntToStr(NetIndex) + #13#10;
  if NetCheck.Visible and NetCheck.Checked then S := S + 'netprivate=1' + #13#10 else S := S + 'netprivate=0' + #13#10;
  if KeptCheck.Visible and KeptCheck.Checked then S := S + 'usekept=1' + #13#10 else S := S + 'usekept=0' + #13#10;
  ForceDirectories(DataDir);
  SaveStringToFile(ResumeFile, S, False);
end;

function ResumeVal(Key: String): String;
var A: TArrayOfString; I: Integer;
begin
  Result := '';
  if FileExists(ResumeFile) and LoadStringsFromFile(ResumeFile, A) then
    for I := 0 to GetArrayLength(A) - 1 do
      if Copy(A[I], 1, Length(Key) + 1) = Key + '=' then Result := Copy(A[I], Length(Key) + 2, MaxInt);
end;

// ---- "Checking your PC" -----------------------------------------------------------------------------------------

procedure RunChecks;
var T, Busy, Reserved, Cat, NetName, Others, Owner, Me: String; Mem, Disk, I, N: Integer; Hard: Boolean;
begin
  ChecksText.Caption := 'Checking…';
  RetryButton.Visible := False;
  WizardForm.NextButton.Enabled := False;
  T := '';
  Hard := False;

  if UserMismatch then begin
    ChecksText.Caption := Mark(False, 'Setup is running as a different Windows account than the one signed in (Windows asked for another ' +
      'administrator''s password). Sign in to Windows with the account that will run the server (it needs to be an administrator), then run setup again.');
    ChecksOk := False;
    ChecksDone := True;
    Exit;
  end;

  RunHelper('check', '', False);
  T := T + Mark(RTrue('os.ok'), RV('os.caption') + ' (build ' + RV('os.build') + ')');
  Owner := RV('task.user');
  if Pos('\', Owner) > 0 then Owner := Copy(Owner, Pos('\', Owner) + 1, MaxInt);
  Me := IdUser;
  if Pos('\', Me) > 0 then Me := Copy(Me, Pos('\', Me) + 1, MaxInt);
  if (Owner <> '') and (CompareText(Owner, Me) <> 0) then begin
    T := T + Mark(False, 'Tin Hat Server already runs on this PC for the Windows account "' + Owner + '". One PC runs one server ' +
      '(it needs the PC''s ports). Sign in as ' + Owner + ' to use or update it, or uninstall it there first.');
    Hard := True;
  end;
  if RTrue('virt.ok') then
    T := T + Mark(True, 'Virtualization is switched on')
  else begin
    T := T + Mark(False, 'Virtualization is switched off. Switch it on in your PC''s firmware settings (BIOS/UEFI): the guide''s "Virtualization is disabled" shows how. Then run setup again.');
    Hard := True;
  end;
  Mem := StrToIntDef(RV('mem.gb'), 0);
  if Mem >= 8 then
    T := T + Mark(True, 'Memory: ' + IntToStr(Mem) + ' GB')
  else
    T := T + Mark(False, 'Memory: ' + IntToStr(Mem) + ' GB. The server takes up to 3 GB; with less than 8 GB in total, games may feel it.');
  Disk := StrToIntDef(RV('disk.freegb'), 0);
  if Disk < 10 then begin
    T := T + Mark(False, 'Free disk space: ' + IntToStr(Disk) + ' GB. The server needs at least 10 GB (20 GB is better). Free up some space, then press Try again.');
    Hard := True;
  end else
    T := T + Mark(Disk >= 20, 'Free disk space: ' + IntToStr(Disk) + ' GB');
  NeedWsl := not RTrue('wsl.ok');
  if NeedWsl then
    T := T + Mark(True, 'Windows'' Linux support (WSL) gets switched on: setup downloads it from Microsoft (about 370 MB), then Windows restarts once')
  else
    T := T + Mark(True, 'Windows'' Linux support (WSL ' + RV('wsl.version') + ') is ready');
  Busy := RV('ports.busy');
  Reserved := RV('ports.reserved');
  if Busy <> '' then begin
    T := T + Mark(False, 'Another program uses a port the server needs: ' + Busy + '. Stop that program or change its port, then press Try again.');
    Hard := True;
  end else if Reserved <> '' then begin
    T := T + Mark(False, 'Windows keeps a port the server needs for itself (' + Reserved + '). Restarting the PC usually frees it; then run setup again.');
    Hard := True;
  end else
    T := T + Mark(True, 'Ports 80, 443, 7881 and 7882 are free');

  // Networks: only those Windows treats as Private let other devices in.
  N := StrToIntDef(RV('net.count'), 0);
  NetIndex := -1;
  NetCheck.Visible := False;
  for I := 0 to N - 1 do begin
    Cat := RV('net.' + IntToStr(I) + '.category');
    NetName := RV('net.' + IntToStr(I) + '.name');
    if (CompareText(Cat, 'Public') = 0) and (NetIndex < 0) then begin
      NetIndex := StrToIntDef(RV('net.' + IntToStr(I) + '.index'), -1);
      NetCheck.Caption := 'This is my home network: set "' + NetName + '" to Private';
      NetCheck.Visible := True;
      T := T + Mark(False, 'Windows treats the network "' + NetName + '" as Public, so other devices can''t reach the server. At home, tick the box below.');
    end else if CompareText(Cat, 'Private') = 0 then
      T := T + Mark(True, 'Network "' + NetName + '" is Private: devices at home can reach the server');
  end;
  if N = 0 then T := T + Mark(False, 'No network right now. The server works once this PC is on your home network.');

  // The signed-in person's side: an existing server, one kept at the last uninstall, their WSL settings.
  RunHelper('user-check', '', True);
  HasDistro := RTrue('distro.installed');
  KeptDate := RV('kept.date');
  KeptCheck.Visible := RTrue('kept') and not HasDistro;
  KeptCheck.Caption := 'Bring back the server you kept when you uninstalled (' + KeptDate + ')';
  if HasDistro then T := T + Mark(True, 'Tin Hat Server is already here: setup updates the Windows part and keeps your server as it is');
  WslNeedsAgree := Before(RV('wslconfig.networkingMode')) = 'change';
  Others := RV('wsl.others');
  WslPageNeeded := RTrue('wslconfig.exists') or (Others <> '');
  T := T + Mark(True, 'WSL settings: mirrored networking, a 3 GB memory cap (' + RV('wslconfig.path') + ')');

  WslPage.RichEditViewer.Lines.Text :=
    'Your WSL settings file: ' + RV('wslconfig.path') + #13#10#13#10 +
    'WSL keeps one settings file for all your Linux distributions (' + Others + '). Tin Hat Server adds only these lines, ' +
    'each marked "added by Tin Hat Server", and saves a copy of your file first (.wslconfig.before-tinhat-server). ' +
    'Uninstalling Tin Hat Server takes them out again.' + #13#10#13#10 +
    '•  networkingMode=mirrored   [' + Before(RV('wslconfig.networkingMode')) + ']' + #13#10 +
    '    The server uses this PC''s own network address, so devices at home and friends can reach it. ' +
    'Your other distributions use this PC''s address too.' + #13#10 +
    '•  memory=3GB   [' + Before(RV('wslconfig.memory')) + ']' + #13#10 +
    '    A cap so games keep their memory. If you already chose a memory size, yours stays. The cap is shared by all your distributions.' + #13#10 +
    '•  hostAddressLoopback=true   [' + Before(RV('wslconfig.hostAddressLoopback')) + ']' + #13#10 +
    '    This PC can reach its own server at its network address (needed for calls from this PC).' + #13#10#13#10 +
    '[add] = a new line, [keep] = already right, [change] = your value is replaced (it comes back when you uninstall).' + #13#10 +
    'If WSL is running, it restarts once to take the new settings, so running distributions stop.';
  WslAgree.Visible := WslNeedsAgree;

  ChecksText.Caption := T;
  Log('checks:' + #13#10 + T);
  ChecksOk := not Hard;
  ChecksDone := True;
  RetryButton.Visible := Hard;
  WizardForm.NextButton.Enabled := ChecksOk;
end;

procedure RetryClick(Sender: TObject);
begin
  RunChecks;
end;

procedure WslAgreeClick(Sender: TObject);
begin
  WizardForm.NextButton.Enabled := WslAgree.Checked;
end;

// ---- start ------------------------------------------------------------------------------------------------------

function InitializeSetup: Boolean;
var V: TWindowsVersion; ModeParam, Refusal: String;
begin
  Result := True;
  GetWindowsVersionEx(V);
  if (V.Major < 10) or (V.Build < 22621) then begin
    SuppressibleMsgBox('Tin Hat Server needs Windows 11, version 22H2 or newer.' + #13#10#13#10 +
      'This PC runs Windows build ' + IntToStr(V.Build) + '. Windows 10 isn''t supported: it doesn''t have the network mode ' +
      'the server needs, and its security updates for home PCs ended in October 2026.' + #13#10#13#10 +
      'Update to Windows 11 (Settings → Windows Update), then run setup again.', mbCriticalError, MB_OK, IDOK);
    Result := False;
    Exit;
  end;
  Resume := ExpandConstant('{param:RESUME|0}') = '1';
  ReadInstalled;
  Mode := ModeInstall;
  // What was asked for on the command line. Repair or Uninstall of something that isn't there is an error, never an
  // install instead. (A resumed run takes its mode from the resume file, in InitializeWizard.)
  ModeParam := Lowercase(ExpandConstant('{param:MODE|install}'));
  if not Resume then begin
    if ModeParam = 'repair' then begin
      Mode := ModeRepair;
      if InstalledVer = '' then Refusal := 'Tin Hat Server isn''t installed on this PC, so there''s nothing to repair. ' +
        'Run setup without /MODE to install it.';
    end else if ModeParam = 'uninstall' then begin
      Mode := ModeUninstall;
      if InstalledVer = '' then Refusal := 'Tin Hat Server isn''t installed on this PC: there''s nothing to uninstall.'
      else if UninstExe = '' then Refusal := 'Tin Hat Server''s uninstaller is missing. Run setup with /MODE=repair ' +
        'first (it puts the uninstaller back), then /MODE=uninstall.';
    end else if ModeParam <> 'install' then
      Refusal := 'Unknown /MODE=' + ModeParam + ': use install, repair or uninstall.';
  end;
  Log(Format('mode %d, asked: %s (installed: %s; uninstaller: %s)', [Mode, ModeParam, InstalledVer, UninstExe]));
  if Refusal <> '' then begin
    Log('refused: ' + Refusal);
    SuppressibleMsgBox(Refusal, mbError, MB_OK, IDOK);
    Result := False;
  end;
end;

// ---- the choice page --------------------------------------------------------------------------------------------

procedure ChoiceClick(Sender: TObject);
begin
  if Sender = RepairButton then Mode := ModeRepair
  else if Sender = UninstallButton then Mode := ModeUninstall
  else Mode := ModeInstall;
  WizardForm.NextButton.OnClick(WizardForm.NextButton);
end;

function MakeChoice(const Caption, Hint: String; const Top: Integer): TNewButton;
var Grown: Integer;
begin
  Result := TNewButton.Create(ChoicePage);
  Result.Parent := ChoicePage.Surface;
  Result.Style := bsCommandLink;
  Result.Caption := Caption;
  Result.CommandLinkHint := Hint;
  Result.Left := 0;
  Result.Top := Top;
  Result.Width := ChoicePage.SurfaceWidth;
  Result.Height := ScaleY(64);
  Grown := Result.AdjustHeightIfCommandLink;
  Result.OnClick := @ChoiceClick;
end;

function VerOf(S: String): Int64;
begin
  if not StrToVersion(S, Result) then Result := 0;
end;

procedure MakeChoicePage;
var InstallCaption, InstallHint: String; Y: Integer;
begin
  if InstalledVer = '' then begin
    InstallCaption := 'Install Tin Hat Server';
    InstallHint := 'Your group''s own chat and call server, running quietly in the background on this PC. It uses Windows'' ' +
      'Linux support (WSL): if that isn''t on yet, setup switches it on, with one restart. 5 to 10 minutes.';
  end else if InstalledVer = '{#AppVersion}' then begin
    InstallCaption := 'Reinstall Tin Hat Server';
    InstallHint := 'Tin Hat Server {#AppVersion} is already here. This lays down its Windows part again; your server and ' +
      'everything on it stay as they are.';
  end else if ComparePackedVersion(VerOf(InstalledVer), VerOf('{#AppVersion}')) < 0 then begin
    InstallCaption := 'Update Tin Hat Server';
    InstallHint := 'Updates the Windows part of Tin Hat Server ' + InstalledVer + ' to {#AppVersion}. Your server and everything ' +
      'on it stay as they are (the server itself keeps updating from its dashboard).';
  end else begin
    InstallCaption := 'Install Tin Hat Server {#AppVersion}';
    InstallHint := 'You have Tin Hat Server ' + InstalledVer + ', which is newer than this setup. Your server stays as it is.';
  end;
  ChoicePage := CreateCustomPage(wpWelcome, 'What would you like to do?',
    'Repair and Uninstall show you what they''ll do before they change anything.');
  InstallButton := MakeChoice(InstallCaption, InstallHint, 0);
  Y := InstallButton.Top + InstallButton.Height + ScaleY(8);
  RepairButton := MakeChoice('Repair Tin Hat Server',
    'For a server that won''t start, or that other devices can''t reach: puts back its WSL settings, firewall rules, ' +
    'startup task and tray icon, then restarts the server and checks it answers. Your server and its data stay.', Y);
  Y := RepairButton.Top + RepairButton.Height + ScaleY(8);
  UninstallButton := MakeChoice('Uninstall Tin Hat Server',
    'Removes Tin Hat Server from this PC. You choose whether to keep your server''s data (accounts, rooms, messages).', Y);
  if InstalledVer = '' then begin
    RepairButton.Enabled := False;
    RepairButton.CommandLinkHint := 'Tin Hat Server isn''t installed on this PC.';
    UninstallButton.Enabled := False;
    UninstallButton.CommandLinkHint := 'Tin Hat Server isn''t installed on this PC.';
  end else if UninstExe = '' then begin
    UninstallButton.Enabled := False;
    UninstallButton.CommandLinkHint := 'This installation''s uninstaller is missing: choose Repair first, then Uninstall.';
  end;
end;

procedure InitializeWizard;
var Code: Integer;
begin
  PowerShell := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  ExtractTemporaryFile('setup-helper.ps1');
  Helper := ExpandConstant('{tmp}\setup-helper.ps1');
  OutDir := ExpandConstant('{tmp}\out');
  ForceDirectories(OutDir);
  HelperLog := OutDir + '\setup-helper.log';
  // The steps that run as the signed-in user (not elevated) write their answers into OutDir.
  RunHelper('grant-out', '', False);

  // Whose server? The person signed in to Windows. If Windows asked for another administrator's password, setup
  // would run as that other account, and the server would end up in the wrong place.
  Code := RunHelper('identity', '', True);
  IdUser := RV('user');
  IdSid := RV('sid');
  IdLocalAppData := RV('localappdata');
  DataDir := IdLocalAppData + '\Tin Hat Server';
  ResumeFile := DataDir + '\setup-resume.txt';
  UserMismatch := (IdUser = '') or (CompareText(ExpandConstant('{localappdata}'), IdLocalAppData) <> 0);
  if Resume and (ResumeVal('mode') = IntToStr(ModeRepair)) then Mode := ModeRepair;
  Log('server owner ' + IdUser + ' (' + IdLocalAppData + '); setup elevated as ' + GetUserNameString + '; resume=' + IntToStr(Ord(Resume)));

  MakeChoicePage;
  ChecksPage := CreateCustomPage(ChoicePage.ID, 'Checking your PC', 'Tin Hat Server looks at what it needs before it changes anything.');
  RetryButton := TNewButton.Create(ChecksPage);
  RetryButton.Parent := ChecksPage.Surface;
  RetryButton.Caption := 'Try again';
  RetryButton.Width := ScaleX(100);
  RetryButton.Height := WizardForm.NextButton.Height;
  RetryButton.Top := ChecksPage.SurfaceHeight - RetryButton.Height;
  RetryButton.Visible := False;
  RetryButton.OnClick := @RetryClick;
  KeptCheck := TNewCheckBox.Create(ChecksPage);
  KeptCheck.Parent := ChecksPage.Surface;
  KeptCheck.Width := ChecksPage.SurfaceWidth;
  KeptCheck.Height := ScaleY(20);
  KeptCheck.Top := RetryButton.Top - ScaleY(28);
  KeptCheck.Checked := ExpandConstant('{param:USEKEPT|1}') <> '0';   // /USEKEPT=0: a new server even when one was kept
  KeptCheck.Visible := False;
  NetCheck := TNewCheckBox.Create(ChecksPage);
  NetCheck.Parent := ChecksPage.Surface;
  NetCheck.Width := ChecksPage.SurfaceWidth;
  NetCheck.Height := ScaleY(20);
  NetCheck.Top := KeptCheck.Top - ScaleY(26);
  NetCheck.Checked := (not WizardSilent) or (ExpandConstant('{param:NETWORKPRIVATE|0}') = '1');
  NetCheck.Visible := False;
  ChecksText := TNewStaticText.Create(ChecksPage);
  ChecksText.Parent := ChecksPage.Surface;
  ChecksText.AutoSize := False;
  ChecksText.WordWrap := True;
  ChecksText.Width := ChecksPage.SurfaceWidth;
  ChecksText.Height := NetCheck.Top - ScaleY(8);
  ChecksText.Caption := 'Checking…';

  WslPage := CreateOutputMsgMemoPage(ChecksPage.ID, 'Windows'' Linux settings',
    'Tin Hat Server needs three WSL settings. Your other settings stay as they are.', '', '');
  WslPage.RichEditViewer.Height := WslPage.SurfaceHeight - ScaleY(30);
  WslAgree := TNewCheckBox.Create(WslPage);
  WslAgree.Parent := WslPage.Surface;
  WslAgree.Caption := 'Yes, change my WSL network mode to "mirrored"';
  WslAgree.Width := WslPage.SurfaceWidth;
  WslAgree.Top := WslPage.RichEditViewer.Top + WslPage.RichEditViewer.Height + ScaleY(8);
  WslAgree.Visible := False;
  WslAgree.OnClick := @WslAgreeClick;

  UninstallPage := CreateCustomPage(WslPage.ID, 'Uninstall Tin Hat Server',
    'Stops the server and removes it from this PC.');
  UninstallText := TNewStaticText.Create(UninstallPage);
  UninstallText.Parent := UninstallPage.Surface;
  UninstallText.AutoSize := False;
  UninstallText.WordWrap := True;
  UninstallText.Width := UninstallPage.SurfaceWidth;
  UninstallText.Height := ScaleY(150);
  UninstallText.Caption :=
    'Uninstalling removes:' + #13#10 +
    '•  the server (its WSL distribution "TinHatServer") and the Tin Hat Server app with its tray icon' + #13#10 +
    '•  its startup task and the firewall rules for ports 80, 443, 7881 and 7882' + #13#10 +
    '•  the lines it added to your WSL settings (.wslconfig): yours come back as they were' + #13#10#13#10 +
    'Windows'' Linux support (WSL) stays installed: other programs may use it.';
  KeepDataCheck := TNewCheckBox.Create(UninstallPage);
  KeepDataCheck.Parent := UninstallPage.Surface;
  KeepDataCheck.Top := UninstallText.Top + UninstallText.Height + ScaleY(12);
  KeepDataCheck.Width := UninstallPage.SurfaceWidth;
  KeepDataCheck.Height := ScaleY(36);
  KeepDataCheck.Caption := 'Keep my server''s data (accounts, rooms and messages) on this PC, so installing Tin Hat Server again can bring it back';
  KeepDataCheck.Checked := ExpandConstant('{param:REMOVEDATA|0}') <> '1';
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  // The choice page's own buttons replace Next there; the pages after it have Next again (Inno hides it while it works).
  if CurPageID = ChoicePage.ID then
    WizardForm.NextButton.Visible := False
  else if (CurPageID = ChecksPage.ID) or (CurPageID = WslPage.ID) or (CurPageID = UninstallPage.ID) or
          (CurPageID = wpReady) or (CurPageID = wpFinished) then
    WizardForm.NextButton.Visible := True;
  if CurPageID = ChoicePage.ID then WizardForm.ActiveControl := InstallButton;
  if CurPageID = UninstallPage.ID then WizardForm.NextButton.Caption := 'Uninstall';
  if (CurPageID = wpReady) and IsRepairMode then WizardForm.NextButton.Caption := 'Repair';
  if (CurPageID = wpPreparing) or (CurPageID = wpInstalling) then begin
    if IsRepairMode then begin
      WizardForm.PageNameLabel.Caption := 'Repairing';
      WizardForm.PageDescriptionLabel.Caption := 'Please wait while setup repairs Tin Hat Server.';
    end else if IsUninstallMode then begin
      WizardForm.PageNameLabel.Caption := 'Uninstalling';
      WizardForm.PageDescriptionLabel.Caption := 'Please wait while setup removes Tin Hat Server from this PC.';
    end;
  end;
  // After the restart, carry on without asking again (Inno can't skip the Ready page from code: press Install).
  if Resume and (CurPageID = wpReady) then PostMessage(WizardForm.NextButton.Handle, $00F5, 0, 0);
  if CurPageID = ChecksPage.ID then RunChecks;
  if CurPageID = WslPage.ID then WizardForm.NextButton.Enabled := (not WslNeedsAgree) or WslAgree.Checked;
  if (CurPageID = wpFinished) and IsUninstallMode then begin
    if UninstallError <> '' then begin
      WizardForm.FinishedHeadingLabel.Caption := 'Tin Hat Server was not removed completely';
      WizardForm.FinishedLabel.Caption := UninstallError;
    end else begin
      WizardForm.FinishedHeadingLabel.Caption := 'Tin Hat Server is removed';
      if KeepData then
        WizardForm.FinishedLabel.Caption := 'Your server''s data is kept in ' + DataDir + '\kept. Installing Tin Hat Server ' +
          'again offers to bring it back; to delete it for good, delete that folder.' + #13#10#13#10 +
          'Windows'' Linux support (WSL) stays installed: other programs may use it.'
      else
        WizardForm.FinishedLabel.Caption := 'Tin Hat Server and its data are gone from this PC.' + #13#10#13#10 +
          'Windows'' Linux support (WSL) stays installed: other programs may use it. You can remove "Windows Subsystem ' +
          'for Linux" in Settings → Apps if nothing else needs it.';
      if not KeepData and (KeptEarlier <> '') then
        WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 +
          'A server you kept when you uninstalled before is still in ' + KeptEarlier + ' (delete that folder to remove it too).';
    end;
    WizardForm.FinishedLabel.AdjustHeight;
  end else if CurPageID = wpFinished then begin
    if not ServerOk then begin
      WizardForm.FinishedHeadingLabel.Caption := 'Tin Hat Server is installed, but not running yet';
      WizardForm.FinishedLabel.Caption := 'The server didn''t start properly:' + #13#10#13#10 + ServerError + #13#10#13#10 +
        'The tray icon next to the clock shows what it''s doing. The logs are in ' + DataDir + '\logs.';
    end else if IsRepairMode then begin
      WizardForm.FinishedHeadingLabel.Caption := 'Tin Hat Server is repaired';
      WizardForm.FinishedLabel.Caption := 'Its WSL settings, firewall rules, startup task and tray icon are back in place, and ' +
        'the server restarted and answers. Your server and everything on it stayed as it was.';
      if not AlreadySetUp then
        WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 +
          'It isn''t set up yet: finish in your browser, at ' + SetupUrl + ' (your setup code: ' + SetupCode + ').';
    end else if AlreadySetUp then begin
      WizardForm.FinishedHeadingLabel.Caption := 'Tin Hat Server is running';
      WizardForm.FinishedLabel.Caption := 'Tin Hat Server is updated and running. Your server and everything on it stayed as it was.';
    end else begin
      WizardForm.FinishedHeadingLabel.Caption := 'Tin Hat Server is running';
      WizardForm.FinishedLabel.Caption := 'Finish setting up your server in your browser, at ' + SetupUrl + #13#10#13#10 +
        'Your setup code:     ' + SetupCode + #13#10#13#10 +
        'The setup page asks for it to be sure it''s you. The Tin Hat Server icon next to the clock shows it again ' +
        '(right-click it → Show setup code). It also pauses or starts the server.';
    end;
    WizardForm.FinishedLabel.AdjustHeight;
    OpenCheck := TNewCheckBox.Create(WizardForm);
    OpenCheck.Parent := WizardForm.FinishedPage;
    OpenCheck.Left := WizardForm.FinishedLabel.Left;
    OpenCheck.Top := WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height + ScaleY(16);
    OpenCheck.Width := WizardForm.FinishedLabel.Width;
    if AlreadySetUp then OpenCheck.Caption := 'Open the dashboard now' else OpenCheck.Caption := 'Open the setup page now';
    OpenCheck.Checked := ServerOk;
    OpenCheck.Visible := ServerOk;
  end;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
  if PageID = ChoicePage.ID then Result := Resume or WizardSilent;
  if (PageID = ChecksPage.ID) or (PageID = WslPage.ID) or (PageID = wpReady) then Result := IsUninstallMode;
  if PageID = UninstallPage.ID then Result := WizardSilent or not IsUninstallMode;
  if Result then Exit;
  if PageID = WslPage.ID then Result := Resume or HasDistro or not WslPageNeeded;
  if Resume and ((PageID = wpWelcome) or (PageID = ChecksPage.ID) or (PageID = wpReady)) then Result := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var Code: Integer;
begin
  Result := True;
  // (Silent installs carry on to PrepareToInstall, which stops with the reasons in the log.)
  if (CurPageID = ChecksPage.ID) and not ChecksOk and not WizardSilent then Result := False;
  if (CurPageID = wpFinished) and (OpenCheck <> nil) and OpenCheck.Checked then begin
    if AlreadySetUp then
      ExecAsOriginalUser(ExpandConstant('{app}\TinHatServer.exe'), '--tray', '', SW_SHOWNORMAL, ewNoWait, Code)
    else
    begin
      { the code after "#code=" fills itself in on the page; a fragment never leaves the browser }
      if SetupCode <> '' then
        ShellExecAsOriginalUser('open', SetupUrl + '#code=' + SetupCode, '', '', SW_SHOWNORMAL, ewNoWait, Code)
      else
        ShellExecAsOriginalUser('open', SetupUrl, '', '', SW_SHOWNORMAL, ewNoWait, Code);
    end;
  end;
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  if IsRepairMode then Result := 'Setup will repair Tin Hat Server:' + NewLine else Result := 'Setup will:' + NewLine;
  if NeedWsl then Result := Result + Space + 'switch on Windows'' Linux support (WSL) and restart Windows once' + NewLine;
  if HasDistro then Result := Result + Space + 'update the Windows part of Tin Hat Server (your server stays as it is)' + NewLine
  else if KeptCheck.Visible and KeptCheck.Checked then Result := Result + Space + 'bring back the server you kept (' + KeptDate + ')' + NewLine
  else Result := Result + Space + 'unpack the server into ' + DataDir + '\server (about 2 GB)' + NewLine;
  Result := Result + Space + 'set WSL to mirrored networking with a 3 GB memory cap (in your .wslconfig)' + NewLine;
  Result := Result + Space + 'open ports 80, 443, 7881 and 7882 for devices on private (home) networks' + NewLine;
  if NetCheck.Visible and NetCheck.Checked then Result := Result + Space + 'set your network to Private' + NewLine;
  Result := Result + Space + 'start the server with Windows, and put the Tin Hat Server icon next to the clock' + NewLine;
  if IsRepairMode then Result := Result + Space + 'restart the server cleanly and check it answers' + NewLine
  else Result := Result + Space + 'open the server''s setup page in your browser' + NewLine;
end;

// ---- before files are copied: WSL, and stopping an older copy ---------------------------------------------------

function ShortUser(S: String): String;
begin
  Result := S;
  if Pos('\', Result) > 0 then Result := Copy(Result, Pos('\', Result) + 1, MaxInt);
end;

// Setup's Uninstall. The server's part first, as the person it belongs to (stop it, keep or delete its data,
// unregister it); only when that worked the installed uninstaller removes the rest, so a failure leaves a complete
// installation that Repair or another Uninstall can work with.
// Is the server someone else's? By SID when both are known (PC\alex and DOMAIN\alex are different people).
function OtherOwner(TaskUser, TaskSid, MeName, MeSid: String): Boolean;
begin
  if TaskUser = '' then Result := False      // no startup task: nothing says whose it is
  else if (TaskSid <> '') and (MeSid <> '') then Result := CompareText(TaskSid, MeSid) <> 0
  else if (Pos('\', TaskUser) > 0) and (Pos('\', MeName) > 0) then Result := CompareText(TaskUser, MeName) <> 0
  else Result := CompareText(ShortUser(TaskUser), ShortUser(MeName)) <> 0;
end;

function UninstallFromSetup: String;
var Code, Waited: Integer; Progress: TOutputProgressWizardPage; Keep, RemoveData, Owner, Exe: String;
begin
  Result := '';
  KeepData := WizardSilent and (ExpandConstant('{param:REMOVEDATA|0}') <> '1');
  if not WizardSilent then KeepData := KeepDataCheck.Checked;
  if UserMismatch then begin
    Result := 'Setup is running as a different Windows account than the one signed in (Windows asked for another ' +
      'administrator''s password). Sign in to Windows with the account the server belongs to, then uninstall it there.';
    Exit;
  end;
  RunHelper('owner', '', False);
  Owner := RV('task.user');
  if OtherOwner(Owner, RV('task.sid'), IdUser, IdSid) then begin
    Result := 'Tin Hat Server on this PC belongs to the Windows account "' + Owner + '". Sign in as ' + ShortUser(Owner) +
      ' to uninstall it (its server and data are in that account).';
    Exit;
  end;
  Exe := ExtractFileDir(UninstExe) + '\TinHatServer.exe';
  // Two different switches: the helper's -Keep (1 = keep) and the uninstaller's /REMOVEDATA (1 = delete).
  if KeepData then begin Keep := '1'; RemoveData := '0'; end else begin Keep := '0'; RemoveData := '1'; end;
  Progress := CreateOutputProgressPage('Uninstalling Tin Hat Server', 'This takes a minute or two.');
  Progress.ProgressBar.Style := npbstMarquee;
  Progress.Show;
  try
    // The installed uninstaller calls the helper next to it. An older one doesn't know /USERPARTDONE and runs the
    // server's part again: with this setup's helper that finds nothing left to remove and never deletes kept data.
    // Done first, so a failure stops before anything changes.
    if not FileCopy(Helper, ExtractFileDir(UninstExe) + '\setup-helper.ps1', False) then begin
      Result := 'Setup couldn''t update Tin Hat Server''s uninstall helper (' + ExtractFileDir(UninstExe) +
        '\setup-helper.ps1). Nothing was changed.';
      Exit;
    end;
    Progress.SetText('Stopping the server…', '');
    RunHelper('stop-task', '-Exe "' + Exe + '"', False);
    RunHelper('hosts-clear', '-Exe "' + Exe + '"', False);
    if KeepData then Progress.SetText('Keeping your server''s data and removing the server…', '')
    else Progress.SetText('Removing the server and its data…', '');
    if RunHelper('user-uninstall', '-Keep ' + Keep + ' -Exe "' + Exe + '"', True) <> 0 then begin
      ForceDirectories(DataDir + '\logs');
      FileCopy(HelperLog, DataDir + '\logs\uninstall.log', False);
      Result := 'Removing the server didn''t finish, so nothing else was removed: ' + RV('error') + #13#10#13#10 +
        'The server is stopped: restart the PC, or run setup again and choose Repair, to bring it back. ' +
        'The log is ' + DataDir + '\logs\uninstall.log.';
      Exit;
    end;
    if RV('kept.earlier') <> '' then KeptEarlier := RV('kept.earlier');
    Progress.SetText('Removing the Tin Hat Server app, its startup task and firewall rules…', '');
    // The uninstaller hands over to a temporary copy of itself and returns when that has removed everything
    // (exit code 0 only then); the copy deletes the uninstall entry last.
    if not Exec(UninstExe, '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /USERPARTDONE=1 /REMOVEDATA=' + RemoveData, '', SW_HIDE,
                ewWaitUntilTerminated, Code) then begin
      Result := 'The uninstaller (' + UninstExe + ') couldn''t be started: ' + SysErrorMessage(Code) + #13#10#13#10 +
        'The server itself is already removed; Settings → Apps → Tin Hat Server → Uninstall removes the rest.';
      Exit;
    end;
    Waited := 0;
    while RegKeyExists(HKLM, UninstKey) and (Waited < 120) do begin
      Sleep(500);
      Waited := Waited + 1;
    end;
  finally
    Progress.Hide;
  end;
  if (Code <> 0) or RegKeyExists(HKLM, UninstKey) then begin
    Result := 'The uninstaller stopped before it was done (exit code ' + IntToStr(Code) + '). The server itself is ' +
      'already removed; Settings → Apps → Tin Hat Server → Uninstall removes the rest.';
    Exit;
  end;
  // Did the server itself go, and is the data where it was asked to be?
  if (RunHelper('user-check', '', True) <> 0) or not RTrue('distro.known') then
    UninstallError := 'Setup couldn''t check that the server is gone (WSL''s list of distributions couldn''t be read). ' +
      'In a terminal, "wsl --list" must not show TinHatServer.'
  else if RTrue('distro.installed') then
    UninstallError := 'The server itself is still on this PC (its WSL distribution "TinHatServer"). Running this setup ' +
      'again and choosing Install, then Uninstall, finishes the job.'
  else if KeepData and not RTrue('kept') then
    UninstallError := 'The server was removed, but its data wasn''t kept as asked.';
  if UninstallError = '' then begin
    if RunHelper('leftovers', '-Exe "' + Exe + '"', False) <> 0 then
      UninstallError := 'The server is removed, but setup couldn''t check that the rest of Tin Hat Server went too.'
    else if RV('left') <> '' then
      UninstallError := 'The server is removed, but some of Tin Hat Server is still on this PC: ' + RV('left') + '. ' +
        'Running this setup again and choosing Install, then Uninstall, removes it.';
  end;
  if UninstallError <> '' then Log('uninstall check: ' + UninstallError);
end;

// The switches a run after the restart keeps (an unattended install stays unattended).
function ResumeSwitches: String;
var I: Integer; P: String;
begin
  Result := '';
  for I := 1 to ParamCount do begin
    P := Uppercase(ParamStr(I));
    if (P = '/SILENT') or (P = '/VERYSILENT') or (P = '/SUPPRESSMSGBOXES') or (P = '/NORESTART') or (P = '/SP-') or
       (P = '/CHANGEWSLNETWORK=1') or (P = '/NETWORKPRIVATE=1') then
      Result := Result + ' ' + P;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer; ResumeExe: String; Progress: TOutputProgressWizardPage;
begin
  Result := '';
  if IsUninstallMode then begin
    Result := UninstallFromSetup;
    Exit;
  end;
  if not ChecksDone then RunChecks;   // silent installs and the resumed run skip the page
  if not ChecksOk then begin
    Result := 'Setup can''t continue:' + #13#10#13#10 + ChecksText.Caption;
    Exit;
  end;
  if WizardSilent and WslNeedsAgree and (ExpandConstant('{param:CHANGEWSLNETWORK|0}') <> '1') then begin
    Result := 'Your WSL settings use another network mode. Run setup without /VERYSILENT, or add /CHANGEWSLNETWORK=1.';
    Exit;
  end;
  if Resume then begin
    NetIndex := StrToIntDef(ResumeVal('netindex'), -1);
    NetCheck.Checked := ResumeVal('netprivate') = '1';
    KeptCheck.Checked := ResumeVal('usekept') = '1';
  end;
  // An older copy: stop the keep-alive and the tray so their files can be replaced (the server itself keeps running).
  if FileExists(ExpandConstant('{app}\TinHatServer.exe')) then begin
    RunHelper('stop-task', '-Exe "' + ExpandConstant('{app}\TinHatServer.exe') + '"', False);
    Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM TinHatServer.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
  end;
  if NeedWsl then begin
    Progress := CreateOutputProgressPage('Switching on Windows'' Linux support (WSL)', 'This takes a few minutes. Windows restarts once afterwards.');
    Progress.SetText('Downloading Windows Subsystem for Linux from Microsoft (about 370 MB) and installing it…', '');
    Progress.ProgressBar.Style := npbstMarquee;
    Progress.Show;
    try
      Code := RunHelper('install-wsl', '', False);
    finally
      Progress.Hide;
    end;
    if Code = 3010 then begin
      // Restart, then carry on by itself: this same setup file runs once when this person signs in again.
      SaveResume;
      ResumeExe := ExpandConstant('{srcexe}');
      // The person already chose to run this download: without its "came from the internet" mark, Windows runs it
      // after the restart without a second "unknown publisher" warning (UAC still asks).
      DeleteFile(ResumeExe + ':Zone.Identifier');
      RegWriteStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\RunOnce', 'TinHatServerSetup', '"' + ResumeExe + '" /RESUME=1' + ResumeSwitches);
      NeedsRestart := True;
      Result := 'Windows needs to restart to finish switching on its Linux support (WSL).' + #13#10#13#10 +
        'After the restart, sign in as usual: setup continues by itself (Windows asks once more for permission).';
      Exit;
    end;
    if Code <> 0 then begin
      Result := 'Windows'' Linux support (WSL) couldn''t be switched on: ' + RV('error') + #13#10#13#10 + 'Details: ' + HelperLog;
      Exit;
    end;
    NeedWsl := False;
  end;
end;

// ---- after files are copied: the server ---------------------------------------------------------------------------

procedure Fail(Msg: String);
begin
  if ServerError = '' then ServerError := Msg;
  Log('FAILED: ' + Msg);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var Exe, Tar: String; Code: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  if IsUninstallMode then begin
    RemoveDir(ExpandConstant('{app}'));   // Inno made the (empty) folder again: nothing was installed into it
    Exit;
  end;
  Exe := ExpandConstant('{app}\TinHatServer.exe');
  ServerError := '';

  if not HasDistro then begin
    if KeptCheck.Visible and KeptCheck.Checked then begin
      Status('Bringing back the server you kept…');
      Code := RunHelper('import', '-Keep 1', True);
    end else begin
      Status('Unpacking the server (2 to 5 minutes)…');
      ExtractTemporaryFile('tinhat-server-wsl.tar.gz');
      Tar := ExpandConstant('{tmp}\tinhat-server-wsl.tar.gz');
      Code := RunHelper('import', '-Keep 0 -Tar "' + Tar + '"', True);
      DeleteFile(Tar);
    end;
    if Code <> 0 then Fail('The server couldn''t be unpacked: ' + RV('error'));
  end;

  if ServerError = '' then begin
    Status('Adjusting Windows'' Linux settings…');
    if RunHelper('wslconfig', '', True) <> 0 then
      Fail('The WSL settings couldn''t be saved: ' + RV('error'))
    else if RTrue('changed') then
      // New settings only apply when WSL starts again.
      ExecAsOriginalUser(ExpandConstant('{sys}\wsl.exe'), '--shutdown', '', SW_HIDE, ewWaitUntilTerminated, Code);
  end;

  if ServerError = '' then begin
    Status('Letting devices on your home network reach the server…');
    if RunHelper('firewall', '', False) <> 0 then Fail('The firewall rules couldn''t be added: ' + RV('error'));
    if NetCheck.Visible and NetCheck.Checked and (NetIndex >= 0) then
      if RunHelper('network-private', '-InterfaceIndex ' + IntToStr(NetIndex), False) <> 0 then
        Log('network-private: ' + RV('error'));
  end;

  if ServerError = '' then begin
    Status('Making the server start with Windows…');
    if RunHelper('task', '-Exe "' + Exe + '" -User "' + IdUser + '"', False) <> 0 then Fail('The startup task couldn''t be added: ' + RV('error'));
    if RunHelper('run-key', '-Exe "' + Exe + '"', True) <> 0 then Log('run key: ' + RV('error'));
  end;

  if (ServerError = '') and IsRepairMode and HasDistro then begin
    Status('Stopping the server for a clean start…');
    if RunHelper('restart-distro', '-Exe "' + Exe + '"', True) <> 0 then
      Fail('The server couldn''t be stopped for a clean start: ' + RV('error'));
  end;

  if ServerError = '' then begin
    Status('Starting the server (the first start takes a minute or two)…');
    if RunHelper('start', '-Exe "' + Exe + '"', True) <> 0 then Fail(RV('error'));
  end;

  ServerOk := ServerError = '';
  if ServerOk then begin
    RunHelper('read-setup-code', '-Exe "' + Exe + '"', True);
    SetupCode := RV('code');
    AlreadySetUp := RV('phase') = 'ready';
  end;
  // The tray icon for the signed-in person (it also starts at every sign-in).
  ExecAsOriginalUser(Exe, '--tray', '', SW_SHOWNORMAL, ewNoWait, Code);
  // Done with the restart path, if it was taken.
  RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\RunOnce', 'TinHatServerSetup');
  DeleteFile(ResumeFile);
  ForceDirectories(DataDir + '\logs');
  FileCopy(HelperLog, DataDir + '\logs\setup-helper.log', False);
end;

// Unattended callers see the outcome too (0 only when it really worked).
function GetCustomSetupExitCode: Integer;
begin
  Result := 0;
  if IsUninstallMode then begin
    if UninstallError <> '' then Result := 12;
  end else if not ServerOk then
    Result := 11;
end;

// ---- uninstall --------------------------------------------------------------------------------------------------

function InitializeUninstall: Boolean;
var Owner, Me: String;
begin
  Result := True;
  KeepData := ExpandConstant('{param:REMOVEDATA|0}') <> '1';
  UserPartDone := ExpandConstant('{param:USERPARTDONE|0}') = '1';   // setup's Uninstall did the server's part already
  PowerShell := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  Helper := ExpandConstant('{app}\setup-helper.ps1');
  OutDir := ExpandConstant('{tmp}');
  HelperLog := ExpandConstant('{localappdata}\Tin Hat Server\logs\uninstall.log');
  // The server belongs to one Windows account (its startup task runs as it). Uninstalling as another account (another
  // administrator's password at Windows' prompt) would remove the program but leave that person's server behind.
  RunHelper('owner', '', False);
  Owner := RV('task.user');
  Me := RV('me');
  if OtherOwner(Owner, RV('task.sid'), Me, RV('me.sid')) then begin
    Log('refused: the server belongs to ' + Owner + ', the uninstaller runs as ' + Me);
    if not UninstallSilent then
      MsgBox('Tin Hat Server on this PC belongs to the Windows account "' + Owner + '", and this runs as "' + Me + '".' + #13#10#13#10 +
        'Sign in to Windows as ' + ShortUser(Owner) + ' and uninstall it there: its server and data are in that account.', mbError, MB_OK);
    Result := False;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var Exe, Keep: String;
begin
  // After Windows' "Remove Tin Hat Server from this PC?": what happens to the server's data.
  if (CurUninstallStep = usAppMutexCheck) and not UninstallSilent then
    KeepData := MsgBox('Keep your server''s data?' + #13#10#13#10 +
      'Yes: keep the accounts, rooms and messages on this PC. Installing Tin Hat Server again offers to bring them back.' + #13#10#13#10 +
      'No: delete them for good.', mbConfirmation, MB_YESNO) = IDYES;
  if CurUninstallStep = usUninstall then begin
    Exe := ExpandConstant('{app}\TinHatServer.exe');
    if KeepData then Keep := '1' else Keep := '0';
    RunHelper('stop-task', '-Exe "' + Exe + '"', False);
    RunHelper('hosts-clear', '-Exe "' + Exe + '"', False);
    if not UserPartDone then
      if RunHelper('user-uninstall', '-Keep ' + Keep + ' -Exe "' + Exe + '"', False) <> 0 then
        // Raised here, before Inno removes any file or setting: the uninstall stops and Tin Hat Server stays installed
        // (Repair or another Uninstall can work with it), instead of an app-less server nobody can remove.
        RaiseException('Removing the server didn''t finish, so Tin Hat Server stays installed: ' + RV('error') + #13#10#13#10 +
          'The server is stopped: restart the PC, or run Tin Hat Server''s setup and choose Repair, to bring it back. ' +
          'The log is ' + HelperLog + '.');
    if (not UserPartDone) and (RV('kept.earlier') <> '') then KeptEarlier := RV('kept.earlier');
    RunHelper('firewall-remove', '', False);
    RunHelper('task-remove', '', False);
  end;
  if CurUninstallStep = usPostUninstall then begin
    if not KeepData then begin
      // the log of a successful removal goes too (and the folder, unless an earlier kept server is in it)
      DelTree(ExpandConstant('{localappdata}\Tin Hat Server\logs'), True, True, True);
      RemoveDir(ExpandConstant('{localappdata}\Tin Hat Server'));
    end;
    if not UninstallSilent and not UserPartDone then begin
      if KeepData then
        MsgBox('Your server''s data is kept in ' + ExpandConstant('{localappdata}') + '\Tin Hat Server\kept.' + #13#10#13#10 +
          'Installing Tin Hat Server again offers to bring it back. To delete it for good, delete that folder.', mbInformation, MB_OK)
      else if KeptEarlier <> '' then
        MsgBox('A server you kept when you uninstalled before is still in ' + KeptEarlier + '.' + #13#10#13#10 +
          'Delete that folder to remove it too.', mbInformation, MB_OK);
    end;
  end;
end;
