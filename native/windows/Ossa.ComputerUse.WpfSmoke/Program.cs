using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Threading;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
        var window = BuildWindow();
        app.Run(window);
    }

    private static Window BuildWindow()
    {
        var window = new Window
        {
            Title = "Ossa WPF UI Smoke",
            Width = 560,
            Height = 430,
            WindowStartupLocation = WindowStartupLocation.CenterScreen,
        };
        AutomationProperties.SetAutomationId(window, "RootWindow");

        var panel = new StackPanel { Margin = new Thickness(20) };
        var input = new TextBox { Width = 420, Margin = new Thickness(0, 0, 0, 10) };
        AutomationProperties.SetAutomationId(input, "InputBox");
        AutomationProperties.SetName(input, "Task input");

        var apply = new Button { Content = "Apply", Width = 120, Margin = new Thickness(0, 0, 0, 10) };
        AutomationProperties.SetAutomationId(apply, "ApplyButton");
        AutomationProperties.SetName(apply, "Apply task");

        var check = new CheckBox { Content = "Enabled", IsChecked = false, Margin = new Thickness(0, 0, 0, 10) };
        AutomationProperties.SetAutomationId(check, "ToggleControl");
        AutomationProperties.SetName(check, "Task toggle");

        var slider = new Slider { Minimum = 0, Maximum = 100, Value = 10, Width = 420, Margin = new Thickness(0, 0, 0, 10) };
        AutomationProperties.SetAutomationId(slider, "RangeControl");
        AutomationProperties.SetName(slider, "Task range");

        var list = new ListBox { Height = 90, Width = 420, Margin = new Thickness(0, 0, 0, 10) };
        AutomationProperties.SetAutomationId(list, "SelectionControl");
        var alpha = new ListBoxItem { Content = "Alpha" };
        var beta = new ListBoxItem { Content = "Beta" };
        AutomationProperties.SetAutomationId(alpha, "SelectionAlpha");
        AutomationProperties.SetAutomationId(beta, "SelectionBeta");
        list.Items.Add(alpha);
        list.Items.Add(beta);

        var result = new TextBlock { Text = "RESULT:pending", Margin = new Thickness(0, 8, 0, 0) };
        AutomationProperties.SetAutomationId(result, "ResultLabel");
        AutomationProperties.SetName(result, "RESULT:pending");
        apply.Click += (_, _) =>
        {
            result.Text = "RESULT:" + input.Text;
            AutomationProperties.SetName(result, result.Text);
        };

        panel.Children.Add(input);
        panel.Children.Add(apply);
        panel.Children.Add(check);
        panel.Children.Add(slider);
        panel.Children.Add(list);
        panel.Children.Add(result);
        window.Content = panel;

        window.ContentRendered += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(window).Handle;
            var worker = new Thread(() => RunSemanticTasks(window.Dispatcher, hwnd));
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
        };
        return window;
    }

    private static void RunSemanticTasks(Dispatcher dispatcher, nint hwnd)
    {
        try
        {
            Thread.Sleep(150);
            var root = AutomationElement.FromHandle(hwnd);
            var input = Find(root, "InputBox");
            var apply = Find(root, "ApplyButton");
            var toggle = Find(root, "ToggleControl");
            var slider = Find(root, "RangeControl");
            var beta = Find(root, "SelectionBeta");

            var hasValue = input.TryGetCurrentPattern(ValuePattern.Pattern, out var rawValue);
            var hasInvoke = apply.TryGetCurrentPattern(InvokePattern.Pattern, out var rawInvoke);
            var hasToggle = toggle.TryGetCurrentPattern(TogglePattern.Pattern, out var rawToggle);
            var hasRange = slider.TryGetCurrentPattern(RangeValuePattern.Pattern, out var rawRange);
            var hasSelection = beta.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var rawSelection);
            var hasWindow = root.TryGetCurrentPattern(WindowPattern.Pattern, out var rawWindow);
            Console.WriteLine($"WPF_PATTERNS=value:{hasValue}:invoke:{hasInvoke}:toggle:{hasToggle}:range:{hasRange}:selection:{hasSelection}:window:{hasWindow}");

            var textPassed = false;
            if (hasValue && hasInvoke)
            {
                ((ValuePattern)rawValue!).SetValue("WPF-SEMANTIC-TASK");
                ((InvokePattern)rawInvoke!).Invoke();
                Thread.Sleep(150);
                var inputVerify = Find(root, "InputBox");
                var resultVerify = Find(root, "ResultLabel");
                var textValue = inputVerify.TryGetCurrentPattern(ValuePattern.Pattern, out var verifyValue)
                    ? ((ValuePattern)verifyValue).Current.Value
                    : null;
                var resultValue = resultVerify.Current.Name;
                textPassed = textValue == "WPF-SEMANTIC-TASK" && resultValue == "RESULT:WPF-SEMANTIC-TASK";
                Console.WriteLine($"WPF_TEXT_BUTTON={(textPassed ? "pass" : "fail")}:value={textValue}:result={resultValue}");
            }
            else Console.WriteLine("WPF_TEXT_BUTTON=unsupported");

            var togglePassed = false;
            if (hasToggle)
            {
                var pattern = (TogglePattern)rawToggle!;
                pattern.Toggle();
                Thread.Sleep(100);
                togglePassed = pattern.Current.ToggleState == ToggleState.On;
                Console.WriteLine($"WPF_TOGGLE={(togglePassed ? "pass" : "fail")}:state={pattern.Current.ToggleState}");
            }
            else Console.WriteLine("WPF_TOGGLE=unsupported");

            var rangePassed = false;
            if (hasRange)
            {
                var pattern = (RangeValuePattern)rawRange!;
                pattern.SetValue(73);
                Thread.Sleep(100);
                rangePassed = Math.Abs(pattern.Current.Value - 73) < 0.001;
                Console.WriteLine($"WPF_RANGE={(rangePassed ? "pass" : "fail")}:value={pattern.Current.Value}");
            }
            else Console.WriteLine("WPF_RANGE=unsupported");

            var selectionPassed = false;
            if (hasSelection)
            {
                var pattern = (SelectionItemPattern)rawSelection!;
                pattern.Select();
                Thread.Sleep(100);
                selectionPassed = pattern.Current.IsSelected;
                Console.WriteLine($"WPF_SELECTION={(selectionPassed ? "pass" : "fail")}:selected={pattern.Current.IsSelected}");
            }
            else Console.WriteLine("WPF_SELECTION=unsupported");

            var windowPassed = false;
            if (hasWindow)
            {
                var pattern = (WindowPattern)rawWindow!;
                pattern.SetWindowVisualState(WindowVisualState.Minimized);
                Thread.Sleep(100);
                var minimized = pattern.Current.WindowVisualState == WindowVisualState.Minimized;
                pattern.SetWindowVisualState(WindowVisualState.Normal);
                Thread.Sleep(100);
                var restored = pattern.Current.WindowVisualState == WindowVisualState.Normal;
                windowPassed = minimized && restored;
                Console.WriteLine($"WPF_WINDOW={(windowPassed ? "pass" : "fail")}:minimized={minimized}:restored={restored}");
            }
            else Console.WriteLine("WPF_WINDOW=unsupported");

            var allSupported = hasValue && hasInvoke && hasToggle && hasRange && hasSelection && hasWindow;
            var allPassed = allSupported && textPassed && togglePassed && rangePassed && selectionPassed && windowPassed;
            Console.WriteLine(allPassed ? "WPF_STATUS=completed" : allSupported ? "WPF_STATUS=verification-mismatch" : "WPF_STATUS=pattern-unavailable");
            Environment.ExitCode = allPassed ? 0 : 4;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"WPF_STATUS=blocked:{ex.GetType().Name}:0x{ex.HResult:X8}");
            Environment.ExitCode = 2;
        }
        finally
        {
            dispatcher.BeginInvokeShutdown(DispatcherPriority.Normal);
        }
    }

    private static AutomationElement Find(AutomationElement root, string automationId)
    {
        return root.FindFirst(
            TreeScope.Descendants,
            new PropertyCondition(AutomationElement.AutomationIdProperty, automationId))
            ?? throw new InvalidOperationException($"uia-element-not-found:{automationId}");
    }
}
