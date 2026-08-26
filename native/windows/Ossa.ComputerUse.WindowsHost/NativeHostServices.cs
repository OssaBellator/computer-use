using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Ossa.ComputerUse.WindowsHost;

internal sealed class NativeHostServices
{
    internal object Hello(MtaExecutor mta) => new
    {
        protocol = 1,
        host = "ossa-computer-use-windows-host",
        apartment = "mta",
        threadToken = mta.ThreadToken,
    };

    internal object ListWindows(WindowListRequest request)
    {
        if (request.MaxItems < 1 || request.MaxItems > 10_000 || request.MaxTextBytes < 1 || request.MaxTextBytes > 1_000_000)
        {
            throw new ProtocolException("windows.enumeration-limits-invalid");
        }

        var foreground = NativeMethods.GetForegroundWindow();
        var windows = new List<object>();
        var textBytes = 0;
        var truncated = false;

        NativeMethods.EnumWindows((hwnd, _) =>
        {
            if (!NativeMethods.IsWindowVisible(hwnd))
            {
                return true;
            }
            if (windows.Count >= request.MaxItems)
            {
                truncated = true;
                return false;
            }

            NativeMethods.GetWindowThreadProcessId(hwnd, out var pid);
            if (pid == 0)
            {
                return true;
            }

            string startIdentity;
            try
            {
                using var process = Process.GetProcessById(checked((int)pid));
                startIdentity = process.StartTime.ToUniversalTime().ToString("O");
            }
            catch
            {
                return true;
            }

            var title = ReadWindowText(hwnd);
            var titleBytes = System.Text.Encoding.UTF8.GetByteCount(title);
            if (textBytes + titleBytes > request.MaxTextBytes)
            {
                truncated = true;
                return false;
            }
            textBytes += titleBytes;

            NativeMethods.GetWindowRect(hwnd, out var rect);
            windows.Add(new
            {
                window = new
                {
                    hwnd = $"0x{hwnd.ToInt64():x}",
                    desktopSessionId = $"session:{Process.GetCurrentProcess().SessionId}",
                    process = new { processId = checked((int)pid), startIdentity },
                    generation = 0,
                },
                title,
                foreground = hwnd == foreground,
                bounds = new
                {
                    x = rect.Left,
                    y = rect.Top,
                    width = Math.Max(0, rect.Right - rect.Left),
                    height = Math.Max(0, rect.Bottom - rect.Top),
                },
            });
            return true;
        }, 0);

        return new { windows, truncated, itemCount = windows.Count, textBytes };
    }

    internal object ReadCurrentIntegrity()
    {
        if (!NativeMethods.OpenProcessToken(NativeMethods.GetCurrentProcess(), NativeMethods.TOKEN_QUERY, out var token))
        {
            NativeMethods.ThrowLastWin32("OpenProcessToken(current)");
        }
        using (token)
        {
            return new { rid = ReadIntegrityRid(token) };
        }
    }

    internal object ReadProcessIntegrity(IntegrityProcessRequest request)
    {
        ValidateProcessGeneration(request.Process);
        using var process = NativeMethods.OpenProcess(
            NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            checked((uint)request.Process.ProcessId));
        if (process.IsInvalid)
        {
            NativeMethods.ThrowLastWin32("OpenProcess");
        }

        ValidateProcessGeneration(request.Process);
        if (!NativeMethods.OpenProcessToken(process, NativeMethods.TOKEN_QUERY, out var token))
        {
            NativeMethods.ThrowLastWin32("OpenProcessToken(target)");
        }
        using (token)
        {
            var rid = ReadIntegrityRid(token);
            ValidateProcessGeneration(request.Process);
            return new { rid };
        }
    }

    internal object SendInput(SendInputRequest request)
    {
        if (request.Events is null || request.Events.Length < 1 || request.Events.Length > 4_096)
        {
            throw new ProtocolException("input.event-count-invalid");
        }

        var inputs = new NativeMethods.INPUT[request.Events.Length];
        for (var index = 0; index < request.Events.Length; index++)
        {
            inputs[index] = CompileInput(request.Events[index]);
        }

