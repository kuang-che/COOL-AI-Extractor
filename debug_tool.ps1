# ============================================================================
# COOL AI Companion - video_id capture script
#
# What it does:
#   1. Backs up the original app.asar (only on first run, won't overwrite
#      an existing backup)
#   2. Replaces it with app-patched.asar (contains a few extra console.log
#      lines that print video_id)
#   3. Launches the app and captures its stdout in real time, looking for
#      lines like: [DEBUG] video_id = xxxxx
#   4. Writes each newly seen video_id (deduplicated) into video_ids.txt,
#      one per line - this format can be pasted directly into the web app's
#      Settings -> Video ID list
#   5. When you close the app window, this script automatically restores
#      the original app.asar
#
# How to use:
#   1. Put this .ps1 file and app-patched.asar in the SAME folder
#   2. Edit the $AppDir variable below to match your actual install path
#   3. In that folder: Shift + right-click -> "Open PowerShell window here"
#   4. Run: powershell -ExecutionPolicy Bypass -File .\capture_video_id.ps1
# ============================================================================

# ---- Edit this to match your actual install path ----
$AppDir = "$env:LOCALAPPDATA\Programs\COOL AI Companion"
# -------------------------------------------------------

$ScriptDir   = $PSScriptRoot
$ResDir      = Join-Path $AppDir "resources"
$AsarPath    = Join-Path $ResDir "app.asar"
$BackupPath  = Join-Path $ResDir "app.asar.bak"
$PatchedAsar = Join-Path $ScriptDir "app-patched.asar"
$OutputFile  = Join-Path $ScriptDir "video_ids.txt"

function Find-AppExe {
    param([string]$Dir)
    if (!(Test-Path $Dir)) { return $null }
    $exe = Get-ChildItem -Path $Dir -Filter "*.exe" -File |
        Where-Object { $_.Name -notmatch "Uninstall" } |
        Select-Object -First 1
    if ($exe) { return $exe.FullName }
    return $null
}

Write-Host "=== COOL AI Companion video_id capture tool ===" -ForegroundColor Cyan

if (!(Test-Path $PatchedAsar)) {
    Write-Host "[ERROR] app-patched.asar not found. Put it in the same folder as this script." -ForegroundColor Red
    exit 1
}

if (!(Test-Path $AppDir)) {
    Write-Host "[ERROR] Install folder not found: $AppDir" -ForegroundColor Red
    Write-Host "Edit the `$AppDir variable at the top of this script to your real install path." -ForegroundColor Yellow
    exit 1
}

$ExePath = Find-AppExe -Dir $AppDir
if (-not $ExePath) {
    Write-Host "[ERROR] No .exe found under $AppDir" -ForegroundColor Red
    exit 1
}
if (!(Test-Path $AsarPath)) {
    Write-Host "[ERROR] $AsarPath not found. Check your install path." -ForegroundColor Red
    exit 1
}

Write-Host "App executable: $ExePath"
Write-Host "app.asar path : $AsarPath"

# Make sure the app isn't currently running (locked files can't be replaced)
$procName = [System.IO.Path]::GetFileNameWithoutExtension($ExePath)
Get-Process -Name $procName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

# Backup original app.asar (only once, so re-running this script never
# overwrites a good backup with an already-patched file)
if (!(Test-Path $BackupPath)) {
    Copy-Item $AsarPath $BackupPath
    Write-Host "Backed up original app.asar -> app.asar.bak" -ForegroundColor Green
} else {
    Write-Host "Backup app.asar.bak already exists, skipping backup step."
}

# Swap in the patched version
Copy-Item $PatchedAsar $AsarPath -Force
Write-Host "Patched app.asar installed. Launching app..." -ForegroundColor Green

# Launch the app and capture stdout
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $ExePath
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.EnvironmentVariables["ELECTRON_ENABLE_LOGGING"] = "1"

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi

$foundIds = New-Object 'System.Collections.Generic.HashSet[string]'
if (Test-Path $OutputFile) {
    Get-Content $OutputFile | ForEach-Object { $foundIds.Add($_.Trim()) | Out-Null }
}

$regex = [regex]"\[DEBUG\] video_id = (\S+)"

Write-Host ""
Write-Host "App is running. Use it normally: open a lecture, ask the AI a question." -ForegroundColor Cyan
Write-Host "New video_id values will show here and be saved to: $OutputFile"
Write-Host "When you close the app window, app.asar will be restored automatically."
Write-Host ""

[void]$proc.Start()

while ($true) {
    $line = $proc.StandardOutput.ReadLine()
    if ($null -eq $line) { break }
    $m = $regex.Match($line)
    if ($m.Success) {
        $vid = $m.Groups[1].Value.Trim()
        if ($foundIds.Add($vid)) {
            Add-Content -Path $OutputFile -Value $vid -Encoding UTF8
            Write-Host "New video_id found: $vid" -ForegroundColor Green
        }
    }
}

$proc.WaitForExit()

# Restore the original asar now that the app has closed
Copy-Item $BackupPath $AsarPath -Force
Write-Host ""
Write-Host "App closed. Original app.asar has been restored." -ForegroundColor Cyan
Write-Host "Collected video_id list: $OutputFile"
