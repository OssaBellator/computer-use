using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Threading;

internal static class Program
{
    private enum SemanticRunResult { Completed, UnavailableBeforeDispatch, UncertainAfterDispatch }
    private const uint KeyEventKeyUp = 0x0002;
    private const uint KeyEventUnicode = 0x0004;
    private const uint MouseLeftDown = 0x0002;
    private const uint MouseLeftUp = 0x0004;
    private const int SwMinimize = 6;
    private const int SwRestore = 9;
    private const byte VkControl = 0x11;
    private const byte VkA = 0x41;
    private const byte VkTab = 0x09;
    private const byte VkReturn = 0x0D;
    private const byte VkSpace = 0x20;
    private const byte VkHome = 0x24;
    private const byte VkEnd = 0x23;
    private const byte VkRight = 0x27;

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint Type;
        public InputUnion Union;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public KeybdInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeybdInput
    {
        public ushort VirtualKey;
        public ushort ScanCode;
        public uint Flags;
        public uint Time;
        public nuint ExtraInfo;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(nint hwnd);

    [DllImport("user32.dll")]
    private static extern nint GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ClientToScreen(nint hwnd, ref Point point);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, nuint extraInfo);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, nuint extraInfo);

    [DllImport("user32.dll")]
    private static extern uint SendInput(uint count, Input[] inputs, int size);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(nint hwnd, int command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(nint hwnd);

    [STAThread]
    private static void Main(string[] args)
    {
        var mode = args.Length == 0 ? "semantic-then-raw" : args[0];
        if (mode is not ("semantic-only" or "raw-only" or "semantic-then-raw"))
        {
            Console.Error.WriteLine("usage: [semantic-only|raw-only|semantic-then-raw]");
            Environment.ExitCode = 64;
            return;
        }

        var app = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
        var window = BuildWindow(mode);
        app.Run(window);
    }

    private static Window BuildWindow(string mode)
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
            var worker = new Thread(() => RunTasks(window.Dispatcher, window, hwnd, mode, input, result, check, slider, beta));
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
        };
        return window;
    }

    private static void RunTasks(Dispatcher dispatcher, Window window, nint hwnd, string mode, TextBox input, TextBlock result, CheckBox check, Slider slider, ListBoxItem beta)
    {
        try
        {
            if (mode != "raw-only")
            {
                var semantic = RunSemanticTasks(hwnd);
                if (semantic == SemanticRunResult.Completed)
                {
                    Environment.ExitCode = 0;
                    return;
                }
                if (semantic == SemanticRunResult.UncertainAfterDispatch)
                {
                    Console.WriteLine("WPF_FALLBACK=blocked-after-possible-semantic-dispatch");
                    Environment.ExitCode = 5;
                    return;
                }
                if (mode == "semantic-only")
                {
                    Environment.ExitCode = 4;
                    return;
                }
                Console.WriteLine("WPF_FALLBACK=raw-after-semantic-unavailable-before-dispatch");
            }

            Environment.ExitCode = RunRawTasks(dispatcher, window, hwnd, input, result, check, slider, beta) ? 0 : 3;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            Environment.ExitCode = 2;
        }
        finally
        {
            dispatcher.BeginInvokeShutdown(DispatcherPriority.Normal);
        }
    }

    private static SemanticRunResult RunSemanticTasks(nint hwnd)
    {
        var actionBoundaryCrossed = false;
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
            var allSupported = hasValue && hasInvoke && hasToggle && hasRange && hasSelection && hasWindow;
            if (!allSupported)
            {
                Console.WriteLine("WPF_STATUS=pattern-unavailable-before-dispatch");
                return SemanticRunResult.UnavailableBeforeDispatch;
            }

            actionBoundaryCrossed = true;
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

            var allPassed = textPassed && togglePassed && rangePassed && selectionPassed && windowPassed;
            Console.WriteLine(allPassed ? "WPF_STATUS=completed" : "WPF_STATUS=verification-mismatch-after-dispatch");
            return allPassed ? SemanticRunResult.Completed : SemanticRunResult.UncertainAfterDispatch;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"WPF_STATUS=blocked:{ex.GetType().Name}:0x{ex.HResult:X8}");
            return actionBoundaryCrossed ? SemanticRunResult.UncertainAfterDispatch : SemanticRunResult.UnavailableBeforeDispatch;
        }
    }

    private static bool RunRawTasks(Dispatcher dispatcher, Window window, nint hwnd, TextBox input, TextBlock result, CheckBox check, Slider slider, ListBoxItem beta)
    {
        dispatcher.Invoke(() =>
        {
            window.Activate();
            input.Focus();
            Keyboard.Focus(input);
        });
        Console.WriteLine("RAW_WPF_FOCUS_SETUP=application-assisted-test-harness");
        Thread.Sleep(100);
        var foregroundSet = SetForegroundWindow(hwnd);
        if (!foregroundSet && GetForegroundWindow() != hwnd)
        {
            Console.WriteLine("RAW_WPF_STATUS=foreground-failed");
            return false;
        }
        Thread.Sleep(150);
        var origin = new Point();
        if (!ClientToScreen(hwnd, ref origin) || !SetCursorPos(origin.X + 100, origin.Y + 32))
        {
            Console.WriteLine("RAW_WPF_STATUS=input-origin-failed");
            return false;
        }
        mouse_event(MouseLeftDown, 0, 0, 0, 0);
        mouse_event(MouseLeftUp, 0, 0, 0, 0);
        Thread.Sleep(100);

        KeyDown(VkControl); Press(VkA); KeyUp(VkControl);
        TypeUnicode("WPF-RAW-TASK");
        Press(VkTab); Press(VkReturn);
        Thread.Sleep(100);
        Press(VkTab); Press(VkSpace);
        Press(VkTab); Press(VkHome);
        for (var i = 0; i < 73; i++) Press(VkRight);
        Press(VkTab); Press(VkEnd);
        Thread.Sleep(150);

        ShowWindow(hwnd, SwMinimize);
        Thread.Sleep(100);
        var minimized = IsIconic(hwnd);
        ShowWindow(hwnd, SwRestore);
        Thread.Sleep(120);
        var restored = !IsIconic(hwnd);

        var state = dispatcher.Invoke(() => new
        {
            Input = input.Text,
            Result = result.Text,
            Checked = check.IsChecked == true,
            Range = slider.Value,
            Selected = beta.IsSelected,
        });
        var textPassed = state.Input == "WPF-RAW-TASK" && state.Result == "RESULT:WPF-RAW-TASK";
        var rangePassed = Math.Abs(state.Range - 73) < 0.001;
        var windowPassed = minimized && restored;
        Console.WriteLine($"RAW_WPF_TEXT_BUTTON={(textPassed ? "pass" : "fail")}:value={state.Input}:result={state.Result}");
        Console.WriteLine($"RAW_WPF_TOGGLE={(state.Checked ? "pass" : "fail")}:checked={state.Checked}");
        Console.WriteLine($"RAW_WPF_RANGE={(rangePassed ? "pass" : "fail")}:value={state.Range}");
        Console.WriteLine($"RAW_WPF_SELECTION={(state.Selected ? "pass" : "fail")}:selected={state.Selected}");
        Console.WriteLine($"RAW_WPF_WINDOW={(windowPassed ? "pass" : "fail")}:minimized={minimized}:restored={restored}");
        var allPassed = textPassed && state.Checked && rangePassed && state.Selected && windowPassed;
        Console.WriteLine(allPassed ? "RAW_WPF_STATUS=completed" : "RAW_WPF_STATUS=verification-mismatch");
        return allPassed;
    }

    private static AutomationElement Find(AutomationElement root, string automationId)
    {
        return root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, automationId))
            ?? throw new InvalidOperationException($"uia-element-not-found:{automationId}");
    }

    private static void Press(byte key)
    {
        KeyDown(key);
        KeyUp(key);
        Thread.Sleep(8);
    }

    private static void KeyDown(byte key) => keybd_event(key, 0, 0, 0);
    private static void KeyUp(byte key) => keybd_event(key, 0, KeyEventKeyUp, 0);

    private static void TypeUnicode(string value)
    {
        foreach (var character in value)
        {
            var down = new Input { Type = 1, Union = new InputUnion { Keyboard = new KeybdInput { ScanCode = character, Flags = KeyEventUnicode } } };
            var up = new Input { Type = 1, Union = new InputUnion { Keyboard = new KeybdInput { ScanCode = character, Flags = KeyEventUnicode | KeyEventKeyUp } } };
            var inputs = new[] { down, up };
            if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>()) != inputs.Length)
                throw new InvalidOperationException("raw-wpf-send-input-failed");
        }
    }
}
