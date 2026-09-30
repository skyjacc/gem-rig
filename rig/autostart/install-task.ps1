# Автозапуск панели на домашнем ПК.
#
#   powershell -ExecutionPolicy Bypass -File rig\autostart\install-task.ps1            поставить
#   powershell -ExecutionPolicy Bypass -File rig\autostart\install-task.ps1 -Remove    убрать
#
# Задача «Gemtrack panel» стартует при запуске Windows — без входа
# пользователя (S4U: пароль не хранится) — и перезапускается при падении.
# Нужны права администратора.
#
# Зачем: машина стоит дома, а к панели заходят издалека через Tailscale.
# После отключения света или обновления Windows панель должна подняться сама.

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$name = 'Gemtrack panel'

if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "задача «$name» убрана"
  return
}

$cmd = Join-Path $PSScriptRoot 'run-panel.cmd'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$envFile = Join-Path $root 'tools\panel.env.cmd'
if (-not (Test-Path $envFile)) {
  Set-Content -Path $envFile -Encoding ascii -Value @(
    '@echo off',
    'rem Panel environment for autostart. Not tracked by git.',
    'rem Tailnet machine name from tailscale status; comma-separated for several.',
    'set ALLOWED_HOSTS='
  )
  Write-Host "создан $envFile — впишите ALLOWED_HOSTS после установки Tailscale"
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$cmd`"" -WorkingDirectory (Split-Path $cmd)
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "задача «$name» поставлена: старт при запуске Windows от $user, перезапуск при падении"
Write-Host "запустить сейчас:  Start-ScheduledTask -TaskName '$name'"
