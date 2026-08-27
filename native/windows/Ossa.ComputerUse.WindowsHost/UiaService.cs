using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Automation;

namespace Ossa.ComputerUse.WindowsHost;

internal sealed class UiaService
{
    private const int MaxHandles = 4_096;
    private const int MaxRuntimeIdParts = 64;
    private const int MaxFieldBytes = 16_384;

    private sealed record HandleEntry(AutomationElement Element, WindowRefDto Window);
    private sealed record ControlIdentity(AutomationElement Element, long Generation);

    private readonly string _threadToken;
    private readonly Dictionary<string, HandleEntry> _handles = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ControlIdentity> _identities = new(StringComparer.Ordinal);
    private long _nextHandle;

    internal UiaService(string threadToken) => _threadToken = threadToken;

    internal object ResolveWindow(ResolveWindowRequest request)
    {
        RequireThread(request.ThreadToken);
        ValidateWindowGeneration(request.Window);
        AutomationElement element;
        try
        {
            element = AutomationElement.FromHandle(ParseHwnd(request.Window.Hwnd));
        }
        catch (ElementNotAvailableException)
        {
            return new { status = "missing" };
        }
        catch (InvalidOperationException)
        {
            return new { status = "inaccessible" };
        }
        catch (COMException)
        {
            return new { status = "inaccessible" };
        }

        if (CurrentInt(element, AutomationElement.ProcessIdProperty) != request.Window.Process.ProcessId)
        {
            return new { status = "stale" };
        }
        return new { status = "current", root = RegisterHandle(element, request.Window) };
    }

    internal object BuildCache(BuildCacheRequest request)
    {
        RequireThread(request.ThreadToken);
        ValidateCachePlan(request.Plan);
        var root = GetHandle(request.Root);
        ValidateWindowGeneration(root.Window);
        VerifyWindowElement(root.Element, root.Window);

        var state = new TreeBuildState(request.Plan.MaxItems, request.Plan.MaxDepth, request.Plan.MaxTextBytes);
        var node = BuildNode(root.Element, root.Window, request.Plan, state, 1);
        return new
        {
            window = root.Window,
            root = node,
            itemCount = state.ItemCount,
            textBytes = state.TextBytes,
            truncated = state.Truncated,
            invalidationEpoch = request.InvalidationEpoch,
            capturedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
    }

    internal object ResolveControl(ResolveControlRequest request)
    {
        RequireThread(request.ThreadToken);
        ValidateWindowGeneration(request.Ref.Window);
        try
        {
            var root = ResolveWindowElement(request.Ref.Window);
            var resolved = FindByRuntimeId(root, request.Ref.RuntimeId, 10_000);
            if (resolved is null) return new { status = "missing" };

            var snapshot = Snapshot(resolved, request.Ref.Window);
            if (snapshot.Ref.Generation != request.Ref.Generation) return new { status = "missing" };
            return new { status = "candidate", element = RegisterHandle(resolved, request.Ref.Window) };
        }
        catch (ElementNotAvailableException)
        {
            return new { status = "missing" };
        }
        catch (InvalidOperationException)
        {
            return new { status = "inaccessible" };
        }
        catch (COMException)
        {
            return new { status = "inaccessible" };
        }
    }

