# 本当の更新の経路を 1 回通す（Windows）。CI の windows ジョブが、配布物の段（.github/actions/windows-installer）の後で呼ぶ。
# 使い方: pwsh apps/desktop/scripts/ci-update-windows.ps1 -Target x86_64-pc-windows-msvc -Out <成果物の置き場>
#
# 1. CI の中で使い捨ての updater の鍵を作る（tauri signer generate）。本物の secret は使わない。
# 2. 版 A（今の版）と版 B（版を一時的に上げたもの）のインストーラを、その鍵とローカルの目録を重ねて build する（update-rehearsal.ts の config）。
#    版のファイルは build の後で git checkout で元に戻す。
# 3. 版 B のインストーラと目録（latest.json）を 127.0.0.1 で配り、版 A を静かに入れる。
# 4. 入れた版 A の UI に、確認、取得、インストールを殻へ頼む台本を差し込み（update-rehearsal.ts の inject）、殻を起こす。
#    殻はふだんと同じ updater の経路で、取得した版 B のインストーラを /P /UPDATE /R /ARGS で起こし、その直前（on_before_exit）に子のサーバを止めて抜ける。
#    インストーラは入れるときのフック（hooks.nsh の NSIS_HOOK_PREINSTALL）で殻が抜けるのを待ち、入れ終えたら殻を起こし直す。
# 5. 起き直した殻のサーバが /health で版 B を名乗ること、インストーラの引数、desktop.log の印、目録と更新物が取られたことを確かめる。
# 6. 版 B が開いている間にアンインストーラを起こし、動いている殻の問いで取り消すと、PATH と入れた先が残ることを確かめる（hooks.nsh の NSIS_HOOK_POSTUNINSTALL）。
# 7. 殻を止めて静かに消し、PATH から外れたことを見て片付ける。
#
# 殻は、更新のあと updater のインストーラから起こし直される（nsis_tauri_utils の RunAsUser）。
# そのとき殻が受け取る環境はこの台本のものとは限らないので、HANGAR_HOME は使わず、既定のホーム（~\.agent-hangar）の settings.json の nodePath で setup-node の Node を指す。
# CI の機械は使い捨てで、終わったら settings.json を元に戻す。
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$desktop = Join-Path $root 'apps/desktop'
$helper = Join-Path $PSScriptRoot 'update-rehearsal.ts'
$plan = Join-Path $PSScriptRoot 'release-plan.ts'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$work = Join-Path ([IO.Path]::GetTempPath()) ('hangar-update-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work | Out-Null
$port = 47180
$health = 'http://127.0.0.1:4177/health'
$dir = Join-Path $env:LOCALAPPDATA 'Hangar'
$bin = Join-Path $dir 'server\bin'
$hangarHome = Join-Path $env:USERPROFILE '.agent-hangar'
$settings = Join-Path $hangarHome 'settings.json'
$desktopLog = Join-Path $hangarHome 'desktop.log'
# 版の在りか（release-plan.ts の VERSION_FILES）。set-version で上げた版 B の build の後で元に戻す。
$versionFiles = @('apps/desktop/src-tauri/tauri.conf.json', 'apps/desktop/package.json', 'apps/desktop/src-tauri/Cargo.toml', 'apps/desktop/src-tauri/Cargo.lock', 'package-lock.json')

function Invoke-Helper {
  & node --experimental-strip-types --no-warnings $helper @args
  if ($LASTEXITCODE -ne 0) { throw "update-rehearsal.ts $($args -join ' ') が終了コード $LASTEXITCODE で終わった" }
}

function Get-Health {
  try { return Invoke-RestMethod -Uri $health -TimeoutSec 2 } catch { return $null }
}

# 利用者単位の PATH（展開前）に、同梱の hangar.cmd の置き場があるか。書き方の違い（大文字小文字、末尾の \）は同じものとみなす。
function Test-BinOnPath {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  $v = if ($k) { [string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames') } else { '' }
  return @($v -split ';' | Where-Object { $_.TrimEnd('\') -eq $bin }).Count -gt 0
}

# 入れた先の殻のプロセス（版を問わない）。
function Get-Shell {
  return @(Get-Process | Where-Object { $_.Path -and $_.Path -like "$dir\*" -and $_.Name -notlike 'uninstall*' })
}

# 版 A と版 B のインストーラを、使い捨ての鍵とローカルの目録を重ねて build し、署名と一緒に $dest へ写す。
function Build-Installer([string]$version, [string]$dest) {
  $bundle = Join-Path $desktop "src-tauri/target/$Target/release/bundle/nsis"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $bundle
  $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $keyFile -Raw).Trim()
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $password
  try {
    Push-Location $root
    npm run tauri -w apps/desktop -- build --bundles nsis --target $Target --config $conf | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "版 $version の build が終了コード $LASTEXITCODE で終わった" }
  } finally {
    Pop-Location
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
  }
  $setup = @(Get-ChildItem $bundle | Where-Object { $_.Name -like '*-setup.exe' })
  if ($setup.Count -ne 1) { throw "版 $version の NSIS のインストーラが 1 つでない（$($setup.Count) 個）" }
  if ($setup[0].Name -notlike "*_${version}_*") { throw "$($setup[0].Name) は版 $version のインストーラではない" }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item $setup[0].FullName, "$($setup[0].FullName).sig" $dest
  return (Join-Path $dest $setup[0].Name)
}

$server = $null
$savedSettings = $null
$hadSettings = Test-Path $settings
$restoreVersions = $false
try {
  # --- 1. 使い捨ての鍵と、重ねる設定 ---
  $versionA = (Get-Content (Join-Path $desktop 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
  $versionB = (Invoke-Helper next-version $versionA | Out-String).Trim()
  "版 A: ${versionA}、版 B: $versionB"
  $keyFile = Join-Path $work 'updater.key'
  $password = 'ci-update-rehearsal'
  Push-Location $root
  try {
    npm run tauri -w apps/desktop -- signer generate --ci -p $password -w $keyFile | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "鍵を作れなかった（終了コード ${LASTEXITCODE}）" }
  } finally { Pop-Location }
  $conf = Join-Path $work 'rehearsal.conf.json'
  Invoke-Helper config "$keyFile.pub" $port $conf
  Get-Content $conf

  # --- 2. 版 A と版 B の build ---
  $t0 = Get-Date
  $setupA = Build-Installer $versionA (Join-Path $work 'a')
  '版 A の build: {0:N0} 秒' -f ((Get-Date) - $t0).TotalSeconds
  $restoreVersions = $true
  & node --experimental-strip-types --no-warnings $plan set-version $versionB $root
  if ($LASTEXITCODE -ne 0) { throw "版を $versionB に上げられなかった" }
  $t0 = Get-Date
  $setupB = Build-Installer $versionB (Join-Path $work 'b')
  '版 B の build: {0:N0} 秒' -f ((Get-Date) - $t0).TotalSeconds
  git -C $root checkout -- @versionFiles
  if ($LASTEXITCODE -ne 0) { throw '版のファイルを戻せなかった' }
  $restoreVersions = $false

  # --- 3. 目録と更新物を配り、版 A を入れる ---
  $serveDir = Join-Path $work 'serve'
  Invoke-Helper stage $serveDir $versionB 'windows-x86_64' $setupB $port
  $serveLog = Join-Path $Out 'serve.log'
  $server = Start-Process -FilePath (Get-Command node).Source -ArgumentList @('--experimental-strip-types', '--no-warnings', $helper, 'serve', $serveDir, $port) -RedirectStandardOutput $serveLog -RedirectStandardError (Join-Path $Out 'serve.err.log') -PassThru -NoNewWindow
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline -and -not ((Test-Path $serveLog) -and (Get-Content $serveLog -Raw) -match 'listening on')) { Start-Sleep -Milliseconds 200 }
  if (-not ((Get-Content $serveLog -Raw) -match 'listening on')) { throw '目録を配る HTTP が起きない' }

  if (Get-Health) { throw '版 A を起こす前から 4177 が応えている' }
  if (Get-Shell) { throw '版 A を入れる前から殻が動いている' }
  $p = Start-Process -FilePath $setupA -ArgumentList '/S' -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "版 A のインストーラが終了コード $($p.ExitCode) で終わった" }
  if (-not (Test-BinOnPath)) { throw "版 A を入れても PATH に $bin が無い" }
  $exe = Get-ChildItem $dir -Filter *.exe | Where-Object { $_.Name -ne 'uninstall.exe' } | Select-Object -First 1
  if (-not $exe) { throw '殻の exe が入っていない' }

  # --- 4. 版 A の UI に更新を進める台本を差し込み、殻を起こす ---
  $ui = Join-Path $dir 'server\ui'
  Invoke-Helper inject $ui
  $injected = Join-Path $ui 'assets\ci-update-rehearsal.js'
  New-Item -ItemType Directory -Force -Path $hangarHome | Out-Null
  if ($hadSettings) { $savedSettings = Get-Content $settings -Raw }
  $node = (Get-Command node).Source
  @{ nodePath = $node } | ConvertTo-Json | Set-Content -Path $settings -Encoding utf8
  if (Test-Path $desktopLog) { Remove-Item $desktopLog -Force }
  $a = Start-Process -FilePath $exe.FullName -PassThru
  "版 A の殻を起こした（pid $($a.Id)）"

  # --- 5. 版 B が起き直すのを待つ ---
  # 殻がインストーラに渡す引数は、インストーラが動いている間にだけ読める。0.25 秒おきに見る。
  $installerLine = $null
  $sawA = $false
  $serverA = $null
  $h = $null
  $deadline = (Get-Date).AddMinutes(5)
  $nextHealth = Get-Date
  while ((Get-Date) -lt $deadline) {
    if (-not $installerLine) {
      $installer = Get-CimInstance Win32_Process -Filter "Name LIKE '%-installer.exe'" -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($installer) { $installerLine = $installer.CommandLine; "インストーラを見た: $installerLine" }
    }
    if ((Get-Date) -ge $nextHealth) {
      $nextHealth = (Get-Date).AddSeconds(1)
      $h = Get-Health
      if ($h -and $h.version -eq $versionA -and -not $sawA) {
        $sawA = $true
        $serverA = (Get-NetTCPConnection -LocalPort 4177 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
        "版 A のサーバーが応えた（pid ${serverA}）"
      }
      if ($h -and $h.version -eq $versionB) { break }
      if ((Test-Path $desktopLog) -and (Get-Content $desktopLog -Raw) -match 'update: (check|download|install) failed[^\r\n]*') { throw "殻の更新が失敗した: $($Matches[0])" }
    }
    Start-Sleep -Milliseconds 250
  }
  if (Test-Path $desktopLog) { Copy-Item $desktopLog (Join-Path $Out 'desktop.log') }
  '--- desktop.log ---'
  if (Test-Path $desktopLog) { Get-Content $desktopLog -Tail 60 }
  '--- serve.log ---'
  Get-Content $serveLog
  if (-not $sawA) { throw '版 A のサーバーが応えなかった' }
  if (-not ($h -and $h.version -eq $versionB)) { throw "更新のあと $health が版 $versionB を名乗らなかった（最後の答え: $($h | ConvertTo-Json -Compress)）" }
  "起き直した殻のサーバーが版 $versionB を名乗った"

  # インストーラは、殻の updater が passive（/P）、更新（/UPDATE）、入れ終えたら起こし直す（/R と /ARGS）で起こしたもの。
  if (-not $installerLine) { throw '更新のインストーラが動いているところを見られなかった' }
  $words = @($installerLine -split '\s+')
  foreach ($a1 in @('/P', '/UPDATE', '/R', '/ARGS')) {
    if ($words -notcontains $a1) { throw "インストーラの引数に $a1 が無い: $installerLine" }
  }
  # 殻は、インストーラへ渡す直前（on_before_exit）に子のサーバを止めてから抜けた。
  $log = Get-Content $desktopLog -Raw
  foreach ($mark in @("update: checked, found $versionB", "update: downloaded $versionB", 'update: handing over to the installer')) {
    if (-not $log.Contains($mark)) { throw "desktop.log に「${mark}」が無い" }
  }
  $handOver = $log.IndexOf('update: handing over to the installer')
  if ($log.IndexOf('server stopped', $handOver) -lt 0) { throw 'インストーラへ渡すときに、殻がサーバーを止めていない（desktop.log に server stopped が無い）' }
  if ($serverA -and (Get-Process -Id $serverA -ErrorAction SilentlyContinue)) { throw "版 A のサーバー（pid ${serverA}）が残っている" }
  # 入れるときのフック（NSIS_HOOK_PREINSTALL）は、殻が抜けてから同梱サーバの置き場を空にした。差し込んだ台本は版 B に無い。
  if (Test-Path $injected) { throw '版 A に差し込んだ台本が残っている（入れるときのフックが置き場を空にしていない）' }
  $display = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Hangar' -ErrorAction SilentlyContinue).DisplayVersion
  if ($display -ne $versionB) { throw "アンインストールの登録の版が ${display}（期待は ${versionB}）" }
  $served = Get-Content $serveLog -Raw
  if ($served -notmatch 'GET /latest\.json 200') { throw '殻が目録を取りに来ていない' }
  if ($served -notmatch "GET /[^ ]*$([regex]::Escape([uri]::EscapeDataString((Split-Path $setupB -Leaf)))) 200") { throw '殻が版 B のインストーラを取りに来ていない' }
  if (-not (Test-BinOnPath)) { throw "更新のあと PATH に $bin が無い" }
  $shells = Get-Shell
  if ($shells.Count -eq 0) { throw '起き直した殻が見つからない' }
  "起き直した殻: $($shells | ForEach-Object { "$($_.Id) $($_.Path)" })"

  # --- 6. 殻を開いたまま消そうとして、動いている殻の問いで取り消す ---
  # Tauri の雛形では、消す前のフック（NSIS_HOOK_PREUNINSTALL）は、動いている殻の確認（CheckIfAppIsRunning）より前に走る。
  # 取り消したアンインストールは、PATH も入れた先も変えない。
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class HangarWindows {
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  // このプロセスの、見えている対話の窓（#32770）。NSIS の本体の窓も MessageBox もこの形である。
  public static IntPtr[] Dialogs(uint pid) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint p;
      GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h)) {
        var s = new StringBuilder(64);
        GetClassNameW(h, s, s.Capacity);
        if (s.ToString() == "#32770") found.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
}
'@
  $WM_COMMAND = 0x0111
  $IDOK = 1
  $IDCANCEL = 2
  $u = Start-Process -FilePath (Join-Path $dir 'uninstall.exe') -ArgumentList "_?=$dir" -PassThru
  try {
    $main = [IntPtr]::Zero
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and $main -eq [IntPtr]::Zero) {
      $d = [HangarWindows]::Dialogs([uint32]$u.Id)
      if ($d.Count -gt 0) { $main = $d[0] } else { Start-Sleep -Milliseconds 250 }
    }
    if ($main -eq [IntPtr]::Zero) { throw 'アンインストーラの確認の頁が出ない' }
    Start-Sleep -Seconds 1
    # 確認の頁の「アンインストール」（NSIS の次へのボタン、IDOK）を押す。
    [HangarWindows]::PostMessageW($main, $WM_COMMAND, [IntPtr]$IDOK, [HangarWindows]::GetDlgItem($main, $IDOK)) | Out-Null
    $box = [IntPtr]::Zero
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and $box -eq [IntPtr]::Zero) {
      $others = @([HangarWindows]::Dialogs([uint32]$u.Id) | Where-Object { $_ -ne $main })
      if ($others.Count -gt 0) { $box = $others[0] } else { Start-Sleep -Milliseconds 250 }
      if ($u.HasExited) { break }
    }
    if ($box -eq [IntPtr]::Zero) { throw "動いている殻を止めるかの問いが出ない（アンインストーラの終了: $($u.HasExited)）" }
    # 問いの「キャンセル」（IDCANCEL）を押す。雛形はここで Abort し、何も消さずに止まる。
    [HangarWindows]::PostMessageW($box, $WM_COMMAND, [IntPtr]$IDCANCEL, [IntPtr]::Zero) | Out-Null
    Start-Sleep -Seconds 3
    if ($u.HasExited -and $u.ExitCode -eq 0) { throw '取り消したのにアンインストールが終わった' }
    if (-not (Test-BinOnPath)) { throw "取り消したのに PATH から $bin が外れた" }
    if (-not (Test-Path $exe.FullName) -or -not (Test-Path (Join-Path $dir 'server\server.mjs'))) { throw '取り消したのに入れた先のファイルが消えた' }
    if ((Get-Shell).Count -eq 0) { throw '取り消したのに殻が止まった' }
    '殻を開いたまま消そうとして取り消すと、PATH と入れた先が残った'
  } finally {
    if (-not $u.HasExited) { Stop-Process -Id $u.Id -Force }
    $u.WaitForExit(15000) | Out-Null
  }
} finally {
  # --- 7. 片付け ---
  foreach ($s in Get-Shell) { Stop-Process -Id $s.Id -Force -ErrorAction SilentlyContinue }
  $gone = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $gone -and (Get-Process | Where-Object { $_.Path -like "$dir\*" })) { Start-Sleep -Milliseconds 500 }
  if (Test-Path (Join-Path $dir 'uninstall.exe')) {
    $u2 = Start-Process -FilePath (Join-Path $dir 'uninstall.exe') -ArgumentList "/S _?=$dir" -Wait -PassThru
    if ($u2.ExitCode -ne 0) { "::warning::アンインストーラが終了コード $($u2.ExitCode) で終わった" }
    elseif (Test-BinOnPath) { "::error::消し終えたのに PATH に $bin が残っている"; $script:cleanupFailed = $true }
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
  if ($restoreVersions) { git -C $root checkout -- @versionFiles }
  if ($hadSettings) { Set-Content -Path $settings -Value $savedSettings -NoNewline } else { Remove-Item $settings -Force -ErrorAction SilentlyContinue }
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
if ($script:cleanupFailed) { exit 1 }
'更新の経路を通し終えた'
