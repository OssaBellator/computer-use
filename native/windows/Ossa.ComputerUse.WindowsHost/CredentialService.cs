using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Ossa.ComputerUse.WindowsHost;

/**
 * Narrow Windows Credential Manager consumer. It supports exact named generic
 * credentials only; there is intentionally no enumerate, inspect, or export API.
 */
internal sealed class CredentialService
{
    private const uint CredTypeGeneric = 1;
    private const int ErrorNotFound = 1168;
    private const int MaxCredentialBytes = 16_384;
    private static readonly Regex RefPattern = new("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", RegexOptions.CultureInvariant | RegexOptions.Compiled);

    internal object Apply(UiaService uia, CredentialApplyRequest request)
    {
        if (!RefPattern.IsMatch(request.CredentialRef) || !RefPattern.IsMatch(request.Purpose))
            throw new ProtocolException("credential.request-invalid");

        var invalidTarget = uia.ValidateCredentialTarget(request);
        if (invalidTarget is not null)
            return new { status = "rejected", evidence = new[] { invalidTarget } };

        if (!NativeMethods.CredReadW(request.CredentialRef, CredTypeGeneric, 0, out var credentialPointer))
        {
            return Marshal.GetLastWin32Error() == ErrorNotFound
                ? new { status = "unavailable", evidence = new[] { "windows-credential-not-found" } }
                : new { status = "unavailable", evidence = new[] { "windows-credential-store-unavailable" } };
        }

        string secret;
        byte[]? secretBytes = null;
        try
        {
            var credential = Marshal.PtrToStructure<NativeCredential>(credentialPointer);
            var blob = credential.CredentialBlob;
            var blobSize = credential.CredentialBlobSize;
            if (credential.Type != CredTypeGeneric || blob == 0 || blobSize is 0 or > MaxCredentialBytes || (blobSize & 1) != 0)
                return new { status = "unavailable", evidence = new[] { "windows-credential-format-unsupported" } };

            secretBytes = new byte[checked((int)blobSize)];
            Marshal.Copy(blob, secretBytes, 0, secretBytes.Length);
            secret = Encoding.Unicode.GetString(secretBytes);
            if (string.IsNullOrEmpty(secret) || secret.IndexOf('\0') >= 0)
                return new { status = "unavailable", evidence = new[] { "windows-credential-format-unsupported" } };
        }
        finally
        {
            // Finish credential-store cleanup before the semantic dispatch
            // boundary. Any exception after this point therefore reflects the
            // UIA application itself and must remain sticky UNKNOWN upstream.
            if (secretBytes is not null) CryptographicOperations.ZeroMemory(secretBytes);
            NativeMethods.CredFree(credentialPointer);
        }

        // ValuePattern.SetValue requires String, so a short-lived managed string
        // exists only inside this trusted sidecar. It is never serialized.
        return uia.ApplyCredential(request, secret);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NativeCredential
    {
        internal uint Flags;
        internal uint Type;
        internal nint TargetName;
        internal nint Comment;
        internal System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        internal uint CredentialBlobSize;
        internal nint CredentialBlob;
        internal uint Persist;
        internal uint AttributeCount;
        internal nint Attributes;
        internal nint TargetAlias;
        internal nint UserName;
    }

    private static class NativeMethods
    {
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CredReadW(string target, uint type, uint flags, out nint credential);

        [DllImport("advapi32.dll")]
        internal static extern void CredFree(nint credential);

    }
}
