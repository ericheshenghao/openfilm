@echo off
REM Launch OpenFilm Desktop from source on Windows.
REM Uses the bundled Node/pnpm.cmd to avoid the PowerShell pnpm.ps1 execution-policy issue.
setlocal
set "NODE_BIN=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6"
set "PATH=%NODE_BIN%;%PATH%"
cd /d "%~dp0"

echo Starting OpenFilm Desktop from source...
call "%NODE_BIN%\pnpm.cmd" --filter @openfilm/desktop start %*
endlocal
