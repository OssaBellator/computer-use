using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Ossa.ComputerUse.WindowsHost;

internal sealed class TotpFactorService
{
    private const uint CredTypeGeneric = 1;
    private const int ErrorNotFound = 1168;
    private const int MaxCredentialBytes = 4_096;
    private const int TimeStepSeconds = 30;
    private static readonly Regex RefPattern = new("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", RegexOptions.CultureInvariant | RegexOptions.Compiled);

    internal object Apply(UiaService uia, TotpFactorApplyRequest request)
    {
        if (!RefPattern.IsMatch(request.FactorRef) || request.Purpose is not ("authenticate" or "reauthenticate"))
            throw new ProtocolException("factor.totp.request-invalid");
        var invalidTarget = uia.ValidateTotpTarget(request);
        if (invalidTarget is not null) return new { status = "rejected", evidence = new[] { invalidTarget } };
        if (!NativeMethods.CredReadW(request.FactorRef, CredTypeGeneric, 0, out var credentialPointer))
            return Marshal.GetLastWin32Error() == ErrorNotFound
                ? new { status = "unavailable", evidence = new[] { "windows-totp-factor-not-found" } }
                : new { status = "unavailable", evidence = new[] { "windows-totp-store-unavailable" } };

        byte[]? credentialBytes = null;
        byte[]? seedBytes = null;
        string? code = null;
        try
        {
            var credential = Marshal.PtrToStructure<NativeCredential>(credentialPointer);
            var blob = credential.CredentialBlob;
            var blobSize = credential.CredentialBlobSize;
            if (credential.Type != CredTypeGeneric || blob == 0 || blobSize is 0 or > MaxCredentialBytes || (blobSize & 1) != 0)
                return new { status = "unavailable", evidence = new[] { "windows-totp-factor-format-unsupported" } };
            credentialBytes = new byte[checked((int)blobSize)];
            Marshal.Copy(blob, credentialBytes, 0, credentialBytes.Length);
            seedBytes = DecodeBase32(Encoding.Unicode.GetString(credentialBytes).Trim());
            if (seedBytes.Length < 10 || seedBytes.Length > 128)
                return new { status = "unavailable", evidence = new[] { "windows-totp-factor-format-unsupported" } };
            code = GenerateTotp(seedBytes, DateTimeOffset.UtcNow.ToUnixTimeSeconds() / TimeStepSeconds);
        }
        catch (FormatException)
        {
            return new { status = "unavailable", evidence = new[] { "windows-totp-factor-format-unsupported" } };
        }
        finally
        {
            if (credentialBytes is not null) CryptographicOperations.ZeroMemory(credentialBytes);
            if (seedBytes is not null) CryptographicOperations.ZeroMemory(seedBytes);
            NativeMethods.CredFree(credentialPointer);
        }
        // Base32 text and the generated code necessarily exist as short-lived managed strings.
        // They remain confined to this trusted sidecar and are never serialized.
        return uia.ApplyTotp(request, code);
    }

    private static string GenerateTotp(byte[] seed, long counter)
    {
        Span<byte> counterBytes = stackalloc byte[8];
        for (var i = 7; i >= 0; i--) { counterBytes[i] = (byte)(counter & 0xff); counter >>= 8; }
        using var hmac = new HMACSHA1(seed);
        var hash = hmac.ComputeHash(counterBytes.ToArray());
        try
        {
            var offset = hash[^1] & 0x0f;
            var binary = ((hash[offset] & 0x7f) << 24) | ((hash[offset + 1] & 0xff) << 16) | ((hash[offset + 2] & 0xff) << 8) | (hash[offset + 3] & 0xff);
            return (binary % 1_000_000).ToString("D6", CultureInfo.InvariantCulture);
        }
        finally { CryptographicOperations.ZeroMemory(hash); }
    }

    private static byte[] DecodeBase32(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 256) throw new FormatException();
        var normalized = value.Trim().TrimEnd('=').ToUpperInvariant();
        if (normalized.Length == 0) throw new FormatException();
        var output = new List<byte>((normalized.Length * 5 + 7) / 8);
        var buffer = 0; var bits = 0;
        foreach (var ch in normalized)
        {
            var digit = ch switch { >= 'A' and <= 'Z' => ch - 'A', >= '2' and <= '7' => ch - '2' + 26, _ => throw new FormatException() };
            buffer = (buffer << 5) | digit; bits += 5;
            if (bits >= 8) { bits -= 8; output.Add((byte)(buffer >> bits)); buffer &= (1 << bits) - 1; }
        }
        return output.ToArray();
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NativeCredential
    {
        internal uint Flags; internal uint Type; internal nint TargetName; internal nint Comment;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; internal uint CredentialBlobSize;
        internal nint CredentialBlob; internal uint Persist; internal uint AttributeCount; internal nint Attributes;
        internal nint TargetAlias; internal nint UserName;
    }
    private static class NativeMethods
    {
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CredReadW(string target, uint type, uint flags, out nint credential);
        [DllImport("advapi32.dll")] internal static extern void CredFree(nint credential);
    }
}
