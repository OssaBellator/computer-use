using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;
using System.Windows.Forms;

internal static class Program
{
    private const uint WmSetText = 0x000C;
    private const uint BmClick = 0x00F5;
    private const uint WmUser = 0x0400;
    private const uint TbmGetPos = WmUser;
    private const uint TbmSetPos = WmUser + 5;
    private const int SwMinimize = 6;
    private const int SwRestore = 9;

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
    private static extern nint SendMessageText(nint hwnd, uint message, nint wParam, string lParam);

    [DllImport("user32.dll", EntryPoint = "SendMessageW")]
    private static extern nint SendMessagePtr(nint hwnd, uint message, nint wParam, nint lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(nint hwnd, StringBuilder text, int maxCount);

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
        var iterations = 1;
        if (args.Length > 1 && (!int.TryParse(args[1], out iterations) || iterations < 1 || iterations > 20))
        {
            Console.Error.WriteLine("usage: [semantic-only|raw-only|semantic-then-raw] [iterations:1..20]");
            Environment.ExitCode = 64;
            return;
        }
        if (mode is not ("semantic-only" or "raw-only" or "semantic-then-raw"))
        {
            Console.Error.WriteLine("usage: [semantic-only|raw-only|semantic-then-raw] [iterations:1..20]");
            Environment.ExitCode = 64;
            return;
        }

        Application.EnableVisualStyles();
        using var form = new Form { Text = "Ossa VM UI Smoke", Width = 520, Height = 260 };
        var input = new TextBox { Name = "InputBox", Left = 20, Top = 25, Width = 300, AccessibleName = "Task input" };
        var apply = new Button { Name = "ApplyButton", Text = "Apply", Left = 335, Top = 23, Width = 100, AccessibleName = "Apply task" };
        var range = new TrackBar { Name = "RangeControl", Left = 20, Top = 65, Width = 300, Minimum = 0, Maximum = 100, Value = 10, AccessibleName = "Task range" };
        var result = new Label { Name = "ResultLabel", Text = "RESULT:pending", Left = 20, Top = 125, Width = 440, AccessibleName = "Task result" };
        apply.Click += (_, _) => result.Text = "RESULT:" + input.Text;
        form.Controls.Add(input);
        form.Controls.Add(apply);
        form.Controls.Add(range);
        form.Controls.Add(result);

        form.Shown += (_, _) =>
        {
            _ = form.Handle;
            _ = input.Handle;
            _ = apply.Handle;
            _ = range.Handle;
            _ = result.Handle;
            var worker = new Thread(() =>
            {
                try
                {
                    var allPassed = true;
                    for (var iteration = 1; iteration <= iterations; iteration++)
                    {
                        Console.WriteLine($"SMOKE_ITERATION={iteration}/{iterations}");
                        if (mode != "raw-only")
                        {
                            var semantic = RunSemanticTasks(form.Handle, input.Handle, apply.Handle, range.Handle, result.Handle);
                            if (semantic) continue;
                            if (mode == "semantic-only")
                            {
                                allPassed = false;
                                break;
                            }
                        }

                        if (!RunRawTasks(form.Handle, input.Handle, apply.Handle, range.Handle, result.Handle))
                        {
                            allPassed = false;
                            break;
                        }
                    }
                    Environment.ExitCode = allPassed ? 0 : mode == "semantic-only" ? 4 : 3;
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine(ex.ToString());
                    Environment.ExitCode = 2;
                }
                finally
                {
                    form.BeginInvoke(new Action(form.Close));
                }
            });
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
        };

        Application.Run(form);
    }

