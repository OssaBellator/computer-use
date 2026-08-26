using System.Globalization;
using System.Text;
using System.Windows.Automation;

namespace Ossa.ComputerUse.WindowsHost;

internal sealed class UiaService
{
    private const int MaxHandles = 4_096;
    private const int MaxRuntimeIdParts = 64;
    private const int MaxFieldBytes = 16_384;

    private sealed record ControlIdentity(AutomationElement Element, long Generation);

    private readonly string _threadToken;
    private readonly Dictionary<string, AutomationElement> _handles = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ControlIdentity> _identities = new(StringComparer.Ordinal);
    private long _nextHandle;

    internal UiaService(string threadToken)
    {
        _threadToken = threadToken;
    }

    internal object ResolveWindow(ResolveWindowRequest request)
    {
        RequireThread(request.ThreadToken);
        ValidateWindowGeneration(request.Window);
        var hwnd = ParseHwnd(request.Window.Hwnd);
        AutomationElement element;
        try
        {
            element = AutomationElement.FromHandle(hwnd);
        }
        catch (ElementNotAvailableException)
        {
            return new { status = "missing" };
        }
        catch (InvalidOperationException)
        {
            return new { status = "inaccessible" };
        }

        var processId = GetIntProperty(element, AutomationElement.ProcessIdProperty);
        if (processId != request.Window.Process.ProcessId)
        {
            return new { status = "stale" };
        }
        return new { status = "current", root = RegisterHandle(element) };
    }

    internal object BuildCache(BuildCacheRequest request)
    {
        RequireThread(request.ThreadToken);
        ValidateCachePlan(request.Plan);
        var root = GetHandle(request.Root);
        var window = WindowFromElement(root, request.Plan, request.InvalidationEpoch);
        return window;
    }

    internal object ResolveControl(ResolveControlRequest request)
    {
        RequireThread(request.ThreadToken);
        ValidateWindowGeneration(request.Ref.Window);
        var root = ResolveWindowElement(request.Ref.Window);
        var resolved = FindByRuntimeId(root, request.Ref.RuntimeId, 10_000);
        if (resolved is null)
        {
            return new { status = "missing" };
        }

        var snapshot = Snapshot(resolved, request.Ref.Window, includeChildren: false);
        if (snapshot.Ref.Generation != request.Ref.Generation)
        {
            return new { status = "missing" };
        }
        return new { status = "candidate", element = RegisterHandle(resolved) };
    }

    internal object CompareElements(CompareElementsRequest request)
    {
        RequireThread(request.ThreadToken);
        var a = GetHandle(request.A);
        var b = GetHandle(request.B);
        try
        {
            return new { same = Automation.Compare(a, b) };
        }
        catch (ElementNotAvailableException)
        {
            return new { same = false };
        }
    }

    internal object SnapshotControl(SnapshotControlRequest request)
    {
        RequireThread(request.ThreadToken);
        ValidateWindowGeneration(request.Ref.Window);
        var expected = GetHandle(request.Element);
        var root = ResolveWindowElement(request.Ref.Window);
        var current = FindByRuntimeId(root, request.Ref.RuntimeId, 10_000);
        if (current is null)
        {
            return new { status = "missing" };
        }
        if (!Automation.Compare(expected, current))
        {
            return new { status = "stale", evidence = new[] { "windows-uia-compare-elements-mismatch" } };
        }

        var control = Snapshot(current, request.Ref.Window, includeChildren: false);
        if (control.Ref.Generation != request.Ref.Generation)
        {
            return new { status = "stale", evidence = new[] { "windows-uia-control-generation-mismatch" } };
        }
        return new { status = "current", control };
    }

    internal object PerformPattern(PerformPatternRequest request)
    {
        RequireThread(request.ThreadToken);
        ValidateWindowGeneration(request.Ref.Window);
        var expected = GetHandle(request.Element);
        var root = ResolveWindowElement(request.Ref.Window);
        var current = FindByRuntimeId(root, request.Ref.RuntimeId, 10_000);
        if (current is null)
        {
            return ActionResult("rejected", false, "windows-uia-control-missing");
        }
        if (!Automation.Compare(expected, current))
        {
            return ActionResult("rejected", false, "windows-uia-compare-elements-mismatch");
        }