    internal object CompareElements(CompareElementsRequest request)
    {
        RequireThread(request.ThreadToken);
        var a = GetHandle(request.A);
        var b = GetHandle(request.B);
        try
        {
            return new { same = Automation.Compare(a.Element, b.Element) };
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
        try
        {
            var expected = GetHandle(request.Element);
            if (!SameWindow(expected.Window, request.Ref.Window)) return new { status = "stale" };

            var current = FindByRuntimeId(ResolveWindowElement(request.Ref.Window), request.Ref.RuntimeId, 10_000);
            if (current is null) return new { status = "missing" };
            if (!SafeCompare(expected.Element, current))
                return new { status = "stale", evidence = new[] { "windows-uia-compare-elements-mismatch" } };

            var control = Snapshot(current, request.Ref.Window);
            if (control.Ref.Generation != request.Ref.Generation)
                return new { status = "stale", evidence = new[] { "windows-uia-control-generation-mismatch" } };
            return new { status = "current", control };
        }
        catch (ElementNotAvailableException)
        {
            return new { status = "missing" };
        }
        catch (InvalidOperationException)
        {
            return new { status = "inaccessible", evidence = new[] { "windows-uia-provider-inaccessible-before-dispatch" } };
        }
        catch (COMException)
        {
            return new { status = "inaccessible", evidence = new[] { "windows-uia-provider-inaccessible-before-dispatch" } };
        }
    }

    internal object PerformPattern(PerformPatternRequest request)
    {
        RequireThread(request.ThreadToken);
        ValidateWindowGeneration(request.Ref.Window);
        var expected = GetHandle(request.Element);
        if (!SameWindow(expected.Window, request.Ref.Window))
            return ActionResult("rejected", false, "windows-uia-window-generation-mismatch");

        var current = FindByRuntimeId(ResolveWindowElement(request.Ref.Window), request.Ref.RuntimeId, 10_000);
        if (current is null) return ActionResult("rejected", false, "windows-uia-control-missing");
        if (!SafeCompare(expected.Element, current)) return ActionResult("rejected", false, "windows-uia-compare-elements-mismatch");

        var snapshot = Snapshot(current, request.Ref.Window);
        if (snapshot.Ref.Generation != request.Ref.Generation)
            return ActionResult("rejected", false, "windows-uia-control-generation-mismatch");
        if (snapshot.Enabled is false) return ActionResult("rejected", false, "windows-uia-control-disabled");

        return DispatchPattern(current, request.Action);
    }

    internal string? ValidateCredentialTarget(CredentialApplyRequest request)
    {
        RequireThread(request.ThreadToken);
        ValidateWindowGeneration(request.Ref.Window);
        var current = FindByRuntimeId(ResolveWindowElement(request.Ref.Window), request.Ref.RuntimeId, 10_000);
        if (current is null) return "windows-credential-target-missing";
        var snapshot = Snapshot(current, request.Ref.Window);
        if (snapshot.Ref.Generation != request.Ref.Generation) return "windows-credential-target-replaced";
        if (snapshot.IsPassword is not true) return "windows-credential-target-not-password";
        if (snapshot.Enabled is false) return "windows-credential-target-disabled";
        if (!current.TryGetCurrentPattern(ValuePattern.Pattern, out _)) return "windows-credential-value-pattern-unavailable";
        return null;
    }

    internal object ApplyCredential(CredentialApplyRequest request, string secret)
    {
        var invalid = ValidateCredentialTarget(request);
        if (invalid is not null) return new { status = "rejected", evidence = new[] { invalid } };
        var current = FindByRuntimeId(ResolveWindowElement(request.Ref.Window), request.Ref.RuntimeId, 10_000);
        if (current is null) return new { status = "rejected", evidence = new[] { "windows-credential-target-missing" } };

        var snapshot = Snapshot(current, request.Ref.Window);
        var nativeHandle = CurrentInt(current, AutomationElement.NativeWindowHandleProperty);
        if (snapshot.Ref.ControlType == "Edit" && nativeHandle != 0)
        {
            var sent = CredentialNativeMethods.SendMessageTimeoutW(
                checked((nint)nativeHandle),
                0x000C,
                0,
                secret,
                0x0001 | 0x0002,
                1_000,
                out var messageResult);
            if (sent == 0)
                return new { status = "unknown", evidence = new[] { "windows-credential-native-edit-dispatch-unknown" } };
            return messageResult != 0
                ? new { status = "applied", evidence = new[] { "windows-credential-native-edit-applied" } }
                : new { status = "rejected", evidence = new[] { "windows-credential-native-edit-rejected" } };
        }

