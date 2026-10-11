@echo off
rem agent-hangar CLI launcher for the installed Hangar app on Windows (counterpart of hangar.sh).
rem This file must stay ASCII only: cmd reads it in the OEM code page, so UTF-8 text would be garbled.
rem cmd cannot read JSON, so it only finds some Node that can read launch-cli.mjs and runs launch-cli.mjs with it.
rem launch-cli.mjs then checks the Node version against manifest.json and, if needed, hands over to a matching Node
rem (HANGAR_NODE, settings.json nodePath, the official installer locations, nvm-windows, fnm, Volta, scoop, then every node.exe on PATH).
rem Order here: HANGAR_NODE, every node.exe on PATH, the official installer locations.
rem A candidate is skipped when it does not exist, or when it does not answer as Node 16 or later
rem (launch-cli.mjs is built for Node 16, LAUNCHER_MIN_NODE in bundle-server.ts; an older Node on PATH would fail on its syntax).
goto start
:find_dp0
rem %~dp0 read inside a called label is reliable even when this file was started by a quoted name found on PATH.
set "dp0=%~dp0"
exit /b
:try
rem %1 is a candidate. Sets HANGAR_NODE to it when it is a file and answers as Node 16 or later.
if defined HANGAR_NODE exit /b
if "%~1"=="" exit /b
if not exist "%~1" exit /b
if exist "%~1\*" exit /b
set "major="
for /f "tokens=1 delims=. " %%v in ('call "%~1" -p "parseInt(process.versions.node)" 2^>nul') do if not defined major set "major=%%v"
if not defined major exit /b
rem Anything but digits (an error message, a user name) is not a Node version.
for /f "delims=0123456789" %%x in ("%major%") do set "major="
if not defined major exit /b
if %major% GEQ 16 set "HANGAR_NODE=%~1"
exit /b
:start
setlocal
call :find_dp0
rem The user's HANGAR_NODE is tried first, and dropped here when it is missing or too old.
rem The user's value itself comes back after endlocal, so launch-cli.mjs still lists it among the places it checked.
set "want=%HANGAR_NODE%"
set "HANGAR_NODE="
if defined want call :try "%want%"
rem $PATH: makes where look only in the PATH entries, not in the current directory.
for /f "delims=" %%n in ('where $PATH:node.exe 2^>nul') do call :try "%%n"
call :try "%ProgramFiles%\nodejs\node.exe"
call :try "%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined HANGAR_NODE goto run
echo Node.js was not found (a Node.js older than 16 cannot start this command). Install Node 22 with "winget install -e --id OpenJS.NodeJS.22" in PowerShell, or with nvm-windows ("nvm install 22"). If it is somewhere else, set HANGAR_NODE to the full path of node.exe. 1>&2
exit /b 1
:run
rem The batch must be over before node starts. Otherwise, after Ctrl+C stops node, cmd asks
rem "Terminate batch job (Y/N)?" before it goes on. The same trick as npm's cmd-shim (npm/cli#969):
rem cmd reads and expands this whole line first, endlocal drops the variables set above (they are already expanded),
rem and the goto to a missing label ends the batch. The rest of the line still runs, outside the batch,
rem so Ctrl+C has nothing left to ask about, and the exit code of node becomes the exit code of cmd.
rem "ver >nul" only gives "||" something harmless to run; npm uses "title" there, which would rename the terminal tab.
endlocal & goto #_end_of_batch_# 2>nul || ver >nul & "%HANGAR_NODE%" "%dp0%..\launch-cli.mjs" %*
