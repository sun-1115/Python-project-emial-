@echo off
REM Start GitHub Track (crawler + UI/campaign) under PM2. Double-click to run.
REM
REM Deliberately does more than "npm run serve": that starts an UNSUPERVISED
REM process which pm2 cannot see or stop, and two of those running at once send
REM every recipient the same mail twice. This script guarantees exactly one.
setlocal
cd /d "%~dp0"

echo ============================================
echo   GitHub Track - START
echo ============================================
echo.

echo [1/4] Building (so the running code matches src/)...
call npm run build
if errorlevel 1 (
  echo.
  echo BUILD FAILED - not starting. Fix the errors above and try again.
  pause
  exit /b 1
)
echo.

echo [2/4] Clearing any unsupervised instance...
REM PM2-managed processes run via ProcessContainerFork.js and are NOT matched
REM here, so only hand-started "node dist/server.js" strays get cleared.
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dist.(server|index)\.js' } | ForEach-Object { Write-Host ('      stopping stray pid ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force }"
echo.

echo [3/4] Starting under PM2...
REM Deregister first: a stale entry makes "pm2 start" fail with "Process not found".
call scripts\pm2.cmd delete gh-track-crawler >nul 2>&1
call scripts\pm2.cmd delete gh-track-ui >nul 2>&1
call scripts\pm2.cmd start ecosystem.config.cjs
echo.

echo [4/4] Status:
call scripts\pm2.cmd list
echo.
echo ============================================
echo   Dashboard : http://localhost:1001
echo   Logs      : logs\ui.out.log , logs\crawler.out.log
echo   Live logs : scripts\pm2.cmd logs
echo   Stop      : stop.cmd
echo ============================================
echo.
echo NOTE: the UI process also runs the email campaign and the daily
echo       account-to-account warm-up. Starting this resumes sending.
echo.
pause
