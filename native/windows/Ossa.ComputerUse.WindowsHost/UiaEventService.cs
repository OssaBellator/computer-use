using System.Collections.Concurrent;
using System.Globalization;
using System.Windows.Automation;

namespace Ossa.ComputerUse.WindowsHost;

internal sealed class UiaEventService : IDisposable
{
    private const int MaxRegistrations = 128;
    private const int MaxQueuedEventsPerRegistration = 1_024;
    private static readonly HashSet<string> AllowedEvents = new(StringComparer.Ordinal)
    {
        "structure-changed",
        "property-changed",
        "focus-changed",
        "window-opened",
        "window-closed",
    };

    private sealed class Registration
    {
        internal required string Id { get; init; }
        internal required AutomationElement Root { get; init; }
        internal required HashSet<string> Events { get; init; }
        internal required ConcurrentQueue<string> Queue { get; init; }
        internal StructureChangedEventHandler? StructureHandler { get; set; }
        internal AutomationPropertyChangedEventHandler? PropertyHandler { get; set; }
        internal AutomationEventHandler? WindowHandler { get; set; }
        internal int Active = 1;
    }

    private readonly string _threadToken;
    private readonly ConcurrentDictionary<string, Registration> _registrations = new(StringComparer.Ordinal);
    private readonly AutomationFocusChangedEventHandler _focusHandler;
    private bool _focusInstalled;
    private bool _disposed;

    internal UiaEventService(string threadToken)
    {
        _threadToken = threadToken;
        _focusHandler = (_, _) =>
        {
            foreach (var registration in _registrations.Values)
            {
                if (registration.Events.Contains("focus-changed")) Enqueue(registration, "focus-changed");
            }
        };
    }

    internal object Register(UiaEventRegisterRequest request)
    {
        ThrowIfDisposed();
        RequireThread(request.ThreadToken);
        if (!ValidRegistrationId(request.RegistrationId)) throw new ProtocolException("uia.events.registration-id-invalid");
        if (_registrations.ContainsKey(request.RegistrationId)) throw new ProtocolException("uia.events.registration-duplicate");
        if (_registrations.Count >= MaxRegistrations) throw new ProtocolException("uia.events.registration-capacity");
        if (request.Events is null || request.Events.Length is < 1 or > 5) throw new ProtocolException("uia.events.set-invalid");

        var events = new HashSet<string>(request.Events, StringComparer.Ordinal);
        if (events.Count != request.Events.Length || events.Any(value => !AllowedEvents.Contains(value)))
            throw new ProtocolException("uia.events.set-invalid");

        NativeHostServices.ValidateProcessGeneration(request.Window.Process);
        var root = ResolveWindow(request.Window);
        var registration = new Registration
        {
            Id = request.RegistrationId,
            Root = root,
            Events = events,
            Queue = new ConcurrentQueue<string>(),
        };

        try
        {
            if (events.Contains("structure-changed"))
            {
                registration.StructureHandler = (_, _) => Enqueue(registration, "structure-changed");
                Automation.AddStructureChangedEventHandler(root, TreeScope.Subtree, registration.StructureHandler);
            }
            if (events.Contains("property-changed"))
            {
                registration.PropertyHandler = (_, _) => Enqueue(registration, "property-changed");
                Automation.AddAutomationPropertyChangedEventHandler(
                    root,
                    TreeScope.Subtree,
                    registration.PropertyHandler,
                    AutomationElement.NameProperty,
                    AutomationElement.IsEnabledProperty,
                    AutomationElement.IsOffscreenProperty,
                    AutomationElement.BoundingRectangleProperty,
                    ValuePattern.ValueProperty);
            }
            if (events.Contains("window-opened") || events.Contains("window-closed"))
            {
                registration.WindowHandler = (_, args) =>
                {
                    if (args.EventId == WindowPattern.WindowOpenedEvent && registration.Events.Contains("window-opened"))
                        Enqueue(registration, "window-opened");
                    else if (args.EventId == WindowPattern.WindowClosedEvent && registration.Events.Contains("window-closed"))
                        Enqueue(registration, "window-closed");
                };
                if (events.Contains("window-opened"))
                    Automation.AddAutomationEventHandler(WindowPattern.WindowOpenedEvent, root, TreeScope.Subtree, registration.WindowHandler);
                if (events.Contains("window-closed"))
                    Automation.AddAutomationEventHandler(WindowPattern.WindowClosedEvent, root, TreeScope.Subtree, registration.WindowHandler);
            }

            if (!_registrations.TryAdd(registration.Id, registration)) throw new ProtocolException("uia.events.registration-duplicate");
            EnsureFocusHandler();
            return new { registered = true };
        }
        catch
        {
            Volatile.Write(ref registration.Active, 0);
            RemoveHandlers(registration);
            _registrations.TryRemove(registration.Id, out _);
            throw;
        }
    }

