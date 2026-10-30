@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 24 or newer is required. Install it from the official Node.js website.
  pause
  exit /b 1
)
if not exist ".env" copy /Y ".env.example" ".env" >nul
echo Open http://localhost:4310 in your browser. Press Ctrl+C here to stop SignalCrew.
node --env-file-if-exists=.env server.mjs
pause
