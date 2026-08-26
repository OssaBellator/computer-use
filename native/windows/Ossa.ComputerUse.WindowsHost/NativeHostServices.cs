using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Ossa.ComputerUse.WindowsHost;

internal sealed class NativeHostServices
{
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
        if (request.Events is null || request.Events.Length is < 1 or > 4_096)
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

    private static NativeMethods.INPUT CompileInput(SendInputEventDto value) => value.Kind switch
    {
        "keyboard-vk" => KeyboardVirtualKey(value),
        "keyboard-unicode" => KeyboardUnicode(value),
        "mouse-absolute-move" => MouseAbsolute(value),
        "mouse-relative-move" => MouseRelative(value),
        "mouse-button" => MouseButton(value),
        _ => throw new ProtocolException("input.event-kind-invalid"),
    };

    private static NativeMethods.INPUT KeyboardVirtualKey(SendInputEventDto value)
    {
        var virtualKey = value.VirtualKey ?? throw new ProtocolException("input.keyboard-vk-invalid");
        var keyUp = value.KeyUp ?? throw new ProtocolException("input.keyboard-vk-invalid");
        var extended = value.Extended ?? throw new ProtocolException("input.keyboard-vk-invalid");
        if (virtualKey is < 1 or > 255) throw new ProtocolException("input.keyboard-vk-invalid");

        var flags = (keyUp ? NativeMethods.KEYEVENTF_KEYUP : 0u)
                    | (extended ? NativeMethods.KEYEVENTF_EXTENDEDKEY : 0u);
        return new NativeMethods.INPUT
        {
            type = NativeMethods.INPUT_KEYBOARD,
            union = new NativeMethods.INPUTUNION
            {
                keyboard = new NativeMethods.KEYBDINPUT
                {
                    wVk = checked((ushort)virtualKey),
                    wScan = 0,
                    dwFlags = flags,
                },
            },
        };
    }

    private static NativeMethods.INPUT KeyboardUnicode(SendInputEventDto value)
    {
        var codeUnit = value.CodeUnit ?? throw new ProtocolException("input.keyboard-unicode-invalid");
        var keyUp = value.KeyUp ?? throw new ProtocolException("input.keyboard-unicode-invalid");
        if (codeUnit is < 1 or > 0xffff) throw new ProtocolException("input.keyboard-unicode-invalid");

        var flags = NativeMethods.KEYEVENTF_UNICODE | (keyUp ? NativeMethods.KEYEVENTF_KEYUP : 0u);
        return new NativeMethods.INPUT
        {
            type = NativeMethods.INPUT_KEYBOARD,
            union = new NativeMethods.INPUTUNION
            {
                keyboard = new NativeMethods.KEYBDINPUT
                {
                    wVk = 0,
                    wScan = checked((ushort)codeUnit),
                    dwFlags = flags,
                },
            },
        };
    }

    private static NativeMethods.INPUT MouseAbsolute(SendInputEventDto value)
    {
        var x = value.NormalizedX ?? throw new ProtocolException("input.mouse-absolute-invalid");
        var y = value.NormalizedY ?? throw new ProtocolException("input.mouse-absolute-invalid");
        if (x is < 0 or > 65_535 || y is < 0 or > 65_535 || value.VirtualDesktop is not true)
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
                    dx = x,
                    dy = y,
                    dwFlags = NativeMethods.MOUSEEVENTF_MOVE | NativeMethods.MOUSEEVENTF_ABSOLUTE | NativeMethods.MOUSEEVENTF_VIRTUALDESK,
                },
            },
        };
    }

    private static NativeMethods.INPUT MouseRelative(SendInputEventDto value)
    {
        var dx = value.Dx ?? throw new ProtocolException("input.mouse-relative-invalid");
        var dy = value.Dy ?? throw new ProtocolException("input.mouse-relative-invalid");
        if (Math.Abs((long)dx) > 100_000 || Math.Abs((long)dy) > 100_000)
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
                    dx = dx,
                    dy = dy,
                    dwFlags = NativeMethods.MOUSEEVENTF_MOVE,
                },
            },
        };
    }

    private static NativeMethods.INPUT MouseButton(SendInputEventDto value)
    {
        var keyUp = value.KeyUp ?? throw new ProtocolException("input.mouse-button-invalid");
        if (value.Button is not ("left" or "middle" or "right"))
        {
            throw new ProtocolException("input.mouse-button-invalid");
        }
        var flags = (value.Button, keyUp) switch
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
            if (label.Label.Sid == 0) throw new ProtocolException("integrity.sid-invalid");
            var countPointer = NativeMethods.GetSidSubAuthorityCount(label.Label.Sid);
            if (countPointer == 0) throw new ProtocolException("integrity.sid-invalid");
            var count = Marshal.ReadByte(countPointer);
            if (count == 0) throw new ProtocolException("integrity.sid-invalid");
            var ridPointer = NativeMethods.GetSidSubAuthority(label.Label.Sid, checked((uint)(count - 1)));
            if (ridPointer == 0) throw new ProtocolException("integrity.sid-invalid");
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
}
