@echo off
REM Version-pinned PM2 wrapper. Always uses node v24 (where PM2 is installed),
REM so `pm2` works no matter which node version nvm has active on your PATH.
REM Usage:  scripts\pm2.cmd status   |   scripts\pm2.cmd logs   |   scripts\pm2.cmd restart all
"C:\Users\Administrator\AppData\Roaming\nvm\v24.18.0\node.exe" "C:\Users\Administrator\AppData\Roaming\nvm\v24.18.0\node_modules\pm2\bin\pm2" %*