        if (!current.TryGetCurrentPattern(ValuePattern.Pattern, out var valuePattern))
            return new { status = "rejected", evidence = new[] { "windows-credential-value-pattern-unavailable" } };
        try
        {
            ((ValuePattern)valuePattern).SetValue(secret);
            return new { status = "applied", evidence = new[] { "windows-credential-uia-applied" } };
        }
        catch (ElementNotAvailableException)
        {
            return new { status = "unknown", evidence = new[] { "windows-credential-uia-element-unavailable-after-dispatch" } };
        }
        catch (InvalidOperationException)
        {
            return new { status = "unknown", evidence = new[] { "windows-credential-uia-invalid-operation-after-dispatch" } };
        }
        catch (COMException)
        {
            return new { status = "unknown", evidence = new[] { "windows-credential-uia-com-error-after-dispatch" } };
        }
    }

    internal string? ValidateTotpTarget(TotpFactorApplyRequest request)
    {
        RequireThread(request.ThreadToken);
        ValidateWindowGeneration(request.Ref.Window);
        var current = FindByRuntimeId(ResolveWindowElement(request.Ref.Window), request.Ref.RuntimeId, 10_000);
        if (current is null) return "windows-totp-target-missing";
        var snapshot = Snapshot(current, request.Ref.Window);
        if (snapshot.Ref.Generation != request.Ref.Generation) return "windows-totp-target-replaced";
        if (snapshot.Enabled is false) return "windows-totp-target-disabled";
        if (snapshot.Ref.ControlType != "Edit") return "windows-totp-target-not-edit";
        if (!current.TryGetCurrentPattern(ValuePattern.Pattern, out _)) return "windows-totp-value-pattern-unavailable";
        return null;
    }

    internal object ApplyTotp(TotpFactorApplyRequest request, string code)
    {
        var invalid = ValidateTotpTarget(request);
        if (invalid is not null) return new { status = "rejected", evidence = new[] { invalid } };
        var current = FindByRuntimeId(ResolveWindowElement(request.Ref.Window), request.Ref.RuntimeId, 10_000);
        if (current is null) return new { status = "rejected", evidence = new[] { "windows-totp-target-missing" } };
        if (!current.TryGetCurrentPattern(ValuePattern.Pattern, out var valuePattern))
            return new { status = "rejected", evidence = new[] { "windows-totp-value-pattern-unavailable" } };
        try
        {
            ((ValuePattern)valuePattern).SetValue(code);
            return new { status = "completed", evidence = new[] { "windows-totp-uia-applied" } };
        }
        catch (ElementNotAvailableException) { return ReconcileTotpDispatch(request, code, "windows-totp-uia-element-unavailable-after-dispatch"); }
        catch (InvalidOperationException) { return ReconcileTotpDispatch(request, code, "windows-totp-uia-invalid-operation-after-dispatch"); }
        catch (COMException) { return ReconcileTotpDispatch(request, code, "windows-totp-uia-com-error-after-dispatch"); }
    }

    private object ReconcileTotpDispatch(TotpFactorApplyRequest request, string code, string unknownEvidence)
    {
        try
        {
            var invalid = ValidateTotpTarget(request);
            if (invalid is not null) return new { status = "unknown", evidence = new[] { unknownEvidence } };
            var current = FindByRuntimeId(ResolveWindowElement(request.Ref.Window), request.Ref.RuntimeId, 10_000);
            if (current is null || !current.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern))
                return new { status = "unknown", evidence = new[] { unknownEvidence } };
            var observed = ((ValuePattern)pattern).Current.Value;
            return StringComparer.Ordinal.Equals(observed, code)
                ? new { status = "completed", evidence = new[] { "windows-totp-native-reconciled" } }
                : new { status = "unknown", evidence = new[] { unknownEvidence } };
        }
        catch
        {
            return new { status = "unknown", evidence = new[] { unknownEvidence } };
        }
    }

