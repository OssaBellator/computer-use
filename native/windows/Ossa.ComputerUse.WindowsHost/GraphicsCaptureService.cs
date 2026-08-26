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

    private readonly WindowEnumerationService _windows;
    private readonly object _artifactLock = new();
    private readonly Dictionary<string, byte[]> _artifacts = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _captureGenerations = new(StringComparer.Ordinal);
    private long _artifactSequence;
    private long _retainedBytes;
    private bool _disposed;

    internal GraphicsCaptureService(WindowEnumerationService windows) => _windows = windows;

    internal bool IsAvailable
    {
        get
        {
            try { return GraphicsCaptureSession.IsSupported(); }
            catch { return false; }
        }
    }

    internal async Task<object> CaptureAsync(CaptureNextFrameRequest request)
    {
        ThrowIfDisposed();
        ValidateLimits(request.Limits);

        // Capture authority must originate from the generation-bearing system
        // observation, not from a caller-provided HWND alone.
        var hwnd = _windows.ValidateObserved(request.Window);
        if (!IsAvailable) throw new ProtocolException("capture.unsupported");

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

            var winner = await Task.WhenAny(completion.Task, Task.Delay(FrameTimeoutMs)).ConfigureAwait(false);
            if (!ReferenceEquals(winner, completion.Task))
            {
                completion.TrySetCanceled();
                throw new ProtocolException("capture.frame-timeout");
            }
            frame = await completion.Task.ConfigureAwait(false);
            // This timestamp belongs to frame acquisition, before potentially slow PNG encoding.
            var capturedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            var contentSize = frame.ContentSize;
            ValidateDimensions(contentSize.Width, contentSize.Height, request.Limits.MaxPixels);

            // Revalidate window generation after asynchronous capture; the frame
            // cannot be attached to authority for a window that was replaced while
            // the capture session was producing it.
            _windows.ValidateObserved(request.Window);

            var bytes = await EncodePngAsync(frame, request.Limits.MaxBytes).ConfigureAwait(false);
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

            if (!NativeMethods.GetWindowRect(hwnd, out var rect))
            {
                ReleaseToken(token);
                NativeMethods.ThrowLastWin32("GetWindowRect(capture)");
            }
            var dpi = NativeMethods.GetDpiForWindow(hwnd);
            if (dpi == 0)
            {
                ReleaseToken(token);
                throw new ProtocolException("capture.window-dpi-invalid");
            }

            // Geometry is sampled only after the post-frame generation check. If
            // a caller moves/resizes the same-generation window after this return,
            // the TypeScript frame binding will reject coordinates on revalidation.
            var captureGeneration = NextCaptureGeneration(request.Window);
            return new
            {
                window = request.Window,
                captureGeneration,
                frameSequence = 0,
                capturedAtMs,
                systemRelativeTime100ns = frame.SystemRelativeTime.Ticks,
                contentWidth = contentSize.Width,
                contentHeight = contentSize.Height,
                geometry = new
                {
                    left = rect.Left,
                    top = rect.Top,
                    width = Math.Max(1, rect.Right - rect.Left),
                    height = Math.Max(1, rect.Bottom - rect.Top),
                    dpi = (double)dpi,
                },
                artifact = new
                {
                    token,
                    mediaType = "image/png",
                    byteLength = bytes.Length,
                },
            };
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

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        lock (_artifactLock)
        {
            foreach (var bytes in _artifacts.Values) CryptographicOperations.ZeroMemory(bytes);
            _artifacts.Clear();
            _retainedBytes = 0;
        }
    }

    private static GraphicsCaptureItem CreateItemForWindow(nint hwnd)
    {
        // C#/WinRT's ComImport projection maps the HRESULT/out-result ABI to the
        // pointer-returning managed signature used here.
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
            hr = Marshal.QueryInterface(nativeDevice, ref iid, out dxgiDevice);
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

    private static async Task<byte[]> EncodePngAsync(Direct3D11CaptureFrame frame, int requestedMaxBytes)
    {
        using var bitmap = await SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface).AsTask().ConfigureAwait(false);
        using var stream = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream).AsTask().ConfigureAwait(false);
        encoder.SetSoftwareBitmap(bitmap);
        await encoder.FlushAsync().AsTask().ConfigureAwait(false);

        var size = stream.Size;
        var maxBytes = Math.Min(requestedMaxBytes, MaxCaptureBytes);
        if (size > (ulong)maxBytes || size > int.MaxValue)
            throw new ProtocolException("capture.byte-limit-exceeded");
        var bytes = new byte[(int)size];
        stream.Seek(0);
        using var input = stream.GetInputStreamAt(0);
        using var reader = new DataReader(input);
        var loaded = await reader.LoadAsync((uint)bytes.Length).AsTask().ConfigureAwait(false);
        if (loaded != bytes.Length) throw new ProtocolException("capture.encode-read-incomplete");
        reader.ReadBytes(bytes);
        return bytes;
    }

    private string Retain(byte[] bytes)
    {
        lock (_artifactLock)
        {
            if (_artifacts.Count >= MaxArtifacts || _retainedBytes + bytes.LongLength > MaxRetainedBytes)
                throw new ProtocolException("capture.artifact-budget-exceeded");
            var token = $"capture-{checked(++_artifactSequence):x}";
            _artifacts.Add(token, bytes);
            _retainedBytes += bytes.LongLength;
            return token;
        }
    }

    private bool ReleaseToken(string token)
    {
        lock (_artifactLock)
        {
            if (!_artifacts.Remove(token, out var bytes)) return false;
            _retainedBytes -= bytes.LongLength;
            CryptographicOperations.ZeroMemory(bytes);
            return true;
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
