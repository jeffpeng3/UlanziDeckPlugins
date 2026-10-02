# Get-AudioState.ps1
# Lists active (DeviceState == 1) render endpoints from the MMDevices registry
# and resolves the current default render endpoint via WinRT MediaDevice.
# Outputs a single JSON object: { devices: [...], defaultId: "..." }
#
# NOTE: classic COM MMDeviceEnumerator::GetDefaultAudioEndpoint is deliberately
# NOT used here: its QueryInterface fails in some host processes, while the
# WinRT MediaDevice API works everywhere and returns the same endpoint id.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

$MMDEV_RENDER = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
# DeviceInterface_FriendlyName / DeviceDesc / EnumeratorName
$PKEY_IFACE_NAME = '{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
$PKEY_DESC = '{a45c254e-df1c-4efd-8020-67d146a850e0},2'
$PKEY_ENUMERATOR = '{a45c254e-df1c-4efd-8020-67d146a850e0},24'

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

@{ devices = $devices; defaultId = $defaultId } | ConvertTo-Json -Depth 4 -Compress