        var snapshot = Snapshot(current, request.Ref.Window, includeChildren: false);
        if (snapshot.Ref.Generation != request.Ref.Generation)
        {
            return ActionResult("rejected", false, "windows-uia-control-generation-mismatch");
        }
        if (snapshot.Enabled is false)
        {
            return ActionResult("rejected", false, "windows-uia-control-disabled");
        }

        return InvokePattern(current, request.Action);
    }

    private object WindowFromElement(AutomationElement root, CachePlanDto plan, long invalidationEpoch)
    {
        var rootProcessId = GetIntProperty(root, AutomationElement.ProcessIdProperty);
        var hwnd = GetIntProperty(root, AutomationElement.NativeWindowHandleProperty);
        if (rootProcessId <= 0 || hwnd == 0)
        {
            throw new ProtocolException("uia.window-identity-invalid");
        }
        using var process = System.Diagnostics.Process.GetProcessById(rootProcessId);
        var window = new WindowRefDto(
            $"0x{hwnd:x}",
            $"session:{System.Diagnostics.Process.GetCurrentProcess().SessionId}",
            new ProcessGenerationDto(rootProcessId, process.StartTime.ToUniversalTime().ToString("O")),
            0);

        var state = new TreeBuildState(plan.MaxItems, plan.MaxDepth, plan.MaxTextBytes);
        var node = BuildNode(root, window, plan, state, depth: 1);
        return new
        {
            window,
            root = node,
            itemCount = state.ItemCount,
            textBytes = state.TextBytes,
            truncated = state.Truncated,
            invalidationEpoch,
            capturedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
    }

    private ControlSnapshotDto BuildNode(
        AutomationElement element,
        WindowRefDto window,
        CachePlanDto plan,
        TreeBuildState state,
        int depth)
    {
        if (state.ItemCount >= state.MaxItems)
        {
            state.Truncated = true;
            throw new AcquisitionBoundaryException();
        }

        var cached = CacheElement(element, plan);
        var snapshot = Snapshot(cached, window, includeChildren: false);
        var ownBytes = Utf8Bytes(snapshot.Name) + Utf8Bytes(snapshot.Value);
        if (state.TextBytes + ownBytes > state.MaxTextBytes)
        {
            state.Truncated = true;
            throw new AcquisitionBoundaryException();
        }

        state.ItemCount += 1;
        state.TextBytes += ownBytes;

        if (depth >= state.MaxDepth || plan.TreeScope == "element")
        {
            if (HasControlChild(element))
            {
                state.Truncated = true;
            }
            return snapshot;
        }

        var children = new List<ControlSnapshotDto>();
        var walker = TreeWalker.ControlViewWalker;
        AutomationElement? child;
        try
        {
            child = walker.GetFirstChild(element);
        }
        catch (ElementNotAvailableException)
        {
            child = null;
        }

        while (child is not null)
        {
            if (state.ItemCount >= state.MaxItems)
            {
                state.Truncated = true;
                break;
            }
            try
            {
                children.Add(BuildNode(child, window, plan, state, depth + 1));
            }
            catch (AcquisitionBoundaryException)
            {
                break;
            }

            if (plan.TreeScope == "element-and-children")
            {
                // Children are represented, but their descendants are intentionally omitted.
            }
            try
            {
                child = walker.GetNextSibling(child);
            }
            catch (ElementNotAvailableException)
            {
                child = null;
            }
        }

        return snapshot with { Children = children.Count == 0 ? null : children.ToArray() };
    }

