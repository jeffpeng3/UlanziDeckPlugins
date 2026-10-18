# AudioHost.ps1 - long-lived JSON command host over stdin/stdout.
# Spawned once by the plugin. Keeping the process alive means the PolicyConfig
# C# type is compiled exactly once (Add-Type) instead of on every switch, and
# each request is a pipe round trip rather than a fresh powershell.exe launch.
#
# Protocol: one JSON object per line.
#   request  { "id": <number>, "op": "getState" | "setDefault", "args": {...} }
#   response { "id": <number>, "ok": true,  "result": {...} }
#            { "id": <number>, "ok": false, "error": "..." }
# Only JSON is ever written to stdout; the host exits on stdin EOF.

[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$MMDEV_RENDER = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
# DeviceInterface_FriendlyName / DeviceDesc / EnumeratorName
$PKEY_IFACE_NAME = '{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
$PKEY_DESC = '{a45c254e-df1c-4efd-8020-67d146a850e0},2'
$PKEY_ENUMERATOR = '{a45c254e-df1c-4efd-8020-67d146a850e0},24'

# Enumerate active (DeviceState == 1) render endpoints and resolve the current
# default via WinRT MediaDevice. Classic COM GetDefaultAudioEndpoint is not
# used: its QueryInterface fails in some host processes, WinRT works.
function Get-State {
    $devices = @()
    foreach ($key in (Get-ChildItem -Path $MMDEV_RENDER -ErrorAction Stop)) {
        $guid = $key.PSChildName
        $state = (Get-ItemProperty -Path $key.PSPath -Name DeviceState -ErrorAction SilentlyContinue).DeviceState
        if ($state -ne 1) { continue }

        $propsPath = Join-Path -Path $key.PSPath -ChildPath 'Properties'
        $props = Get-Item -Path $propsPath -ErrorAction SilentlyContinue
        if ($null -eq $props) { continue }

        $devices += @{
            id         = '{0.0.0.00000000}.' + $guid
            name       = [string]$props.GetValue($PKEY_IFACE_NAME, '')
            desc       = [string]$props.GetValue($PKEY_DESC, '')
            enumerator = [string]$props.GetValue($PKEY_ENUMERATOR, '')
        }
    }

    $defaultId = $null
    try {
        $md = [Windows.Media.Devices.MediaDevice, Windows.Media.Devices, ContentType = WindowsRuntime]
        # e.g. \\?\SWD#MMDEVAPI#{0.0.0.00000000}.{guid}#{...} -> canonical endpoint id
        $raw = $md::GetDefaultAudioRenderId(0)
        if ($raw -match '\{0\.0\.0\.00000000\}\.\{[0-9a-fA-F-]+\}') {
            $defaultId = $Matches[0]
        }
    } catch {
        $defaultId = $null
    }

    return @{ devices = $devices; defaultId = $defaultId }
}

# vtable layout: correct IPolicyConfig order is GetMixFormat, GetDeviceFormat,
# ResetDeviceFormat, SetDeviceFormat, GetProcessingPeriod, SetProcessingPeriod,
# GetShareMode, SetShareMode, GetPropertyValue, SetPropertyValue,
# SetDefaultEndpoint (slot 10), SetEndpointVisibility.
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

# Set Console, Multimedia and Communications roles, then read back the fresh
# default in the same process so callers get a free verification.
function Set-Default([string]$deviceId) {
    if ($deviceId -notmatch '^\{0\.0\.0\.00000000\}\.\{[0-9a-fA-F-]+\}$') {
        throw "Invalid device id: $deviceId"
    }
    [AudioPolicyHelper]::SetDefaultRenderId($deviceId)
    $after = Get-State
    return @{ ok = $true; deviceId = $deviceId; defaultId = $after.defaultId }
}

function Write-Response($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 6 -Compress))
    [Console]::Out.Flush()
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }

    $req = $null
    try { $req = $line | ConvertFrom-Json } catch { continue }
    if ($null -eq $req) { continue }

    $id = $req.id
    try {
        switch ($req.op) {
            'getState'   { Write-Response @{ id = $id; ok = $true; result = (Get-State) } }
            'setDefault' { Write-Response @{ id = $id; ok = $true; result = (Set-Default $req.args.id) } }
            default      { Write-Response @{ id = $id; ok = $false; error = "Unknown op: $($req.op)" } }
        }
    } catch {
        try { Write-Response @{ id = $id; ok = $false; error = $_.Exception.Message } } catch { }
    }
}
