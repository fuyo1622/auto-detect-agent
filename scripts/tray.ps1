# Tray icon for Agent Monitor. Started by the agent; exits when the agent exits.
param(
    [string]$AdminUrl = 'http://127.0.0.1:7421',
    [int]$AgentPid = 0,
    [string]$LogPath = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

function New-StatusIcon([System.Drawing.Color]$color) {
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush $color
    $g.FillEllipse($brush, 1, 1, 30, 30)
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 3
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $points = [System.Drawing.Point[]]@(
        (New-Object System.Drawing.Point 6, 17), (New-Object System.Drawing.Point 11, 17),
        (New-Object System.Drawing.Point 14, 9), (New-Object System.Drawing.Point 18, 23),
        (New-Object System.Drawing.Point 21, 15), (New-Object System.Drawing.Point 26, 15))
    $g.DrawLines($pen, $points)
    $g.Dispose()
    return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$icons = @{
    ok   = New-StatusIcon ([System.Drawing.Color]::FromArgb(48, 164, 88))
    warn = New-StatusIcon ([System.Drawing.Color]::FromArgb(214, 140, 20))
    bad  = New-StatusIcon ([System.Drawing.Color]::FromArgb(214, 60, 52))
    off  = New-StatusIcon ([System.Drawing.Color]::FromArgb(120, 120, 128))
}

function Invoke-Agent([string]$path, [string]$method = 'GET') {
    $req = [System.Net.HttpWebRequest]::Create("$AdminUrl$path")
    $req.Method = $method
    $req.Timeout = 3000
    $req.Proxy = $null
    $req.Headers.Add('X-Agent-Client', 'tray')
    if ($method -ne 'GET') { $req.ContentLength = 0 }
    $resp = $req.GetResponse()
    try {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
        return ($reader.ReadToEnd() | ConvertFrom-Json)
    } finally { $resp.Close() }
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icons.off
$tray.Text = 'Agent Monitor: starting'
$tray.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open dashboard')
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
$open.add_Click({ Start-Process $AdminUrl })
$pair = $menu.Items.Add('Pair a phone...')
$pair.add_Click({ Start-Process "$AdminUrl/#pc" })
if ($LogPath) {
    $log = $menu.Items.Add('Open log')
    $log.add_Click({ if (Test-Path $LogPath) { Start-Process notepad.exe $LogPath } })
}
[void]$menu.Items.Add('-')
$quit = $menu.Items.Add('Quit Agent Monitor')
$quit.add_Click({
    try { [void](Invoke-Agent '/api/admin/shutdown' 'POST') } catch { }
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})
$tray.ContextMenuStrip = $menu
$tray.add_MouseClick({ param($sender, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Start-Process $AdminUrl } })

$script:known = @{}
$script:failures = 0

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.add_Tick({
    if ($AgentPid -gt 0 -and -not (Get-Process -Id $AgentPid -ErrorAction SilentlyContinue)) {
        $tray.Visible = $false
        [System.Windows.Forms.Application]::Exit()
        return
    }
    try {
        $s = Invoke-Agent '/api/summary'
        $script:failures = 0
        $tray.Icon = $icons[[string]$s.level]
        $text = "Agent Monitor: $($s.live) running"
        if ($s.problems.Count -gt 0) { $text += ", $($s.problems.Count) need attention" }
        if ($s.awake) { $text += ' (awake)' }
        if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
        $tray.Text = $text

        $now = @{}
        foreach ($p in $s.problems) {
            $id = "$($p.key)|$($p.health)"
            $now[$id] = $true
            if (-not $script:known.ContainsKey($id)) {
                $tip = [System.Windows.Forms.ToolTipIcon]::Warning
                $tray.ShowBalloonTip(8000, $p.title, $p.detail, $tip)
            }
        }
        $script:known = $now
    } catch {
        $script:failures++
        if ($script:failures -ge 2) {
            $tray.Icon = $icons.off
            $tray.Text = 'Agent Monitor: not responding'
        }
    }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
$tray.Dispose()
