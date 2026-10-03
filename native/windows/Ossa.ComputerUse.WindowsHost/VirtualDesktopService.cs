namespace Ossa.ComputerUse.WindowsHost;

internal static class VirtualDesktopService
{
    internal static object Read()
    {
        var left = NativeMethods.GetSystemMetrics(NativeMethods.SM_XVIRTUALSCREEN);
        var top = NativeMethods.GetSystemMetrics(NativeMethods.SM_YVIRTUALSCREEN);
        var width = NativeMethods.GetSystemMetrics(NativeMethods.SM_CXVIRTUALSCREEN);
        var height = NativeMethods.GetSystemMetrics(NativeMethods.SM_CYVIRTUALSCREEN);
        if (width <= 0 || height <= 0 || width > 1_000_000 || height > 1_000_000 ||
            Math.Abs((long)left) > 1_000_000 || Math.Abs((long)top) > 1_000_000)
            throw new ProtocolException("windows.virtual-desktop-invalid");
        return new { left, top, width, height };
    }
}