    private static class CredentialNativeMethods
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern nint SendMessageTimeoutW(
            nint hWnd,
            uint message,
            nint wParam,
            string lParam,
            uint flags,
            uint timeoutMs,
            out nint result);
    }

    private ControlSnapshotDto BuildNode(AutomationElement element, WindowRefDto window, CachePlanDto plan, TreeBuildState state, int depth)
    {
        if (state.ItemCount >= state.MaxItems)
        {
            state.Truncated = true;
            throw new AcquisitionBoundaryException();
        }

        var cached = CacheElement(element);
        var snapshot = Snapshot(cached, window);
        var ownBytes = Utf8Bytes(snapshot.Name) + Utf8Bytes(snapshot.Value);
        if (state.TextBytes + ownBytes > state.MaxTextBytes)
        {
            state.Truncated = true;
            throw new AcquisitionBoundaryException();
        }
        state.ItemCount++;
        state.TextBytes += ownBytes;

        if (plan.TreeScope == "element") return snapshot;
        if (plan.TreeScope == "element-and-children" && depth >= 2) return snapshot;
        if (depth >= state.MaxDepth)
        {
            if (HasControlChild(element)) state.Truncated = true;
            return snapshot;
        }

        var children = new List<ControlSnapshotDto>();
        var walker = TreeWalker.ControlViewWalker;
        AutomationElement? child;
        try { child = walker.GetFirstChild(element); }
        catch (ElementNotAvailableException) { child = null; }

        while (child is not null)
        {
            if (state.ItemCount >= state.MaxItems)
            {
                state.Truncated = true;
                break;
            }
            try { children.Add(BuildNode(child, window, plan, state, depth + 1)); }
            catch (AcquisitionBoundaryException) { break; }
            try { child = walker.GetNextSibling(child); }
            catch (ElementNotAvailableException) { child = null; }
        }

        return snapshot with { Children = children.Count == 0 ? null : children.ToArray() };
    }

