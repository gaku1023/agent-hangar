# Node の無い Windows で、入れた殻が失敗の札を出すことを確かめる。CI の windows ジョブが呼ぶ。
# 使い方: pwsh apps/desktop/scripts/ci-boot-probe-windows.ps1 -Setup <インストーラ> -Out <成果物の置き場>
#
# インストーラで静かに入れ、入れた殻を Node が見つからない状態で起こす。
#   一時のホーム（HANGAR_HOME）の settings.json の nodePath は無いパスにする。
#   殻は公式の入れ先（%ProgramFiles%\nodejs、%LOCALAPPDATA%\Programs\nodejs）、nvm-windows、PATH の順に探す（node.rs の windows_node_paths）。
#   ランナーには Node が入っているので、殻に渡す環境だけで、ProgramFiles と LOCALAPPDATA を空の一時の場所に向け、NVM_* を外し、PATH から node.exe のある項目を外す。
#   Windows は 64 ビットの子を起こすとき、ProgramFiles を ProgramW6432 の値で書き直す。ProgramFiles だけを替えても子には届かないので、ProgramW6432 も替える。
#   機械の上の Node には触らない。WebView2 の置き場は環境変数ではなく既知のフォルダから決まるので、この差し替えに左右されない。
# 殻には HANGAR_BOOT_PROBE で書き出しの先を渡す。起動画面が描いた様子を殻がそこへ書き（bootprobe.rs）、
# boot-probe-check.ts が、札が出て種類が other、詳細が「Node <版>」を含む文になるまで待つ（上限 60 秒）。
# 画面を撮れれば boot-screen.png を、殻の記録（desktop.log）と一緒に成果物の置き場に残す。撮れなくても落とさない。
param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$check = Join-Path $PSScriptRoot 'boot-probe-check.ts'

# 誰かが既に 4177 で応えていると、殻はそれを採って Node を探さない。
$busy = $false
try { Invoke-RestMethod -Uri 'http://127.0.0.1:4177/health' -TimeoutSec 2 | Out-Null; $busy = $true } catch { }
if ($busy) { throw '殻を起こす前から 4177 が応えている' }

$p = Start-Process -FilePath (Resolve-Path $Setup).Path -ArgumentList '/S' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "インストーラが終了コード $($p.ExitCode) で終わった" }
$dir = Join-Path $env:LOCALAPPDATA 'Hangar'
$exe = Get-ChildItem $dir -Filter *.exe | Where-Object { $_.Name -ne 'uninstall.exe' } | Select-Object -First 1
if (-not $exe) { throw '殻の exe が入っていない' }

$work = Join-Path ([IO.Path]::GetTempPath()) ("hangar-boot-probe-" + [guid]::NewGuid().ToString('N'))
$hangarHome = Join-Path $work 'hangar-home'
$emptyProgramFiles = Join-Path $work 'program-files'
$emptyLocalAppData = Join-Path $work 'local-app-data'
foreach ($d in $hangarHome, $emptyProgramFiles, $emptyLocalAppData) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
@{ nodePath = (Join-Path $work 'no-such-node.exe') } | ConvertTo-Json | Set-Content -Path (Join-Path $hangarHome 'settings.json') -Encoding utf8
$probe = Join-Path $Out 'probe.json'

# 殻に渡す環境だけを差し替え、起こしたらすぐ戻す。Start-Process はこのプロセスの環境を子へ渡す。
$names = 'HANGAR_HOME', 'HANGAR_BOOT_PROBE', 'PATH', 'ProgramFiles', 'ProgramW6432', 'LOCALAPPDATA', 'NVM_SYMLINK', 'NVM_HOME'
$saved = @{}
foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
$kept = @($env:PATH -split ';' | Where-Object { $_ -and -not (Test-Path -LiteralPath (Join-Path $_ 'node.exe')) })
$dropped = @($env:PATH -split ';' | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'node.exe')) })
"PATH から外した項目: $($dropped -join '; ')"
$app = $null
try {
  $env:HANGAR_HOME = $hangarHome
  $env:HANGAR_BOOT_PROBE = $probe
  $env:PATH = $kept -join ';'
  $env:ProgramFiles = $emptyProgramFiles
  $env:ProgramW6432 = $emptyProgramFiles
  $env:LOCALAPPDATA = $emptyLocalAppData
  Remove-Item Env:NVM_SYMLINK, Env:NVM_HOME -ErrorAction SilentlyContinue
  # 子が実際に受け取る値を、同じ環境で起こした 64 ビットの cmd で確かめて印字する。
  "子が見る ProgramFiles: $((& cmd.exe /d /c 'echo %ProgramFiles%') -join '')"
  $app = Start-Process -FilePath $exe.FullName -PassThru
} finally {
  foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) }
}
"殻を起こした（pid $($app.Id)）"

$rc = 0
try {
  & node --experimental-strip-types --no-warnings $check wait $probe --kind other --detail 'Node [0-9]+' --timeout 60 --pid $app.Id
  $rc = $LASTEXITCODE
  # 札が描き終わるのを少し待ってから撮る。窓のある画面に出ていなければ撮れない。
  Start-Sleep -Seconds 1
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $Out 'boot-screen.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    "画面を撮った: boot-screen.png（$($b.Width)×$($b.Height)）"
  } catch {
    "::warning::画面を撮れなかった（$($_.Exception.Message)）"
  }
} finally {
  if ($app -and -not $app.HasExited) { Stop-Process -Id $app.Id -Force }
  if ($app) { $app.WaitForExit(15000) | Out-Null }
  $log = Join-Path $hangarHome 'desktop.log'
  if (Test-Path $log) {
    Copy-Item $log (Join-Path $Out 'desktop.log')
    '--- desktop.log ---'
    Get-Content $log -Tail 40
    # 殻が Node を見つけてサーバを起こしたなら、探す場所が増えたか、ランナーの Node を退けきれていない。
    $m = [regex]::Match((Get-Content $log -Raw), '\[desktop\] node (.+) server ')
    if ($m.Success) {
      Write-Host "殻が Node を見つけた: $($m.Groups[1].Value)。node.rs の探す場所が増えたなら、この台本の差し替えも合わせる"
      $rc = 1
    }
  }
  # 片付け。ここでは消す側の振る舞いは確かめない（windows-installer の段が確かめる）。
  $u = Start-Process -FilePath (Join-Path $dir 'uninstall.exe') -ArgumentList "/S _?=$dir" -Wait -PassThru
  if ($u.ExitCode -ne 0) { "::warning::アンインストーラが終了コード $($u.ExitCode) で終わった" }
}
exit $rc
