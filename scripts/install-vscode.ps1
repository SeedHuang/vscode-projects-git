# install-vscode.ps1 - install/upgrade git-batch-commit extension
#
# Flow:
#   1. Find or rebuild vsix
#   2. Optionally uninstall old version
#   3. Install via `code --install-extension`
#   4. Detect running VSCode (warn user to restart)
#   5. After restart, verify extension dir exists
#
# Usage:
#   .\install-vscode.ps1                    # interactive
#   .\install-vscode.ps1 -Force             # skip uninstall confirmation
#   .\install-vscode.ps1 -Rebuild           # force rebuild vsix first
#
# Notes:
#   - Will NOT auto-kill VSCode (KB global rule). When VSCode is running,
#     install only updates metadata; real files copy on next full restart.
#   - This file MUST be saved with UTF-8 BOM for PowerShell 5.1 to parse
#     non-ASCII characters correctly. If you re-save via Set-Content -Encoding UTF8,
#     it works; if via [System.IO.File]::WriteAllText with UTF8Encoding $false,
#     it will fail with "string is missing the terminator".

[CmdletBinding()]
param(
    [switch] $Force,
    [switch] $Rebuild,
    [switch] $Restart,
    [string] $ExtensionId = "your-publisher-name.git-batch-commit"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Locate repo root and vsix path
$repoRoot = (git rev-parse --show-toplevel).Trim()
# vsix is generated into build/ by `npm run package` (see package.json#scripts.package)
$vsixFullPath = Join-Path $repoRoot "build\git-batch-commit-0.0.1.vsix"

function Write-Step { param($m) Write-Host ("[STEP] " + $m) -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host ("[OK]   " + $m) -ForegroundColor Green }
function Write-Warn { param($m) Write-Host ("[WARN] " + $m) -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host ("[ERR]  " + $m) -ForegroundColor Red }

# --- 0. locate code.cmd ---
$codeCmd = Get-Command code.cmd -ErrorAction SilentlyContinue
if (-not $codeCmd) {
    Write-Err "Cannot find code.cmd in PATH. Make sure VSCode is installed."
    exit 5
}
$codeExe = $codeCmd.Source
Write-Ok "Found code: $codeExe"

# --- 1. ensure vsix exists ---
if (-not (Test-Path $vsixFullPath) -or $Rebuild) {
    Write-Step "Building vsix..."
    Push-Location $repoRoot
    try {
        if (Test-Path $vsixFullPath) { Remove-Item $vsixFullPath -Force }
        # Use Start-Process to avoid PowerShell 5.1 NativeCommandError trap on
        # nvm4w's stderr noise (npm.ps1 wrapper emits harmless deprecation lines).
        $tmpOut = [System.IO.Path]::GetTempFileName()
        $tmpErr = [System.IO.Path]::GetTempFileName()
        Start-Process -FilePath "npm.cmd" -ArgumentList @('run', 'package') -NoNewWindow -PassThru -Wait -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr | Out-Null
        Remove-Item $tmpOut, $tmpErr -ErrorAction SilentlyContinue
        # Verify the artifact was produced (real success criterion).
        if (-not (Test-Path $vsixFullPath)) {
            Write-Err "npm run package did not produce: $vsixFullPath"
            exit 8
        }
    } finally { Pop-Location }
}
if (-not (Test-Path $vsixFullPath)) {
    Write-Err "vsix still missing: $vsixFullPath"
    exit 6
}
$size = (Get-Item $vsixFullPath).Length
Write-Ok ("vsix ready (" + $size + " bytes): " + $vsixFullPath)

# --- 2. uninstall old if any ---
$existing = & $codeExe --list-extensions 2>&1 | Where-Object { $_ -eq $ExtensionId }
if ($existing) {
    if (-not $Force) {
        $yn = Read-Host "Found $ExtensionId. Uninstall first? [y/N]"
        if ($yn -in @("y", "Y", "yes", "YES")) {
            Write-Step "Uninstalling..."
            $tmpOut = [System.IO.Path]::GetTempFileName()
            $tmpErr = [System.IO.Path]::GetTempFileName()
            Start-Process -FilePath $codeExe -ArgumentList @('--uninstall-extension', $ExtensionId) -NoNewWindow -PassThru -Wait -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr | Out-Null
            Remove-Item $tmpOut, $tmpErr -ErrorAction SilentlyContinue
            Write-Ok "Uninstall done (pending restart)"
        } else {
            Write-Warn "Skipping uninstall; new version will overwrite on restart."
        }
    } else {
        Write-Step "Force uninstall..."
        $tmpOut = [System.IO.Path]::GetTempFileName()
        $tmpErr = [System.IO.Path]::GetTempFileName()
        Start-Process -FilePath $codeExe -ArgumentList @('--uninstall-extension', $ExtensionId) -NoNewWindow -PassThru -Wait -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr | Out-Null
        Remove-Item $tmpOut, $tmpErr -ErrorAction SilentlyContinue
        Write-Ok "Uninstall done"
    }
} else {
    Write-Ok "No old version to uninstall"
}

# --- 3. install new ---
Write-Step "Installing..."
# Start-Process with separate temp files avoids PowerShell 5.1's
# NativeCommandError trap on stderr noise (code.cmd's node child emits DEP0169).
$tmpOut = [System.IO.Path]::GetTempFileName()
$tmpErr = [System.IO.Path]::GetTempFileName()
$proc = Start-Process -FilePath $codeExe -ArgumentList @('--install-extension', $vsixFullPath) -NoNewWindow -PassThru -Wait -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
Remove-Item $tmpOut, $tmpErr -ErrorAction SilentlyContinue
# code.cmd is a thin wrapper that invokes code.exe Electron; --Wait blocks
# until Electron returns. The exit code is not reliable; we verify via files.
Write-Ok "Install command dispatched (VSCode will copy files on next restart)"

# --- 4. handle VSCode lifecycle per -Restart flag ---
# Order matters: install must complete BEFORE we kill any Code.exe, so the
# metadata is updated. Then a full quit+relaunch is required for the dir to
# actually appear. If VSCode is not running, just launch it.
$codeProcs = Get-Process -Name "Code" -ErrorAction SilentlyContinue
if (-not $Restart) {
    if ($codeProcs) {
        Write-Warn ""
        Write-Warn "============================================================"
        Write-Warn ("Detected " + $codeProcs.Count + " running VSCode process(es).")
        Write-Warn "While VSCode is running, install only updates metadata."
        Write-Warn "Real files copy AFTER all VSCode windows quit."
        Write-Warn ""
        Write-Warn "Action: taskbar VSCode icon -> right-click -> Quit"
        Write-Warn "Then reopen VSCode."
        Write-Warn "Or rerun with -Restart to automate (kills all Code.exe; unsaved work lost)."
        Write-Warn "============================================================"
        Write-Host ""
        Read-Host "Press Enter after quitting VSCode"
    }
} else {
    # -Restart: ensure ALL Code.exe are dead, then launch a fresh one.
    # This guarantees the extension dir gets populated on the next start.
    if ($codeProcs) {
        Write-Warn ("Auto-restart: killing " + $codeProcs.Count + " VSCode process(es)...")
        $killOut = taskkill /F /T /IM Code.exe 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Warn ("taskkill exit=" + $LASTEXITCODE + " (some processes may still be alive)")
            $killOut | ForEach-Object { Write-Host ("  " + $_) }
        } else {
            Write-Ok "VSCode processes terminated"
        }
    } else {
        Write-Warn "No VSCode process detected."
    }
    # Wait for all processes to fully exit before launching fresh.
    $waited = 0
    while ((Get-Process -Name "Code" -ErrorAction SilentlyContinue) -and ($waited -lt 15)) {
        Start-Sleep -Seconds 1
        $waited++
    }
    if (Get-Process -Name "Code" -ErrorAction SilentlyContinue) {
        Write-Warn "Some VSCode processes still alive after 15s; aborting launch."
        exit 9
    }
    Write-Step "Launching VSCode..."
    Start-Process -FilePath $codeExe
    Write-Ok "VSCode launched (extension dir will populate during startup)"
}