        var inserted = NativeMethods.SendInput(
            checked((uint)inputs.Length),
            inputs,
            Marshal.SizeOf<NativeMethods.INPUT>());
        return new { insertedEventCount = inserted };
    }

    private static NativeMethods.INPUT CompileInput(SendInputEventDto value)
    {
        return value.Kind switch
        {
            "keyboard-vk" => KeyboardVirtualKey(value),
            "keyboard-unicode" => KeyboardUnicode(value),
            "mouse-absolute-move" => MouseAbsolute(value),
            "mouse-relative-move" => MouseRelative(value),
            "mouse-button" => MouseButton(value),
            _ => throw new ProtocolException("input.event-kind-invalid"),
        };
    }

    private static NativeMethods.INPUT KeyboardVirtualKey(SendInputEventDto value)
    {
        if (value.VirtualKey is < 1 or > 255 || value.KeyUp is null || value.Extended is null)
        {
            throw new ProtocolException("input.keyboard-vk-invalid");
        }
        var flags = (value.KeyUp.Value ? NativeMethods.KEYEVENTF_KEYUP : 0u)
                    | (value.Extended.Value ? NativeMethods.KEYEVENTF_EXTENDEDKEY : 0u);
        return new NativeMethods.INPUT
        {
            type = NativeMethods.INPUT_KEYBOARD,
            union = new NativeMethods.INPUTUNION
            {
                keyboard = new NativeMethods.KEYBDINPUT
                {
                    wVk = checked((ushort)value.VirtualKey.Value),
                    wScan = 0,
                    dwFlags = flags,
                },
            },
        };
    }

    private static NativeMethods.INPUT KeyboardUnicode(SendInputEventDto value)
    {
        if (value.CodeUnit is < 1 or > 0xffff || value.KeyUp is null)
        {
            throw new ProtocolException("input.keyboard-unicode-invalid");
        }
        var flags = NativeMethods.KEYEVENTF_UNICODE | (value.KeyUp.Value ? NativeMethods.KEYEVENTF_KEYUP : 0u);
        return new NativeMethods.INPUT
        {
            type = NativeMethods.INPUT_KEYBOARD,
            union = new NativeMethods.INPUTUNION
            {
                keyboard = new NativeMethods.KEYBDINPUT
                {
                    wVk = 0,
                    wScan = checked((ushort)value.CodeUnit.Value),
                    dwFlags = flags,
                },
            },
        };
    }

    private static NativeMethods.INPUT MouseAbsolute(SendInputEventDto value)
    {
        if (value.NormalizedX is < 0 or > 65_535 || value.NormalizedY is < 0 or > 65_535 || value.VirtualDesktop is not true)
        {
            throw new ProtocolException("input.mouse-absolute-invalid");
        }
        return new NativeMethods.INPUT
        {
            type = NativeMethods.INPUT_MOUSE,
            union = new NativeMethods.INPUTUNION
            {
                mouse = new NativeMethods.MOUSEINPUT
                {
                    dx = value.NormalizedX.Value,
                    dy = value.NormalizedY.Value,
                    dwFlags = NativeMethods.MOUSEEVENTF_MOVE | NativeMethods.MOUSEEVENTF_ABSOLUTE | NativeMethods.MOUSEEVENTF_VIRTUALDESK,
                },
            },
        };
    }

    private static NativeMethods.INPUT MouseRelative(SendInputEventDto value)
    {
        if (value.Dx is null || value.Dy is null || Math.Abs((long)value.Dx.Value) > 100_000 || Math.Abs((long)value.Dy.Value) > 100_000)
        {
            throw new ProtocolException("input.mouse-relative-invalid");
        }
        return new NativeMethods.INPUT
        {
            type = NativeMethods.INPUT_MOUSE,
            union = new NativeMethods.INPUTUNION
            {
                mouse = new NativeMethods.MOUSEINPUT
                {
                    dx = value.Dx.Value,
                    dy = value.Dy.Value,
                    dwFlags = NativeMethods.MOUSEEVENTF_MOVE,
                },
            },
        };
    }

