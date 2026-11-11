@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting Pulse Crypto Journal (Electron + Vite Dev)...
call npm run dev
if errorlevel 1 (
  echo.
  echo [ERROR] Startup exited with an error. Press any key to close.
  pause >nul
)
