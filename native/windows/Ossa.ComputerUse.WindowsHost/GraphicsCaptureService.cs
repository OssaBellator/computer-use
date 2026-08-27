using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Windows.Foundation;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;
using WinRT;

namespace Ossa.ComputerUse.WindowsHost;

internal sealed class GraphicsCaptureService : IDisposable
{
    private const int MaxArtifacts = 64;
    private const long MaxRetainedBytes = 64L * 1024 * 1024;
    private const int MaxCaptureBytes = 64 * 1024 * 1024;
    private const int MaxCapturePixels = 33_177_600;
    private const int FrameTimeoutMs = 2_000;
    private const long MaxArtifactLifetimeMs = 60_000;

    private static readonly Guid GraphicsCaptureItemGuid = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    private static readonly Guid IdxgiDeviceGuid = new("54EC77FA-1377-44E6-8C32-88FD5F44C84C");

    [ComImport]
    [Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphicsCaptureItemInterop
    {
        nint CreateForWindow([In] nint window, [In] ref Guid iid);
        nint CreateForMonitor([In] nint monitor, [In] ref Guid iid);
    }

    internal sealed record CaptureGeometry(double Left, double Top, int Width, int Height, double Dpi);
    internal sealed record CaptureArtifact(string Token, string MediaType, int ByteLength);
    internal sealed record CaptureResponse(
        WindowRefDto Window,
        long CaptureGeneration,
        long FrameSequence,
        long CapturedAtMs,
        long SystemRelativeTime100ns,
        int ContentWidth,
        int ContentHeight,
        CaptureGeometry Geometry,
        CaptureArtifact Artifact);

    private sealed record ArtifactEntry(byte[] Bytes, long ExpiresAtMs);

    private readonly object _artifactLock = new();
    private readonly Dictionary<string, ArtifactEntry> _artifacts = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _captureGenerations = new(StringComparer.Ordinal);
    private long _artifactSequence;
    private long _retainedBytes;
    private bool _disposed;

    /** Must be called only by the dedicated capture MTA executor. */
    internal CaptureResponse Capture(CaptureNextFrameRequest request, nint hwnd)
    {
        ThrowIfDisposed();
        ValidateLimits(request.Limits);
        if (hwnd == 0) throw new ProtocolException("capture.hwnd-invalid");
        if (!GraphicsCaptureSession.IsSupported())
            throw new ProtocolException("capture.unsupported");

        var item = CreateItemForWindow(hwnd);
        var initialSize = item.Size;
        ValidateDimensions(initialSize.Width, initialSize.Height, request.Limits.MaxPixels);

        var device = CreateDirect3DDevice();
        Direct3D11CaptureFramePool? pool = null;
        GraphicsCaptureSession? session = null;
        Direct3D11CaptureFrame? frame = null;
        TypedEventHandler<Direct3D11CaptureFramePool, object>? handler = null;
        try
        {
            pool = Direct3D11CaptureFramePool.CreateFreeThreaded(
                device,
                DirectXPixelFormat.B8G8R8A8UIntNormalized,
                2,
                initialSize);
            session = pool.CreateCaptureSession(item);

            var completion = new TaskCompletionSource<Direct3D11CaptureFrame>(TaskCreationOptions.RunContinuationsAsynchronously);
            handler = (sender, _) =>
            {
                try
                {
                    var next = sender.TryGetNextFrame();
                    if (next is null) return;
                    if (!completion.TrySetResult(next)) next.Dispose();
                }
                catch (Exception error)
                {
                    completion.TrySetException(error);
                }
            };
            pool.FrameArrived += handler;
            session.StartCapture();

            var winner = Task.WhenAny(completion.Task, Task.Delay(FrameTimeoutMs)).GetAwaiter().GetResult();
            if (!ReferenceEquals(winner, completion.Task))
            {
                completion.TrySetCanceled();
                throw new ProtocolException("capture.frame-timeout");
            }
            frame = completion.Task.GetAwaiter().GetResult();
            // This is the authority/freshness timestamp for the captured frame.
            // Encoding and retention may take materially longer and must not make
            // an old screen frame look newer than it actually is.
            var capturedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            var contentSize = frame.ContentSize;
            ValidateDimensions(contentSize.Width, contentSize.Height, request.Limits.MaxPixels);
            var bytes = EncodePng(frame, request.Limits.MaxBytes);
            string token;
            try
            {
                token = Retain(bytes);
            }
            catch
            {
                CryptographicOperations.ZeroMemory(bytes);
                throw;
            }

            try
            {
                if (!NativeMethods.GetWindowRect(hwnd, out var rect))
                    NativeMethods.ThrowLastWin32("GetWindowRect(capture)");
                var dpi = NativeMethods.GetDpiForWindow(hwnd);
                if (dpi == 0) throw new ProtocolException("capture.window-dpi-invalid");

                return new CaptureResponse(
                    request.Window,
                    NextCaptureGeneration(request.Window),
                    0,
                    capturedAtMs,
                    frame.SystemRelativeTime.Ticks,
                    contentSize.Width,
                    contentSize.Height,
                    new CaptureGeometry(
                        rect.Left,
                        rect.Top,
                        Math.Max(1, rect.Right - rect.Left),
                        Math.Max(1, rect.Bottom - rect.Top),
                        dpi),
                    new CaptureArtifact(token, "image/png", bytes.Length));
            }
            catch
            {
                ReleaseToken(token);
                throw;
            }
        }
        finally
        {
            if (pool is not null && handler is not null) pool.FrameArrived -= handler;
            frame?.Dispose();
            session?.Dispose();
            pool?.Dispose();
            (device as IDisposable)?.Dispose();
        }
    }

    internal object Release(ArtifactReleaseRequest request)
    {
        ThrowIfDisposed();
        if (!ValidToken(request.Token)) throw new ProtocolException("capture.artifact-token-invalid");
        return new { released = ReleaseToken(request.Token) };
    }

    internal void Revoke(CaptureResponse response)
    {
        if (!_disposed) ReleaseToken(response.Artifact.Token);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        lock (_artifactLock)
        {
            foreach (var entry in _artifacts.Values) CryptographicOperations.ZeroMemory(entry.Bytes);
            _artifacts.Clear();
            _retainedBytes = 0;
        }
    }

    private static GraphicsCaptureItem CreateItemForWindow(nint hwnd)
    {
        var interop = GraphicsCaptureItem.As<IGraphicsCaptureItemInterop>();
        var iid = GraphicsCaptureItemGuid;
        var pointer = interop.CreateForWindow(hwnd, ref iid);
        if (pointer == 0) throw new ProtocolException("capture.item-create-failed");
        try
        {
            return GraphicsCaptureItem.FromAbi(pointer);
        }
        finally
        {
            Marshal.Release(pointer);
        }
    }

    private static IDirect3DDevice CreateDirect3DDevice()
    {
        nint nativeDevice = 0;
        nint immediateContext = 0;
        nint dxgiDevice = 0;
        nint graphicsDevice = 0;
        try
        {
            var hr = NativeMethods.D3D11CreateDevice(
                0,
                NativeMethods.D3D_DRIVER_TYPE_HARDWARE,
                0,
                NativeMethods.D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                0,
                0,
                NativeMethods.D3D11_SDK_VERSION,
                out nativeDevice,
                out _,
                out immediateContext);
            if (hr < 0)
            {
                ReleaseCom(ref nativeDevice);
                ReleaseCom(ref immediateContext);
                hr = NativeMethods.D3D11CreateDevice(
                    0,
                    NativeMethods.D3D_DRIVER_TYPE_WARP,
                    0,
                    NativeMethods.D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    0,
                    0,
                    NativeMethods.D3D11_SDK_VERSION,
                    out nativeDevice,
                    out _,
                    out immediateContext);
            }
            if (hr < 0 || nativeDevice == 0)
                throw new ProtocolException($"capture.d3d11-create-device.{unchecked((uint)hr):x8}");

            var iid = IdxgiDeviceGuid;
            hr = Marshal.QueryInterface(nativeDevice, in iid, out dxgiDevice);
            if (hr < 0 || dxgiDevice == 0)
                throw new ProtocolException($"capture.dxgi-device.{unchecked((uint)hr):x8}");

            hr = NativeMethods.CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice, out graphicsDevice);
            if (hr < 0 || graphicsDevice == 0)
                throw new ProtocolException($"capture.winrt-device.{unchecked((uint)hr):x8}");

            return MarshalInterface<IDirect3DDevice>.FromAbi(graphicsDevice);
        }
        finally
        {
            ReleaseCom(ref graphicsDevice);
            ReleaseCom(ref dxgiDevice);
            ReleaseCom(ref immediateContext);
            ReleaseCom(ref nativeDevice);
        }
    }

