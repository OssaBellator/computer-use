using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Ossa.ComputerUse.WindowsHost;

internal static class NativeMethods
{
    internal const uint COINIT_MULTITHREADED = 0x0;
    internal const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    internal const uint TOKEN_QUERY = 0x0008;
    internal const int TokenIntegrityLevel = 25;

    internal const uint INPUT_MOUSE = 0;
    internal const uint INPUT_KEYBOARD = 1;
    internal const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    internal const uint KEYEVENTF_KEYUP = 0x0002;
    internal const uint KEYEVENTF_UNICODE = 0x0004;
    internal const uint MOUSEEVENTF_MOVE = 0x0001;
    internal const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    internal const uint MOUSEEVENTF_LEFTUP = 0x0004;
    internal const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    internal const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    internal const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    internal const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    internal const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    internal const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

    internal const int WH_KEYBOARD_LL = 13;
    internal const int WH_MOUSE_LL = 14;
    internal const int HC_ACTION = 0;
    internal const uint LLKHF_INJECTED = 0x10;
    internal const uint LLMHF_INJECTED = 0x01;
    internal const uint WM_QUIT = 0x0012;
    internal const uint PM_NOREMOVE = 0x0000;
    internal const uint GW_OWNER = 4;

    internal const uint D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20;
    internal const uint D3D11_SDK_VERSION = 7;
    internal const int D3D_DRIVER_TYPE_HARDWARE = 1;
    internal const int D3D_DRIVER_TYPE_WARP = 5;

    internal const int SM_XVIRTUALSCREEN = 76;
    internal const int SM_YVIRTUALSCREEN = 77;
    internal const int SM_CXVIRTUALSCREEN = 78;
    internal const int SM_CYVIRTUALSCREEN = 79;

    internal delegate bool EnumWindowsProc(nint hwnd, nint lParam);
    internal delegate nint HookProc(int nCode, nint wParam, nint lParam);

    [DllImport("ole32.dll")]
    internal static extern int CoInitializeEx(nint pvReserved, uint dwCoInit);

    [DllImport("ole32.dll")]
    internal static extern void CoUninitialize();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, nint lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool IsWindowVisible(nint hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    internal static extern int GetWindowTextLengthW(nint hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern int GetWindowTextW(nint hwnd, char[] text, int maxCount);

    [DllImport("user32.dll")]
    internal static extern uint GetWindowThreadProcessId(nint hwnd, out uint processId);

    [DllImport("user32.dll")]
    internal static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    internal static extern nint GetWindow(nint hwnd, uint command);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetWindowRect(nint hwnd, out RECT rect);

    [DllImport("user32.dll")]
    internal static extern uint GetDpiForWindow(nint hwnd);

    [DllImport("user32.dll")]
    internal static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern nint SetWindowsHookExW(int idHook, HookProc callback, nint module, uint threadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool UnhookWindowsHookEx(nint hook);

    [DllImport("user32.dll")]
    internal static extern nint CallNextHookEx(nint hook, int code, nint wParam, nint lParam);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern int GetMessageW(out MSG message, nint hwnd, uint minFilter, uint maxFilter);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool PeekMessageW(out MSG message, nint hwnd, uint minFilter, uint maxFilter, uint removeMessage);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool PostThreadMessageW(uint threadId, uint message, nint wParam, nint lParam);

    [DllImport("kernel32.dll")]
    internal static extern nint GetCurrentProcess();

    [DllImport("kernel32.dll")]
    internal static extern uint GetCurrentThreadId();

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    internal static extern nint GetModuleHandleW(string? moduleName);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern SafeProcessHandle OpenProcess(uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, uint processId);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool OpenProcessToken(nint processHandle, uint desiredAccess, out SafeAccessTokenHandle tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool OpenProcessToken(SafeProcessHandle processHandle, uint desiredAccess, out SafeAccessTokenHandle tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool GetTokenInformation(
        SafeAccessTokenHandle tokenHandle,
        int tokenInformationClass,
        nint tokenInformation,
        int tokenInformationLength,
        out int returnLength);

    [DllImport("advapi32.dll")]
    internal static extern nint GetSidSubAuthorityCount(nint sid);

    [DllImport("advapi32.dll")]
    internal static extern nint GetSidSubAuthority(nint sid, uint subAuthorityIndex);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern uint SendInput(uint inputCount, [In] INPUT[] inputs, int inputSize);

    [DllImport("user32.dll")]
    internal static extern short GetAsyncKeyState(int virtualKey);

    [DllImport("d3d11.dll", CallingConvention = CallingConvention.StdCall)]
    internal static extern int D3D11CreateDevice(
        nint adapter,
        int driverType,
        nint software,
        uint flags,
        nint featureLevels,
        uint featureLevelCount,
        uint sdkVersion,
        out nint device,
        out int featureLevel,
        out nint immediateContext);

    [DllImport("d3d11.dll", CallingConvention = CallingConvention.StdCall)]
    internal static extern int CreateDirect3D11DeviceFromDXGIDevice(
        nint dxgiDevice,
        out nint graphicsDevice);

    internal static void ThrowLastWin32(string operation)
    {
        if (string.IsNullOrWhiteSpace(operation) || operation.Length > 64)
            throw new ProtocolException("win32.operation-invalid");
        var normalized = new string(operation.ToLowerInvariant()
            .Select(c => char.IsAsciiLetterOrDigit(c) ? c : '-')
            .ToArray()).Trim('-');
        if (normalized.Length == 0 || normalized.Length > 64)
            throw new ProtocolException("win32.operation-invalid");
        throw new ProtocolException($"win32.{normalized}.{Marshal.GetLastWin32Error()}");
    }

    [StructLayout(LayoutKind.Sequential)]
    internal readonly struct RECT
    {
        internal readonly int Left;
        internal readonly int Top;
        internal readonly int Right;
        internal readonly int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct POINT
    {
        internal int X;
        internal int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MSG
    {
        internal nint Hwnd;
        internal uint Message;
        internal nuint WParam;
        internal nint LParam;
        internal uint Time;
        internal POINT Point;
        internal uint Private;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct KBDLLHOOKSTRUCT
    {
        internal uint VkCode;
        internal uint ScanCode;
        internal uint Flags;
        internal uint Time;
        internal nuint ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MSLLHOOKSTRUCT
    {
        internal POINT Point;
        internal uint MouseData;
        internal uint Flags;
        internal uint Time;
        internal nuint ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SID_AND_ATTRIBUTES
    {
        internal nint Sid;
        internal uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct TOKEN_MANDATORY_LABEL
    {
        internal SID_AND_ATTRIBUTES Label;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct INPUT
    {
        internal uint type;
        internal INPUTUNION union;
    }

    [StructLayout(LayoutKind.Explicit)]
    internal struct INPUTUNION
    {
        [FieldOffset(0)] internal MOUSEINPUT mouse;
        [FieldOffset(0)] internal KEYBDINPUT keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MOUSEINPUT
    {
        internal int dx;
        internal int dy;
        internal uint mouseData;
        internal uint dwFlags;
        internal uint time;
        internal nuint dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct KEYBDINPUT
    {
        internal ushort wVk;
        internal ushort wScan;
        internal uint dwFlags;
        internal uint time;
        internal nuint dwExtraInfo;
    }
}
