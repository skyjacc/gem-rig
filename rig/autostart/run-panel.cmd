@echo off
rem Starts the Gemtrack panel for Windows Task Scheduler (see install-task.ps1).
rem Environment comes from tools\panel.env.cmd (not in git): ALLOWED_HOSTS with the
rem tailnet machine name, optionally PORT, PANEL_TOKEN and so on.
rem Output is appended to tools\panel.log.
rem Keep this file ASCII with CRLF line endings: cmd.exe misreads UTF-8 text.
rem
rem The restart loop lives here: Task Scheduler restarts a task only when it
rem fails to launch, not when the program inside exits with an error.
rem Restart or stop it with restart-panel.ps1 (Stop-ScheduledTask alone leaves node running).

cd /d "%~dp0.."
:loop
if exist "..\tools\panel.env.cmd" call "..\tools\panel.env.cmd"
echo ==== %date% %time% start >> "..\tools\panel.log"
node server\index.ts >> "..\tools\panel.log" 2>&1
echo ==== %date% %time% exit %errorlevel%, restart in 15 s >> "..\tools\panel.log"
timeout /t 15 /nobreak > nul
goto loop
