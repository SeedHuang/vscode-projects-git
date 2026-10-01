# install-trae.ps1 - install/upgrade git-batch-commit extension into Trae
#
# Flow:
#   1. Find or rebuild vsix
#   2. Stop running Trae processes (Trae locks its extensions dir while running)
#   3. Extract vsix into Trae's extensions dir as <publisher>.<name>-<version>\
#   4. Append/refresh entry in Trae's extensions.json
#   5. Relaunch Trae (optional via -Restart)
#
# Usage:
#   .\install-trae.ps1                 # install; abort if Trae is running
#   .\install-trae.ps1 -Rebuild        # rebuild vsix first
#   .\install-trae.ps1 -Restart        # kill running Trae then relaunch
#
# Notes:
#   - Trae's extension dir: $env:USERPROFILE\.trae-cn\extensions\
#   - Trae does NOT expose a CLI; we manipulate its dir directly (same layout as VSCode).
#   - extensions.json holds an array of entries with id/version/relativeLocation/etc.
#   - When Trae is running, the dir is file-locked. Use -Restart to kill+relaunch.

[CmdletBinding()]
param(
    [switch] $Rebuild,
    [switch] $Restart,
    [string] $ExtensionId = "your-publisher-name.git-batch-commit"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step { param($m) Write-Host ("[STEP] " + $m) -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host ("[OK]   " + $m) -ForegroundColor Green }
function Write-Warn { param($m) Write-Host ("[WARN] " + $m) -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host ("[ERR]  " + $m) -ForegroundColor Red }

# --- 0. locate Trae installation + extension dir ---
# Strategy: prefer the running Trae process (authoritative). Fallback: scan
# candidate install paths. Extension dir follows the binary's product name.
function Resolve-TraePaths {
    # Candidate mapping: binary name pattern -> default extension dir subfolder.
    # Trae keeps user data under %USERPROFILE%\<productDir>\extensions\.
    # Order matters for fallback: standard CN product first (most common),
    # then solo CN, then international. The running-process branch always wins.
    $candidates = @(
        @{ Pattern = 'Trae CN.exe';      ProductDir = '.trae-cn' },
        @{ Pattern = 'TRAE SOLO CN.exe'; ProductDir = '.trae' },
        @{ Pattern = 'Trae.exe';         ProductDir = '.trae' }
    )
    # 1. Prefer running process.
    $running = Get-Process -Name "Trae*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($running) {
        $exeName = Split-Path -Leaf $running.Path
        $match = $candidates | Where-Object { $exeName -ieq $_.Pattern } | Select-Object -First 1
        if (-not $match) {
            Write-Warn ("Running Trae binary does not match any known pattern: " + $exeName + " — falling back to filesystem probe")
        } else {
            Write-Step ("Resolved via process: " + $running.Path)
            return @{
                TraeExe  = $running.Path
                ExtRoot  = Join-Path $env:USERPROFILE (Join-Path $match.ProductDir "extensions")
            }
        }
    } else {
        Write-Step "No running Trae process — using filesystem probe"
    }
    # 2. Fallback: probe candidate installs. Order must match the candidate
    #    list above — a "Trae CN" candidate paired with a "Programs\TRAE SOLO CN"
    #    root would resolve to a non-existent directory and abort.
    $probeRoots = @(
        "D:\devtools\Trae CN",
        (Join-Path $env:LOCALAPPDATA "Programs\Trae CN"),
        (Join-Path $env:LOCALAPPDATA "Programs\TRAE SOLO CN"),
        "D:\devtools\Trae SOLO CN"
    )
    foreach ($root in $probeRoots) {
        foreach ($cand in $candidates) {
            $exe = Join-Path $root $cand.Pattern
            if (Test-Path $exe) {
                Write-Step ("Resolved via filesystem probe: " + $exe)
                return @{
                    TraeExe = $exe
                    ExtRoot = Join-Path $env:USERPROFILE (Join-Path $cand.ProductDir "extensions")
                }
            }
        }
    }
    return $null
}

$resolved = Resolve-TraePaths
if (-not $resolved) {
    Write-Err "Cannot locate a Trae installation. Is Trae installed?"
    exit 5
}
$traeExe  = $resolved.TraeExe
$extRoot  = $resolved.ExtRoot
$extIndex = Join-Path $extRoot "extensions.json"

