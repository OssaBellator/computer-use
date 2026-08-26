using System.Runtime.InteropServices;

namespace Ossa.ComputerUse.WindowsHost;

/// <summary>
/// Maintains a monotonic sequence for physical/non-injected keyboard and mouse
/// input on the interactive desktop. Agent SendInput events are ignored using
/// the low-level hook injected flags, so a lease can span multiple agent actions
/// without mistaking its own dispatch for human interference.
/// </summary>
internal sealed class HumanInputMonitor : IDisposable
{
    private readonly Thread _thread;
    private readonly TaskCompletionSource<bool> _started = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly NativeMethods.HookProc _keyboardProc;
    private readonly NativeMethods.HookProc _mouseProc;
    private nint _keyboardHook;
    private nint _mouseHook;
    private uint _threadId;
    private long _sequence;
    private int _disposed;

    internal HumanInputMonitor()
    {
        _keyboardProc = KeyboardHook;
        _mouseProc = MouseHook;
        _thread = new Thread(Run)
        {
            IsBackground = true,
            Name = "ossa-computer-use-human-input-monitor",
        };
        _thread.Start();
        _started.Task.GetAwaiter().GetResult();
    }

    internal long Sequence => Interlocked.Read(ref _sequence);

    private void Run()
    {
        try
        {
            _threadId = NativeMethods.GetCurrentThreadId();
            var module = NativeMethods.GetModuleHandleW(null);
            _keyboardHook = NativeMethods.SetWindowsHookExW(NativeMethods.WH_KEYBOARD_LL, _keyboardProc, module, 0);
            if (_keyboardHook == 0) NativeMethods.ThrowLastWin32("set-windows-hook-keyboard");
            _mouseHook = NativeMethods.SetWindowsHookExW(NativeMethods.WH_MOUSE_LL, _mouseProc, module, 0);
            if (_mouseHook == 0) NativeMethods.ThrowLastWin32("set-windows-hook-mouse");
            _started.TrySetResult(true);

            while (true)
            {
                var result = NativeMethods.GetMessageW(out var message, 0, 0, 0);
                if (result == 0) break;
                if (result < 0) NativeMethods.ThrowLastWin32("get-message-human-input");
            }
        }
        catch (Exception error)
        {
            _started.TrySetException(error);
        }
        finally
        {
            if (_mouseHook != 0)
            {
                NativeMethods.UnhookWindowsHookEx(_mouseHook);
                _mouseHook = 0;
            }
            if (_keyboardHook != 0)
            {
                NativeMethods.UnhookWindowsHookEx(_keyboardHook);
                _keyboardHook = 0;
            }
        }
    }

    private nint KeyboardHook(int code, nint wParam, nint lParam)
    {
        if (code == NativeMethods.HC_ACTION && lParam != 0)
        {
            var value = Marshal.PtrToStructure<NativeMethods.KBDLLHOOKSTRUCT>(lParam);
            if ((value.Flags & NativeMethods.LLKHF_INJECTED) == 0)
                Interlocked.Increment(ref _sequence);
        }
        return NativeMethods.CallNextHookEx(_keyboardHook, code, wParam, lParam);
    }

    private nint MouseHook(int code, nint wParam, nint lParam)
    {
        if (code == NativeMethods.HC_ACTION && lParam != 0)
        {
            var value = Marshal.PtrToStructure<NativeMethods.MSLLHOOKSTRUCT>(lParam);
            if ((value.Flags & NativeMethods.LLMHF_INJECTED) == 0)
                Interlocked.Increment(ref _sequence);
        }
        return NativeMethods.CallNextHookEx(_mouseHook, code, wParam, lParam);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        var threadId = Volatile.Read(ref _threadId);
        if (threadId != 0)
            NativeMethods.PostThreadMessageW(threadId, NativeMethods.WM_QUIT, 0, 0);
        _thread.Join();
    }
}
