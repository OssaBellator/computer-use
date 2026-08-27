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
            StartApp("calc.exe");
            window = WaitForTopLevelWindow(name => name.Equals("Calculator", StringComparison.OrdinalIgnoreCase) || name.EndsWith(" Calculator", StringComparison.OrdinalIgnoreCase));
            if (window is null)
            {
                Console.WriteLine("CALCULATOR_STATUS=window-unavailable");
                return false;
            }

            Console.WriteLine($"CALCULATOR_WINDOW=framework:{SafeCurrent(window, AutomationElement.FrameworkIdProperty)}:class:{SafeCurrent(window, AutomationElement.ClassNameProperty)}");
            var ids = new[] { "num7Button", "plusButton", "num5Button", "equalButton" };
            foreach (var id in ids)
            {
                var button = FindByAutomationId(window, id);
                if (button is null || !button.TryGetCurrentPattern(InvokePattern.Pattern, out var rawInvoke))
                {
                    Console.WriteLine($"CALCULATOR_INVOKE=unsupported:{id}");
                    return false;
                }
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
            StartApp("notepad.exe");
            window = WaitForTopLevelWindow(name => name.Contains("Notepad", StringComparison.OrdinalIgnoreCase));
            if (window is null)
            {
                Console.WriteLine("NOTEPAD_STATUS=window-unavailable");
                return false;
            }

            Console.WriteLine($"NOTEPAD_WINDOW=framework:{SafeCurrent(window, AutomationElement.FrameworkIdProperty)}:class:{SafeCurrent(window, AutomationElement.ClassNameProperty)}");
            var descendants = window.FindAll(TreeScope.Descendants, Condition.TrueCondition);
            AutomationElement? content = null;
            for (var i = 0; i < descendants.Count; i++)
            {
                var candidate = descendants[i];
                var type = candidate.Current.ControlType;
                if (type == ControlType.Document || type == ControlType.Edit)
                {
                    content = candidate;
                    break;
                }
            }
            if (content is null)
            {
                Console.WriteLine("NOTEPAD_STATUS=content-control-unavailable");
                return false;
            }

            var hasText = content.TryGetCurrentPattern(TextPattern.Pattern, out _);
            var hasValue = content.TryGetCurrentPattern(ValuePattern.Pattern, out _);
            var hasScroll = content.TryGetCurrentPattern(ScrollPattern.Pattern, out _);
            Console.WriteLine($"NOTEPAD_CONTENT=type:{content.Current.ControlType.ProgrammaticName}:framework:{SafeCurrent(content, AutomationElement.FrameworkIdProperty)}:class:{SafeCurrent(content, AutomationElement.ClassNameProperty)}");
            Console.WriteLine($"NOTEPAD_PATTERNS=text:{hasText}:value:{hasValue}:scroll:{hasScroll}");
            Console.WriteLine("NOTEPAD_GROUNDING=pass");
            Console.WriteLine("NOTEPAD_STATUS=completed");
            return true;
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

    private static AutomationElement? WaitForTopLevelWindow(Func<string, bool> predicate)
    {
        var deadline = DateTime.UtcNow.AddSeconds(12);
        while (DateTime.UtcNow < deadline)
        {
            var windows = AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition);
            for (var i = 0; i < windows.Count; i++)
            {
                var candidate = windows[i];
                string name;
                try { name = candidate.Current.Name; }
                catch (ElementNotAvailableException) { continue; }
                if (predicate(name)) return candidate;
            }
            Thread.Sleep(200);
        }
        return null;
    }

    private static AutomationElement? FindByAutomationId(AutomationElement root, string automationId)
    {
        return root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, automationId));
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
