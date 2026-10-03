using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

internal static class Program
{
    private const int WsOverlappedWindow = 0x00CF0000;
    private const int WsVisible = 0x10000000;
    private const int WsChild = 0x40000000;
    private const int WsTabStop = 0x00010000;
    private const int EsAutoHScroll = 0x0080;
    private const int BsPushButton = 0x00000000;
    private const int BsAutoCheckBox = 0x00000003;
    private const int SwShow = 5;
    private const int WmDestroy = 0x0002;
    private const int WmClose = 0x0010;
    private const int WmCommand = 0x0111;
    private const int BnClicked = 0;
    private const int IdApply = 1001;
    private const int IdToggle = 1002;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WndClass
    {
        public uint Style;
        public nint WndProc;
        public int ClsExtra;
        public int WndExtra;
        public nint Instance;
        public nint Icon;
        public nint Cursor;
        public nint Background;
        public string? MenuName;
        public string ClassName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Msg
    {
        public nint Hwnd;
        public uint Message;
        public nuint WParam;
        public nint LParam;
        public uint Time;
        public int X;
        public int Y;
    }

    private sealed class WindowState
    {
        public required nint Edit { get; init; }
        public required nint Result { get; init; }
    }

    private delegate nint WndProcDelegate(nint hwnd, uint message, nuint wParam, nint lParam);
    private static readonly WndProcDelegate WndProc = WindowProc;
    private static readonly Dictionary<nint, WindowState> States = new();

    [STAThread]
    private static void Main()
    {
        var instance = GetModuleHandleW(null);
        var className = "OssaNativeWin32Smoke";
        var wc = new WndClass
        {
            Instance = instance,
            ClassName = className,
            WndProc = Marshal.GetFunctionPointerForDelegate(WndProc),
            Background = (nint)6,
        };
        if (RegisterClassW(ref wc) == 0) ThrowLastWin32("RegisterClassW");

        var hwnd = CreateWindowExW(0, className, "Ossa Native Win32 UI Smoke", WsOverlappedWindow | WsVisible,
            100, 100, 560, 320, 0, 0, instance, 0);
        if (hwnd == 0) ThrowLastWin32("CreateWindowExW(root)");

        var edit = CreateWindowExW(0, "EDIT", "", WsChild | WsVisible | WsTabStop | EsAutoHScroll,
            24, 24, 430, 30, hwnd, 0, instance, 0);
        var apply = CreateWindowExW(0, "BUTTON", "Apply", WsChild | WsVisible | WsTabStop | BsPushButton,
            24, 70, 120, 32, hwnd, IdApply, instance, 0);
        var toggle = CreateWindowExW(0, "BUTTON", "Enabled", WsChild | WsVisible | WsTabStop | BsAutoCheckBox,
            24, 118, 140, 30, hwnd, IdToggle, instance, 0);
        var result = CreateWindowExW(0, "STATIC", "RESULT:pending", WsChild | WsVisible,
            24, 166, 430, 30, hwnd, 0, instance, 0);
        if (edit == 0 || apply == 0 || toggle == 0 || result == 0) ThrowLastWin32("CreateWindowExW(child)");

        States[hwnd] = new WindowState { Edit = edit, Result = result };
        ShowWindow(hwnd, SwShow);
        UpdateWindow(hwnd);

        var worker = new Thread(() => RunSemanticTasks(hwnd, edit, apply, toggle, result));
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();

        while (GetMessageW(out var msg, 0, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessageW(ref msg);
        }
    }

    private static void RunSemanticTasks(nint hwnd, nint editHwnd, nint applyHwnd, nint toggleHwnd, nint resultHwnd)
    {
        try
        {
            Thread.Sleep(200);
            var root = AutomationElement.FromHandle(hwnd);
            var edit = AutomationElement.FromHandle(editHwnd);
            var apply = AutomationElement.FromHandle(applyHwnd);
            var toggle = AutomationElement.FromHandle(toggleHwnd);

            var hasValue = edit.TryGetCurrentPattern(ValuePattern.Pattern, out var rawValue);
            var hasInvoke = apply.TryGetCurrentPattern(InvokePattern.Pattern, out var rawInvoke);
            var hasToggle = toggle.TryGetCurrentPattern(TogglePattern.Pattern, out var rawToggle);
            var hasWindow = root.TryGetCurrentPattern(WindowPattern.Pattern, out var rawWindow);
            Console.WriteLine($"WIN32_PATTERNS=value:{hasValue}:invoke:{hasInvoke}:toggle:{hasToggle}:window:{hasWindow}");
            if (!(hasValue && hasInvoke && hasToggle && hasWindow))
            {
                Console.WriteLine("WIN32_STATUS=pattern-unavailable");
                Environment.ExitCode = 4;
                return;
            }

            ((ValuePattern)rawValue!).SetValue("WIN32-SEMANTIC-TASK");
            ((InvokePattern)rawInvoke!).Invoke();
            Thread.Sleep(150);
            var editVerify = AutomationElement.FromHandle(editHwnd);
            var resultVerify = AutomationElement.FromHandle(resultHwnd);
            var textValue = editVerify.TryGetCurrentPattern(ValuePattern.Pattern, out var verifyValue)
                ? ((ValuePattern)verifyValue).Current.Value
                : null;
            var resultValue = resultVerify.Current.Name;
            var textPassed = textValue == "WIN32-SEMANTIC-TASK" && resultValue == "RESULT:WIN32-SEMANTIC-TASK";
            Console.WriteLine($"WIN32_TEXT_BUTTON={(textPassed ? "pass" : "fail")}:value={textValue}:result={resultValue}");

            ((TogglePattern)rawToggle!).Toggle();
            Thread.Sleep(100);
            var toggleVerify = AutomationElement.FromHandle(toggleHwnd);
            var togglePassed = toggleVerify.TryGetCurrentPattern(TogglePattern.Pattern, out var verifyToggle)
                && ((TogglePattern)verifyToggle).Current.ToggleState == ToggleState.On;
            Console.WriteLine($"WIN32_TOGGLE={(togglePassed ? "pass" : "fail")}");

            var windowPattern = (WindowPattern)rawWindow!;
            windowPattern.SetWindowVisualState(WindowVisualState.Minimized);
            Thread.Sleep(100);
            var minimized = windowPattern.Current.WindowVisualState == WindowVisualState.Minimized;
            windowPattern.SetWindowVisualState(WindowVisualState.Normal);
            Thread.Sleep(100);
            var restored = windowPattern.Current.WindowVisualState == WindowVisualState.Normal;
            var windowPassed = minimized && restored;
            Console.WriteLine($"WIN32_WINDOW={(windowPassed ? "pass" : "fail")}:minimized={minimized}:restored={restored}");

            var allPassed = textPassed && togglePassed && windowPassed;
            Console.WriteLine(allPassed ? "WIN32_STATUS=completed" : "WIN32_STATUS=verification-mismatch");
            Environment.ExitCode = allPassed ? 0 : 5;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"WIN32_STATUS=blocked:{ex.GetType().Name}:0x{ex.HResult:X8}");
            Environment.ExitCode = 2;
        }
        finally
        {
            PostMessageW(hwnd, WmClose, 0, 0);
        }
    }

    private static nint WindowProc(nint hwnd, uint message, nuint wParam, nint lParam)
    {
        if (message == WmCommand && States.TryGetValue(hwnd, out var state))
        {
            var id = (int)(wParam & 0xffff);
            var code = (int)((wParam >> 16) & 0xffff);
            if (id == IdApply && code == BnClicked)
            {
                SetWindowTextW(state.Result, "RESULT:" + ReadWindowText(state.Edit));
                return 0;
            }
        }
        if (message == WmDestroy)
        {
            States.Remove(hwnd);
            PostQuitMessage(0);
            return 0;
        }
        return DefWindowProcW(hwnd, message, wParam, lParam);
    }

    private static string ReadWindowText(nint hwnd)
    {
        var length = GetWindowTextLengthW(hwnd);
        var builder = new StringBuilder(length + 1);
        GetWindowTextW(hwnd, builder, builder.Capacity);
        return builder.ToString();
    }

    private static void ThrowLastWin32(string operation) => throw new InvalidOperationException($"{operation}:{Marshal.GetLastWin32Error()}");

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern nint GetModuleHandleW(string? moduleName);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern ushort RegisterClassW(ref WndClass wndClass);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern nint CreateWindowExW(int exStyle, string className, string windowName, int style, int x, int y, int width, int height, nint parent, nint menu, nint instance, nint parameter);
    [DllImport("user32.dll")] private static extern bool ShowWindow(nint hwnd, int command);
    [DllImport("user32.dll")] private static extern bool UpdateWindow(nint hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetMessageW(out Msg msg, nint hwnd, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Msg msg);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern nint DispatchMessageW(ref Msg msg);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern nint DefWindowProcW(nint hwnd, uint message, nuint wParam, nint lParam);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int exitCode);
    [DllImport("user32.dll")] private static extern bool PostMessageW(nint hwnd, uint message, nuint wParam, nint lParam);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(nint hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool SetWindowTextW(nint hwnd, string text);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLengthW(nint hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(nint hwnd, StringBuilder builder, int maxCount);
}
