@echo off
rem agent-hangar CLI launcher for the installed Hangar app on Windows (counterpart of hangar.sh).
rem This file must stay ASCII only: cmd reads it in the OEM code page, so UTF-8 text would be garbled.
rem cmd cannot read JSON, so it only finds some Node and runs launch-cli.mjs with it.
rem launch-cli.mjs then checks the Node version against manifest.json and, if needed, hands over to a matching Node
rem (HANGAR_NODE, settings.json nodePath, the official installer locations, nvm-windows, then every node.exe on PATH).
rem Order here: HANGAR_NODE, node on PATH, the official installer locations.
goto start
:find_dp0
rem %~dp0 read inside a called label is reliable even when this file was started by a quoted name found on PATH.
set "dp0=%~dp0"
exit /b
:start
setlocal
call :find_dp0
if defined HANGAR_NODE goto run
where node >nul 2>nul
if not errorlevel 1 set "HANGAR_NODE=node" & goto run
if exist "%ProgramFiles%\nodejs\node.exe" set "HANGAR_NODE=%ProgramFiles%\nodejs\node.exe" & goto run
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "HANGAR_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe" & goto run
echo Node.js was not found. Install Node 22, or set HANGAR_NODE to the full path of node.exe. 1>&2
exit /b 1
:run
rem The batch must be over before node starts. Otherwise, after Ctrl+C stops node, cmd asks
rem "Terminate batch job (Y/N)?" before it goes on. The same trick as npm's cmd-shim (npm/cli#969):
rem cmd reads and expands this whole line first, endlocal drops the variables set above (they are already expanded),
rem and the goto to a missing label ends the batch. The rest of the line still runs, outside the batch,
rem so Ctrl+C has nothing left to ask about, and the exit code of node becomes the exit code of cmd.
rem "ver >nul" only gives "||" something harmless to run; npm uses "title" there, which would rename the terminal tab.
endlocal & goto #_end_of_batch_# 2>nul || ver >nul & "%HANGAR_NODE%" "%dp0%..\launch-cli.mjs" %*
