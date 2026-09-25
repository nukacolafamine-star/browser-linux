@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Node.js is not available. This launcher does not install anything.
  echo The public folder can also be served by an existing HTTPS static host.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:4173 in Chrome or Edge.
echo Keep this window open. Press Ctrl+C to stop the local server.
node tools/serve.mjs
if errorlevel 1 pause
