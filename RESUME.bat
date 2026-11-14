@echo off & setlocal EnableDelayedExpansion
chcp 65001 >nul
title ClaudeCode-Portable - Resume Session

REM Standalone session resume. Unlike START.bat this script installs, repairs,
REM updates and configures nothing - it only checks what START.bat set up once.

set "ROOT=%~dp0"

set "ARCH=x64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=arm64"

set "NODE_EXE=%ROOT%engine\node-win32-%ARCH%\node.exe"
set "CLAUDE_EXE=%ROOT%engine\win32-%ARCH%\current\node_modules\@anthropic-ai\claude-code-win32-%ARCH%\claude.exe"

REM lib/paths.mjs lets PORTABLE_AI_DATA_DIR move the data folder, so the preflight
REM has to look where the runtime actually reads its settings from.
set "DATA_DIR=%PORTABLE_AI_DATA_DIR%"
if "%DATA_DIR%"=="" set "DATA_DIR=%ROOT%data"
set "CONFIG_FILE=%DATA_DIR%\settings.json"

if not exist "%NODE_EXE%" (
    echo [ERROR] Portable Node.js was not found: %NODE_EXE%
    echo [ERROR] Run START.bat once to install the portable runtime, then try again.
    pause
    exit /b 1
)

if not exist "%CLAUDE_EXE%" (
    echo [ERROR] Claude Code was not found: %CLAUDE_EXE%
    echo [ERROR] Run START.bat once to install the portable runtime, then try again.
    pause
    exit /b 1
)

if not exist "%CONFIG_FILE%" (
    echo [ERROR] No provider is configured: %CONFIG_FILE%
    echo [ERROR] Run START.bat once and choose a provider, then try again.
    pause
    exit /b 1
)

REM Argument parsing and validation happen in Node so quoting, duplicate flags
REM and the positional session ID / working directory rules stay testable.
"%NODE_EXE%" "%ROOT%tools\resume.mjs" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not defined PORTABLE_AI_NO_PAUSE pause
exit /b %EXIT_CODE%
