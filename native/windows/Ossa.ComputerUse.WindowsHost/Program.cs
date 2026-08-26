namespace Ossa.ComputerUse.WindowsHost;

internal static class Program
{
    public static async Task<int> Main()
    {
        using var mta = new MtaExecutor();
        var server = new ProtocolServer(mta, Console.In, Console.Out);
        return await server.RunAsync();
    }
}
