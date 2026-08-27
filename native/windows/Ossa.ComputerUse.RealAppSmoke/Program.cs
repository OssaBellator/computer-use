using System.Diagnostics;
using System.Windows.Automation;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        Console.WriteLine("REAL_APP_SMOKE_BEGIN");
        var mode = args.Length == 0 ? "all" : args[0].Trim().ToLowerInvariant();
        if (mode is not ("all" or "calculator" or "notepad" or "explorer"))
        {
            Console.WriteLine("REAL_APP_SMOKE_STATUS=invalid-mode");
            return 2;
        }
        var calculator = mode is "notepad" or "explorer" || RunCalculator();
        var notepad = mode is "calculator" or "explorer" || RunNotepadObservation();
        var explorer = mode is "calculator" or "notepad" || RunExplorer();
        var passed = calculator && notepad && explorer;
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
                var button = WaitForInvokableControl(window, control.Id, control.Names);
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

            var result = WaitForControl(window, candidate =>
                StringComparer.Ordinal.Equals(candidate.Current.AutomationId, "CalculatorResults") ||
                candidate.Current.Name.Contains("Display is", StringComparison.OrdinalIgnoreCase));
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
            var verified = WaitForValue(valuePattern, probe);
            Console.WriteLine("NOTEPAD_VALUE=dispatched-once");
            Console.WriteLine($"NOTEPAD_VERIFY={(verified ? "pass" : "mismatch")}");
            if (!verified)
            {
                Console.WriteLine("NOTEPAD_STATUS=verification-mismatch");
                return false;
            }
            valuePattern.SetValue(string.Empty);
            var cleared = WaitForValue(valuePattern, string.Empty);
            Console.WriteLine($"NOTEPAD_CLEAR_VERIFY={(cleared ? "pass" : "mismatch")}");
            Console.WriteLine($"NOTEPAD_STATUS={(cleared ? "completed" : "verification-mismatch")}");
            return cleared;
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

    private static bool RunExplorer()
    {
        AutomationElement? window = null;
        try
        {
            static bool IsExplorer(string name) => name.EndsWith("File Explorer", StringComparison.OrdinalIgnoreCase);
            var priorWindows = CaptureTopLevelHandles(IsExplorer);
            StartApp("explorer.exe");
            window = WaitForTopLevelWindow(IsExplorer, priorWindows);
            if (window is null)
            {
                Console.WriteLine("EXPLORER_STATUS=window-unavailable");
                return false;
            }

            Console.WriteLine($"EXPLORER_WINDOW=framework:{SafeCurrent(window, AutomationElement.FrameworkIdProperty)}:class:{SafeCurrent(window, AutomationElement.ClassNameProperty)}");
            var addButton = WaitForInvokableControl(window, "AddButton", new[] { "Add New Tab" });
            if (addButton is null || !addButton.TryGetCurrentPattern(InvokePattern.Pattern, out var rawAdd))
            {
                Console.WriteLine("EXPLORER_ADD_TAB=unsupported");
                DumpDescendants(window, "EXPLORER");
                return false;
            }

            var baselineTitle = window.Current.Name;
            ((InvokePattern)rawAdd).Invoke();
            var added = WaitForWindowNameChange(window, baselineTitle);
            var addedTitle = SafeCurrent(window, AutomationElement.NameProperty)?.ToString() ?? string.Empty;
            Console.WriteLine("EXPLORER_ADD_TAB=dispatched-once");
            Console.WriteLine($"EXPLORER_ADD_VERIFY={(added ? "pass" : "mismatch")}:baseline:{baselineTitle}:after:{addedTitle}");
            if (!added)
            {
                Console.WriteLine("EXPLORER_STATUS=verification-mismatch");
                return false;
            }

            var closeButton = WaitForSelectedTabCloseButton(window);
            if (closeButton is null || !closeButton.TryGetCurrentPattern(InvokePattern.Pattern, out var rawClose))
            {
                Console.WriteLine("EXPLORER_CLOSE_TAB=unsupported");
                return false;
            }
            ((InvokePattern)rawClose).Invoke();
            var restored = WaitForWindowName(window, baselineTitle);
            var restoredTitle = SafeCurrent(window, AutomationElement.NameProperty)?.ToString() ?? string.Empty;
            Console.WriteLine("EXPLORER_CLOSE_TAB=dispatched-once");
            Console.WriteLine($"EXPLORER_CLOSE_VERIFY={(restored ? "pass" : "mismatch")}:expected:{baselineTitle}:actual:{restoredTitle}");
            Console.WriteLine($"EXPLORER_STATUS={(restored ? "completed" : "verification-mismatch")}");
            return restored;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"EXPLORER_STATUS=blocked:{ex.GetType().Name}:0x{ex.HResult:X8}");
            return false;
        }
        finally
        {
            CloseWindow(window);
        }
    }

    private static int CountTabCloseButtons(AutomationElement root)
    {
        try
        {
            var tabList = FindByAutomationId(root, "TabListView");
            if (tabList is null) return -1;
            var descendants = tabList.FindAll(TreeScope.Descendants, Condition.TrueCondition);
            var count = 0;
            for (var i = 0; i < descendants.Count; i++)
            {
                var candidate = descendants[i];
                try
                {
                    if (candidate.Current.AutomationId == "CloseButton" &&
                        candidate.Current.ControlType == ControlType.Button &&
                        candidate.TryGetCurrentPattern(InvokePattern.Pattern, out _))
                        count += 1;
                }
                catch (ElementNotAvailableException) { }
            }
            return count;
        }
        catch (ElementNotAvailableException) { return -1; }
    }

    private static AutomationElement? WaitForSelectedTabCloseButton(AutomationElement root)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var tabList = FindByAutomationId(root, "TabListView");
                if (tabList is null) return null;
                var descendants = tabList.FindAll(TreeScope.Descendants, Condition.TrueCondition);
                for (var i = 0; i < descendants.Count; i++)
                {
                    var tab = descendants[i];
                    try
                    {
                        if (tab.Current.ControlType != ControlType.TabItem ||
                            !tab.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var rawSelection) ||
                            !((SelectionItemPattern)rawSelection).Current.IsSelected)
                            continue;
                        var close = FindByAutomationId(tab, "CloseButton");
                        if (IsInvokable(close)) return close;
                    }
                    catch (ElementNotAvailableException) { }
                }
            }
            catch (ElementNotAvailableException) { }
            Thread.Sleep(100);
        }
        return null;
    }

    private static bool WaitForWindowNameChange(AutomationElement window, string baseline)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            try { if (!StringComparer.Ordinal.Equals(window.Current.Name, baseline)) return true; }
            catch (ElementNotAvailableException) { return false; }
            Thread.Sleep(100);
        }
        return false;
    }

    private static bool WaitForWindowName(AutomationElement window, string expected)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            try { if (StringComparer.Ordinal.Equals(window.Current.Name, expected)) return true; }
            catch (ElementNotAvailableException) { return false; }
            Thread.Sleep(100);
        }
        return false;
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

    private static AutomationElement? WaitForInvokableControl(AutomationElement root, string automationId, IReadOnlyCollection<string> semanticNames)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            try
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
            }
            catch (ElementNotAvailableException) { }
            Thread.Sleep(160);
        }
        return null;
    }

    private static bool IsInvokable(AutomationElement? element)
    {
        if (element is null) return false;
        try { return element.Current.IsEnabled && element.TryGetCurrentPattern(InvokePattern.Pattern, out _); }
        catch (ElementNotAvailableException) { return false; }
    }

    private static bool WaitForValue(ValuePattern pattern, string expected)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                if (StringComparer.Ordinal.Equals(pattern.Current.Value, expected)) return true;
            }
            catch (ElementNotAvailableException) { return false; }
            catch (InvalidOperationException) { return false; }
            Thread.Sleep(100);
        }
        return false;
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