    internal object Unregister(UiaEventUnregisterRequest request)
    {
        ThrowIfDisposed();
        RequireThread(request.ThreadToken);
        if (!ValidRegistrationId(request.RegistrationId)) throw new ProtocolException("uia.events.registration-id-invalid");
        if (!_registrations.TryRemove(request.RegistrationId, out var registration)) return new { unregistered = false };
        Volatile.Write(ref registration.Active, 0);
        RemoveHandlers(registration);
        RemoveFocusHandlerIfUnused();
        return new { unregistered = true };
    }

    internal object Poll(UiaEventPollRequest request)
    {
        ThrowIfDisposed();
        RequireThread(request.ThreadToken);
        if (!ValidRegistrationId(request.RegistrationId)) throw new ProtocolException("uia.events.registration-id-invalid");
        if (request.MaxEvents is < 1 or > 256) throw new ProtocolException("uia.events.poll-limit-invalid");
        if (!_registrations.TryGetValue(request.RegistrationId, out var registration))
            throw new ProtocolException("uia.events.registration-missing");

        var result = new List<string>(Math.Min(request.MaxEvents, 64));
        while (result.Count < request.MaxEvents && registration.Queue.TryDequeue(out var value)) result.Add(value);
        return new { events = result.ToArray(), more = !registration.Queue.IsEmpty };
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        foreach (var pair in _registrations.ToArray())
        {
            if (_registrations.TryRemove(pair.Key, out var registration))
            {
                Volatile.Write(ref registration.Active, 0);
                RemoveHandlers(registration);
            }
        }
        if (_focusInstalled)
        {
            Automation.RemoveAutomationFocusChangedEventHandler(_focusHandler);
            _focusInstalled = false;
        }
    }

    private void EnsureFocusHandler()
    {
        if (_focusInstalled || !_registrations.Values.Any(value => value.Events.Contains("focus-changed"))) return;
        Automation.AddAutomationFocusChangedEventHandler(_focusHandler);
        _focusInstalled = true;
    }

    private void RemoveFocusHandlerIfUnused()
    {
        if (!_focusInstalled || _registrations.Values.Any(value => value.Events.Contains("focus-changed"))) return;
        Automation.RemoveAutomationFocusChangedEventHandler(_focusHandler);
        _focusInstalled = false;
    }

    private static void RemoveHandlers(Registration registration)
    {
        try
        {
            if (registration.StructureHandler is not null)
                Automation.RemoveStructureChangedEventHandler(registration.Root, registration.StructureHandler);
        }
        catch (ElementNotAvailableException) { }
        try
        {
            if (registration.PropertyHandler is not null)
                Automation.RemoveAutomationPropertyChangedEventHandler(registration.Root, registration.PropertyHandler);
        }
        catch (ElementNotAvailableException) { }
        try
        {
            if (registration.WindowHandler is not null)
            {
                if (registration.Events.Contains("window-opened"))
                    Automation.RemoveAutomationEventHandler(WindowPattern.WindowOpenedEvent, registration.Root, registration.WindowHandler);
                if (registration.Events.Contains("window-closed"))
                    Automation.RemoveAutomationEventHandler(WindowPattern.WindowClosedEvent, registration.Root, registration.WindowHandler);
            }
        }
        catch (ElementNotAvailableException) { }
    }

    private static AutomationElement ResolveWindow(WindowRefDto window)
    {
        if (window.Generation < 0 || string.IsNullOrWhiteSpace(window.Hwnd)) throw new ProtocolException("uia.window-ref-invalid");
        if (!window.Hwnd.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ||
            !long.TryParse(window.Hwnd.AsSpan(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var parsed) || parsed == 0)
            throw new ProtocolException("uia.hwnd-invalid");
        var element = AutomationElement.FromHandle(checked((nint)parsed));
        var process = element.GetCurrentPropertyValue(AutomationElement.ProcessIdProperty, true);
        if (process is not int processId || processId != window.Process.ProcessId) throw new ProtocolException("uia.window-stale");
        return element;
    }

    private static void Enqueue(Registration registration, string value)
    {
        if (Volatile.Read(ref registration.Active) == 0) return;
        if (registration.Queue.Count >= MaxQueuedEventsPerRegistration) return;
        registration.Queue.Enqueue(value);
    }

    private void RequireThread(string token)
    {
        if (!StringComparer.Ordinal.Equals(token, _threadToken)) throw new ProtocolException("uia.thread-affinity-invalid");
    }

    private static bool ValidRegistrationId(string value) =>
        !string.IsNullOrWhiteSpace(value) && value.Length <= 128 && value.All(c => char.IsLetterOrDigit(c) || c is '.' or '_' or ':' or '-');

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ProtocolException("uia.events.disposed");
    }
}
