# Перезапуск и остановка панели, запущенной задачей «Gemtrack panel».
#
#   powershell -ExecutionPolicy Bypass -File rig\autostart\restart-panel.ps1          перезапустить
#   powershell -ExecutionPolicy Bypass -File rig\autostart\restart-panel.ps1 -Stop    остановить
#
# Stop-ScheduledTask гасит только обёртку run-panel.cmd, а node с панелью
# остаётся жить. Поэтому:
#   перезапуск — убить процесс панели: цикл в run-panel.cmd поднимет его
#                через 15 с, заново прочитав tools\panel.env.cmd;
#   остановка  — сначала задача (чтобы цикл не поднял), потом процесс.

param([switch]$Stop)

$panel = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'server[\\/]index\.ts' }

if ($Stop) {
  Stop-ScheduledTask -TaskName 'Gemtrack panel' -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object { $_.CommandLine -match 'run-panel\.cmd' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

foreach ($p in $panel) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }

if ($Stop) { Write-Host 'панель остановлена; запустить снова: Start-ScheduledTask -TaskName "Gemtrack panel"'; return }

# Обёртки с циклом нет — некому поднять панель. Запускаем задачу сами.
$loop = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -match 'run-panel\.cmd' }
if (-not $loop) { Start-ScheduledTask -TaskName 'Gemtrack panel'; Write-Host 'задача запущена заново' }
if ($panel) { Write-Host 'панель перезапускается — поднимется через ~15 с' }
else { Write-Host 'панель не была запущена; запустить: Start-ScheduledTask -TaskName "Gemtrack panel"' }
