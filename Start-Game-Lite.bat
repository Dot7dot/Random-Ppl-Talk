@echo off
chcp 65001 >nul
title Random ppl talk (Lite)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\start.ps1" -Small %*
if errorlevel 1 (
  echo.
  echo Something went wrong. See the logs folder next to this file.
  pause
)
