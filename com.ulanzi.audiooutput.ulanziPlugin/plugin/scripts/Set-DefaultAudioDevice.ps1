# Set-DefaultAudioDevice.ps1 -DeviceId '{0.0.0.00000000}.{xxxxxxxx-...}'
# Sets the default render endpoint for Console, Multimedia and Communications roles
# via IPolicyConfig::SetDefaultEndpoint. Outputs { ok: true, deviceId } as JSON.
#
# NOTE on the vtable layout: the correct IPolicyConfig order is
# GetMixFormat, GetDeviceFormat, ResetDeviceFormat, SetDeviceFormat,
# GetProcessingPeriod, SetProcessingPeriod, GetShareMode, SetShareMode,
# GetPropertyValue, SetPropertyValue, SetDefaultEndpoint (slot 10),
# SetEndpointVisibility. A widely copied variant that lists GetCustomEvents /
# GetPageSize / GetIconPath / GetControlInterfaceName / GetProtectGuid instead
# is WRONG and calls past the end of the vtable (E_POINTER / crash).

param(
    [Parameter(Mandatory = $true)]
    [string]$DeviceId
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

if ($DeviceId -notmatch '^\{0\.0\.0\.00000000\}\.\{[0-9a-fA-F-]+\}$') {
    throw "Invalid device id: $DeviceId"
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[ComImport]
[Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
public class PolicyConfigClient { }
[Guid("f8679f50-850a-41cf-9c72-430f290290c8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfig
{
    [PreserveSig] int _GetMixFormat([MarshalAs(UnmanagedType.LPWStr)] string a, out IntPtr b);
    [PreserveSig] int _GetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string a, int b, out IntPtr c);
    [PreserveSig] int _ResetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string a);
    [PreserveSig] int _SetDeviceFormat([MarshalAs(UnmanagedType.LPWStr)] string a, IntPtr b, IntPtr c);
    [PreserveSig] int _GetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string a, int b, out long c, out long d);
    [PreserveSig] int _SetProcessingPeriod([MarshalAs(UnmanagedType.LPWStr)] string a, ref long b);
    [PreserveSig] int _GetShareMode([MarshalAs(UnmanagedType.LPWStr)] string a, out IntPtr b);
    [PreserveSig] int _SetShareMode([MarshalAs(UnmanagedType.LPWStr)] string a, IntPtr b);
    [PreserveSig] int _GetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string a, IntPtr b, IntPtr c);
    [PreserveSig] int _SetPropertyValue([MarshalAs(UnmanagedType.LPWStr)] string a, IntPtr b, IntPtr c);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string a, int b);
    [PreserveSig] int _SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string a, int b);
}
public static class AudioPolicyHelper
{
    public static void SetDefaultRenderId(string id)
    {
        IPolicyConfig policy = (IPolicyConfig)new PolicyConfigClient();
        int hr = policy.SetDefaultEndpoint(id, 0);
        if (hr != 0) throw new COMException("SetDefaultEndpoint(eConsole) failed", hr);
        hr = policy.SetDefaultEndpoint(id, 1);
        if (hr != 0) throw new COMException("SetDefaultEndpoint(eMultimedia) failed", hr);
        hr = policy.SetDefaultEndpoint(id, 2);
        if (hr != 0) throw new COMException("SetDefaultEndpoint(eCommunications) failed", hr);
    }
}
"@

[AudioPolicyHelper]::SetDefaultRenderId($DeviceId)

@{ ok = $true; deviceId = $DeviceId } | ConvertTo-Json -Compress
