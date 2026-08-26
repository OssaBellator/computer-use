using System.Collections.Concurrent;

namespace Ossa.ComputerUse.WindowsHost;

internal sealed class MtaExecutor : IDisposable
{
    private sealed record WorkItem(Func<object?> Operation, TaskCompletionSource<object?> Completion);

    private readonly BlockingCollection<WorkItem> _queue = new(new ConcurrentQueue<WorkItem>());
    private readonly Thread _thread;
    private readonly TaskCompletionSource<string> _started = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _disposed;

    internal MtaExecutor()
    {
        _thread = new Thread(Run)
        {
            IsBackground = true,
            Name = "ossa-computer-use-uia-mta",
        };
        _thread.SetApartmentState(ApartmentState.MTA);
        _thread.Start();
    }

    internal string ThreadToken => _started.Task.GetAwaiter().GetResult();

    internal Task<T> InvokeAsync<T>(Func<T> operation)
    {
        ArgumentNullException.ThrowIfNull(operation);
        if (Volatile.Read(ref _disposed) != 0)
        {
            throw new ObjectDisposedException(nameof(MtaExecutor));
        }

        var completion = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_queue.TryAdd(new WorkItem(() => operation(), completion)))
        {
            throw new ObjectDisposedException(nameof(MtaExecutor));
        }

        return AwaitTyped<T>(completion.Task);
    }

    private static async Task<T> AwaitTyped<T>(Task<object?> task)
    {
        var value = await task.ConfigureAwait(false);
        return value is T typed
            ? typed
            : throw new InvalidOperationException("native-mta-result-type-mismatch");
    }

    private void Run()
    {
        var hr = NativeMethods.CoInitializeEx(0, NativeMethods.COINIT_MULTITHREADED);
        // S_OK (0) and S_FALSE (1) are both successful initialization outcomes.
        if (hr < 0)
        {
            _started.TrySetException(new InvalidOperationException($"coinitializeex-failed-{hr:x8}"));
            return;
        }

        try
        {
            _started.TrySetResult($"uia-mta-{Environment.ProcessId}-{Environment.CurrentManagedThreadId}");
            foreach (var item in _queue.GetConsumingEnumerable())
            {
                try
                {
                    item.Completion.TrySetResult(item.Operation());
                }
                catch (Exception error)
                {
                    item.Completion.TrySetException(error);
                }
            }
        }
        finally
        {
            NativeMethods.CoUninitialize();
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }
        _queue.CompleteAdding();
        _thread.Join();
        _queue.Dispose();
    }
}
