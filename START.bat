@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\bootstrap.ps1" %*
set "PortableExitCode=%errorlevel%"
if not "%PortableExitCode%"=="0" (
  echo.
  echo ClaudeCode-Portable could not finish starting.
  echo The error above is important. Please take a screenshot or check data\logs\runtime-install.log.
  if not defined PORTABLE_AI_NO_PAUSE pause
)
exit /b %PortableExitCode%
