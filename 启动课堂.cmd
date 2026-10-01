@echo off
rem ============================================================
rem  Classroom Points v3 - local hub launcher (teacher machine)
rem  NOTE: this file must stay ASCII-only. cmd.exe parses .cmd in
rem  the system ANSI codepage; Chinese text here breaks parsing on
rem  non-UTF8 locales. Chinese guidance is printed by the hub itself.
rem ============================================================
chcp 65001 >nul
title Classroom Hub Launcher
cd /d "%~dp0"

echo ============================================================
echo   Classroom Points v3 - Local Hub
echo   Teacher console / student client / big screen are all served
echo   by THIS computer. No public server is required.
echo   For cross-network use, put devices on the same EasyTier net.
echo   Close the "Classroom Hub" window to stop the service.
echo ============================================================
echo.

if not exist node_modules\ws (
  echo [1/3] Installing dependencies, please wait...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Make sure Node.js 18+ is installed
    echo         and the npm registry is reachable, then run: npm install
    pause
    exit /b 1
  )
  echo.
) else (
  echo [1/3] Dependencies OK.
)

echo [2/3] Starting the hub in a separate window...
start "Classroom Hub" cmd /k "node sync-server.js"

echo [3/3] Opening the teacher console in 3 seconds...
ping -n 4 127.0.0.1 >nul
start "" http://localhost:8080/admin.html

echo.
echo ------------------------------------------------------------
echo  The hub is running in the "Classroom Hub" window.
echo  Teacher console : http://localhost:8080/admin.html
echo  Student client  : http://^<this-PC-IP^>:8080/join   (see hub log)
echo  Big screen      : http://localhost:8080/stage
echo  This window can be closed now.
echo ------------------------------------------------------------
pause