    private static NativeMethods.INPUT MouseButton(SendInputEventDto value)
    {
        if (value.Button is not ("left" or "middle" or "right") || value.KeyUp is null)
        {
            throw new ProtocolException("input.mouse-button-invalid");
        }
        var flags = (value.Button, value.KeyUp.Value) switch
        {
            ("left", false) => NativeMethods.MOUSEEVENTF_LEFTDOWN,
            ("left", true) => NativeMethods.MOUSEEVENTF_LEFTUP,
            ("middle", false) => NativeMethods.MOUSEEVENTF_MIDDLEDOWN,
            ("middle", true) => NativeMethods.MOUSEEVENTF_MIDDLEUP,
            ("right", false) => NativeMethods.MOUSEEVENTF_RIGHTDOWN,
            ("right", true) => NativeMethods.MOUSEEVENTF_RIGHTUP,
            _ => throw new ProtocolException("input.mouse-button-invalid"),
        };
        return new NativeMethods.INPUT
        {
            type = NativeMethods.INPUT_MOUSE,
            union = new NativeMethods.INPUTUNION
            {
                mouse = new NativeMethods.MOUSEINPUT { dwFlags = flags },
            },
        };
    }

    private static uint ReadIntegrityRid(SafeAccessTokenHandle token)
    {
        NativeMethods.GetTokenInformation(token, NativeMethods.TokenIntegrityLevel, 0, 0, out var required);
        if (required <= 0 || required > 65_536)
        {
            throw new ProtocolException("integrity.token-buffer-invalid");
        }
        var buffer = Marshal.AllocHGlobal(required);
        try
        {
            if (!NativeMethods.GetTokenInformation(token, NativeMethods.TokenIntegrityLevel, buffer, required, out _))
            {
                NativeMethods.ThrowLastWin32("GetTokenInformation(TokenIntegrityLevel)");
            }
            var label = Marshal.PtrToStructure<NativeMethods.TOKEN_MANDATORY_LABEL>(buffer);
            if (label.Label.Sid == 0)
            {
                throw new ProtocolException("integrity.sid-invalid");
            }
            var countPointer = NativeMethods.GetSidSubAuthorityCount(label.Label.Sid);
            if (countPointer == 0)
            {
                throw new ProtocolException("integrity.sid-invalid");
            }
            var count = Marshal.ReadByte(countPointer);
            if (count == 0)
            {
                throw new ProtocolException("integrity.sid-invalid");
            }
            var ridPointer = NativeMethods.GetSidSubAuthority(label.Label.Sid, checked((uint)(count - 1)));
            if (ridPointer == 0)
            {
                throw new ProtocolException("integrity.sid-invalid");
            }
            return unchecked((uint)Marshal.ReadInt32(ridPointer));
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    internal static void ValidateProcessGeneration(ProcessGenerationDto expected)
    {
        if (expected.ProcessId <= 0 || string.IsNullOrWhiteSpace(expected.StartIdentity) || expected.StartIdentity.Length > 256)
        {
            throw new ProtocolException("process.generation-invalid");
        }
        try
        {
            using var process = Process.GetProcessById(expected.ProcessId);
            var actual = process.StartTime.ToUniversalTime().ToString("O");
            if (!StringComparer.Ordinal.Equals(actual, expected.StartIdentity))
            {
                throw new ProtocolException("process.generation-mismatch");
            }
        }
        catch (ProtocolException)
        {
            throw;
        }
        catch
        {
            throw new ProtocolException("process.generation-missing");
        }
    }

    private static string ReadWindowText(nint hwnd)
    {
        var length = Math.Clamp(NativeMethods.GetWindowTextLengthW(hwnd), 0, 4_096);
        if (length == 0)
        {
            return string.Empty;
        }
        var buffer = new char[length + 1];
        var copied = NativeMethods.GetWindowTextW(hwnd, buffer, buffer.Length);
        return copied > 0 ? new string(buffer, 0, copied) : string.Empty;
    }
}