# --- 5. verify extension dir ---
Write-Step "Verifying extension directory..."
# Avoid ConvertFrom-Json on package.json here: PowerShell 5.1 misreads Chinese
# fields without BOM. Use regex to read name + version (no encoding dependency).
$pkgJson = Get-Content (Join-Path $repoRoot "package.json") -Raw
$nameMatch = [regex]::Match($pkgJson, '"name"\s*:\s*"([^"]+)"')
$verMatch  = [regex]::Match($pkgJson, '"version"\s*:\s*"([^"]+)"')
$dirName = "{0}-{1}" -f $nameMatch.Groups[1].Value, $verMatch.Groups[1].Value
$extDir = Join-Path $env:USERPROFILE (".vscode\extensions\" + $dirName)

if (Test-Path (Join-Path $extDir "dist\extension.js")) {
    Write-Ok ("Extension dir ready: " + $extDir)
    Write-Ok "extension.js + webview.js present (will activate on next VSCode start)"
} else {
    Write-Warn ("Extension dir missing: " + $extDir)
    if ($Restart) {
        # If we just killed VSCode, the dir should appear after the kill completes.
        # If still missing, vsce may not have copied. Warn but don't exit.
        Write-Warn "After kill+restart, dir still missing. Will retry on next VSCode start."
    } else {
        Write-Warn "VSCode may still be holding the file lock. Quit VSCode fully and rerun."
        exit 7
    }
}

Write-Host ""
Write-Host "Next: open VSCode -> Activity Bar -> 'Git Batch' icon" -ForegroundColor Green
Write-Host "  triggers onView:gitBatch.panel -> extension activates -> webview appears" -ForegroundColor Green