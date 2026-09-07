@echo off
REM Run the library server on its own, with no window on the desktop.
REM
REM The app normally starts the server as a child process and stops it on the
REM way out, so a phone or tablet only reaches the library while a window is
REM open on this computer. Started this way the server outlives the app: open
REM and close the app as you like and the library stays up.
REM
REM The app checks the port first and joins a server that is already running,
REM so the two never fight over it.

set "APP=%~dp0"
set "MEDIA_INSTALL_DIR=%APP:~0,-1%"
set "MEDIA_CONFIG_DIR=%APP:~0,-1%"
set "MEDIA_DATA_DIR=%APP%data"
set "MEDIA_WEB_DIR=%APP%resources\app.asar.unpacked\desktop\dist-web"

REM Do nothing if the library is already up.
REM
REM The scheduled task runs this every few minutes so that a server which has
REM stopped comes back on its own — otherwise the first anyone hears of it is
REM a phone that will not load, hours later, with nobody at the computer. That
REM only works if starting it again while it is already running is harmless,
REM which is what this checks: the task cannot tell, because the launcher it
REM runs returns straight away and leaves the server behind it.
netstat -an | findstr /c:":8787" | findstr /i "LISTENING" >nul
if not errorlevel 1 exit /b 0

cd /d "%APP%resources\app.asar.unpacked"
"%APP%runtime\node.exe" server\src\index.js >> "%APP%data\server.log" 2>&1
