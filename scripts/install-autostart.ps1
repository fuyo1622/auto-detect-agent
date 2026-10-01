# Starts Agent Monitor in the background (with its tray icon) every time you sign in to Windows.
# Undo with scripts\uninstall-autostart.ps1.
param([switch]$StartNow)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$main = Join-Path $root 'src\main.ts'
$link = Join-Path ([Environment]::GetFolderPath('Startup')) 'Agent Monitor.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $node
$shortcut.Arguments = "`"$main`" --background"
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle = 7   # minimized; the launcher exits at once and the agent runs without a window
$shortcut.Description = 'Agent Monitor: watches Claude Code and Codex sessions'
$shortcut.Save()

Write-Host "Autostart installed: $link" -ForegroundColor Green
Write-Host 'Agent Monitor will start in the background every time you sign in.'

if ($StartNow) {
    Start-Process -FilePath $node -ArgumentList "`"$main`" --background" -WorkingDirectory $root -WindowStyle Hidden
    Write-Host 'Started. Dashboard: http://127.0.0.1:7421'
}
