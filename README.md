# Agent Monitor

Keeps Claude Code Remote Control reachable from your iPhone. It watches the Claude Code sessions on this Windows PC (in
a terminal and in the Claude app). When Remote Control drops or a session stops unexpectedly, the phone gets a
notification, and one tap reconnects it. Everything else you do in the official Claude app, through Remote Control.

```
PC (Windows)                                       iPhone
Claude Code sessions ──► Agent Monitor ◄── Tailscale (HTTPS, private) ──► "Agents" app (PWA)
                          ├─ dashboard  http://127.0.0.1:7421 (this PC only)
                          └─ tray icon
```

## Install

1. **Build `AgentMonitor.exe`** (needs Node.js 24 or later, only for building):
   ```
   npm install
   npm run build
   ```
   The result is `dist\AgentMonitor.exe`, one file with everything inside (it carries its own Node).
2. **Double-click `dist\AgentMonitor.exe`.** It installs itself for your Windows user (no admin rights): a Start menu
   entry, a start at every sign-in, and an entry in Settings → Apps. Then it starts, shows a tray icon (maybe under
   **^**), and opens the setup page. A copy downloaded from the internet is unsigned, so Windows may warn first:
   **More info → Run anyway**.

**Update:** build again and double-click the new `dist\AgentMonitor.exe`. It replaces the running copy. Paired phones
and settings are kept.

## Phone setup (once, about 10 minutes)