    private static bool RunSemanticTasks(nint formHandle, nint inputHandle, nint applyHandle, nint rangeHandle, nint resultHandle)
    {
        try
        {
            var root = AutomationElement.FromHandle(formHandle);
            var edit = AutomationElement.FromHandle(inputHandle);
            var button = AutomationElement.FromHandle(applyHandle);
            var slider = AutomationElement.FromHandle(rangeHandle);
            Console.WriteLine($"SEMANTIC_CONTROLS=edit:{edit.Current.ControlType.ProgrammaticName}:button:{button.Current.ControlType.ProgrammaticName}:range:{slider.Current.ControlType.ProgrammaticName}");
            var hasValue = edit.TryGetCurrentPattern(ValuePattern.Pattern, out var rawValue);
            var hasInvoke = button.TryGetCurrentPattern(InvokePattern.Pattern, out var rawInvoke);
            var hasRange = slider.TryGetCurrentPattern(RangeValuePattern.Pattern, out var rawRange);
            var hasWindow = root.TryGetCurrentPattern(WindowPattern.Pattern, out var rawWindow);
            Console.WriteLine($"SEMANTIC_PATTERNS=value:{hasValue}:invoke:{hasInvoke}:range:{hasRange}:window:{hasWindow}");

            var textPassed = false;
            if (hasValue && hasInvoke)
            {
                ((ValuePattern)rawValue!).SetValue("VM-SEMANTIC-TASK");
                ((InvokePattern)rawInvoke!).Invoke();
                Thread.Sleep(150);
                var editVerify = AutomationElement.FromHandle(inputHandle);
                var semanticEditValue = editVerify.TryGetCurrentPattern(ValuePattern.Pattern, out var rawVerifyValue)
                    ? ((ValuePattern)rawVerifyValue).Current.Value
                    : null;
                var semanticResult = WindowText(resultHandle);
                textPassed = semanticEditValue == "VM-SEMANTIC-TASK" && semanticResult == "RESULT:VM-SEMANTIC-TASK";
                Console.WriteLine($"SEMANTIC_TEXT_BUTTON={(textPassed ? "pass" : "fail")}");
                Console.WriteLine($"SEMANTIC_EDIT_VALUE={semanticEditValue}");
                Console.WriteLine($"SEMANTIC_RESULT={semanticResult}");
            }
            else Console.WriteLine("SEMANTIC_TEXT_BUTTON=unsupported");

            var rangePassed = false;
            if (hasRange)
            {
                var rangePattern = (RangeValuePattern)rawRange!;
                rangePattern.SetValue(73);
                Thread.Sleep(100);
                var rangeValue = rangePattern.Current.Value;
                rangePassed = Math.Abs(rangeValue - 73) < 0.001;
                Console.WriteLine($"SEMANTIC_RANGE={(rangePassed ? "pass" : "fail")}:value={rangeValue}");
            }
            else Console.WriteLine("SEMANTIC_RANGE=unsupported");

            var windowPassed = false;
            if (hasWindow)
            {
                var windowPattern = (WindowPattern)rawWindow!;
                windowPattern.SetWindowVisualState(WindowVisualState.Minimized);
                Thread.Sleep(100);
                var minimized = windowPattern.Current.WindowVisualState == WindowVisualState.Minimized;
                windowPattern.SetWindowVisualState(WindowVisualState.Normal);
                Thread.Sleep(100);
                var restored = windowPattern.Current.WindowVisualState == WindowVisualState.Normal;
                windowPassed = minimized && restored;
                Console.WriteLine($"SEMANTIC_WINDOW_STATE={(windowPassed ? "pass" : "fail")}:minimized={minimized}:restored={restored}");
            }
            else Console.WriteLine("SEMANTIC_WINDOW_STATE=unsupported");

            var allSupported = hasValue && hasInvoke && hasRange && hasWindow;
            var allPassed = allSupported && textPassed && rangePassed && windowPassed;
            Console.WriteLine(allPassed ? "SEMANTIC_STATUS=completed" : allSupported ? "SEMANTIC_STATUS=verification-mismatch" : "SEMANTIC_STATUS=pattern-unavailable");
            return allPassed;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"SEMANTIC_STATUS=blocked:{ex.GetType().Name}:0x{ex.HResult:X8}");
            return false;
        }
    }

    private static bool RunRawTasks(nint formHandle, nint inputHandle, nint applyHandle, nint rangeHandle, nint resultHandle)
    {
        SendMessageText(inputHandle, WmSetText, 0, "VM-RAW-TASK");
        SendMessagePtr(applyHandle, BmClick, 0, 0);
        Thread.Sleep(150);
        var resultText = WindowText(resultHandle);
        var inputText = WindowText(inputHandle);
        var textTaskPassed = resultText == "RESULT:VM-RAW-TASK" && inputText == "VM-RAW-TASK";
        Console.WriteLine($"RAW_TEXT_BUTTON={(textTaskPassed ? "pass" : "fail")}");
        Console.WriteLine($"RAW_OBSERVED={resultText}");
        Console.WriteLine($"RAW_EDIT_VALUE={inputText}");

        SendMessagePtr(rangeHandle, TbmSetPos, 1, 73);
        Thread.Sleep(100);
        var rangeState = SendMessagePtr(rangeHandle, TbmGetPos, 0, 0).ToInt64();
        var rangePassed = rangeState == 73;
        Console.WriteLine($"RAW_RANGE={(rangePassed ? "pass" : "fail")}:value={rangeState}");

        ShowWindow(formHandle, SwMinimize);
        Thread.Sleep(100);
        var minimized = IsIconic(formHandle);
        ShowWindow(formHandle, SwRestore);
        Thread.Sleep(100);
        var restored = !IsIconic(formHandle);
        var windowPassed = minimized && restored;
        Console.WriteLine($"RAW_WINDOW_STATE={(windowPassed ? "pass" : "fail")}:minimized={minimized}:restored={restored}");

        var allPassed = textTaskPassed && rangePassed && windowPassed;
        Console.WriteLine(allPassed ? "RAW_STATUS=completed" : "RAW_STATUS=verification-mismatch");
        return allPassed;
    }

    private static string WindowText(nint hwnd)
    {
        var text = new StringBuilder(512);
        GetWindowTextW(hwnd, text, text.Capacity);
        return text.ToString();
    }
}
