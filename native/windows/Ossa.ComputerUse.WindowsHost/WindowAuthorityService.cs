using System.Windows.Automation;

namespace Ossa.ComputerUse.WindowsHost;

internal sealed class WindowAuthorityService
{
    private const int MaxWindows = 256;
    private readonly WindowEnumerationService _windows;

    internal WindowAuthorityService(WindowEnumerationService windows) => _windows = windows;

    /** Must execute on the same UIA MTA as WindowEnumerationService. */
    internal object Observe(WindowStatesRequest request)
    {
        if (request.Windows is null || request.Windows.Length is < 1 or > MaxWindows)
            throw new ProtocolException("uia.window-states-count-invalid");

        var states = new List<object>(request.Windows.Length);
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var window in request.Windows)
        {
            var key = $"{window.DesktopSessionId}:{window.Hwnd}:{window.Process.ProcessId}:{window.Process.StartIdentity}:{window.Generation}";
            if (!keys.Add(key)) throw new ProtocolException("uia.window-states-duplicate");

            var hwnd = _windows.ValidateObserved(window);
            AutomationElement element;
            try
            {
                element = AutomationElement.FromHandle(hwnd);
            }
            catch (ElementNotAvailableException)
            {
                throw new ProtocolException("uia.window-states-stale");
            }
            catch (InvalidOperationException)
            {
                continue;
            }

            if (!element.TryGetCurrentPattern(WindowPattern.Pattern, out var raw) || raw is not WindowPattern pattern)
                continue;

            WindowPattern.WindowPatternInformation current;
            try
            {
                current = pattern.Current;
            }
            catch (ElementNotAvailableException)
            {
                throw new ProtocolException("uia.window-states-stale");
            }

            var ownerHwnd = NativeMethods.GetWindow(hwnd, NativeMethods.GW_OWNER);
            var owner = ownerHwnd == 0 ? null : _windows.TryObserved(ownerHwnd);
            states.Add(new
            {
                window,
                isModal = current.IsModal,
                isTopmost = current.IsTopmost,
                interactionState = InteractionState(current.WindowInteractionState),
                owner,
            });
        }

        return new { states = states.ToArray(), itemCount = states.Count };
    }

    private static string InteractionState(WindowInteractionState state) => state switch
    {
        WindowInteractionState.Running => "running",
        WindowInteractionState.Closing => "closing",
        WindowInteractionState.ReadyForUserInteraction => "ready-for-user-interaction",
        WindowInteractionState.BlockedByModalWindow => "blocked-by-modal-window",
        WindowInteractionState.NotResponding => "not-responding",
        _ => throw new ProtocolException("uia.window-interaction-state-unknown"),
    };
}
