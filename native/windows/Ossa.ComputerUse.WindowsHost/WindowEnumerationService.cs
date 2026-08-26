using System.Diagnostics;
using System.Text;
using System.Windows.Automation;

namespace Ossa.ComputerUse.WindowsHost;

internal sealed class WindowEnumerationService
{
    private sealed record Identity(AutomationElement Element, long Generation);
    private readonly Dictionary<string, Identity> _identities = new(StringComparer.Ordinal);

    internal object List(WindowListRequest request)
    {
        if (request.MaxItems is < 1 or > 10_000 || request.MaxTextBytes is < 1 or > 1_000_000)
            throw new ProtocolException("windows.enumeration-limits-invalid");

        var foreground = NativeMethods.GetForegroundWindow();
        var sessionId = Process.GetCurrentProcess().SessionId;
        var windows = new List<object>();
        var textBytes = 0;
        var truncated = false;

        if (!NativeMethods.EnumWindows((hwnd, _) =>
        {
            if (!NativeMethods.IsWindowVisible(hwnd)) return true;
            if (windows.Count >= request.MaxItems) { truncated = true; return false; }

            NativeMethods.GetWindowThreadProcessId(hwnd, out var pidRaw);
            if (pidRaw == 0 || pidRaw > int.MaxValue) return true;
            var pid = (int)pidRaw;

            string startIdentity;
            try
            {
                using var process = Process.GetProcessById(pid);
                startIdentity = process.StartTime.ToUniversalTime().ToString("O");
            }
            catch { return true; }

            AutomationElement element;
            try { element = AutomationElement.FromHandle(hwnd); }
            catch (ElementNotAvailableException) { return true; }
            catch (InvalidOperationException) { return true; }

            var key = $"session:{sessionId}:{hwnd.ToInt64():x}:{pid}:{startIdentity}";
            var generation = Generation(key, element);
            var title = ReadWindowText(hwnd);
            var bytes = Encoding.UTF8.GetByteCount(title);
            if (textBytes + bytes > request.MaxTextBytes) { truncated = true; return false; }
            textBytes += bytes;

            NativeMethods.GetWindowRect(hwnd, out var rect);
            windows.Add(new
            {
                window = new WindowRefDto(
                    $"0x{hwnd.ToInt64():x}",
                    $"session:{sessionId}",
                    new ProcessGenerationDto(pid, startIdentity),
                    generation),
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
        }, 0))
        {
            throw new ProtocolException("windows.enumeration-failed");
        }

        return new { windows, truncated, itemCount = windows.Count, textBytes };
    }

    private long Generation(string key, AutomationElement current)
    {
        if (_identities.TryGetValue(key, out var prior))
        {
            try
            {
                if (Automation.Compare(prior.Element, current)) return prior.Generation;
            }
            catch (ElementNotAvailableException)
            {
                // Replacement below advances generation.
            }
            var next = checked(prior.Generation + 1);
            _identities[key] = new Identity(current, next);
            return next;
        }
        _identities[key] = new Identity(current, 0);
        return 0;
    }

    private static string ReadWindowText(nint hwnd)
    {
        var length = Math.Clamp(NativeMethods.GetWindowTextLengthW(hwnd), 0, 4_096);
        if (length == 0) return string.Empty;
        var buffer = new char[length + 1];
        var copied = NativeMethods.GetWindowTextW(hwnd, buffer, buffer.Length);
        return copied > 0 ? new string(buffer, 0, copied) : string.Empty;
    }
}
