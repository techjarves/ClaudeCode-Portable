@echo off
REM Starts the portable studio inside Windows Terminal.
REM
REM Two things the classic console cannot do but this session needs:
REM   - Clickable paths. Claude Code sends OSC 8 hyperlinks only to terminals it
REM     recognises, and Windows Terminal identifies itself through WT_SESSION.
REM   - Ctrl+V for images. The console steals Ctrl+V for a text paste before the
REM     application sees it; Windows Terminal only does so when a keybinding
REM     claims the key. See README, "Pasting images".
REM
REM Text paste inside Windows Terminal is Ctrl+Shift+V.

setlocal
where wt.exe >nul 2>&1
if errorlevel 1 (
  echo.
  echo Windows Terminal was not found. Install it from the Microsoft Store,
  echo or keep using START.bat in the classic console.
  echo.
  if not defined PORTABLE_AI_NO_PAUSE pause
  exit /b 1
)

if /i "%~1"=="resume" (
  start "" wt.exe -d "%~dp0." cmd /c "RESUME.bat"
  exit /b 0
)
REM An empty argument would reach START.bat as a blank profile name, so the
REM no-argument case gets its own branch.
if "%~1"=="" (
  start "" wt.exe -d "%~dp0." cmd /c "START.bat"
) else (
  start "" wt.exe -d "%~dp0." cmd /c "START.bat %*"
)
exit /b 0
