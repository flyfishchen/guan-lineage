@echo off
rem guan-lineage one-click installer for Windows: double-click, or "install.cmd [--crawl] [--project-skill] [--no-skill]"
rem Runs install.ps1 with ExecutionPolicy Bypass so no system policy change is needed.
setlocal
set "ARGS="
rem Map "--crawl" / "--project-skill" / "--no-skill" to the PowerShell switches
:args
if "%~1"=="" goto run
if /i "%~1"=="--crawl" set "ARGS=%ARGS% -Crawl"
if /i "%~1"=="-Crawl" set "ARGS=%ARGS% -Crawl"
if /i "%~1"=="--no-skill" set "ARGS=%ARGS% -NoSkill"
if /i "%~1"=="-NoSkill" set "ARGS=%ARGS% -NoSkill"
if /i "%~1"=="--project-skill" set "ARGS=%ARGS% -ProjectSkill"
if /i "%~1"=="-ProjectSkill" set "ARGS=%ARGS% -ProjectSkill"
shift
goto args
:run
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %ARGS%
set "RC=%ERRORLEVEL%"
rem Keep the window open when launched by double-click
echo %CMDCMDLINE% | find /i "/c" >nul && pause
exit /b %RC%