    private static byte[] EncodePng(Direct3D11CaptureFrame frame, int requestedMaxBytes)
    {
        using var bitmap = SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface).AsTask().GetAwaiter().GetResult();
        using var stream = new InMemoryRandomAccessStream();
        var encoder = BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream).AsTask().GetAwaiter().GetResult();
        encoder.SetSoftwareBitmap(bitmap);
        encoder.FlushAsync().AsTask().GetAwaiter().GetResult();

        var size = stream.Size;
        var maxBytes = Math.Min(requestedMaxBytes, MaxCaptureBytes);
        if (size > (ulong)maxBytes || size > int.MaxValue)
            throw new ProtocolException("capture.byte-limit-exceeded");
        var bytes = new byte[(int)size];
        stream.Seek(0);
        using var input = stream.GetInputStreamAt(0);
        using var reader = new DataReader(input);
        var loaded = reader.LoadAsync((uint)bytes.Length).AsTask().GetAwaiter().GetResult();
        if (loaded != bytes.Length) throw new ProtocolException("capture.encode-read-incomplete");
        reader.ReadBytes(bytes);
        return bytes;
    }

    private string Retain(byte[] bytes)
    {
        lock (_artifactLock)
        {
            PurgeExpiredLocked(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            if (_artifacts.Count >= MaxArtifacts || _retainedBytes + bytes.LongLength > MaxRetainedBytes)
                throw new ProtocolException("capture.artifact-budget-exceeded");
            var token = $"capture-{checked(++_artifactSequence):x}";
            var expiresAtMs = checked(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + MaxArtifactLifetimeMs);
            _artifacts.Add(token, new ArtifactEntry(bytes, expiresAtMs));
            _retainedBytes += bytes.LongLength;
            return token;
        }
    }

    private bool ReleaseToken(string token)
    {
        lock (_artifactLock)
        {
            PurgeExpiredLocked(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            if (!_artifacts.Remove(token, out var entry)) return false;
            _retainedBytes -= entry.Bytes.LongLength;
            CryptographicOperations.ZeroMemory(entry.Bytes);
            return true;
        }
    }

    private void PurgeExpiredLocked(long nowMs)
    {
        if (_artifacts.Count == 0) return;
        var expired = _artifacts
            .Where(pair => nowMs >= pair.Value.ExpiresAtMs)
            .Select(pair => pair.Key)
            .ToArray();
        foreach (var token in expired)
        {
            if (!_artifacts.Remove(token, out var entry)) continue;
            _retainedBytes -= entry.Bytes.LongLength;
            CryptographicOperations.ZeroMemory(entry.Bytes);
        }
    }

    private long NextCaptureGeneration(WindowRefDto window)
    {
        var key = $"{window.DesktopSessionId}:{window.Hwnd}:{window.Process.ProcessId}:{window.Process.StartIdentity}:{window.Generation}";
        lock (_captureGenerations)
        {
            var next = _captureGenerations.TryGetValue(key, out var prior) ? checked(prior + 1) : 0;
            _captureGenerations[key] = next;
            return next;
        }
    }

    private static void ValidateLimits(CaptureLimitsDto limits)
    {
        if (limits.MaxPixels is < 1 or > MaxCapturePixels || limits.MaxBytes is < 1 or > MaxCaptureBytes)
            throw new ProtocolException("capture.limits-invalid");
    }

    private static void ValidateDimensions(int width, int height, int requestedMaxPixels)
    {
        if (width < 1 || height < 1 || width > 32_768 || height > 32_768)
            throw new ProtocolException("capture.frame-size-invalid");
        var pixels = (long)width * height;
        if (pixels > Math.Min(requestedMaxPixels, MaxCapturePixels))
            throw new ProtocolException("capture.pixel-limit-exceeded");
    }

    private static bool ValidToken(string value) =>
        !string.IsNullOrWhiteSpace(value) && value.Length <= 192 &&
        value.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or ':' or '-');

    private static void ReleaseCom(ref nint pointer)
    {
        if (pointer == 0) return;
        Marshal.Release(pointer);
        pointer = 0;
    }

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ProtocolException("capture.disposed");
    }
}
