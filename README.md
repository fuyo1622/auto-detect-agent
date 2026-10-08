# Agent Monitor

Watches the Claude Code and Codex sessions on this PC (terminal and desktop app) and shows them on your iPhone. When Remote Control drops, a session gets stuck, crashes, or waits for your approval, the phone gets a notification, and one tap reconnects it.

```
PC (Windows)                                              iPhone
Claude / Codex sessions ──► Agent Monitor ◄── Tailscale (HTTPS, private) ──► "Agents" app (PWA)
                             ├─ dashboard  http://127.0.0.1:7421 (this PC only)
                             └─ tray icon
```

## Setup

Already done on this PC: dependencies installed, autostart at sign-in (the agent and its tray icon start when you sign in to Windows).

What you still need to do (about 10 minutes):

1. **Tailscale on the PC.** Install it from <https://tailscale.com/download> and sign in.
2. **Tailscale on the iPhone.** Install Tailscale from the App Store and sign in with the same account.
3. **Turn on the phone address.** Click the tray icon, then **Phone setup**, then **Turn on phone address**. You can also run `npm run tailscale:setup`.
   If Tailscale asks you to enable HTTPS certificates, follow its link (Tailscale admin console → DNS → HTTPS Certificates), then try again.
4. **Pair the iPhone.** Scan the QR code on the Phone setup page with the iPhone camera, which opens it in Safari. Then tap Share, choose **Add to Home Screen**, open **Agents** from the Home Screen, and enter the 6-digit code.
5. **Turn on notifications.** In the app, go to **Settings → Turn on notifications** (needs iOS 16.4 or later).

## What the statuses mean

| Status | Meaning | Typical fix |
|---|---|---|
| **Remote Control lost** | Started with Remote Control, but Claude reports it as not connected, or Claude's own session list no longer includes the process. | **Reconnect** |
| **Looks stuck** | Working, but no transcript writes and no CPU use (from the session or what it started) for 15 minutes. You can change this in Settings. | **Reconnect** / **Restart** |
| **Needs you** | A tool call is waiting with nothing running behind it, which usually means it needs your approval or answer. Codex approval requests are shown directly. | **Open in Claude** and approve |
| **Stopped unexpectedly** | The process disappeared without Claude cleaning up, or it died while working. | **Resume** |
| Working / Waiting for you / Closed | Normal states. A session you close with **Stop** or **Reconnect** shows as Closed, not as a crash. | |

## What the buttons do

- **Reconnect (Claude, terminal):** closes the process and opens `claude --remote-control --resume <id>` in a new Windows Terminal tab, in the same folder. The conversation is kept, and you're asked to confirm if it's still working. It checks first that the folder can be reached, so it never closes a session it can't reopen.
- **Restart (Codex, terminal):** closes it and runs `codex resume <id>` in a new tab.
- **Open in terminal (Codex app thread):** runs `codex resume <id>` in a new tab.
- **Restart Claude app / Codex app:** closes the app and starts it again (Apps section, or a session's ⋯ menu). This is the fix for Claude app sessions: the app reopens a session's process by itself, so a terminal copy would run the conversation twice.
- **Codex remote control:** start, restart or stop the Codex app-server daemon (`codex remote-control start`, `codex app-server daemon restart|stop`).
- **Resume:** reopens a session that is gone.
- **Open in Claude:** opens the session's claude.ai link (Remote Control) in the Claude app or in Safari.

## Settings (in the app)

- **Notifications:** problems, needs-you, finished (off by default), PC status (woke up, back online).
- **Keep the PC awake:** off, while working, or always. This stops Windows from sleeping on its own; closing the lid or choosing Sleep still sleeps. For Remote Control from your phone, "Always" is the most reliable.
- **Call it stuck after:** 5 to 90 minutes.
- **Auto-reconnect** (off by default): reopens idle terminal Claude sessions that lost Remote Control, at most 3 times an hour.

## Commands

```
npm start                  run in this console (Ctrl+C to stop)
npm run start:bg           run in the background
npm run status             list sessions in the console
npm run pair               show a pairing code and QR code in the console
npm run stop               stop the background agent
npm run autostart:install  start at sign-in (already done)
npm run autostart:remove   remove autostart and stop the agent
npm test                   run the tests
npm run check              type-check
npm run dev                a dry-run copy on ports 17420/17421 (sees real sessions, never closes or opens anything)
npm run dev:status         list sessions from that copy
```

Logs are in `data\agent.log`, or use the tray icon → Open log.

## Configuration

Copy `config.example.json` to `config.json` and change what you need. Restart the agent afterwards. The main options are:

- `phonePort` / `adminPort` (7420 / 7421)
- `pollIntervalMs` (5000)
- `approvalSeconds` (60): how long a quiet tool call waits before it counts as "Needs you"
- `alertDelaySeconds` (30): how long a problem must last before a push
- `recentHours` (12): which Codex app threads are listed
- `claudeCommand` / `codexCommand`
- `dryRun`: plan actions without closing or launching anything
- `paths`: where data, Claude and Codex files are (relative paths are relative to this folder)

To use another config file, set `AGENT_MONITOR_CONFIG` (that is how `npm run dev` uses `scripts/dev-config.json`).

## How detection works

- **Processes:** `bin\proc-helper.exe` (built from `helper\ProcHelper.cs` with the .NET Framework compiler that ships with Windows) reads every `claude.exe` / `codex.exe` / Codex app process. It gets the command line, working folder, start time, CPU time, and what each process started, in a few milliseconds per scan.
- **Claude:** `~/.claude/sessions/<pid>.json` is Claude's own list of running sessions (`status` busy/idle, `bridgeSessionId` = Remote Control). Entries are matched to processes by start time, so a recycled pid can't fool it. Transcripts in `~/.claude/projects` provide the last message, pending tool calls and Remote Control links. The Claude app's `claude-code-sessions` records say whether Remote Control should be on.
- **Codex:** `~/.codex/sessions/**/rollout-*.jsonl` (`task_started` / `task_complete` / approval events), `session_index.jsonl` for thread names, and `codex app-server daemon version` for the daemon. Helper threads (spawned agents, the approval reviewer) are not listed; their activity counts for the thread they work for.

Nothing is sent anywhere except push notifications (through Apple's push service) and the app's own traffic over your tailnet.

## Security

- **PC-only port (7421):** listens on 127.0.0.1 only. It rejects other Host headers (DNS rebinding) and cross-site requests, and changes require a custom header.
- **Phone port (7420):** also listens on 127.0.0.1. `tailscale serve` forwards your tailnet to it over HTTPS. It is never published to the internet (that would need `tailscale funnel`, which this project doesn't use).
- **Pairing tokens:** each phone gets a random token from a single-use 6-digit code that expires after 15 minutes. Only a SHA-256 hash of the token is stored, and you can remove phones from the Phone setup page.
- **What the phone can do:** only the listed actions (close/relaunch known sessions, restart the two desktop apps, the Codex daemon). It can never run arbitrary commands.
