# Random ppl talk - first-run setup (Windows PowerShell 5.1 compatible).
# Downloads the llama.cpp Windows build and/or the Qwen3 GGUF model.
# Called by start.ps1:   setup.ps1 -What vulkan | cpu | model | check   [-Size 8b|4b]
param(
    [Parameter(Mandatory = $true)][ValidateSet('vulkan', 'cpu', 'model', 'check')][string]$What,
    [ValidateSet('8b', '4b')][string]$Size = '8b'
)
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent $PSScriptRoot
$LlamaTag = 'b12767'   # pinned llama.cpp release; assets are llama-<tag>-bin-win-<backend>-x64.zip
$Models = @{
    '8b' = @{
        File = 'Qwen3-8B-Q4_K_M.gguf'; MinBytes = [int64]4500000000; NeedDiskGB = 7; WarnRamGB = 12
        Urls = @(
            'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
            'https://huggingface.co/bartowski/Qwen_Qwen3-8B-GGUF/resolve/main/Qwen_Qwen3-8B-Q4_K_M.gguf'
        )
    }
    '4b' = @{
        File = 'Qwen3-4B-Q4_K_M.gguf'; MinBytes = [int64]2000000000; NeedDiskGB = 4; WarnRamGB = 8
        Urls = @(
            'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf',
            'https://huggingface.co/bartowski/Qwen_Qwen3-4B-GGUF/resolve/main/Qwen_Qwen3-4B-Q4_K_M.gguf'
        )
    }
}

function Find-Server([string]$Dir) {
    if (-not (Test-Path -LiteralPath $Dir)) { return $null }
    $f = Get-ChildItem -LiteralPath $Dir -Recurse -Filter 'llama-server.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($f) { return $f.FullName }
    return $null
}

function Get-FreeGB([string]$Path) {
    try {
        $qual = Split-Path -Qualifier $Path
        if (-not $qual) { return $null }
        $d = New-Object System.IO.DriveInfo($qual)
        return [math]::Round($d.AvailableFreeSpace / 1GB, 1)
    } catch { return $null }
}

# Resumable download: curl.exe (ships with Windows 10 1803+), BITS as fallback.
function Get-File([string[]]$Urls, [string]$Dest, [int64]$MinBytes) {
    $part = "$Dest.part"
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    foreach ($u in $Urls) {
        Write-Host "  來源：$u"
        if (Test-Path -LiteralPath $part) {
            # Only resume a partial file when it came from the same URL.
            $marker = "$part.url"
            $prev = ''
            if (Test-Path -LiteralPath $marker) { $prev = (Get-Content -LiteralPath $marker -Raw).Trim() }
            if ($prev -ne $u) { Remove-Item -LiteralPath $part -Force }
        }
        Set-Content -LiteralPath "$part.url" -Value $u -Encoding ASCII
        for ($try = 1; $try -le 3; $try++) {
            $code = 1
            if ($curl) {
                & $curl.Source -L --fail --retry 5 --retry-delay 3 --connect-timeout 30 -C - --progress-bar -o $part $u
                $code = $LASTEXITCODE
            } else {
                try {
                    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
                    Start-BitsTransfer -Source $u -Destination $part -DisplayName 'Random ppl talk'
                    $code = 0
                } catch { $code = 1 }
            }
            $sz = 0
            if (Test-Path -LiteralPath $part) { $sz = (Get-Item -LiteralPath $part).Length }
            if (($code -eq 0 -or $code -eq 33) -and $sz -ge $MinBytes) {
                Move-Item -LiteralPath $part -Destination $Dest -Force
                Remove-Item -LiteralPath "$part.url" -Force -ErrorAction SilentlyContinue
                return $true
            }
            if ($code -eq 22) { break }   # HTTP error (404/403): retrying the same URL will not help
            if ($code -eq 0 -and $sz -lt $MinBytes) {
                # Finished but too small: not the real file.
                Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
                break
            }
            Write-Host "  下載中斷（代碼 $code），第 $try 次重試…"
            Start-Sleep -Seconds 3
        }
    }
    Remove-Item -LiteralPath "$part.url" -Force -ErrorAction SilentlyContinue
    return $false
}

