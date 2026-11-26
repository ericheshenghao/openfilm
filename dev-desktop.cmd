@echo off
REM Launch OpenFilm Desktop from source on Windows.
REM Uses the bundled Node/pnpm.cmd to avoid the PowerShell pnpm.ps1 execution-policy issue.
setlocal
set "NODE_BIN=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6"
REM ffmpeg/ffprobe: Studio needs these on PATH to derive each clip's sound (?film-sound).
REM Without them the mixer returns 204 and timeline audio is silent while library preview (raw wav) still plays.
REM The packaged exe has its own copy; from source we place the first one we find on PATH.
set "FFMPEG_BIN="
for %%D in (
  "%~dp0runtime\ffmpeg"
  "D:\WorkBuddy\2026-11-25-23-03-22\EditroomWin\bin"
  "%USERPROFILE%\scoop\apps\ffmpeg\current\bin"
) do if exist "%%~D\ffmpeg.exe" if exist "%%~D\ffprobe.exe" set "FFMPEG_BIN=%%~D"
if defined FFMPEG_BIN (
  set "PATH=%NODE_BIN%;%FFMPEG_BIN%;%PATH%"
) else (
  echo WARNING: ffmpeg/ffprobe not found - timeline audio will be silent. Put both on PATH.
  set "PATH=%NODE_BIN%;%PATH%"
)
cd /d "%~dp0"

echo Starting OpenFilm Desktop from source...
call "%NODE_BIN%\pnpm.cmd" --filter @openfilm/desktop start %*
endlocal
