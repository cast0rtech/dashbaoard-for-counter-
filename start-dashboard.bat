@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required. Install Node.js, then run this file again.
  pause
  exit /b 1
)
echo Starting Janitza Monitor...
echo Keep this window open while using the dashboard.
set OPEN_BROWSER=1
node server.js
pause