function Install-Llama([string]$Variant) {
    $dir = Join-Path $Root "bin\$Variant"
    if (Find-Server $dir) { return }
    $binRoot = Join-Path $Root 'bin'
    New-Item -ItemType Directory -Force -Path $binRoot | Out-Null
    $asset = "llama-$LlamaTag-bin-win-$Variant-x64.zip"
    Write-Host ''
    Write-Host "== 下載 llama.cpp ($Variant 版，約數十 MB) =="
    $zip = Join-Path $binRoot $asset
    $urls = @("https://github.com/ggml-org/llama.cpp/releases/download/$LlamaTag/$asset")
    $ok = Get-File $urls $zip ([int64]5000000)
    if (-not $ok) {
        # Pinned asset unreachable: ask the GitHub API for the newest release that has this backend.
        Write-Host '  固定版本下載失敗，嘗試查詢最新版本…'
        try {
            $rel = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest' -Headers @{ 'User-Agent' = 'RandomPplTalk' }
            $a = $rel.assets | Where-Object { $_.name -match "bin-win-$Variant-x64\.zip$" } | Select-Object -First 1
            if ($a) { $zip = Join-Path $binRoot $a.name; $ok = Get-File @($a.browser_download_url) $zip ([int64]5000000) }
        } catch { Write-Host "  查詢失敗：$($_.Exception.Message)" }
    }
    if (-not $ok) { throw "無法下載 llama.cpp ($Variant)。請檢查網路，或手動把 $asset 解壓縮到 $dir" }
    Write-Host '  解壓縮中…'
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    try {
        Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
    } catch {
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        throw "解壓縮失敗：$($_.Exception.Message)"
    }
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    if (-not (Find-Server $dir)) { throw "解壓縮後找不到 llama-server.exe（$dir）" }
    Write-Host '  llama.cpp 準備完成。'
}

function Test-System([string]$ModelSize) {
    $m = $Models[$ModelSize]
    $ramGB = $null
    try { $ramGB = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1) } catch { }
    if ($ramGB) {
        Write-Host "記憶體：$ramGB GB"
        if ($ramGB -lt $m.WarnRamGB) {
            Write-Host "警告：記憶體低於建議的 $($m.WarnRamGB) GB，可能會很慢或載入失敗。可改用較小的模型：Start-Game.bat -Small" -ForegroundColor Yellow
        }
    }
}

switch ($What) {
    'check' { Test-System $Size }
    'vulkan' { Install-Llama 'vulkan' }
    'cpu' { Install-Llama 'cpu' }
    'model' {
        $m = $Models[$Size]
        $dir = Join-Path $Root 'models'
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $dest = Join-Path $dir $m.File
        if ((Test-Path -LiteralPath $dest) -and ((Get-Item -LiteralPath $dest).Length -ge $m.MinBytes)) { return }
        Test-System $Size
        $free = Get-FreeGB $dir
        if ($free -ne $null -and $free -lt $m.NeedDiskGB) {
            throw "磁碟空間不足：需要至少 $($m.NeedDiskGB) GB，目前只剩 $free GB。請清出空間，或把整個資料夾搬到空間較大的磁碟。"
        }
        Write-Host ''
        Write-Host "== 下載模型 $($m.File)（約 $($m.NeedDiskGB - 2) GB，只需第一次；可隨時關閉視窗，下次會從中斷處繼續）=="
        if (-not (Get-File $m.Urls $dest $m.MinBytes)) {
            throw "模型下載失敗。請檢查網路後再試一次（會續傳）。也可手動下載 $($m.Urls[0]) 放到 $dir"
        }
        Write-Host '  模型下載完成。'
    }
}