    private AutomationElement CacheElement(AutomationElement element, CachePlanDto plan)
    {
        var request = new CacheRequest
        {
            TreeScope = TreeScope.Element,
            TreeFilter = Automation.ControlViewCondition,
            AutomationElementMode = AutomationElementMode.Full,
        };
        request.Add(AutomationElement.RuntimeIdProperty);
        request.Add(AutomationElement.AutomationIdProperty);
        request.Add(AutomationElement.ControlTypeProperty);
        request.Add(AutomationElement.NameProperty);
        request.Add(AutomationElement.IsEnabledProperty);
        request.Add(AutomationElement.IsOffscreenProperty);
        request.Add(AutomationElement.BoundingRectangleProperty);
        request.Add(AutomationElement.NativeWindowHandleProperty);
        request.Add(AutomationElement.ProcessIdProperty);
        request.Add(ValuePattern.ValueProperty);
        request.Add(WindowPattern.IsModalProperty);
        request.Add(WindowPattern.WindowInteractionStateProperty);

        request.Add(InvokePattern.Pattern);
        request.Add(ValuePattern.Pattern);
        request.Add(TogglePattern.Pattern);
        request.Add(SelectionItemPattern.Pattern);
        request.Add(ExpandCollapsePattern.Pattern);
        request.Add(ScrollPattern.Pattern);
        request.Add(RangeValuePattern.Pattern);
        request.Add(WindowPattern.Pattern);

        return element.GetUpdatedCache(request);
    }

    private ControlSnapshotDto Snapshot(AutomationElement element, WindowRefDto window, bool includeChildren)
    {
        int[] runtimeId;
        try
        {
            runtimeId = element.GetRuntimeId();
        }
        catch (ElementNotAvailableException)
        {
            throw new ProtocolException("uia.element-not-available");
        }
        if (runtimeId.Length is < 1 or > MaxRuntimeIdParts)
        {
            throw new ProtocolException("uia.runtime-id-invalid");
        }

        var automationId = TruncateUtf8(GetStringProperty(element, AutomationElement.AutomationIdProperty), 256);
        var controlType = GetControlTypeName(element);
        var generation = ControlGeneration(window, runtimeId, controlType, element);
        var name = TruncateUtf8(GetStringProperty(element, AutomationElement.NameProperty), MaxFieldBytes);
        var value = TruncateUtf8(GetStringProperty(element, ValuePattern.ValueProperty), MaxFieldBytes);
        var enabled = GetBoolProperty(element, AutomationElement.IsEnabledProperty);
        var offscreen = GetBoolProperty(element, AutomationElement.IsOffscreenProperty);
        var bounds = GetBounds(element);
        var patterns = SupportedPatterns(element);

        return new ControlSnapshotDto(
            new ControlRefDto(window, runtimeId, EmptyToNull(automationId), controlType, null, generation),
            EmptyToNull(name),
            EmptyToNull(value),
            enabled,
            offscreen,
            bounds,
            patterns,
            includeChildren ? Array.Empty<ControlSnapshotDto>() : null);
    }

    private long ControlGeneration(WindowRefDto window, int[] runtimeId, string controlType, AutomationElement element)
    {
        var key = $"{window.DesktopSessionId}:{window.Hwnd}:{window.Process.ProcessId}:{window.Process.StartIdentity}:{string.Join(',', runtimeId)}:{controlType}";
        if (_identities.TryGetValue(key, out var prior))
        {
            try
            {
                if (Automation.Compare(prior.Element, element))
                {
                    return prior.Generation;
                }
            }
            catch (ElementNotAvailableException)
            {
                // Replacement below advances the generation.
            }
            var next = checked(prior.Generation + 1);
            _identities[key] = new ControlIdentity(element, next);
            return next;
        }
        _identities[key] = new ControlIdentity(element, 0);
        return 0;
    }

