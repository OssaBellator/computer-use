using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Ossa.ComputerUse.WindowsHost;

internal sealed class ProtocolServer : IDisposable
{
    private const int ProtocolVersion = 1;
    private const int MaxMessageChars = 1_048_576;
    private static readonly Regex IdPattern = new("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", RegexOptions.CultureInvariant | RegexOptions.Compiled);
    private static readonly HashSet<string> Operations = new(StringComparer.Ordinal)
    {
        "hello",
        "system.windows",
        "system.virtual-desktop",
        "uia.resolve-window",
        "uia.build-cache",
        "uia.resolve-control",
        "uia.compare-elements",
        "uia.snapshot-control",
        "uia.perform-pattern",
        "uia.events.register",
        "uia.events.unregister",
        "uia.events.poll",
        "capture.next-frame",
        "artifact.release",
        "integrity.current",
        "integrity.process",
        "input.send",
    };
    private static readonly string[] ImplementedOperations = Operations
        .Where(value => value is not "capture.next-frame" and not "artifact.release")
        .OrderBy(value => value, StringComparer.Ordinal)
        .ToArray();

    private readonly MtaExecutor _mta;
    private readonly NativeHostServices _services = new();
    private readonly UiaService _uia;
    private readonly UiaEventService _events;
    private readonly WindowEnumerationService _windows = new();
    private readonly TextReader _input;
    private readonly TextWriter _output;
    private int _disposed;

    internal ProtocolServer(MtaExecutor mta, TextReader input, TextWriter output)
    {
        _mta = mta;
        _uia = new UiaService(mta.ThreadToken);
        _events = new UiaEventService(mta.ThreadToken);
        _input = input;
        _output = output;
    }

    internal async Task<int> RunAsync()
    {
        while (true)
        {
            var line = await _input.ReadLineAsync().ConfigureAwait(false);
            if (line is null) return 0;
            if (line.Length == 0) continue;
            if (line.Length > MaxMessageChars)
            {
                await WriteErrorAsync("invalid", "protocol.message-too-large").ConfigureAwait(false);
                continue;
            }
            await HandleLineAsync(line).ConfigureAwait(false);
        }
    }

    private async Task HandleLineAsync(string line)
    {
        HostRequest? request = null;
        try
        {
            request = JsonSerializer.Deserialize<HostRequest>(line, ProtocolJson.Options)
                      ?? throw new ProtocolException("protocol.request-invalid");
            ValidateRequest(request);
            var body = await DispatchAsync(request).ConfigureAwait(false);
            await WriteOkAsync(request.Id, body).ConfigureAwait(false);
        }
        catch (ProtocolException error)
        {
            await WriteErrorAsync(ValidId(request?.Id) ? request!.Id : "invalid", error.Code).ConfigureAwait(false);
        }
        catch
        {
            await WriteErrorAsync(ValidId(request?.Id) ? request!.Id : "invalid", "host.internal-error").ConfigureAwait(false);
        }
    }

    private static void ValidateRequest(HostRequest request)
    {
        if (request.Protocol != ProtocolVersion) throw new ProtocolException("protocol.version-unsupported");
        if (!ValidId(request.Id)) throw new ProtocolException("protocol.id-invalid");
        if (!Operations.Contains(request.Operation)) throw new ProtocolException("protocol.operation-unsupported");
        if (request.Body.ValueKind is JsonValueKind.Undefined) throw new ProtocolException("protocol.body-invalid");
    }

    private Task<object> DispatchAsync(HostRequest request)
    {
        return request.Operation switch
        {
            "hello" => Task.FromResult<object>(new
            {
                protocol = ProtocolVersion,
                host = "ossa-computer-use-windows-host",
                apartment = "mta",
                threadToken = _mta.ThreadToken,
                operations = Operations.OrderBy(value => value, StringComparer.Ordinal).ToArray(),
                implementedOperations = ImplementedOperations,
            }),
            "system.windows" => _mta.InvokeAsync(() => _windows.List(ProtocolJson.DeserializeBody<WindowListRequest>(request.Body))),
            "system.virtual-desktop" => Task.FromResult(VirtualDesktopService.Read()),
            "integrity.current" => Task.FromResult(_services.ReadCurrentIntegrity()),
            "integrity.process" => Task.FromResult(_services.ReadProcessIntegrity(ProtocolJson.DeserializeBody<IntegrityProcessRequest>(request.Body))),
            "input.send" => Task.FromResult(_services.SendInput(ProtocolJson.DeserializeBody<SendInputRequest>(request.Body))),
            "uia.resolve-window" => _mta.InvokeAsync(() => _uia.ResolveWindow(ProtocolJson.DeserializeBody<ResolveWindowRequest>(request.Body))),
            "uia.build-cache" => _mta.InvokeAsync(() => _uia.BuildCache(ProtocolJson.DeserializeBody<BuildCacheRequest>(request.Body))),
            "uia.resolve-control" => _mta.InvokeAsync(() => _uia.ResolveControl(ProtocolJson.DeserializeBody<ResolveControlRequest>(request.Body))),
            "uia.compare-elements" => _mta.InvokeAsync(() => _uia.CompareElements(ProtocolJson.DeserializeBody<CompareElementsRequest>(request.Body))),
            "uia.snapshot-control" => _mta.InvokeAsync(() => _uia.SnapshotControl(ProtocolJson.DeserializeBody<SnapshotControlRequest>(request.Body))),
            "uia.perform-pattern" => _mta.InvokeAsync(() => _uia.PerformPattern(ProtocolJson.DeserializeBody<PerformPatternRequest>(request.Body))),
            "uia.events.register" => _mta.InvokeAsync(() => _events.Register(ProtocolJson.DeserializeBody<UiaEventRegisterRequest>(request.Body))),
            "uia.events.unregister" => _mta.InvokeAsync(() => _events.Unregister(ProtocolJson.DeserializeBody<UiaEventUnregisterRequest>(request.Body))),
            "uia.events.poll" => _mta.InvokeAsync(() => _events.Poll(ProtocolJson.DeserializeBody<UiaEventPollRequest>(request.Body))),
            "capture.next-frame" or "artifact.release" => throw new ProtocolException("capture.not-implemented"),
            _ => throw new ProtocolException("protocol.operation-unsupported"),
        };
    }

    private async Task WriteOkAsync(string id, object body)
    {
        var json = JsonSerializer.Serialize(new { protocol = ProtocolVersion, id, status = "ok", body }, ProtocolJson.Options);
        await _output.WriteLineAsync(json).ConfigureAwait(false);
        await _output.FlushAsync().ConfigureAwait(false);
    }

    private async Task WriteErrorAsync(string id, string error)
    {
        var safeError = Regex.IsMatch(error, "^[a-z0-9][a-z0-9._:-]{0,127}$", RegexOptions.CultureInvariant)
            ? error
            : "host.internal-error";
        var json = JsonSerializer.Serialize(new { protocol = ProtocolVersion, id, status = "error", error = safeError }, ProtocolJson.Options);
        await _output.WriteLineAsync(json).ConfigureAwait(false);
        await _output.FlushAsync().ConfigureAwait(false);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        try
        {
            _mta.InvokeAsync(() =>
            {
                _events.Dispose();
                return true;
            }).GetAwaiter().GetResult();
        }
        catch (ObjectDisposedException)
        {
            // MTA is already unavailable; process teardown will release remaining OS state.
        }
    }

    private static bool ValidId(string? id) => id is not null && IdPattern.IsMatch(id);
}