1. **Tailscale** on the PC and on the iPhone, signed in to the same account (<https://tailscale.com/download>).
2. **Phone address.** The setup page turns it on (Phone setup → **Turn on phone address**; the installer already
   tries this). It is reachable only from your own Tailscale devices. If Tailscale asks for HTTPS certificates, turn
   them on in the Tailscale admin console (DNS → HTTPS Certificates) and try again.
3. **Pair the iPhone.** Scan the QR code on the setup page with the iPhone camera, which opens Safari. Tap Share →
   **Add to Home Screen**, open **Agents** from the Home Screen, and enter the 6-digit code.
4. **Notifications.** In the app: **Settings → Turn on notifications** (iOS 16.4 or later).

## Uninstall

Settings → Apps → Installed apps → **Agent Monitor** → Uninstall, or tray icon → **Uninstall Agent Monitor…**. This
removes the program, its shortcuts and its phone address. Paired phones and settings stay in
`%LOCALAPPDATA%\AgentMonitor`; delete that folder too (or run `AgentMonitor.exe uninstall --purge`) to remove them.

## What the statuses mean

| Status | Meaning | Fix |
|---|---|---|
| **Remote Control lost** | Remote Control was on (or asked for), and Claude now reports it as not connected, or no longer lists the session. New sessions get 30 seconds to connect. | **Reconnect** (terminal) / **Restart Claude app** |
| **Stopped unexpectedly** | The process ended without Claude closing the session, or while it was working. | **Resume** |
| Working / Waiting for you / Closed | Normal. A session closed by Reconnect or an app restart shows as Closed, not as a crash. | |

**No Remote Control** marks a session that runs without Remote Control. For terminal sessions the button is **Turn on
Remote Control**.

## What the buttons do

- **Reconnect / Turn on Remote Control** (terminal session): closes the process and opens
  `claude --remote-control --resume <id>` in a new Windows Terminal tab, in the same folder. The conversation is kept.
  It asks first if the session is still working, and it never closes a session whose folder it can't reach.
- **Resume:** reopens a session that is gone, the same way.
- **Restart Claude app:** closes the Claude app and starts it again. This is the fix for Claude app sessions: the app
  reopens their processes by itself. **Open Claude app** starts it when it isn't running.
- **Open in Claude:** opens the session's Remote Control link (claude.ai) to continue it on the phone.
- **Dismiss:** hides a closed session.

## Settings (in the app)

- **Notifications:** problems (Remote Control lost, stopped unexpectedly) and PC status (woke up, back online after a
  restart).
- **Keep the PC awake:** off, while working, or always. Stops Windows from sleeping by itself; closing the lid or
  choosing Sleep still sleeps. For Remote Control from the phone, "Always" is the most reliable.
- **Auto-reconnect** (off by default): when an idle terminal session loses Remote Control, reopens it after 2 minutes,
  at most 3 times an hour, and tells the phone.

## Troubleshooting

- **The phone says "Can't reach your PC":** the PC must be awake, and Tailscale must be running and connected on both
  the PC (its tray icon) and the phone. The dashboard's Phone setup page shows whether the phone address is on.
- **No tray icon:** Agent Monitor isn't running (**Quit Agent Monitor** in its menu stops it until the next sign-in).
  Start it from the Start menu.
- **Log:** tray icon → **Open log**, or `%LOCALAPPDATA%\AgentMonitor\data\agent.log`.

## Commands

```
AgentMonitor.exe                     install this copy, or open the dashboard of the installed one
AgentMonitor.exe status              list sessions in the console
AgentMonitor.exe pair                show a pairing code and QR code in the console
AgentMonitor.exe stop                stop the running agent
AgentMonitor.exe install [--quiet]   install or update (--quiet: no setup page, no message boxes)
AgentMonitor.exe uninstall [--purge] [--quiet]
AgentMonitor.exe --background        run without a window (what the sign-in shortcut does)
AgentMonitor.exe --foreground        run in this console (Ctrl+C to stop)
```

From source (Node.js 24 or later):

```
npm start              run in this console (Ctrl+C to stop)
npm run start:bg       run in the background
npm run status         list sessions (also: npm run pair, npm run stop)
npm test               run the tests
npm run check          type-check
npm run build          build dist\AgentMonitor.exe
npm run e2e:exe        end-to-end test of dist\AgentMonitor.exe with real actions on fake sessions (about 5 minutes;
                       self-closing Windows Terminal tabs open). npm run e2e does the same from source.
npm run dev            a dry-run copy on ports 17420/17421: sees real sessions, never closes or opens anything
npm run dev:status     list sessions from that copy
```

## Files

| | Installed | From source |
|---|---|---|
| Program | `%LOCALAPPDATA%\Programs\AgentMonitor\AgentMonitor.exe` | this folder |
| Settings and paired phones | `%LOCALAPPDATA%\AgentMonitor\data\state.json` | `data\state.json` |
| Log | `%LOCALAPPDATA%\AgentMonitor\data\agent.log` | `data\agent.log` |
| Configuration (optional) | `%LOCALAPPDATA%\AgentMonitor\config.json` | `config.json` |

The installed copy unpacks its web app, tray script and process helper into `%LOCALAPPDATA%\AgentMonitor\app`.

## Configuration

Copy `config.example.json` to `config.json` (see Files) and change what you need, then restart Agent Monitor. Options:

- `phonePort` / `adminPort` (7420 / 7421), `listenHost` (127.0.0.1)
- `pollIntervalMs` (5000): how often sessions are checked
- `alertDelaySeconds` (30): how long a problem must last before a push
- `staleRetentionHours` (24) / `endedRetentionMinutes` (30): how long gone sessions stay listed
- `claudeCommand` (claude): used when a session's own Claude executable no longer exists
- `tray`, `publicUrl` (empty = ask Tailscale), `vapidSubject`, `dryRun` (plan actions, never close or open anything)
- `defaults`: starting values of the in-app settings (`keepAwake`, `autoReconnect`)
- `paths`: where data and Claude's files are. Relative paths start from `%LOCALAPPDATA%\AgentMonitor` (installed) or
  this folder (from source).

To use another config file, set `AGENT_MONITOR_CONFIG` (that's how `npm run dev` uses `scripts/dev-config.json`).

## How detection works

- **Processes:** `proc-helper.exe` (built from `helper\ProcHelper.cs` with the .NET Framework compiler that ships with
  Windows) lists the `claude.exe` processes with their command line, folder and start time, in a few milliseconds.
- **Claude's session list:** `~/.claude/sessions/<pid>.json` gives each session's status (busy or idle) and whether
  Remote Control is connected. Entries are matched to processes by start time, so a reused process ID can't fool it.
- **Claude app records** (`claude-code-sessions`): titles, whether Remote Control was turned on, and its link.
- **Transcripts** (`~/.claude/projects`): only their file times, to find a session's ID and when it was last active.
  Their content is not read.

Nothing is sent anywhere except push notifications (through Apple's push service) and the app's own traffic over your
tailnet.

## Security

- **PC-only port (7421):** listens on 127.0.0.1 only. It rejects other Host headers (DNS rebinding) and cross-site
  requests, and changes need a custom header.
- **Phone port (7420):** also on 127.0.0.1. `tailscale serve` forwards your tailnet to it over HTTPS. It is never
  published to the internet (that would need `tailscale funnel`, which this project doesn't use).
- **Pairing:** each phone gets a random token for a single-use 6-digit code that expires after 15 minutes. Only a
  SHA-256 hash of the token is stored, and you can remove phones on the Phone setup page.
- **What the phone can do:** only the listed actions (reconnect or resume known sessions, restart or start the Claude
  app) and the settings above. It can never run arbitrary commands.

## Not covered

Codex sessions. On this PC, Codex refuses to start its remote-control daemon ("host Job Object prevents daemon
detachment", [openai/codex#44503](https://github.com/openai/codex/issues/44503)), so there would be nothing to
reconnect.
