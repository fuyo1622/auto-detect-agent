// proc-helper: fast process snapshots for auto-detect-agent.
//
// Reads one command per line on stdin and answers with one JSON line on stdout:
//   ping                  -> {"ok":true}
//   snap <a.exe,b.exe>    -> every process with one of those image names: pid, ppid, name,
//                            start time, command line, executable path and working directory
//   awake <0|1>           -> keep the PC from idle-sleeping (1) or release it (0)
//   exit
// Output is pure ASCII (everything else is \u-escaped) so console code pages never matter.
// The helper exits when stdin closes, so it never outlives the agent.
//
// Built with the C# 5 compiler that ships with .NET Framework (no newer syntax on purpose).
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

static class ProcHelper
{
    const uint TH32CS_SNAPPROCESS = 0x00000002;
    const uint PROCESS_QUERY_INFORMATION = 0x0400;
    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint PROCESS_VM_READ = 0x0010;
    const uint ES_CONTINUOUS = 0x80000000;
    const uint ES_SYSTEM_REQUIRED = 0x00000001;
    const int ProcessBasicInformation = 0;
    const int ProcessCommandLineInformation = 60;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsWow64Process(IntPtr process, out bool wow64);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
    [DllImport("kernel32.dll")]
    static extern uint SetThreadExecutionState(uint flags);
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref PROCESS_BASIC_INFORMATION info, int length, out int returned);
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr info, int length, out int returned);

    class Entry
    {
        public uint Pid;
        public uint Ppid;
        public string Name;
    }

    static int Main()
    {
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            if (line == "exit") break;
            string reply;
            try
            {
                if (line == "ping") reply = "{\"ok\":true}";
                else if (line == "snap" || line.StartsWith("snap ")) reply = Snap(line.Length > 5 ? line.Substring(5) : "");
                else if (line.StartsWith("awake ")) reply = Awake(line.EndsWith("1"));
                else reply = "{\"ok\":false,\"error\":\"unknown command\"}";
            }
            catch (Exception ex)
            {
                StringBuilder sb = new StringBuilder("{\"ok\":false,\"error\":");
                Str(sb, ex.Message);
                reply = sb.Append('}').ToString();
            }
            Console.Out.WriteLine(reply);
            Console.Out.Flush();
        }
        SetThreadExecutionState(ES_CONTINUOUS);
        return 0;
    }

    static string Awake(bool on)
    {
        uint flags = ES_CONTINUOUS | (on ? ES_SYSTEM_REQUIRED : 0);
        uint previous = SetThreadExecutionState(flags);
        return "{\"ok\":" + (previous != 0 ? "true" : "false") + "}";
    }

    static string Snap(string namesArg)
    {
        HashSet<string> names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string n in namesArg.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries)) names.Add(n.Trim());

        List<Entry> found = new List<Entry>();
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1)) throw new Win32Exception();
        try
        {
            PROCESSENTRY32W e = new PROCESSENTRY32W();
            e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
            if (Process32FirstW(snapshot, ref e))
            {
                do
                {
                    if (e.th32ProcessID == 0 || !names.Contains(e.szExeFile)) continue;
                    Entry x = new Entry();
                    x.Pid = e.th32ProcessID;
                    x.Ppid = e.th32ParentProcessID;
                    x.Name = e.szExeFile;
                    found.Add(x);
                } while (Process32NextW(snapshot, ref e));
            }
        }
        finally { CloseHandle(snapshot); }

        StringBuilder sb = new StringBuilder(16384);
        sb.Append("{\"ok\":true,\"now\":").Append(NowMs()).Append(",\"procs\":[");
        for (int i = 0; i < found.Count; i++)
        {
            if (i > 0) sb.Append(',');
            Describe(sb, found[i]);
        }
        return sb.Append("]}").ToString();
    }

    static void Describe(StringBuilder sb, Entry x)
    {
        sb.Append("{\"pid\":").Append(x.Pid).Append(",\"ppid\":").Append(x.Ppid).Append(",\"name\":");
        Str(sb, x.Name);

        bool canRead = true;
        IntPtr h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, x.Pid);
        if (h == IntPtr.Zero)
        {
            canRead = false;
            h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, x.Pid);
        }
        if (h != IntPtr.Zero)
        {
            try
            {
                long creation, exit, kernel, user;
                if (GetProcessTimes(h, out creation, out exit, out kernel, out user)) sb.Append(",\"startFt\":\"").Append(creation).Append('"');
                string cmd = CommandLine(h);
                if (cmd != null) { sb.Append(",\"cmd\":"); Str(sb, cmd); }
                StringBuilder path = new StringBuilder(1024);
                uint size = (uint)path.Capacity;
                if (QueryFullProcessImageNameW(h, 0, path, ref size)) { sb.Append(",\"exe\":"); Str(sb, path.ToString()); }
                if (canRead)
                {
                    string cwd = CurrentDirectory(h);
                    if (cwd != null) { sb.Append(",\"cwd\":"); Str(sb, cwd); }
                }
            }
            finally { CloseHandle(h); }
        }
        sb.Append('}');
    }

    static string CommandLine(IntPtr h)
    {
        int length;
        NtQueryInformationProcess(h, ProcessCommandLineInformation, IntPtr.Zero, 0, out length);
        if (length <= 0 || length > (1 << 20)) return null;
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            int returned;
            if (NtQueryInformationProcess(h, ProcessCommandLineInformation, buffer, length, out returned) != 0) return null;
            int byteLength = (ushort)Marshal.ReadInt16(buffer);
            IntPtr text = Marshal.ReadIntPtr(buffer, IntPtr.Size);
            if (text == IntPtr.Zero || byteLength == 0) return "";
            return Marshal.PtrToStringUni(text, byteLength / 2);
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    // PEB -> RTL_USER_PROCESS_PARAMETERS -> CurrentDirectory.DosPath (x64 layout only).
    static string CurrentDirectory(IntPtr h)
    {
        if (IntPtr.Size != 8) return null;
        bool wow64;
        if (IsWow64Process(h, out wow64) && wow64) return null;
        PROCESS_BASIC_INFORMATION pbi = new PROCESS_BASIC_INFORMATION();
        int returned;
        if (NtQueryInformationProcess(h, ProcessBasicInformation, ref pbi, Marshal.SizeOf(pbi), out returned) != 0) return null;
        if (pbi.PebBaseAddress == IntPtr.Zero) return null;

        byte[] pointer = new byte[8];
        if (!Read(h, new IntPtr(pbi.PebBaseAddress.ToInt64() + 0x20), pointer)) return null;
        long parameters = BitConverter.ToInt64(pointer, 0);
        if (parameters == 0) return null;

        byte[] unicodeString = new byte[16];
        if (!Read(h, new IntPtr(parameters + 0x38), unicodeString)) return null;
        int length = BitConverter.ToUInt16(unicodeString, 0);
        long text = BitConverter.ToInt64(unicodeString, 8);
        if (length == 0 || text == 0) return null;

        byte[] chars = new byte[length];
        if (!Read(h, new IntPtr(text), chars)) return null;
        string dir = Encoding.Unicode.GetString(chars);
        if (dir.Length > 3 && dir.EndsWith("\\")) dir = dir.Substring(0, dir.Length - 1);
        return dir;
    }

    static bool Read(IntPtr h, IntPtr address, byte[] buffer)
    {
        IntPtr read;
        return ReadProcessMemory(h, address, buffer, new IntPtr(buffer.Length), out read) && read.ToInt64() == buffer.Length;
    }

    static long NowMs()
    {
        return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
    }

    static void Str(StringBuilder sb, string s)
    {
        sb.Append('"');
        if (s != null)
        {
            foreach (char c in s)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < 0x20 || c > 0x7e) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
        }
        sb.Append('"');
    }
}