    private AutomationElement? FindByRuntimeId(AutomationElement root, int[] runtimeId, int maxItems)
    {
        if (runtimeId.Length is < 1 or > MaxRuntimeIdParts)
        {
            throw new ProtocolException("uia.runtime-id-invalid");
        }
        var walker = TreeWalker.ControlViewWalker;
        var stack = new Stack<AutomationElement>();
        stack.Push(root);
        var visited = 0;
        while (stack.Count > 0)
        {
            var current = stack.Pop();
            if (++visited > maxItems)
            {
                throw new ProtocolException("uia.resolve-control-limit");
            }
            try
            {
                if (Automation.Compare(current.GetRuntimeId(), runtimeId))
                {
                    return current;
                }
            }
            catch (ElementNotAvailableException)
            {
                continue;
            }

            var children = new List<AutomationElement>();
            AutomationElement? child;
            try
            {
                child = walker.GetFirstChild(current);
                while (child is not null)
                {
                    children.Add(child);
                    child = walker.GetNextSibling(child);
                }
            }
            catch (ElementNotAvailableException)
            {
                continue;
            }
            for (var index = children.Count - 1; index >= 0; index--)
            {
                stack.Push(children[index]);
            }
        }
        return null;
    }

    private object InvokePattern(AutomationElement element, SemanticActionDto action)
    {
        switch (action.Kind)
        {
            case "invoke":
                if (!element.TryGetCurrentPattern(InvokePattern.Pattern, out var invoke)) return ActionResult("unsupported", false, "windows-uia-pattern-unsupported");
                ((InvokePattern)invoke).Invoke();
                return ActionResult("completed", true, null);
            case "set-value":
                if (action.Value is null || Utf8Bytes(action.Value) > MaxFieldBytes) throw new ProtocolException("uia.action-invalid");
                if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out var valuePattern)) return ActionResult("unsupported", false, "windows-uia-pattern-unsupported");
                ((ValuePattern)valuePattern).SetValue(action.Value);
                return ActionResult("completed", true, null);
            case "toggle":
                if (!element.TryGetCurrentPattern(TogglePattern.Pattern, out var toggle)) return ActionResult("unsupported", false, "windows-uia-pattern-unsupported");
                ((TogglePattern)toggle).Toggle();
                return ActionResult("completed", true, null);
            case "select":
                if (!element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var selection)) return ActionResult("unsupported", false, "windows-uia-pattern-unsupported");
                ((SelectionItemPattern)selection).Select();
                return ActionResult("completed", true, null);
            case "expand-collapse":
                if (!element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out var expand)) return ActionResult("unsupported", false, "windows-uia-pattern-unsupported");
                if (action.State == "expanded") ((ExpandCollapsePattern)expand).Expand();
                else if (action.State == "collapsed") ((ExpandCollapsePattern)expand).Collapse();
                else throw new ProtocolException("uia.action-invalid");
                return ActionResult("completed", true, null);
            case "scroll":
                if (!element.TryGetCurrentPattern(ScrollPattern.Pattern, out var scroll)) return ActionResult("unsupported", false, "windows-uia-pattern-unsupported");
                ((ScrollPattern)scroll).Scroll(ParseScrollAmount(action.Horizontal), ParseScrollAmount(action.Vertical));
                return ActionResult("completed", true, null);
            case "set-range-value":
                if (action.Value is null || !double.TryParse(action.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var rangeValue) || !double.IsFinite(rangeValue))
                    throw new ProtocolException("uia.action-invalid");
                if (!element.TryGetCurrentPattern(RangeValuePattern.Pattern, out var range)) return ActionResult("unsupported", false, "windows-uia-pattern-unsupported");
                ((RangeValuePattern)range).SetValue(rangeValue);
                return ActionResult("completed", true, null);
            case "window":
                if (!element.TryGetCurrentPattern(WindowPattern.Pattern, out var window)) return ActionResult("unsupported", false, "windows-uia-pattern-unsupported");
                var pattern = (WindowPattern)window;
                switch (action.Operation)
                {
                    case "minimize": pattern.SetWindowVisualState(WindowVisualState.Minimized); break;
                    case "maximize": pattern.SetWindowVisualState(WindowVisualState.Maximized); break;
                    case "restore": pattern.SetWindowVisualState(WindowVisualState.Normal); break;
                    case "close": pattern.Close(); break;
                    default: throw new ProtocolException("uia.action-invalid");
                }
                return ActionResult("completed", true, null);
            default:
                throw new ProtocolException("uia.action-invalid");
        }
    }

    private static ScrollAmount ParseScrollAmount(string? value) => value switch
    {
        "large-decrement" => ScrollAmount.LargeDecrement,
        "small-decrement" => ScrollAmount.SmallDecrement,
        "no-amount" => ScrollAmount.NoAmount,
        "large-increment" => ScrollAmount.LargeIncrement,
        "small-increment" => ScrollAmount.SmallIncrement,
        _ => throw new ProtocolException("uia.action-invalid"),
    };

    private static object ActionResult(string status, bool dispatched, string? evidence) => new
    {
        status,
        dispatched,
        verified = (bool?)null,
        evidence = evidence is null ? null : new[] { evidence },
    };

    private ElementHandleDto RegisterHandle(AutomationElement element)
    {
        if (_handles.Count >= MaxHandles)
        {
            throw new ProtocolException("uia.handle-capacity");
        }
        var token = $"uia-{++_nextHandle:x}";
        _handles[token] = element;
        return new ElementHandleDto(token);
    }

    private AutomationElement GetHandle(ElementHandleDto handle)
    {
        if (string.IsNullOrWhiteSpace(handle.Token) || handle.Token.Length > 192 || !_handles.TryGetValue(handle.Token, out var element))
        {
            throw new ProtocolException("uia.handle-invalid");
        }
        return element;
    }

    private AutomationElement ResolveWindowElement(WindowRefDto window)
    {
        var hwnd = ParseHwnd(window.Hwnd);
        var element = AutomationElement.FromHandle(hwnd);
        if (GetIntProperty(element, AutomationElement.ProcessIdProperty) != window.Process.ProcessId)
        {
            throw new ProtocolException("uia.window-stale");
        }
        return element;
    }

    private static nint ParseHwnd(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 32 || !value.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ||
            !long.TryParse(value.AsSpan(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var parsed) || parsed == 0)
        {
            throw new ProtocolException("uia.hwnd-invalid");
        }
        return checked((nint)parsed);
    }

    private static void ValidateWindowGeneration(WindowRefDto window)
    {
        if (window.Generation < 0 || window.Process.ProcessId <= 0 || string.IsNullOrWhiteSpace(window.Process.StartIdentity))
        {
            throw new ProtocolException("uia.window-ref-invalid");
        }
        NativeHostServices.ValidateProcessGeneration(window.Process);
    }

    private static void ValidateCachePlan(CachePlanDto plan)
    {
        if (plan.MaxItems is < 1 or > 10_000 || plan.MaxDepth is < 1 or > 128 || plan.MaxTextBytes is < 1 or > 1_000_000 ||
            plan.ControlViewOnly is not true || plan.ElementMode != "full" ||
            plan.TreeScope is not ("element" or "element-and-children" or "element-and-descendants"))
        {
            throw new ProtocolException("uia.cache-plan-invalid");
        }
    }

    private void RequireThread(string value)
    {
        if (!StringComparer.Ordinal.Equals(value, _threadToken))
        {
            throw new ProtocolException("uia.thread-affinity-invalid");
        }
    }

    private static int GetIntProperty(AutomationElement element, AutomationProperty property)
    {
        var value = element.GetCurrentPropertyValue(property, true);
        return value is int number ? number : 0;
    }

    private static string GetStringProperty(AutomationElement element, AutomationProperty property)
    {
        object value;
        try
        {
            value = element.GetCachedPropertyValue(property, true);
            if (ReferenceEquals(value, AutomationElement.NotSupported)) value = element.GetCurrentPropertyValue(property, true);
        }
        catch (InvalidOperationException)
        {
            value = element.GetCurrentPropertyValue(property, true);
        }
        return value as string ?? string.Empty;
    }

    private static bool? GetBoolProperty(AutomationElement element, AutomationProperty property)
    {
        object value;
        try
        {
            value = element.GetCachedPropertyValue(property, true);
            if (ReferenceEquals(value, AutomationElement.NotSupported)) value = element.GetCurrentPropertyValue(property, true);
        }
        catch (InvalidOperationException)
        {
            value = element.GetCurrentPropertyValue(property, true);
        }
        return value is bool flag ? flag : null;
    }

    private static RectDto? GetBounds(AutomationElement element)
    {
        object value;
        try
        {
            value = element.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty, true);
            if (ReferenceEquals(value, AutomationElement.NotSupported)) value = element.GetCurrentPropertyValue(AutomationElement.BoundingRectangleProperty, true);
        }
        catch (InvalidOperationException)
        {
            value = element.GetCurrentPropertyValue(AutomationElement.BoundingRectangleProperty, true);
        }
        return value is System.Windows.Rect rect && !rect.IsEmpty
            ? new RectDto(rect.X, rect.Y, Math.Max(0, rect.Width), Math.Max(0, rect.Height))
            : null;
    }

    private static string GetControlTypeName(AutomationElement element)
    {
        object value;
        try
        {
            value = element.GetCachedPropertyValue(AutomationElement.ControlTypeProperty, true);
            if (ReferenceEquals(value, AutomationElement.NotSupported)) value = element.GetCurrentPropertyValue(AutomationElement.ControlTypeProperty, true);
        }
        catch (InvalidOperationException)
        {
            value = element.GetCurrentPropertyValue(AutomationElement.ControlTypeProperty, true);
        }
        return value is ControlType type ? type.ProgrammaticName.Replace("ControlType.", string.Empty, StringComparison.Ordinal) : "Custom";
    }

    private static string[] SupportedPatterns(AutomationElement element)
    {
        var result = new List<string>(8);
        if (element.TryGetCurrentPattern(InvokePattern.Pattern, out _)) result.Add("invoke");
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out _)) result.Add("value");
        if (element.TryGetCurrentPattern(TogglePattern.Pattern, out _)) result.Add("toggle");
        if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out _)) result.Add("selection-item");
        if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out _)) result.Add("expand-collapse");
        if (element.TryGetCurrentPattern(ScrollPattern.Pattern, out _)) result.Add("scroll");
        if (element.TryGetCurrentPattern(RangeValuePattern.Pattern, out _)) result.Add("range-value");
        if (element.TryGetCurrentPattern(WindowPattern.Pattern, out _)) result.Add("window");
        return result.ToArray();
    }

    private static bool HasControlChild(AutomationElement element)
    {
        try
        {
            return TreeWalker.ControlViewWalker.GetFirstChild(element) is not null;
        }
        catch (ElementNotAvailableException)
        {
            return false;
        }
    }

    private static int Utf8Bytes(string? value) => value is null ? 0 : Encoding.UTF8.GetByteCount(value);

    private static string TruncateUtf8(string value, int maxBytes)
    {
        if (Encoding.UTF8.GetByteCount(value) <= maxBytes) return value;
        var builder = new StringBuilder();
        var bytes = 0;
        foreach (var rune in value.EnumerateRunes())
        {
            var count = rune.Utf8SequenceLength;
            if (bytes + count > maxBytes) break;
            builder.Append(rune.ToString());
            bytes += count;
        }
        return builder.ToString();
    }

    private static string? EmptyToNull(string value) => value.Length == 0 ? null : value;

    private sealed class AcquisitionBoundaryException : Exception;

    private sealed class TreeBuildState(int maxItems, int maxDepth, int maxTextBytes)
    {
        internal int MaxItems { get; } = maxItems;
        internal int MaxDepth { get; } = maxDepth;
        internal int MaxTextBytes { get; } = maxTextBytes;
        internal int ItemCount { get; set; }
        internal int TextBytes { get; set; }
        internal bool Truncated { get; set; }
    }

    internal sealed record RectDto(double X, double Y, double Width, double Height);
    internal sealed record ControlSnapshotDto(
        ControlRefDto Ref,
        string? Name,
        string? Value,
        bool? Enabled,
        bool? Offscreen,
        RectDto? Bounds,
        string[] Patterns,
        ControlSnapshotDto[]? Children);
}
