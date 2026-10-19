@echo off
rem guan-lineage one-click installer for Windows: double-click, or run "install.cmd --crawl"
rem Runs install.ps1 with ExecutionPolicy Bypass so no system policy change is needed.
setlocal
set "ARGS="
if /i "%~1"=="--crawl" set "ARGS=-Crawl"
if /i "%~1"=="-Crawl" set "ARGS=-Crawl"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %ARGS%
set "RC=%ERRORLEVEL%"
rem Keep the window open when launched by double-click
echo %CMDCMDLINE% | find /i "/c" >nul && pause
exit /b %RC%
