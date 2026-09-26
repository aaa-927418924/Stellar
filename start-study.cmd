@echo off
title Study App
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  echo Download it from https://nodejs.org/
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  node --version
  pause
  exit /b 1
)
echo Starting Study App. Close this window to stop the server.
node server\index.js
if errorlevel 1 pause
