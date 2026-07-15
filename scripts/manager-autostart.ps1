# scripts/manager-autostart.ps1
# ------------------------------------------------------------
# AdBrain Manager auto-start on Windows login.
#
# Usage (run in PowerShell on the MANAGER PC):
#   .\scripts\manager-autostart.ps1 install     # add Startup shortcut
#   .\scripts\manager-autostart.ps1 uninstall   # remove Startup shortcut
#   .\scripts\manager-autostart.ps1 start       # start manager NOW (background)
#   .\scripts\manager-autostart.ps1 stop        # kill running manager
#   .\scripts\manager-autostart.ps1 status      # show install + running state
#
# What 'install' does:
#  - Creates 'AdBrain Manager.lnk' in shell:startup
#  - On every Windows login the shortcut launches:
#        powershell -WindowStyle Hidden -Command "cd '<repo>'; node manager/server.js"
#  - MANAGER_TOKEN env var is inherited from the user profile so the
#    manager starts with the same token you already have.
#  - No admin needed. No Windows Service. No third-party helpers.
# ------------------------------------------------------------

param([Parameter(Position=0)][ValidateSet('install','uninstall','start','stop','status')]$Action = 'status')

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$startup  = [Environment]::GetFolderPath('Startup')
$lnkPath  = Join-Path $startup 'AdBrain Manager.lnk'
$logPath  = Join-Path $repoRoot 'manager\autostart.log'

function Get-ManagerProcess {
    # Any node process holding port 8787 is our manager.
    $conn = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if (-not $conn) { return $null }
    return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
}

function Cmd-Install {
    if (-not (Test-Path (Join-Path $repoRoot 'manager\server.js'))) {
        throw "Cannot find $repoRoot\manager\server.js - run this from the repo root, not a copy."
    }
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw "node not on PATH. Install Node.js 24+ from https://nodejs.org." }

    # Wrap the node invocation in a hidden PowerShell so the manager runs
    # in the background without a visible terminal on every login. stdout +
    # stderr are appended to manager\autostart.log so you can diagnose.
    $inner = "Set-Location '$repoRoot'; & '$node' manager/server.js *>> '$logPath'"
    $psArgs = "-WindowStyle Hidden -NoProfile -Command `"$inner`""

    $sh  = New-Object -ComObject WScript.Shell
    $lnk = $sh.CreateShortcut($lnkPath)
    $lnk.TargetPath       = (Get-Command powershell.exe).Source
    $lnk.Arguments        = $psArgs
    $lnk.WorkingDirectory = $repoRoot
    $lnk.Description      = 'AdBrain Manager auto-start SQLite HTTP server'
    $lnk.WindowStyle      = 7  # 7 = minimized outer shell (PS itself Hidden)
    $lnk.Save()

    Write-Host ""
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host " AdBrain Manager auto-start INSTALLED" -ForegroundColor Cyan
    Write-Host "================================================================" -ForegroundColor Cyan
    Write-Host " Shortcut:    $lnkPath" -ForegroundColor Gray
    Write-Host " Working dir: $repoRoot" -ForegroundColor Gray
    Write-Host " Log file:    $logPath" -ForegroundColor Gray
    Write-Host " Node path:   $node" -ForegroundColor Gray
    Write-Host ""
    Write-Host " Manager launches on every Windows login." -ForegroundColor Green
    Write-Host ""
    Write-Host " Verify with: .\scripts\manager-autostart.ps1 status" -ForegroundColor Yellow
    Write-Host " Start NOW (do not wait for next login):" -ForegroundColor Yellow
    Write-Host "              .\scripts\manager-autostart.ps1 start" -ForegroundColor Yellow
    Write-Host "================================================================" -ForegroundColor Cyan
}

function Cmd-Uninstall {
    if (Test-Path $lnkPath) {
        Remove-Item $lnkPath -Force
        Write-Host "Removed: $lnkPath" -ForegroundColor Green
    } else {
        Write-Host ("No shortcut to remove: {0}" -f $lnkPath) -ForegroundColor Yellow
    }
    Write-Host "Currently-running manager (if any) is NOT killed. Use 'stop' for that." -ForegroundColor Gray
}

function Cmd-Start {
    $p = Get-ManagerProcess
    if ($p) {
        Write-Host ("Manager already running: PID {0}. Nothing to do." -f $p.Id) -ForegroundColor Yellow
        return
    }
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw "node not on PATH." }
    Write-Host "Starting manager in the background (log: $logPath)..." -ForegroundColor Cyan
    $inner = "Set-Location '$repoRoot'; & '$node' manager/server.js *>> '$logPath'"
    Start-Process -FilePath powershell.exe `
                  -ArgumentList @('-WindowStyle','Hidden','-NoProfile','-Command', $inner) `
                  -WorkingDirectory $repoRoot | Out-Null
    Start-Sleep -Seconds 2
    $p = Get-ManagerProcess
    if ($p) { Write-Host ("Started: PID {0} on port 8787" -f $p.Id) -ForegroundColor Green }
    else    { Write-Host "Manager did not come up in 2s - check $logPath" -ForegroundColor Red }
}

function Cmd-Stop {
    $p = Get-ManagerProcess
    if (-not $p) {
        Write-Host "No manager running (port 8787 free)." -ForegroundColor Yellow
        return
    }
    Write-Host ("Stopping PID {0}..." -f $p.Id) -ForegroundColor Cyan
    Stop-Process -Id $p.Id -Force
    Start-Sleep -Milliseconds 500
    if (Get-ManagerProcess) { Write-Host "Still alive - try again." -ForegroundColor Red }
    else                    { Write-Host "Stopped." -ForegroundColor Green }
}

function Cmd-Status {
    Write-Host ""
    Write-Host "=== AdBrain Manager status ===" -ForegroundColor Cyan
    $installed = Test-Path $lnkPath
    $installedLabel = if ($installed) { 'YES' } else { 'NO' }
    Write-Host (" Auto-start installed: {0}" -f $installedLabel)
    if ($installed) { Write-Host ("   shortcut: {0}" -f $lnkPath) -ForegroundColor Gray }
    $p = Get-ManagerProcess
    if ($p) {
        Write-Host (" Currently running:    YES (PID {0})" -f $p.Id) -ForegroundColor Green
        Write-Host ("   started: {0}" -f $p.StartTime) -ForegroundColor Gray
    } else {
        Write-Host " Currently running:    NO" -ForegroundColor Yellow
    }
    $token = [Environment]::GetEnvironmentVariable('MANAGER_TOKEN', 'User')
    if ($token) {
        Write-Host " MANAGER_TOKEN set:    YES" -ForegroundColor Green
    } else {
        Write-Host " MANAGER_TOKEN set:    NO (manager will run open on the tailnet)" -ForegroundColor Yellow
    }
    Write-Host (" Log file:             {0}" -f $logPath) -ForegroundColor Gray
    if (Test-Path $logPath) {
        $size = (Get-Item $logPath).Length
        Write-Host ("   size: {0} bytes" -f $size) -ForegroundColor Gray
        Write-Host "   last 5 lines:" -ForegroundColor Gray
        Get-Content $logPath -Tail 5 | ForEach-Object { Write-Host ("     {0}" -f $_) -ForegroundColor DarkGray }
    }
    Write-Host ""
}

switch ($Action) {
    'install'   { Cmd-Install }
    'uninstall' { Cmd-Uninstall }
    'start'     { Cmd-Start }
    'stop'      { Cmd-Stop }
    'status'    { Cmd-Status }
}
