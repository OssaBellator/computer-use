using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Windows.Automation;

namespace Ossa.ComputerUse.WindowsHost;

internal sealed class WindowEnumerationService
{
    private sealed record Identity(AutomationElement Element, long Generation);
    private readonly Dictionary<string, Identity> _identities = new(StringComparer.Ordinal);
    private readonly Dictionary<nint, WindowRefDto> _observed = new();

    internal object List(WindowListRequest request)
    {
        if (request.MaxItems is < 1 or > 10_000 || request.MaxTextBytes is < 1 or > 1_000_000)
            throw new ProtocolException("windows.enumeration-limits-invalid");

        var foreground = NativeMethods.GetForegroundWindow();
        var sessionId = Process.GetCurrentProcess().SessionId;
        var windows = new List<object>();
        var seen = new HashSet<nint>();
        var textBytes = 0;
        var truncated = false;

        var completed = NativeMethods.EnumWindows((hwnd, _) =>
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

            var key = Key(sessionId, hwnd, pid, startIdentity);
            var generation = Generation(key, element);
            var window = new WindowRefDto(
                $"0x{hwnd.ToInt64():x}",
                $"session:{sessionId}",
                new ProcessGenerationDto(pid, startIdentity),
                generation);
            var title = ReadWindowText(hwnd);
            var bytes = Encoding.UTF8.GetByteCount(title);
            if (textBytes + bytes > request.MaxTextBytes) { truncated = true; return false; }
            textBytes += bytes;

            NativeMethods.GetWindowRect(hwnd, out var rect);
            windows.Add(new
            {
                window,
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
            _observed[hwnd] = window;
            seen.Add(hwnd);
            return true;
        }, 0);

        if (!completed && !truncated)
            throw new ProtocolException("windows.enumeration-failed");

        // Only a complete enumeration proves that an older observed HWND is no
        // longer in the bounded system observation. A deliberately truncated pass
        // is incomplete by construction, so retain older refs and revalidate them
        // lazily in TryObserved before they can contribute owner authority.
        if (completed && !truncated)
        {
            foreach (var hwnd in _observed.Keys.Where(hwnd => !seen.Contains(hwnd)).ToArray())
                _observed.Remove(hwnd);
        }

        return new { windows, truncated, itemCount = windows.Count, textBytes };
    }

    /**
     * Re-resolves an exact generation-bearing window that was previously emitted
     * by List(). HWND/PID/start identity alone are insufficient because a native
     * window can be replaced inside the same process; Automation.Compare keeps
     * the generation tied to the underlying UIA window instance.
     */
    internal nint ValidateObserved(WindowRefDto window)
    {
        NativeHostServices.ValidateProcessGeneration(window.Process);
        var sessionId = Process.GetCurrentProcess().SessionId;
        if (!StringComparer.Ordinal.Equals(window.DesktopSessionId, $"session:{sessionId}") || window.Generation < 0)
            throw new ProtocolException("windows.window-generation-mismatch");

        var hwnd = ParseHwnd(window.Hwnd);
        NativeMethods.GetWindowThreadProcessId(hwnd, out var pidRaw);
        if (pidRaw == 0 || pidRaw > int.MaxValue || (int)pidRaw != window.Process.ProcessId)
            throw new ProtocolException("windows.window-generation-mismatch");

        var key = Key(sessionId, hwnd, window.Process.ProcessId, window.Process.StartIdentity);
        if (!_identities.TryGetValue(key, out var prior) || prior.Generation != window.Generation)
            throw new ProtocolException("windows.window-generation-unobserved");

        AutomationElement current;
        try { current = AutomationElement.FromHandle(hwnd); }
        catch (ElementNotAvailableException) { throw new ProtocolException("windows.window-generation-mismatch"); }
        catch (InvalidOperationException) { throw new ProtocolException("windows.window-generation-mismatch"); }
        try
        {
            if (!Automation.Compare(prior.Element, current))
                throw new ProtocolException("windows.window-generation-mismatch");
        }
        catch (ElementNotAvailableException)
        {
            throw new ProtocolException("windows.window-generation-mismatch");
        }
        return hwnd;
    }

    /** Returns only an already-observed exact ref; never synthesizes authority from an HWND. */
    internal WindowRefDto? TryObserved(nint hwnd)
    {
        if (hwnd == 0 || !_observed.TryGetValue(hwnd, out var window)) return null;
        try
        {
            ValidateObserved(window);
            return window;
        }
        catch (ProtocolException)
        {
            _observed.Remove(hwnd);
            return null;
        }
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

    private static string Key(int sessionId, nint hwnd, int pid, string startIdentity) =>
        $"session:{sessionId}:{hwnd.ToInt64():x}:{pid}:{startIdentity}";

    private static nint ParseHwnd(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 32 || !value.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ||
            !long.TryParse(value.AsSpan(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var parsed) || parsed == 0)
            throw new ProtocolException("windows.hwnd-invalid");
        return checked((nint)parsed);
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
