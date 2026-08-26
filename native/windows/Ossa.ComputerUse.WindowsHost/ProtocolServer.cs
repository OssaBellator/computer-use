using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Windows.Graphics.Capture;

namespace Ossa.ComputerUse.WindowsHost;

internal sealed class ProtocolServer : IDisposable
{
    private const int ProtocolVersion = 1;
    private const int MaxMessageBytes = 1_048_576;
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
        "uia.window-states",
        "uia.events.register",
        "uia.events.unregister",
        "uia.events.poll",
        "capture.next-frame",
        "artifact.release",
        "integrity.current",
        "integrity.process",
        "input.send",
        "input.human-sequence",
    };

    private readonly MtaExecutor _mta;
    private readonly MtaExecutor _captureMta;
    private readonly NativeHostServices _services = new();
    private readonly UiaService _uia;
    private readonly UiaEventService _events;
    private readonly WindowEnumerationService _windows = new();
    private readonly WindowAuthorityService _windowAuthority;
    private readonly GraphicsCaptureService _capture = new();
    private readonly bool _captureAvailable;
    private readonly HumanInputMonitor? _humanInput;
    private readonly TextReader _input;
    private readonly TextWriter _output;
    private int _disposed;

    internal ProtocolServer(MtaExecutor mta, TextReader input, TextWriter output)
    {
        _mta = mta;
        _uia = new UiaService(mta.ThreadToken);
        _events = new UiaEventService(mta.ThreadToken);
        _windowAuthority = new WindowAuthorityService(_windows);
        _captureMta = new MtaExecutor("capture");
        try
        {
            _captureAvailable = _captureMta.InvokeAsync(GraphicsCaptureSession.IsSupported).GetAwaiter().GetResult();
        }
        catch
        {
            _captureAvailable = false;
        }
        try
        {
            _humanInput = new HumanInputMonitor();
        }
        catch
        {
            // Host remains usable for semantic/background work. The hello
            // capability snapshot omits input.human-sequence so interactive-host
            // leases stay fail closed instead of assuming human-input coverage.
            _humanInput = null;
        }
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
            if (Encoding.UTF8.GetByteCount(line) > MaxMessageBytes)
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
        catch (JsonException)
        {
            await WriteErrorAsync(ValidId(request?.Id) ? request!.Id : "invalid", "protocol.request-invalid").ConfigureAwait(false);
        }
        catch (COMException error)
        {
            await WriteErrorAsync(
                ValidId(request?.Id) ? request!.Id : "invalid",
                $"host.com.{unchecked((uint)error.HResult):x8}").ConfigureAwait(false);
        }
        catch (UnauthorizedAccessException)
        {
            await WriteErrorAsync(ValidId(request?.Id) ? request!.Id : "invalid", "host.access-denied").ConfigureAwait(false);
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

    private string[] ImplementedOperations()
    {
        var result = new List<string>(Operations.Count);
        foreach (var operation in Operations.OrderBy(value => value, StringComparer.Ordinal))
        {
            if (operation is "capture.next-frame" or "artifact.release")
            {
                if (_captureAvailable) result.Add(operation);
                continue;
            }
            if (operation == "input.human-sequence")
            {
                if (_humanInput is not null) result.Add(operation);
                continue;
            }
            result.Add(operation);
        }
        return result.ToArray();
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
                implementedOperations = ImplementedOperations(),
            }),
            "system.windows" => _mta.InvokeAsync(() => _windows.List(ProtocolJson.DeserializeBody<WindowListRequest>(request.Body))),
            "system.virtual-desktop" => Task.FromResult(VirtualDesktopService.Read()),
            "integrity.current" => Task.FromResult(_services.ReadCurrentIntegrity()),
            "integrity.process" => Task.FromResult(_services.ReadProcessIntegrity(ProtocolJson.DeserializeBody<IntegrityProcessRequest>(request.Body))),
            "input.send" => Task.FromResult(_services.SendInput(ProtocolJson.DeserializeBody<SendInputRequest>(request.Body))),
            "input.human-sequence" => Task.FromResult<object>(new
            {
                sequence = _humanInput?.Sequence ?? throw new ProtocolException("input.human-monitor-unavailable"),
            }),
            "uia.resolve-window" => _mta.InvokeAsync(() => _uia.ResolveWindow(ProtocolJson.DeserializeBody<ResolveWindowRequest>(request.Body))),
            "uia.build-cache" => _mta.InvokeAsync(() => _uia.BuildCache(ProtocolJson.DeserializeBody<BuildCacheRequest>(request.Body))),
            "uia.resolve-control" => _mta.InvokeAsync(() => _uia.ResolveControl(ProtocolJson.DeserializeBody<ResolveControlRequest>(request.Body))),
            "uia.compare-elements" => _mta.InvokeAsync(() => _uia.CompareElements(ProtocolJson.DeserializeBody<CompareElementsRequest>(request.Body))),
            "uia.snapshot-control" => _mta.InvokeAsync(() => _uia.SnapshotControl(ProtocolJson.DeserializeBody<SnapshotControlRequest>(request.Body))),
            "uia.perform-pattern" => _mta.InvokeAsync(() => _uia.PerformPattern(ProtocolJson.DeserializeBody<PerformPatternRequest>(request.Body))),
            "uia.window-states" => _mta.InvokeAsync(() => _windowAuthority.Observe(ProtocolJson.DeserializeBody<WindowStatesRequest>(request.Body))),
            "uia.events.register" => _mta.InvokeAsync(() => _events.Register(ProtocolJson.DeserializeBody<UiaEventRegisterRequest>(request.Body))),
            "uia.events.unregister" => _mta.InvokeAsync(() => _events.Unregister(ProtocolJson.DeserializeBody<UiaEventUnregisterRequest>(request.Body))),
            "uia.events.poll" => _mta.InvokeAsync(() => _events.Poll(ProtocolJson.DeserializeBody<UiaEventPollRequest>(request.Body))),
            "capture.next-frame" => CaptureFrameAsync(ProtocolJson.DeserializeBody<CaptureNextFrameRequest>(request.Body)),
            "artifact.release" => ReleaseArtifactAsync(ProtocolJson.DeserializeBody<ArtifactReleaseRequest>(request.Body)),
            _ => throw new ProtocolException("protocol.operation-unsupported"),
        };
    }

    private async Task<object> CaptureFrameAsync(CaptureNextFrameRequest request)
    {
        if (!_captureAvailable) throw new ProtocolException("capture.unsupported");

        // Window identity is owned by the UIA MTA. Validate immediately before
        // crossing into the capture apartment, then again before returning the
        // retained artifact to the caller.
        var hwnd = await _mta.InvokeAsync(() => _windows.ValidateObserved(request.Window)).ConfigureAwait(false);
        var response = await _captureMta.InvokeAsync(() => _capture.Capture(request, hwnd)).ConfigureAwait(false);
        try
        {
            await _mta.InvokeAsync(() =>
            {
                _windows.ValidateObserved(request.Window);
                return true;
            }).ConfigureAwait(false);
            return response;
        }
        catch
        {
            await _captureMta.InvokeAsync(() =>
            {
                _capture.Revoke(response);
                return true;
            }).ConfigureAwait(false);
            throw;
        }
    }

    private Task<object> ReleaseArtifactAsync(ArtifactReleaseRequest request)
    {
        if (!_captureAvailable) throw new ProtocolException("capture.unsupported");
        return _captureMta.InvokeAsync(() => _capture.Release(request));
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
        _humanInput?.Dispose();
        try
        {
            _captureMta.InvokeAsync(() =>
            {
                _capture.Dispose();
                return true;
            }).GetAwaiter().GetResult();
        }
        finally
        {
            _captureMta.Dispose();
        }
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
            // UIA MTA is already unavailable; process teardown will release OS state.
        }
    }

    private static bool ValidId(string? id) => id is not null && IdPattern.IsMatch(id);
}
