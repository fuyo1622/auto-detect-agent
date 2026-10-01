# Publishes the phone port to your tailnet as https://<this-pc>.<tailnet>.ts.net
# (only devices signed in to your Tailscale account can reach it; nothing is opened to the internet).
param([int]$Port = 7420)

$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts) {
    $candidate = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (Test-Path $candidate) { $ts = $candidate }
}
if (-not $ts) {
    Write-Host 'Tailscale is not installed. Get it from https://tailscale.com/download, sign in, then run this again.' -ForegroundColor Yellow
    exit 1
}

$status = & $ts status --json | ConvertFrom-Json
if ($status.BackendState -ne 'Running') {
    Write-Host "Tailscale is not connected ($($status.BackendState)). Open Tailscale from the tray, sign in, then run this again." -ForegroundColor Yellow
    exit 1
}

& $ts serve --bg --https=443 "http://127.0.0.1:$Port"
if ($LASTEXITCODE -ne 0) {
    Write-Host 'tailscale serve failed. If the message mentions HTTPS certificates, turn on HTTPS on the DNS page of the Tailscale admin console, then run this again.' -ForegroundColor Yellow
    exit 1
}

$name = $status.Self.DNSName.TrimEnd('.')
Write-Host ''
Write-Host "Phone address: https://$name" -ForegroundColor Green
Write-Host 'Next: open the dashboard (tray icon > Pair a phone) and scan the QR code with the iPhone.'