if (-not (Test-Path $extRoot)) {
    Write-Err "Trae extension dir not found at: $extRoot"
    exit 5
}
Write-Ok "Trae: $traeExe"
Write-Ok "Extension dir: $extRoot"

# --- 1. ensure vsix exists ---
$repoRoot = (git rev-parse --show-toplevel).Trim()
$vsixFullPath = Join-Path $repoRoot "build\git-batch-commit-0.0.1.vsix"

if (-not (Test-Path $vsixFullPath) -or $Rebuild) {
    Write-Step "Building vsix..."
    Push-Location $repoRoot
    try {
        if (Test-Path $vsixFullPath) { Remove-Item $vsixFullPath -Force }
        $tmpOut = [System.IO.Path]::GetTempFileName()
        $tmpErr = [System.IO.Path]::GetTempFileName()
        Start-Process -FilePath "npm.cmd" -ArgumentList @('run', 'package') -NoNewWindow -PassThru -Wait -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr | Out-Null
        Remove-Item $tmpOut, $tmpErr -ErrorAction SilentlyContinue
        if (-not (Test-Path $vsixFullPath)) {
            Write-Err "npm run package did not produce: $vsixFullPath"
            exit 8
        }
    } finally { Pop-Location }
}
$size = (Get-Item $vsixFullPath).Length
Write-Ok ("vsix ready (" + $size + " bytes): " + $vsixFullPath)

# --- 2. read package.json to get name + version (regex, no JSON parse — avoids BOM issues) ---
$pkgJson = Get-Content (Join-Path $repoRoot "package.json") -Raw
$nameMatch = [regex]::Match($pkgJson, '"name"\s*:\s*"([^"]+)"')
$verMatch  = [regex]::Match($pkgJson, '"version"\s*:\s*"([^"]+)"')
$pubMatch  = [regex]::Match($pkgJson, '"publisher"\s*:\s*"([^"]+)"')
$extName = $nameMatch.Groups[1].Value
$extVer  = $verMatch.Groups[1].Value
$extPub  = $pubMatch.Groups[1].Value
$dirName = "{0}.{1}-{2}" -f $extPub, $extName, $extVer
$targetDir = Join-Path $extRoot $dirName

Write-Ok ("Target dir name: " + $dirName)

# --- 3. handle running Trae ---
# Use the EXACT exe path we resolved in step 0 (not a name wildcard — Trae and
# TRAE SOLO CN both match "Trae*" and we don't want to kill the wrong product).
$traeExeName = Split-Path -Leaf $traeExe
$traeProcs = Get-Process -Name $traeExeName -ErrorAction SilentlyContinue
if ($traeProcs) {
    Write-Warn ""
    Write-Warn "============================================================"
    Write-Warn ("Detected " + $traeProcs.Count + " running $traeExeName process(es).")
    Write-Warn "Trae locks its extension dir while running; install will fail."
    Write-Warn ""
    if ($Restart) {
        Write-Warn "-Restart set: killing all $traeExeName processes..."
        $killOut = taskkill /F /T /IM $traeExeName 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Warn ("taskkill exit=" + $LASTEXITCODE)
            $killOut | ForEach-Object { Write-Host ("  " + $_) }
        } else {
            Write-Ok "Trae processes terminated"
        }
        # wait for processes to fully exit (Electron children can lag the parent)
        $waited = 0
        while ((Get-Process -Name $traeExeName -ErrorAction SilentlyContinue) -and ($waited -lt 60)) {
            Start-Sleep -Seconds 1
            $waited++
            if (($waited % 10) -eq 0) {
                Write-Warn ("  still waiting... " + $waited + "s")
            }
        }
        if (Get-Process -Name $traeExeName -ErrorAction SilentlyContinue) {
            Write-Err "Trae still alive after 60s; aborting."
            exit 9
        }
    } else {
        Write-Warn "Action: close all Trae windows, then rerun this script."
        Write-Warn "Or rerun with -Restart to automate."
        Write-Warn "============================================================"
        exit 6
    }
}

# --- 4. remove old version dir if present ---
if (Test-Path $targetDir) {
    Write-Step ("Removing existing dir: " + $targetDir)
    Remove-Item $targetDir -Recurse -Force
}

