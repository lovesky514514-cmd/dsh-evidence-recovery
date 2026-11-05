@echo off
chcp 65001 >nul
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0DSH_本地试跑.ps1" %*
set "skyExit=%errorlevel%"
if not "%skyExit%"=="0" (
  echo.
  echo DSH preflight failed. Review the error above.
  pause
)
endlocal & exit /b %skyExit%
