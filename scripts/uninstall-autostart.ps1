# Removes the sign-in shortcut and stops a running Agent Monitor.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$link = Join-Path ([Environment]::GetFolderPath('Startup')) 'Agent Monitor.lnk'

if (Test-Path $link) {
    Remove-Item $link
    Write-Host "Removed $link" -ForegroundColor Green
} else {
    Write-Host 'Autostart was not installed.'
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($node) {
    & $node (Join-Path $root 'src\cli.ts') stop 2>$null
}
