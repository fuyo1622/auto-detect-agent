// Stand-in for claude.exe in the Agent Monitor self-test. It records how it was started
// (folder + arguments) next to itself, then just waits. When started with --resume (by the
// agent's Reconnect/Resume, inside Windows Terminal) it exits after 25 s so the tab closes itself.
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

static class FakeClaude
{
    static int Main(string[] args)
    {
        string exe = Process.GetCurrentProcess().MainModule.FileName;
        string line = DateTime.UtcNow.ToString("o") + "\t" + Process.GetCurrentProcess().Id + "\t" + Environment.CurrentDirectory + "\t" + string.Join(" ", args);
        File.AppendAllText(Path.Combine(Path.GetDirectoryName(exe), "launches.txt"), line + Environment.NewLine);
        bool resumed = Array.IndexOf(args, "--resume") >= 0;
        Console.WriteLine("AGENT MONITOR SELF-TEST: fake Claude session, safe to ignore.");
        Console.WriteLine("Started with: " + string.Join(" ", args));
        if (resumed) Console.WriteLine("This tab closes by itself in 25 seconds.");
        Thread.Sleep(resumed ? 25000 : 600000);
        // A normal exit: Claude removes its own entry from ~/.claude/sessions.
        string record = Path.Combine(Path.GetDirectoryName(exe), "..", "claude-home", "sessions", Process.GetCurrentProcess().Id + ".json");
        if (File.Exists(record)) File.Delete(record);
        return 0;
    }
}
