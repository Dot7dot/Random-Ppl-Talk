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
# llama.cpp releases: assets are llama-<tag>-bin-win-<backend>-x64.zip. Some tags (e.g. b12767) were
# never published with binaries (404), so keep an ordered list of tags verified to have Windows assets.
$LlamaTags = @('b12774', 'b12778', 'b12779')
# Test hooks (also usable for mirrors): override download base URL / API URL.
$LlamaBase = 'https://github.com/ggml-org/llama.cpp/releases/download'
if ($env:RPT_LLAMA_BASE) { $LlamaBase = $env:RPT_LLAMA_BASE.TrimEnd('/') }
$LlamaApi = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30'
if ($env:RPT_LLAMA_API) { $LlamaApi = $env:RPT_LLAMA_API }
$ReleasePage = 'https://github.com/ggml-org/llama.cpp/releases'
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
# -Fast (llama.cpp binaries): short connect timeout, never BITS (it retries a 404 for a very long time).
function Get-File([string[]]$Urls, [string]$Dest, [int64]$MinBytes, [switch]$Fast) {
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
                $ct = 30
                if ($Fast) { $ct = 20 }
                & $curl.Source -L --fail --retry 5 --retry-delay 3 --connect-timeout $ct -C - --progress-bar -o $part $u
                $code = $LASTEXITCODE
            } elseif ($Fast) {
                try {
                    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
                    Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $part -TimeoutSec 600 -Headers @{ 'User-Agent' = 'RandomPplTalk' }
                    $code = 0
                } catch {
                    $code = 1
                    if ($_.Exception.Message -match '404|403|410') { $code = 22 }
                }
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

# Releases from the GitHub API (prereleases included) that ship a Windows zip for this backend.
# Never uses /releases/latest: it can point at a tag without binaries.
function Get-ApiCandidates([string]$Variant) {
    $list = @()
    try {
        $rels = Invoke-RestMethod -UseBasicParsing -Uri $LlamaApi -TimeoutSec 20 -Headers @{ 'User-Agent' = 'RandomPplTalk'; 'Accept' = 'application/vnd.github+json' }
        foreach ($r in @($rels)) {
            foreach ($a in @($r.assets)) {
                if ($a.name -match "^llama-b\d+-bin-win-$Variant-x64\.zip$") {
                    $list += [pscustomobject]@{ Tag = [string]$r.tag_name; Url = [string]$a.browser_download_url; Name = [string]$a.name }
                    break
                }
            }
        }
    } catch { Write-Host "  查詢 GitHub 版本清單失敗：$($_.Exception.Message)" }
    return $list
}

function Install-Llama([string]$Variant) {
    $dir = Join-Path $Root "bin\$Variant"
    if (Find-Server $dir) { return }
    $binRoot = Join-Path $Root 'bin'
    New-Item -ItemType Directory -Force -Path $binRoot | Out-Null
    Write-Host ''
    Write-Host "== 準備 llama.cpp ($Variant 版，約數十 MB) =="
    $zip = $null
    $tag = $null
    $ok = $false

    # 1) A zip the user placed manually in bin\ wins over downloading.
    $manual = Get-ChildItem -LiteralPath $binRoot -Filter "llama-*-bin-win-$Variant-x64.zip" -ErrorAction SilentlyContinue |
        Where-Object { $_.Length -ge 5000000 } | Sort-Object Name -Descending | Select-Object -First 1
    if ($manual) {
        Write-Host "  使用手動放置的檔案：$($manual.Name)"
        $zip = $manual.FullName
        if ($manual.Name -match '^llama-(b\d+)-') { $tag = $Matches[1] } else { $tag = 'manual' }
        $ok = $true
    }

    # 2) Pinned/known-good tags in order; a 404 moves on to the next one immediately.
    $tried = @{}
    if (-not $ok) {
        foreach ($t in $LlamaTags) {
            $tried[$t] = $true
            $asset = "llama-$t-bin-win-$Variant-x64.zip"
            $zip = Join-Path $binRoot $asset
            Write-Host "  嘗試版本 $t …"
            if (Get-File @("$LlamaBase/$t/$asset") $zip ([int64]5000000) -Fast) { $tag = $t; $ok = $true; break }
        }
    }

    # 3) Ask the GitHub API for any release (incl. prereleases) that has the asset.
    if (-not $ok) {
        Write-Host '  已知版本都無法下載，查詢 GitHub 上其他可用的版本…'
        $n = 0
        foreach ($c in (Get-ApiCandidates $Variant)) {
            if ($tried.ContainsKey($c.Tag)) { continue }
            $tried[$c.Tag] = $true
            $n++
            if ($n -gt 6) { break }
            $zip = Join-Path $binRoot $c.Name
            Write-Host "  嘗試版本 $($c.Tag) …"
            if (Get-File @($c.Url) $zip ([int64]5000000) -Fast) { $tag = $c.Tag; $ok = $true; break }
        }
    }

    if (-not $ok) {
        $nl = [Environment]::NewLine
        throw ("無法下載 llama.cpp ($Variant 版)。可能是網路問題，或 GitHub 上該版本沒有附上 Windows 檔案。$nl" +
            "請手動下載：$nl" +
            "  1. 用瀏覽器開啟 $ReleasePage$nl" +
            "  2. 選一個有 Assets 的版本（建議 $($LlamaTags[0])），下載 llama-bXXXX-bin-win-$Variant-x64.zip$nl" +
            "  3. 把這個 zip 檔直接放進資料夾：$binRoot（不用解壓縮），再重新執行啟動檔$nl" +
            "     （也可以自己解壓縮到：$dir，需包含 llama-server.exe）")
    }

    Write-Host '  解壓縮中…'
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
    try {
        Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
    } catch {
        Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
        throw "解壓縮失敗：$($_.Exception.Message)（壓縮檔已刪除，請重新執行；若是手動下載的檔案請重新下載）"
    }
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    if (-not (Find-Server $dir)) { throw "解壓縮後找不到 llama-server.exe（$dir）。請確認下載的是 llama-bXXXX-bin-win-$Variant-x64.zip" }
    try { Set-Content -LiteralPath (Join-Path $binRoot 'version.txt') -Value $tag -Encoding ASCII } catch { }
    Write-Host "  llama.cpp 準備完成（版本 $tag）。"
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