    private static AutomationElement CacheElement(AutomationElement element)
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
        request.Add(AutomationElement.IsPasswordProperty);
        request.Add(AutomationElement.IsOffscreenProperty);
        request.Add(AutomationElement.BoundingRectangleProperty);
        request.Add(AutomationElement.NativeWindowHandleProperty);
        request.Add(AutomationElement.ProcessIdProperty);
        request.Add(ValuePattern.ValueProperty);
        request.Add(WindowPattern.IsModalProperty);
        request.Add(WindowPattern.WindowInteractionStateProperty);
        request.Add(TogglePattern.ToggleStateProperty);
        request.Add(SelectionItemPattern.IsSelectedProperty);
        request.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);
        request.Add(RangeValuePattern.ValueProperty);
        request.Add(WindowPattern.WindowVisualStateProperty);
        request.Add(System.Windows.Automation.InvokePattern.Pattern);
        request.Add(ValuePattern.Pattern);
        request.Add(TogglePattern.Pattern);
        request.Add(SelectionItemPattern.Pattern);
        request.Add(ExpandCollapsePattern.Pattern);
        request.Add(ScrollPattern.Pattern);
        request.Add(RangeValuePattern.Pattern);
        request.Add(WindowPattern.Pattern);
        return element.GetUpdatedCache(request);
    }

    private ControlSnapshotDto Snapshot(AutomationElement element, WindowRefDto window)
    {
        int[] runtimeId;
        try { runtimeId = element.GetRuntimeId(); }
        catch (ElementNotAvailableException) { throw new ProtocolException("uia.element-not-available"); }
        if (runtimeId.Length is < 1 or > MaxRuntimeIdParts) throw new ProtocolException("uia.runtime-id-invalid");

        var automationId = TruncateUtf8(StringProperty(element, AutomationElement.AutomationIdProperty), 256);
        var controlType = ControlTypeName(element);
        var generation = ControlGeneration(window, runtimeId, controlType, element);
        var name = TruncateUtf8(StringProperty(element, AutomationElement.NameProperty), MaxFieldBytes);
        var isPassword = BoolProperty(element, AutomationElement.IsPasswordProperty);
        // Password/credential text is never serialized across the native-host boundary.
        var value = isPassword == true ? string.Empty : TruncateUtf8(StringProperty(element, ValuePattern.ValueProperty), MaxFieldBytes);
        return new ControlSnapshotDto(
            new ControlRefDto(window, runtimeId, EmptyToNull(automationId), controlType, null, generation),
            EmptyToNull(name),
            EmptyToNull(value),
            BoolProperty(element, AutomationElement.IsEnabledProperty),
            isPassword,
            BoolProperty(element, AutomationElement.IsOffscreenProperty),
            Bounds(element),
            SupportedPatterns(element),
            ToggleStateValue(element),
            BoolProperty(element, SelectionItemPattern.IsSelectedProperty),
            ExpandCollapseStateValue(element),
            DoubleProperty(element, RangeValuePattern.ValueProperty),
            WindowVisualStateValue(element),
            null);
    }

    private long ControlGeneration(WindowRefDto window, int[] runtimeId, string controlType, AutomationElement element)
    {
        var key = $"{window.DesktopSessionId}:{window.Hwnd}:{window.Process.ProcessId}:{window.Process.StartIdentity}:{string.Join(',', runtimeId)}:{controlType}";
        if (_identities.TryGetValue(key, out var prior))
        {
            if (SafeCompare(prior.Element, element)) return prior.Generation;
            var next = checked(prior.Generation + 1);
            _identities[key] = new ControlIdentity(element, next);
            return next;
        }
        _identities[key] = new ControlIdentity(element, 0);
        return 0;
    }

    private static AutomationElement? FindByRuntimeId(AutomationElement root, int[] runtimeId, int maxItems)
    {
        if (runtimeId.Length is < 1 or > MaxRuntimeIdParts) throw new ProtocolException("uia.runtime-id-invalid");
        var walker = TreeWalker.ControlViewWalker;
        var stack = new Stack<AutomationElement>();
        stack.Push(root);
        var visited = 0;
        while (stack.Count > 0)
        {
            var current = stack.Pop();
            if (++visited > maxItems) throw new ProtocolException("uia.resolve-control-limit");
            try
            {
                if (Automation.Compare(current.GetRuntimeId(), runtimeId)) return current;
            }
            catch (ElementNotAvailableException) { continue; }

            var children = new List<AutomationElement>();
            try
            {
                var child = walker.GetFirstChild(current);
                while (child is not null)
                {
                    children.Add(child);
                    child = walker.GetNextSibling(child);
                }
            }
            catch (ElementNotAvailableException) { continue; }
            for (var i = children.Count - 1; i >= 0; i--) stack.Push(children[i]);
        }
        return null;
    }

    private static object DispatchPattern(AutomationElement element, SemanticActionDto action)
    {
        switch (action.Kind)
        {
            case "invoke":
                if (!element.TryGetCurrentPattern(System.Windows.Automation.InvokePattern.Pattern, out var invoke)) return ActionResult("unsupported", false, "windows-uia-pattern-unsupported");
                ((System.Windows.Automation.InvokePattern)invoke).Invoke();
                return ActionResult("completed", true, null);
            case "set-value":
                var text = StringActionValue(action.Value);
                if (text is null || Utf8Bytes(text) > MaxFieldBytes) throw new ProtocolException("uia.action-invalid");
                if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out var valuePattern)) return ActionResult("unsupported", false, "windows-uia-pattern-unsupported");
                ((ValuePattern)valuePattern).SetValue(text);
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
                var number = NumberActionValue(action.Value);
                if (number is null || !double.IsFinite(number.Value)) throw new ProtocolException("uia.action-invalid");
                if (!element.TryGetCurrentPattern(RangeValuePattern.Pattern, out var range)) return ActionResult("unsupported", false, "windows-uia-pattern-unsupported");
                ((RangeValuePattern)range).SetValue(number.Value);
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

    private static string? StringActionValue(JsonElement? value) => value is { ValueKind: JsonValueKind.String } element ? element.GetString() : null;
    private static double? NumberActionValue(JsonElement? value) => value is { ValueKind: JsonValueKind.Number } element && element.TryGetDouble(out var number) ? number : null;

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
        evidence = evidence is null ? null : new[] { evidence },
    };

    private ElementHandleDto RegisterHandle(AutomationElement element, WindowRefDto window)
    {
        if (_handles.Count >= MaxHandles) throw new ProtocolException("uia.handle-capacity");
        var token = $"uia-{++_nextHandle:x}";
        _handles[token] = new HandleEntry(element, window);
        return new ElementHandleDto(token);
    }

    private HandleEntry GetHandle(ElementHandleDto handle)
    {
        if (string.IsNullOrWhiteSpace(handle.Token) || handle.Token.Length > 192 || !_handles.TryGetValue(handle.Token, out var entry))
            throw new ProtocolException("uia.handle-invalid");
        return entry;
    }

    private static AutomationElement ResolveWindowElement(WindowRefDto window)
    {
        var element = AutomationElement.FromHandle(ParseHwnd(window.Hwnd));
        VerifyWindowElement(element, window);
        return element;
    }

    private static void VerifyWindowElement(AutomationElement element, WindowRefDto window)
    {
        if (CurrentInt(element, AutomationElement.ProcessIdProperty) != window.Process.ProcessId)
            throw new ProtocolException("uia.window-stale");
        var native = CurrentInt(element, AutomationElement.NativeWindowHandleProperty);
        if (native != ParseHwnd(window.Hwnd).ToInt64()) throw new ProtocolException("uia.window-stale");
    }

    private static nint ParseHwnd(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 32 || !value.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ||
            !long.TryParse(value.AsSpan(2), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var parsed) || parsed == 0)
            throw new ProtocolException("uia.hwnd-invalid");
        return checked((nint)parsed);
    }

    private static void ValidateWindowGeneration(WindowRefDto window)
    {
        if (window.Generation < 0 || window.Process.ProcessId <= 0 || string.IsNullOrWhiteSpace(window.Process.StartIdentity))
            throw new ProtocolException("uia.window-ref-invalid");
        NativeHostServices.ValidateProcessGeneration(window.Process);
    }

    private static void ValidateCachePlan(CachePlanDto plan)
    {
        if (plan.MaxItems is < 1 or > 10_000 || plan.MaxDepth is < 1 or > 128 || plan.MaxTextBytes is < 1 or > 1_000_000 ||
            plan.ControlViewOnly is not true || plan.ElementMode != "full" ||
            plan.TreeScope is not ("element" or "element-and-children" or "element-and-descendants"))
            throw new ProtocolException("uia.cache-plan-invalid");
    }

    private void RequireThread(string value)
    {
        if (!StringComparer.Ordinal.Equals(value, _threadToken)) throw new ProtocolException("uia.thread-affinity-invalid");
    }

    private static bool SameWindow(WindowRefDto a, WindowRefDto b) =>
        a.Hwnd == b.Hwnd && a.DesktopSessionId == b.DesktopSessionId && a.Generation == b.Generation &&
        a.Process.ProcessId == b.Process.ProcessId && a.Process.StartIdentity == b.Process.StartIdentity;

    private static bool SafeCompare(AutomationElement a, AutomationElement b)
    {
        try { return Automation.Compare(a, b); }
        catch (ElementNotAvailableException) { return false; }
    }

    private static int CurrentInt(AutomationElement element, AutomationProperty property)
    {
        var value = element.GetCurrentPropertyValue(property, true);
        return value is int number ? number : 0;
    }

    private static object Property(AutomationElement element, AutomationProperty property)
    {
        try
        {
            var cached = element.GetCachedPropertyValue(property, true);
            return ReferenceEquals(cached, AutomationElement.NotSupported) ? element.GetCurrentPropertyValue(property, true) : cached;
        }
        catch (InvalidOperationException)
        {
            return element.GetCurrentPropertyValue(property, true);
        }
    }

    private static string StringProperty(AutomationElement element, AutomationProperty property) => Property(element, property) as string ?? string.Empty;
    private static bool? BoolProperty(AutomationElement element, AutomationProperty property) => Property(element, property) is bool flag ? flag : null;
    private static double? DoubleProperty(AutomationElement element, AutomationProperty property) => Property(element, property) is double number && double.IsFinite(number) ? number : null;
    private static string? ToggleStateValue(AutomationElement element) => Property(element, TogglePattern.ToggleStateProperty) is ToggleState state ? state switch
    {
        ToggleState.Off => "off",
        ToggleState.On => "on",
        ToggleState.Indeterminate => "indeterminate",
        _ => null,
    } : null;
    private static string? ExpandCollapseStateValue(AutomationElement element) => Property(element, ExpandCollapsePattern.ExpandCollapseStateProperty) is ExpandCollapseState state ? state switch
    {
        ExpandCollapseState.Collapsed => "collapsed",
        ExpandCollapseState.Expanded => "expanded",
        ExpandCollapseState.PartiallyExpanded => "partially-expanded",
        ExpandCollapseState.LeafNode => "leaf-node",
        _ => null,
    } : null;
    private static string? WindowVisualStateValue(AutomationElement element) => Property(element, WindowPattern.WindowVisualStateProperty) is WindowVisualState state ? state switch
    {
        WindowVisualState.Normal => "normal",
        WindowVisualState.Minimized => "minimized",
        WindowVisualState.Maximized => "maximized",
        _ => null,
    } : null;

    private static RectDto? Bounds(AutomationElement element)
    {
        var value = Property(element, AutomationElement.BoundingRectangleProperty);
        return value is System.Windows.Rect rect && !rect.IsEmpty
            ? new RectDto(rect.X, rect.Y, Math.Max(0, rect.Width), Math.Max(0, rect.Height))
            : null;
    }

    private static string ControlTypeName(AutomationElement element)
    {
        var value = Property(element, AutomationElement.ControlTypeProperty);
        return value is ControlType type ? type.ProgrammaticName.Replace("ControlType.", string.Empty, StringComparison.Ordinal) : "Custom";
    }

    private static string[] SupportedPatterns(AutomationElement element)
    {
        var result = new List<string>(8);
        if (element.TryGetCurrentPattern(System.Windows.Automation.InvokePattern.Pattern, out _)) result.Add("invoke");
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
        try { return TreeWalker.ControlViewWalker.GetFirstChild(element) is not null; }
        catch (ElementNotAvailableException) { return false; }
    }

    private static int Utf8Bytes(string? value) => value is null ? 0 : Encoding.UTF8.GetByteCount(value);

    private static string TruncateUtf8(string value, int maxBytes)
    {
        if (Encoding.UTF8.GetByteCount(value) <= maxBytes) return value;
        var builder = new StringBuilder();
        var bytes = 0;
        foreach (var rune in value.EnumerateRunes())
        {
            if (bytes + rune.Utf8SequenceLength > maxBytes) break;
            builder.Append(rune.ToString());
            bytes += rune.Utf8SequenceLength;
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
        bool? IsPassword,
        bool? Offscreen,
        RectDto? Bounds,
        string[] Patterns,
        string? ToggleState,
        bool? Selected,
        string? ExpandCollapseState,
        double? RangeValue,
        string? WindowVisualState,
        ControlSnapshotDto[]? Children);
}
