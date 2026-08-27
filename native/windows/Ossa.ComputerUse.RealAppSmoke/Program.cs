using System.Diagnostics;
using System.Windows.Automation;

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        Console.WriteLine("REAL_APP_SMOKE_BEGIN");
        var calculator = RunCalculator();
        var notepad = RunNotepadObservation();
        var passed = calculator && notepad;
        Console.WriteLine($"REAL_APP_SMOKE_STATUS={(passed ? "completed" : "blocked")}");
        return passed ? 0 : 3;
    }

    private static bool RunCalculator()
    {
        AutomationElement? window = null;
        try
        {
            static bool IsCalculator(string name) => name.Equals("Calculator", StringComparison.OrdinalIgnoreCase) || name.EndsWith(" Calculator", StringComparison.OrdinalIgnoreCase);
            var priorWindows = CaptureTopLevelHandles(IsCalculator);
            StartApp("calc.exe");
            window = WaitForTopLevelWindow(IsCalculator, priorWindows);
            if (window is null)
            {
                Console.WriteLine("CALCULATOR_STATUS=window-unavailable");
                return false;
            }

            Console.WriteLine($"CALCULATOR_WINDOW=framework:{SafeCurrent(window, AutomationElement.FrameworkIdProperty)}:class:{SafeCurrent(window, AutomationElement.ClassNameProperty)}");
            var controls = new[]
            {
                new { Id = "num7Button", Names = new[] { "Seven", "7" } },
                new { Id = "plusButton", Names = new[] { "Plus", "+" } },
                new { Id = "num5Button", Names = new[] { "Five", "5" } },
                new { Id = "equalButton", Names = new[] { "Equals", "=" } },
            };
            foreach (var control in controls)
            {
                var button = FindInvokableControl(window, control.Id, control.Names);
                if (button is null || !button.TryGetCurrentPattern(InvokePattern.Pattern, out var rawInvoke))
                {
                    Console.WriteLine($"CALCULATOR_INVOKE=unsupported:{control.Id}");
                    DumpDescendants(window, "CALCULATOR");
                    return false;
                }
                Console.WriteLine($"CALCULATOR_CONTROL=id:{button.Current.AutomationId}:name:{button.Current.Name}");
                ((InvokePattern)rawInvoke).Invoke();
                Thread.Sleep(120);
            }

            var result = FindByAutomationId(window, "CalculatorResults");
            var resultName = result?.Current.Name ?? string.Empty;
            var resultPassed = resultName.Contains("12", StringComparison.Ordinal);
            Console.WriteLine("CALCULATOR_INVOKE=pass");
            Console.WriteLine($"CALCULATOR_RESULT_NAME={resultName}");
            Console.WriteLine($"CALCULATOR_RESULT={(resultPassed ? "pass" : "fail")}");
            Console.WriteLine($"CALCULATOR_STATUS={(resultPassed ? "completed" : "verification-mismatch")}");
            return resultPassed;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"CALCULATOR_STATUS=blocked:{ex.GetType().Name}:0x{ex.HResult:X8}");
            return false;
        }
        finally
        {
            CloseWindow(window);
        }
    }

    private static bool RunNotepadObservation()
    {
        AutomationElement? window = null;
        try
        {
            static bool IsNotepad(string name) => name.Contains("Notepad", StringComparison.OrdinalIgnoreCase);
            var priorWindows = CaptureTopLevelHandles(IsNotepad);
            StartApp("notepad.exe");
            window = WaitForTopLevelWindow(IsNotepad, priorWindows);
            if (window is null)
            {
                Console.WriteLine("NOTEPAD_STATUS=window-unavailable");
                return false;
            }

            Console.WriteLine($"NOTEPAD_WINDOW=framework:{SafeCurrent(window, AutomationElement.FrameworkIdProperty)}:class:{SafeCurrent(window, AutomationElement.ClassNameProperty)}");
            var content = WaitForControl(window, candidate =>
            {
                var type = candidate.Current.ControlType;
                return type == ControlType.Document || type == ControlType.Edit;
            });
            if (content is null)
            {
                Console.WriteLine("NOTEPAD_STATUS=content-control-unavailable");
                DumpDescendants(window, "NOTEPAD");
                return false;
            }

            var hasText = content.TryGetCurrentPattern(TextPattern.Pattern, out _);
            var hasValue = content.TryGetCurrentPattern(ValuePattern.Pattern, out var rawValue);
            var hasScroll = content.TryGetCurrentPattern(ScrollPattern.Pattern, out _);
            Console.WriteLine($"NOTEPAD_CONTENT=type:{content.Current.ControlType.ProgrammaticName}:framework:{SafeCurrent(content, AutomationElement.FrameworkIdProperty)}:class:{SafeCurrent(content, AutomationElement.ClassNameProperty)}");
            Console.WriteLine($"NOTEPAD_PATTERNS=text:{hasText}:value:{hasValue}:scroll:{hasScroll}");
            Console.WriteLine("NOTEPAD_GROUNDING=pass");
            if (!hasValue || rawValue is not ValuePattern valuePattern)
            {
                Console.WriteLine("NOTEPAD_VALUE=unsupported");
                Console.WriteLine("NOTEPAD_STATUS=blocked");
                return false;
            }
            const string probe = "Ossa semantic real-app probe";
            valuePattern.SetValue(probe);
            Thread.Sleep(120);
            var observed = valuePattern.Current.Value;
            var verified = StringComparer.Ordinal.Equals(observed, probe);
            Console.WriteLine("NOTEPAD_VALUE=dispatched-once");
            Console.WriteLine($"NOTEPAD_VERIFY={(verified ? "pass" : "mismatch")}");
            Console.WriteLine($"NOTEPAD_STATUS={(verified ? "completed" : "verification-mismatch")}");
            return verified;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"NOTEPAD_STATUS=blocked:{ex.GetType().Name}:0x{ex.HResult:X8}");
            return false;
        }
        finally
        {
            CloseWindow(window);
        }
    }

    private static void StartApp(string fileName)
    {
        _ = Process.Start(new ProcessStartInfo(fileName) { UseShellExecute = true });
    }

    private static HashSet<int> CaptureTopLevelHandles(Func<string, bool> predicate)
    {
        var handles = new HashSet<int>();
        var windows = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
        for (var i = 0; i < windows.Count; i++)
        {
            var candidate = windows[i];
            try
            {
                if (predicate(candidate.Current.Name) && candidate.Current.NativeWindowHandle != 0)
                    handles.Add(candidate.Current.NativeWindowHandle);
            }
            catch (ElementNotAvailableException) { }
        }
        return handles;
    }

    private static AutomationElement? WaitForTopLevelWindow(Func<string, bool> predicate, IReadOnlySet<int>? excludedHandles = null)
    {
        var deadline = DateTime.UtcNow.AddSeconds(12);
        while (DateTime.UtcNow < deadline)
        {
            var windows = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
            for (var i = 0; i < windows.Count; i++)
            {
                var candidate = windows[i];
                try
                {
                    var current = candidate.Current;
                    if (predicate(current.Name) && (current.NativeWindowHandle == 0 || excludedHandles is null || !excludedHandles.Contains(current.NativeWindowHandle)))
                        return candidate;
                }
                catch (ElementNotAvailableException) { continue; }
            }
            Thread.Sleep(200);
        }
        return null;
    }

    private static AutomationElement? FindByAutomationId(AutomationElement root, string automationId)
    {
        return root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, automationId));
    }

    private static AutomationElement? WaitForControl(AutomationElement root, Func<AutomationElement, bool> predicate)
    {
        var deadline = DateTime.UtcNow.AddSeconds(8);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var descendants = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
                for (var i = 0; i < descendants.Count; i++)
                {
                    var candidate = descendants[i];
                    try { if (predicate(candidate)) return candidate; }
                    catch (ElementNotAvailableException) { }
                }
            }
            catch (ElementNotAvailableException) { }
            Thread.Sleep(160);
        }
        return null;
    }

    private static AutomationElement? FindInvokableControl(AutomationElement root, string automationId, IReadOnlyCollection<string> semanticNames)
    {
        var byId = FindByAutomationId(root, automationId);
        if (IsInvokable(byId)) return byId;

        var descendants = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        for (var i = 0; i < descendants.Count; i++)
        {
            var candidate = descendants[i];
            if (!IsInvokable(candidate)) continue;
            string name;
            try { name = candidate.Current.Name; }
            catch (ElementNotAvailableException) { continue; }
            if (semanticNames.Any(expected => StringComparer.OrdinalIgnoreCase.Equals(expected, name))) return candidate;
        }
        return null;
    }

    private static bool IsInvokable(AutomationElement? element)
    {
        if (element is null) return false;
        try { return element.Current.IsEnabled && element.TryGetCurrentPattern(InvokePattern.Pattern, out _); }
        catch (ElementNotAvailableException) { return false; }
    }

    private static void DumpDescendants(AutomationElement root, string prefix)
    {
        try
        {
            var descendants = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
            var count = Math.Min(descendants.Count, 80);
            Console.WriteLine($"{prefix}_TREE_COUNT={descendants.Count}");
            for (var i = 0; i < count; i++)
            {
                var element = descendants[i];
                try
                {
                    Console.WriteLine($"{prefix}_TREE[{i}]=name:{element.Current.Name}:id:{element.Current.AutomationId}:type:{element.Current.ControlType.ProgrammaticName}:framework:{SafeCurrent(element, AutomationElement.FrameworkIdProperty)}:class:{SafeCurrent(element, AutomationElement.ClassNameProperty)}");
                }
                catch (ElementNotAvailableException)
                {
                    Console.WriteLine($"{prefix}_TREE[{i}]=unavailable");
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"{prefix}_TREE=blocked:{ex.GetType().Name}:0x{ex.HResult:X8}");
        }
    }

    private static object SafeCurrent(AutomationElement element, AutomationProperty property)
    {
        try { return element.GetCurrentPropertyValue(property, true) ?? string.Empty; }
        catch (ElementNotAvailableException) { return "unavailable"; }
    }

    private static void CloseWindow(AutomationElement? window)
    {
        if (window is null) return;
        try
        {
            if (window.TryGetCurrentPattern(WindowPattern.Pattern, out var rawWindow))
                ((WindowPattern)rawWindow).Close();
        }
        catch (Exception) { }
    }
}
