@echo off
REM Stop GitHub Track completely. Double-click to run.
REM
REM "pm2 stop all" alone is NOT enough: a process started by hand (npm run serve,
REM node dist/server.js) is invisible to pm2 and keeps sending after pm2 reports
REM everything stopped. This script stops both kinds.
setlocal
cd /d "%~dp0"

echo ============================================
echo   GitHub Track - STOP
echo ============================================
echo.

echo [1/3] Stopping PM2 apps...
call scripts\pm2.cmd stop gh-track-crawler >nul 2>&1
call scripts\pm2.cmd stop gh-track-ui >nul 2>&1
echo       done.
echo.

echo [2/3] Stopping any unsupervised instance...
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dist.(server|index)\.js' }; if ($p) { $p | ForEach-Object { Write-Host ('      stopping pid ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force } } else { Write-Host '      none found.' }"
echo.

echo [3/3] Verifying nothing is left running...
powershell -NoProfile -Command "Start-Sleep -Seconds 2; $p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ($_.CommandLine -match 'dist.(server|index)\.js' -or $_.CommandLine -match 'ProcessContainerFork') }; if ($p) { Write-Host '      WARNING - still running:'; $p | ForEach-Object { Write-Host ('        pid ' + $_.ProcessId) } } else { Write-Host '      confirmed: nothing running.' }"
echo.
call scripts\pm2.cmd list
echo.
echo ============================================
echo   Stopped. No mail is being sent.
echo   Start again with: start.cmd
echo ============================================
echo.
pause
