# Random ppl talk - launcher (Windows PowerShell 5.1 compatible).
# Starts a local llama.cpp llama-server (Qwen3 GGUF) that serves the game and the
# OpenAI-compatible API on http://127.0.0.1:<port>/ , then opens the browser.
#   Start-Game.bat                    default: Qwen3-8B, Vulkan GPU build (auto fallback to CPU)
#   Start-Game.bat -Small             use Qwen3-4B (weaker PCs)
#   Start-Game.bat -Model D:\x.gguf   use your own GGUF file (or set env RPT_MODEL)
#   Start-Game.bat -CpuOnly           skip the GPU build
#   Start-Game.bat -Port 8090         preferred port (a free one is chosen if busy)
param(
    [string]$Model = '',
    [switch]$Small,
    [switch]$CpuOnly,
    [int]$Port = 8080,
    [int]$Context = 8192,
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { $Host.UI.RawUI.WindowTitle = 'Random ppl talk' } catch { }

$Root = Split-Path -Parent $PSScriptRoot
$GameDir = Join-Path $Root 'game'
if (-not (Test-Path -LiteralPath (Join-Path $GameDir 'index.html'))) {
    # Running from a source checkout (index.html at the repo root) instead of the release zip.
    if (Test-Path -LiteralPath (Join-Path $Root 'index.html')) { $GameDir = $Root }
}
$LogDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LauncherLog = Join-Path $LogDir 'launcher.log'
$Setup = Join-Path $PSScriptRoot 'setup.ps1'
$SizeKey = '8b'
if ($Small) { $SizeKey = '4b' }

function Log([string]$msg) {
    try { Add-Content -LiteralPath $LauncherLog -Value ("{0} {1}" -f (Get-Date -Format 's'), $msg) -Encoding UTF8 } catch { }
}
function Say([string]$msg, [string]$color = '') {
    Log $msg
    if ($color) { Write-Host $msg -ForegroundColor $color } else { Write-Host $msg }
}
function Fail([string]$msg) {
    Say ''
    Say "錯誤：$msg" 'Red'
    Say "詳細記錄在：$LogDir"
    exit 1
}

function Test-PortFree([int]$p) {
    try {
        $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
        $l.Start(); $l.Stop()
        return $true
    } catch { return $false }
}

function Find-Server([string]$Dir) {
    if (-not (Test-Path -LiteralPath $Dir)) { return $null }
    $f = Get-ChildItem -LiteralPath $Dir -Recurse -Filter 'llama-server.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($f) { return $f.FullName }
    return $null
}

function Stop-Server($p) {
    try { if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } catch { }
}

# Leftover server from a previous run (e.g. the window was killed): free the model file and port.
function Stop-StaleServers {
    try {
        Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue | Where-Object {
            $_.Path -and $_.Path.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)
        } | ForEach-Object { Say "關閉上次殘留的模型伺服器 (PID $($_.Id))"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    } catch { }
}

# Returns $true when /health answers 200 {"status":"ok"}. 503 means the model is still loading.
function Wait-Healthy($proc, [int]$p, [int]$timeoutSec) {
    $t0 = Get-Date
    $url = "http://127.0.0.1:$p/health"
    while (((Get-Date) - $t0).TotalSeconds -lt $timeoutSec) {
        if ($proc.HasExited) { return $false }
        try {
            $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3
            if ($r.StatusCode -eq 200) { Write-Host ''; return $true }
        } catch { }
        $secs = [int]((Get-Date) - $t0).TotalSeconds
        Write-Host -NoNewline ("`r模型載入中…（已等待 {0} 秒）   " -f $secs)
        Start-Sleep -Milliseconds 1000
    }
    Write-Host ''
    return $false
}

function Tail-Log([string]$file, [int]$n = 15) {
    try { if (Test-Path -LiteralPath $file) { Get-Content -LiteralPath $file -Tail $n -Encoding UTF8 | ForEach-Object { Write-Host "    $_" } } } catch { }
}

# ------------------------------------------------------------------ main
Say '=== Random ppl talk（隨機的人聊聊）==='
Say '本機 AI 模式：模型在你自己的電腦上執行，不會連到任何雲端服務。'
if (-not [Environment]::Is64BitOperatingSystem) { Fail '需要 64 位元的 Windows。' }
if (-not (Test-Path -LiteralPath (Join-Path $GameDir 'index.html'))) { Fail "找不到遊戲檔案（$GameDir）。請確認有把整個 RandomPplTalk 資料夾完整解壓縮。" }

# Model
if (-not $Model -and $env:RPT_MODEL) { $Model = $env:RPT_MODEL }
$ModelFile = @{ '8b' = 'Qwen3-8B-Q4_K_M.gguf'; '4b' = 'Qwen3-4B-Q4_K_M.gguf' }[$SizeKey]
if ($Model) {
    if (-not (Test-Path -LiteralPath $Model)) { Fail "找不到指定的模型檔：$Model" }
    $ModelPath = (Resolve-Path -LiteralPath $Model).Path
    Say "使用自訂模型：$ModelPath"
} else {
    $ModelPath = Join-Path $Root "models\$ModelFile"
    try {
        & $Setup -What model -Size $SizeKey
    } catch { Fail $_.Exception.Message }
    if (-not (Test-Path -LiteralPath $ModelPath)) { Fail "模型檔不存在：$ModelPath" }
}

Stop-StaleServers
$ChosenPort = $Port
if (-not (Test-PortFree $ChosenPort)) {
    $found = $false
    foreach ($c in ($Port + 1)..($Port + 40)) { if (Test-PortFree $c) { $ChosenPort = $c; $found = $true; break } }
    if (-not $found) { Fail "找不到可用的連接埠（從 $Port 起）。" }
    Say "連接埠 $Port 已被占用，改用 $ChosenPort。"
}

# Backend order: last backend that worked first; Vulkan (any GPU) then CPU.
$BackendFile = Join-Path $Root 'bin\backend.txt'
$variants = @('vulkan', 'cpu')
if ($CpuOnly) { $variants = @('cpu') }
elseif ((Test-Path -LiteralPath $BackendFile) -and ((Get-Content -LiteralPath $BackendFile -Raw).Trim() -eq 'cpu')) { $variants = @('cpu') }

$server = $null
$serverOk = $false
$dllMissing = $false
foreach ($v in $variants) {
    try { & $Setup -What $v } catch { Say "無法準備 $v 版：$($_.Exception.Message)" 'Yellow'; continue }
    $exe = Find-Server (Join-Path $Root "bin\$v")
    if (-not $exe) { Say "找不到 $v 版的 llama-server.exe" 'Yellow'; continue }
    $ngl = 99
    if ($v -eq 'cpu') { $ngl = 0 }
    $label = 'GPU（Vulkan）'
    if ($v -eq 'cpu') { $label = 'CPU' }
    Say ''
    Say "啟動模型伺服器：$label，連接埠 $ChosenPort（第一次載入約需 10～60 秒，CPU 較久）"
    $out = Join-Path $LogDir "server-$v.out.log"
    $err = Join-Path $LogDir "server-$v.err.log"
    $argStr = ('-m "{0}" --path "{1}" --host 127.0.0.1 --port {2} -c {3} -np 1 -ngl {4} --jinja --reasoning off' -f $ModelPath, $GameDir, $ChosenPort, $Context, $ngl)
    Log "exec: $exe $argStr"
    try {
        $server = Start-Process -FilePath $exe -ArgumentList $argStr -WorkingDirectory (Split-Path -Parent $exe) -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
        $null = $server.Handle   # keep the handle so ExitCode stays readable
    } catch {
        Say "無法執行 $exe：$($_.Exception.Message)" 'Yellow'
        $server = $null
        continue
    }
    if (Wait-Healthy $server $ChosenPort 420) {
        $serverOk = $true
        try { Set-Content -LiteralPath $BackendFile -Value $v -Encoding ASCII } catch { }
        break
    }
    $code = $null
    if ($server.HasExited) { $code = $server.ExitCode }
    Say "$label 版沒有成功啟動（結束代碼：$code）。最後的記錄：" 'Yellow'
    Tail-Log $err
    if ($code -eq -1073741515) { $dllMissing = $true }
    Stop-Server $server
    $server = $null
    if ($v -eq 'vulkan') { Say '改用 CPU 版重試…' 'Yellow' }
}

if (-not $serverOk) {
    if ($dllMissing) { Say '缺少系統元件。請先安裝 Microsoft Visual C++ 可轉散發套件：https://aka.ms/vs/17/release/vc_redist.x64.exe' 'Yellow' }
    Fail '模型伺服器無法啟動。若記憶體不足，請試試：Start-Game.bat -Small（改用 Qwen3-4B）。'
}

$url = "http://127.0.0.1:$ChosenPort/"
try {
    Say ''
    Say "遊戲已就緒：$url" 'Green'
    if (-not $NoBrowser) { Start-Process $url }
    Say '如果瀏覽器沒有自動開啟，請手動貼上上面的網址。'
    Say '關閉此視窗即可結束遊戲。' 'Cyan'
    while (-not $server.HasExited) { Start-Sleep -Seconds 1 }
    Say "模型伺服器已停止（結束代碼：$($server.ExitCode)）。最後的記錄：" 'Yellow'
    Tail-Log $err
    Say '請關閉此視窗後再重新啟動。'
    exit 1
} finally {
    Stop-Server $server
}
