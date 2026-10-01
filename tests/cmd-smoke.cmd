@echo off
rem ASCII-only smoke test for the launcher structure (docs/08 explains the why).
rem Runs the same steps as the launcher but on a throwaway port, then stops it.
chcp 65001 >nul
cd /d "%~dp0.."

echo [TEST 1] dependency check (node_modules\ws)
if not exist node_modules\ws (
  echo [TEST 1] MISSING ws - the real launcher would run npm install
) else (
  echo [TEST 1] OK - ws present
)

echo [TEST 2] start hub on port 8199
set PORT=8199
start "Hub-Test" cmd /c "node sync-server.js"
ping -n 4 127.0.0.1 >nul

echo [TEST 3] probe /health
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://127.0.0.1:8199/health' -UseBasicParsing -TimeoutSec 5).Content } catch { 'PROBE-FAILED: ' + $_.Exception.Message }"

echo [TEST 4] stop test hub
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8199 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
echo [TEST] DONE
