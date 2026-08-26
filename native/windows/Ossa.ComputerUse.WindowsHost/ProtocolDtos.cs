using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ossa.ComputerUse.WindowsHost;

internal static class ProtocolJson
{
    internal static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        MaxDepth = 64,
    };

    internal static T DeserializeBody<T>(JsonElement body)
        where T : class
        => JsonSerializer.Deserialize<T>(body.GetRawText(), Options)
           ?? throw new ProtocolException("protocol.body-invalid");
}

internal sealed class ProtocolException(string code) : Exception(code)
{
    internal string Code { get; } = code;
}

internal sealed record HostRequest(int Protocol, string Id, string Operation, JsonElement Body);
internal sealed record ProcessGenerationDto(int ProcessId, string StartIdentity);
internal sealed record WindowRefDto(string Hwnd, string DesktopSessionId, ProcessGenerationDto Process, long Generation);
internal sealed record ControlRefDto(
    WindowRefDto Window,
    int[] RuntimeId,
    string? AutomationId,
    string ControlType,
    string? StructuralPathHash,
    long Generation);
internal sealed record CachePlanDto(
    string TreeScope,
    bool ControlViewOnly,
    string ElementMode,
    string[] Properties,
    string[] Patterns,
    int MaxItems,
    int MaxDepth,
    int MaxTextBytes);
internal sealed record SemanticActionDto(
    string Kind,
    JsonElement? Value,
    string? State,
    string? Horizontal,
    string? Vertical,
    string? Operation);
internal sealed record ElementHandleDto(string Token);

internal sealed record ResolveWindowRequest(string ThreadToken, WindowRefDto Window);
internal sealed record BuildCacheRequest(string ThreadToken, ElementHandleDto Root, CachePlanDto Plan, long InvalidationEpoch);
internal sealed record ResolveControlRequest(string ThreadToken, ControlRefDto Ref);
internal sealed record CompareElementsRequest(string ThreadToken, ElementHandleDto A, ElementHandleDto B);
internal sealed record SnapshotControlRequest(string ThreadToken, ElementHandleDto Element, ControlRefDto Ref);
internal sealed record PerformPatternRequest(
    string ThreadToken,
    ElementHandleDto Element,
    ControlRefDto Ref,
    SemanticActionDto Action,
    string Effect);
internal sealed record WindowListRequest(int MaxItems = 256, int MaxTextBytes = 16_384);
internal sealed record IntegrityProcessRequest(ProcessGenerationDto Process);
internal sealed record ArtifactReleaseRequest(string Token);

internal sealed record SendInputEventDto(
    string Kind,
    int? VirtualKey,
    bool? KeyUp,
    bool? Extended,
    int? CodeUnit,
    int? NormalizedX,
    int? NormalizedY,
    bool? VirtualDesktop,
    int? Dx,
    int? Dy,
    string? Button);
internal sealed record SendInputRequest(SendInputEventDto[] Events);
