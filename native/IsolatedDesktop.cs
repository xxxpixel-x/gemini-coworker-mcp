using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// No desktop switching. The active desktop continues receiving the user's input.
public static class IsolatedDesktop
{
    public const string Name = "GeminiDesktopMCP";
    private const uint DesktopAccess = 0x00bf; // ordinary desktop rights, excluding SWITCHDESKTOP

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public ushort ShowWindow, ReservedSize;
        public IntPtr ReservedData, Stdin, Stdout, Stderr;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [DllImport("user32", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateDesktop(string name, IntPtr device, IntPtr mode, uint flags, uint access, IntPtr security);
    [DllImport("user32", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
    [DllImport("user32", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32", SetLastError = true)]
    private static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32", SetLastError = true)]
    private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder buffer, uint size, out uint needed);
    [DllImport("user32", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    private delegate bool WindowCallback(IntPtr window, IntPtr context);
    [DllImport("user32", SetLastError = true)]
    private static extern bool EnumDesktopWindows(IntPtr desktop, WindowCallback visit, IntPtr context);
    [DllImport("user32")]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("kernel32")]
    private static extern uint GetCurrentThreadId();
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string image, StringBuilder args, IntPtr processSecurity, IntPtr threadSecurity,
        bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo result);
    [DllImport("kernel32")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32", SetLastError = true)]
    private static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr copy,
        uint access, bool inherit, uint options);
    [DllImport("kernel32", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    private delegate void WinEvent(IntPtr hook, uint evt, IntPtr window, int obj, int child, uint thread, uint time);
    [DllImport("user32", SetLastError = true)]
    private static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr module, WinEvent callback, uint pid, uint tid, uint flags);
    [DllImport("user32")]
    private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32")]
    private static extern IntPtr GetForegroundWindow();
    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr Window;
        public uint Id;
        public UIntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public int X, Y;
        public uint Private;
    }
    [DllImport("user32", CharSet = CharSet.Unicode)]
    private static extern bool PeekMessage(out Message msg, IntPtr window, uint min, uint max, uint remove);
    [DllImport("user32")]
    private static extern bool TranslateMessage(ref Message msg);
    [DllImport("user32", CharSet = CharSet.Unicode)]
    private static extern IntPtr DispatchMessage(ref Message msg);

    private static bool IsGemini(IntPtr window)
    {
        uint pid;
        if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out pid) == 0) return false;
        try {
            using (var process = Process.GetProcessById((int)pid))
                return String.Equals(process.ProcessName, "Gemini", StringComparison.OrdinalIgnoreCase);
        } catch (ArgumentException) { return false; }
    }

    private static string ObjectName(IntPtr handle)
    {
        var name = new StringBuilder(256);
        uint needed;
        if (handle == IntPtr.Zero || !GetUserObjectInformation(handle, 2, name, (uint)name.Capacity * 2, out needed))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return name.ToString();
    }

    public static string InputName()
    {
        IntPtr input = OpenInputDesktop(0, false, 1);
        if (input == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try { return ObjectName(input); }
        finally { CloseDesktop(input); }
    }

    private static void CheckIsolation()
    {
        if (!String.Equals(ObjectName(GetProcessWindowStation()), "WinSta0", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Run in the signed-in user's interactive window station.");
        if (String.Equals(InputName(), Name, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("The agent desktop is receiving user input.");
    }

    public static void AssertWorker()
    {
        CheckIsolation();
        if (ObjectName(GetThreadDesktop(GetCurrentThreadId())) != Name)
            throw new InvalidOperationException("The worker is outside the agent desktop.");
    }

    public static void AssertWindow(IntPtr window)
    {
        AssertWorker();
        uint processId;
        uint thread = GetWindowThreadProcessId(window, out processId);
        if (thread == 0 || ObjectName(GetThreadDesktop(thread)) != Name)
            throw new InvalidOperationException("The Gemini window is outside the agent desktop.");
    }

    public static IntPtr[] Windows(int[] ids)
    {
        AssertWorker();
        var windows = new List<IntPtr>();
        var owners = new HashSet<int>(ids);
        if (!EnumDesktopWindows(GetThreadDesktop(GetCurrentThreadId()), delegate(IntPtr window, IntPtr unused) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owners.Contains((int)owner) && IsWindowVisible(window)) windows.Add(window);
            return true;
        }, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return windows.ToArray();
    }

    private static IntPtr CopyStream(int id)
    {
        IntPtr copy, process = GetCurrentProcess();
        if (!DuplicateHandle(process, GetStdHandle(id), process, out copy, 0, true, 2))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return copy;
    }

    // The UIA client must start on this desktop as well. Moving a running
    // PowerShell STA thread fails if it has already created a window.
    public static uint RunWorker(string script, bool create, bool checkForeground)
    {
        CheckIsolation();
        IntPtr desktop = create ? CreateDesktop(Name, IntPtr.Zero, IntPtr.Zero, 0, DesktopAccess, IntPtr.Zero)
                                : OpenDesktop(Name, 0, false, DesktopAccess);
        if (desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        var startup = new StartupInfo();
        startup.Size = Marshal.SizeOf(startup);
        startup.Desktop = @"WinSta0\" + Name;
        startup.Flags = 0x100; // STARTF_USESTDHANDLES
        ProcessInfo result = new ProcessInfo();
        IntPtr hook = IntPtr.Zero;
        bool sawGemini = false;
        WinEvent onForeground = delegate(IntPtr h, uint evt, IntPtr window, int obj, int child, uint thread, uint time) {
            try { if (IsGemini(window)) sawGemini = true; }
            catch { sawGemini = true; } // An unidentifiable foreground event cannot certify a run.
        };
        try
        {
            if (checkForeground) {
                if (ObjectName(GetThreadDesktop(GetCurrentThreadId())) != InputName())
                    throw new InvalidOperationException("Run the foreground check from the user's active desktop.");
                hook = SetWinEventHook(3, 3, IntPtr.Zero, onForeground, 0, 0, 0); // EVENT_SYSTEM_FOREGROUND
                if (hook == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                sawGemini = IsGemini(GetForegroundWindow());
            }
            string shell = Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            var args = new StringBuilder("\"" + shell + "\" -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File \"" +
                script + "\" -IsolatedWorker");
            startup.Stdin = CopyStream(-10);
            startup.Stdout = CopyStream(-11);
            startup.Stderr = CopyStream(-12);
            if (!CreateProcess(shell, args, IntPtr.Zero, IntPtr.Zero, true, 0x08000000, IntPtr.Zero,
                    Path.GetDirectoryName(script), ref startup, out result))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            uint code, waited;
            do {
                waited = WaitForSingleObject(result.Process, checkForeground ? 40 : UInt32.MaxValue);
                if (checkForeground) {
                    Message msg;
                    while (PeekMessage(out msg, IntPtr.Zero, 0, 0, 1)) {
                        TranslateMessage(ref msg);
                        DispatchMessage(ref msg);
                    }
                }
            } while (waited == 258);
            if (waited != 0 || !GetExitCodeProcess(result.Process, out code))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (checkForeground && (sawGemini || IsGemini(GetForegroundWindow())))
                throw new InvalidOperationException("Gemini acquired foreground on the user's desktop during the check.");
            return code;
        }
        finally
        {
            if (hook != IntPtr.Zero) UnhookWinEvent(hook);
            GC.KeepAlive(onForeground);
            if (result.Thread != IntPtr.Zero) CloseHandle(result.Thread);
            if (result.Process != IntPtr.Zero) CloseHandle(result.Process);
            if (startup.Stdin != IntPtr.Zero) CloseHandle(startup.Stdin);
            if (startup.Stdout != IntPtr.Zero) CloseHandle(startup.Stdout);
            if (startup.Stderr != IntPtr.Zero) CloseHandle(startup.Stderr);
            CloseDesktop(desktop);
        }
    }

    public static uint StartGemini(string image)
    {
        AssertWorker();
        int session = Process.GetCurrentProcess().SessionId;
        foreach (var process in Process.GetProcessesByName("Gemini"))
        {
            using (process)
                if (process.SessionId == session)
                    throw new InvalidOperationException("Gemini is already running. A second launch may activate its existing window.");
        }
        var startup = new StartupInfo();
        startup.Size = Marshal.SizeOf(startup);
        startup.Desktop = @"WinSta0\" + Name;
        ProcessInfo result;
        if (!CreateProcess(image, new StringBuilder("\"" + image + "\""), IntPtr.Zero, IntPtr.Zero,
                false, 0, IntPtr.Zero, Path.GetDirectoryName(image), ref startup, out result))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        CloseHandle(result.Thread);
        CloseHandle(result.Process);
        return result.ProcessId;
    }
}