# --- 5. extract vsix -> targetDir (a .vsix is a ZIP; PowerShell Expand-Archive
#        rejects .vsix extension even though the bytes are valid ZIP) ---
Write-Step ("Extracting vsix -> " + $targetDir)
$tmpExtract = Join-Path $env:TEMP ("trae-extract-" + [Guid]::NewGuid().ToString("N"))
$zipCopy = Join-Path $tmpExtract "package.zip"
$null = New-Item -ItemType Directory -Path $tmpExtract -Force
Copy-Item -LiteralPath $vsixFullPath -Destination $zipCopy -Force
Expand-Archive -LiteralPath $zipCopy -DestinationPath $tmpExtract -Force
Remove-Item -LiteralPath $zipCopy -Force
# Expand-Archive creates a temp dir named after the zip; find and move it.
$extractedDir = Get-ChildItem -LiteralPath $tmpExtract -Directory | Select-Object -First 1
if (-not $extractedDir) {
    Write-Err "Expand-Archive did not produce a subdir under $tmpExtract"
    exit 8
}
Move-Item -LiteralPath $extractedDir.FullName -Destination $targetDir
Remove-Item -LiteralPath $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue
Write-Ok ("Extracted: " + $targetDir)

# --- 6. update extensions.json ---
# Trae requires: identifier.uuid, location{$mid,path,scheme}, metadata{...}.
# UUID must be stable per extension (use MD5 of publisher.name as a deterministic UUID).
Write-Step "Updating extensions.json..."
$list = @()
if (Test-Path $extIndex) {
    $raw = Get-Content $extIndex -Raw
    if (-not [string]::IsNullOrWhiteSpace($raw)) {
        $list = $raw | ConvertFrom-Json
    }
}
# Remove any existing entry for this id
$filtered = @($list | Where-Object { $_.identifier.id -ne $ExtensionId })

# Deterministic UUID: MD5 of "<publisher>.<name>", formatted as 8-4-4-4-12.
$uuidSeed = "$extPub.$extName"
$md5 = [System.Security.Cryptography.MD5]::Create()
$hashBytes = $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($uuidSeed))
$hex = ($hashBytes | ForEach-Object { $_.ToString("x2") }) -join ""
$extUuid = "{0}-{1}-{2}-{3}-{4}" -f $hex.Substring(0,8), $hex.Substring(8,4), $hex.Substring(12,4), $hex.Substring(16,4), $hex.Substring(20,12)

# Trae location path uses forward slashes and /c:/Users/<u>/... form.
$locationPath = "/c:/Users/$env:USERNAME/$($extRoot.Substring($env:USERPROFILE.Length + 1).Replace('\','/'))/$dirName"
$relLoc = $dirName

$entry = [ordered]@{
    identifier = [ordered]@{
        id   = $ExtensionId
        uuid = $extUuid
    }
    version          = $extVer
    location         = [ordered]@{
        '$mid'  = 1
        path    = $locationPath
        scheme  = 'file'
    }
    relativeLocation = $relLoc
    metadata         = [ordered]@{
        isApplicationScoped = $true
        installedTimestamp  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        pinned              = $false
        source              = 'gallery'
        id                  = $extUuid
        publisherId         = '00000000-0000-0000-0000-000000000000'
        publisherDisplayName = $extPub
        targetPlatform      = 'universal'
        updated             = $false
        private             = $false
        isPreReleaseVersion = $false
        hasPreReleaseVersion = $false
    }
}
$filtered += [pscustomobject]$entry

# Serialize back. Trae uses JSON with 2-space indent based on the existing file.
$json = $filtered | ConvertTo-Json -Depth 10
# Write without BOM (Trae's parser handles plain UTF-8 fine).
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($extIndex, $json, $utf8NoBom)
Write-Ok ("extensions.json updated (" + $filtered.Count + " entries)")

# --- 7. verify ---
if (Test-Path (Join-Path $targetDir "dist\extension.js")) {
    Write-Ok ("Extension dir ready: " + $targetDir)
} else {
    Write-Warn ("dist\extension.js missing under " + $targetDir + " — extension may not activate.")
}

# --- 8. relaunch if requested ---
if ($Restart) {
    Write-Step "Launching Trae..."
    Start-Process -FilePath $traeExe
    Write-Ok "Trae launched (extension will activate on next start)"
} else {
    Write-Host ""
    Write-Host "Next: open Trae -> Activity Bar -> 'Git Batch' icon" -ForegroundColor Green
    Write-Host "  (extension activates on next Trae start; if Trae was open, restart it)" -ForegroundColor Green
}
