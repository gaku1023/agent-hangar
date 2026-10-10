@echo off
rem agent-hangar CLI launcher for the installed Hangar app on Windows (counterpart of hangar.sh).
rem This file must stay ASCII only: cmd reads it in the OEM code page, so UTF-8 text would be garbled.
rem cmd cannot read JSON, so it only finds some Node and runs launch-cli.mjs with it.
rem launch-cli.mjs then checks the Node version against manifest.json and, if needed, hands over to a matching Node.
rem Order: HANGAR_NODE, node on PATH, the official installer locations.
setlocal
if defined HANGAR_NODE goto run
where node >nul 2>nul
if not errorlevel 1 set "HANGAR_NODE=node" & goto run
if exist "%ProgramFiles%\nodejs\node.exe" set "HANGAR_NODE=%ProgramFiles%\nodejs\node.exe" & goto run
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "HANGAR_NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe" & goto run
echo Node.js was not found. Install Node 22, or set HANGAR_NODE to the full path of node.exe. 1>&2
exit /b 1
:run
"%HANGAR_NODE%" "%~dp0..\launch-cli.mjs" %*
exit /b %ERRORLEVEL%
