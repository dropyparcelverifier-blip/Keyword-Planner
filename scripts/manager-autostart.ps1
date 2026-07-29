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

param([Parameter(Position=0)][ValidateSet('install','uninstall','start','stop','status','watchdog','unwatchdog')]$Action = 'status')

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
    # Uninstall must undo everything install can put in place, or removing the
    # Startup shortcut leaves a watchdog quietly relaunching the manager every
    # two minutes -- an uninstall that does not uninstall.
    Cmd-Unwatchdog
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

# ---------------------------------------------------------------
# Watchdog: keep the manager alive between logins.
#
# The Startup shortcut only fires once, at logon. Nothing ever checks
# afterwards, so when the manager is killed - session ends, machine sleeps,
# the console window gets closed - it stays dead and every worker goes blind
# until someone notices. It was found dead twice in one day, once for over two
# hours, and the log showed no crash: just a clean stop mid-run.
#
# Same shape as the Chrome watchdog: a scheduled task every 2 minutes, run
# through a wscript.exe shim so no console window flashes on an interactive
# desktop. Probes /api/health rather than the port, because a wedged process
# still holds the socket. Only starts the manager; never kills a healthy one.
# ---------------------------------------------------------------
$taskName    = 'AdBrain Manager Watchdog'
$watchdogPs1 = Join-Path $repoRoot 'scripts\manager-watchdog.ps1'
$watchdogVbs = Join-Path $repoRoot 'scripts\manager-watchdog-hidden.vbs'

function Write-WatchdogFiles {
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw "node not on PATH. Install Node.js 24+ from https://nodejs.org." }

    $ps = @"
# AUTO-GENERATED by scripts/manager-autostart.ps1 - edits will be overwritten.
`$ErrorActionPreference = 'SilentlyContinue'
`$repoRoot = '$repoRoot'
`$logPath  = '$logPath'
`$node     = '$node'
`$token    = [Environment]::GetEnvironmentVariable('MANAGER_TOKEN','User')

# Health, not liveness. A wedged process still owns port 8787, so a port check
# would report a manager that answers nothing as healthy.
`$healthy = `$false
try {
    `$headers = @{}
    if (`$token) { `$headers['X-Manager-Token'] = `$token }
    `$r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/api/health' ``
                            -Headers `$headers -TimeoutSec 10
    if (`$r.StatusCode -eq 200) { `$healthy = `$true }
} catch { `$healthy = `$false }

if (`$healthy) { exit 0 }

# Clear a wedged process before relaunching, or the new one cannot bind.
Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id `$_ -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

`$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
Add-Content -Path `$logPath -Value "[watchdog] `$stamp manager not answering /api/health - relaunching."
`$inner = "Set-Location '`$repoRoot'; & '`$node' manager/server.js *>> '`$logPath'"
Start-Process -FilePath powershell.exe ``
              -ArgumentList @('-WindowStyle','Hidden','-NoProfile','-Command', `$inner) ``
              -WorkingDirectory `$repoRoot
"@
    Set-Content -Path $watchdogPs1 -Value $ps -Encoding utf8

    # wscript shim. A scheduled task launching powershell.exe directly pops a
    # window on an interactive desktop every time it fires, however the task is
    # flagged hidden - the Chrome watchdog had exactly this problem.
    $vbs = @"
' AUTO-GENERATED by scripts/manager-autostart.ps1 - edits will be overwritten.
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""$watchdogPs1""", 0, False
"@
    Set-Content -Path $watchdogVbs -Value $vbs -Encoding ascii
}

function Cmd-Watchdog {
    Write-WatchdogFiles
    # schtasks.exe, not Register-ScheduledTask.
    #
    # Register-ScheduledTask fails with "Access is denied" for a non-elevated
    # user here, and it reports that as a NON-terminating CIM error -- so it
    # prints the failure and carries straight on to the success message. The
    # first run of this claimed "Watchdog registered" over a task that did not
    # exist. A watchdog that lies about being installed is worse than none,
    # because nobody goes looking. schtasks.exe registers the same task for
    # the current user without elevation, and we verify by reading it back
    # either way.
    $out = schtasks.exe /Create /TN "$taskName" /TR "wscript.exe `"$watchdogVbs`"" /SC MINUTE /MO 2 /F 2>&1
    if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
        Write-Host ""
        Write-Host "Watchdog NOT registered - Task Scheduler refused the request:" -ForegroundColor Red
        $out | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        Write-Host "Try again from an ELEVATED PowerShell (Run as administrator):" -ForegroundColor Yellow
        Write-Host "    cd '$repoRoot'; .\scripts\manager-autostart.ps1 watchdog" -ForegroundColor Yellow
        Write-Host ""
        throw "Could not register '$taskName'."
    }
    Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Write-Host "Watchdog registered: '$taskName' - probes /api/health every 2 minutes." -ForegroundColor Green
    Write-Host "  script: $watchdogPs1" -ForegroundColor Gray
    Write-Host "  shim:   $watchdogVbs" -ForegroundColor Gray
}

function Cmd-Unwatchdog {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        # schtasks for symmetry with Cmd-Watchdog: Unregister-ScheduledTask
        # hits the same non-elevated "Access is denied" on a task schtasks
        # created. Fall back to the cmdlet if schtasks is unavailable.
        schtasks.exe /Delete /TN "$taskName" /F 2>&1 | Out-Null
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        }
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            Write-Host "Could not remove '$taskName' - try an elevated PowerShell." -ForegroundColor Red
        } else {
            Write-Host "Watchdog task removed." -ForegroundColor Green
        }
    } else {
        Write-Host "No watchdog task registered." -ForegroundColor Yellow
    }
    # The generated shim and probe carry absolute paths for THIS machine and
    # are useless once the task is gone. Leaving them behind is how a stale
    # watchdog gets re-registered later against a repo that has since moved.
    foreach ($f in @($watchdogPs1, $watchdogVbs)) {
        if (Test-Path $f) { Remove-Item $f -Force; Write-Host "Removed: $f" -ForegroundColor Gray }
    }
}

switch ($Action) {
    'install'   { Cmd-Install }
    'watchdog'   { Cmd-Watchdog }
    'unwatchdog' { Cmd-Unwatchdog }
    'uninstall' { Cmd-Uninstall }
    'start'     { Cmd-Start }
    'stop'      { Cmd-Stop }
    'status'    { Cmd-Status }
}
