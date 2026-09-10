@echo off
title ClaudeCode-Portable - Local Model Setup
cls

echo.
echo Running Local Model Setup...
echo.

powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0setup_local_models.ps1"

echo.
pause
