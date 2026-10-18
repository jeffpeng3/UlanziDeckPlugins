// audiohost: Windows 常駐音訊裝置查詢器與切換器。
// 常駐一個 process，協定為 stdin/stdout 單行 JSON：
//   request  { "id": N, "op": "getState" | "setDefault", "args": {...} }
//   response { "id": N, "ok": true,  "result": {...} }
//            { "id": N, "ok": false, "error": "..." }
//   event    { "event": "ready" | "defaultChanged" | "notifierError", ... }
// 通知走 IMMNotificationClient，預設裝置一變就主動推事件，不用輪詢。
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
#![allow(non_snake_case, non_camel_case_types, non_upper_case_globals)]

use std::io::{self, BufRead, Write};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use windows::core::{implement, interface, GUID, HRESULT, IUnknown, IUnknown_Vtbl, PCWSTR};
use windows::Win32::Foundation::{ERROR_SUCCESS, PROPERTYKEY};
use windows::Win32::Media::Audio::{
    eCommunications, eConsole, eMultimedia, eRender, EDataFlow, ERole, IMMDeviceEnumerator,
    IMMNotificationClient, IMMNotificationClient_Impl, MMDeviceEnumerator, DEVICE_STATE,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Registry::{
    RegGetValueW, HKEY_LOCAL_MACHINE, REG_VALUE_TYPE, RRF_RT_REG_DWORD, RRF_RT_REG_EXPAND_SZ,
    RRF_RT_REG_SZ,
};

// IPolicyConfig (未公開介面) 的 CLSID 與 vtable 順序。
// vtable: GetMixFormat, GetDeviceFormat, ResetDeviceFormat, SetDeviceFormat,
// GetProcessingPeriod, SetProcessingPeriod, GetShareMode, SetShareMode,
// GetPropertyValue, SetPropertyValue, SetDefaultEndpoint (slot 10),
// SetEndpointVisibility.
const POLICY_CONFIG_CLIENT: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);

const MMDEV_RENDER: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render";
const PKEY_IFACE_NAME: &str = "{b3f8fa53-0004-438e-9003-51a46e139bfc},6";
const PKEY_DESC: &str = "{a45c254e-df1c-4efd-8020-67d146a850e0},2";
const PKEY_ENUMERATOR: &str = "{a45c254e-df1c-4efd-8020-67d146a850e0},24";

#[interface("f8679f50-850a-41cf-9c72-430f290290c8")]
unsafe trait IPolicyConfig: IUnknown {
    fn GetMixFormat(&self, a: PCWSTR, b: *mut *mut core::ffi::c_void) -> HRESULT;
    fn GetDeviceFormat(&self, a: PCWSTR, b: i32, c: *mut *mut core::ffi::c_void) -> HRESULT;
    fn ResetDeviceFormat(&self, a: PCWSTR) -> HRESULT;
    fn SetDeviceFormat(
        &self,
        a: PCWSTR,
        b: *mut core::ffi::c_void,
        c: *mut core::ffi::c_void,
    ) -> HRESULT;
    fn GetProcessingPeriod(&self, a: PCWSTR, b: i32, c: *mut i64, d: *mut i64) -> HRESULT;
    fn SetProcessingPeriod(&self, a: PCWSTR, b: *mut i64) -> HRESULT;
    fn GetShareMode(&self, a: PCWSTR, b: *mut *mut core::ffi::c_void) -> HRESULT;
    fn SetShareMode(&self, a: PCWSTR, b: *mut core::ffi::c_void) -> HRESULT;
    fn GetPropertyValue(
        &self,
        a: PCWSTR,
        b: *mut core::ffi::c_void,
        c: *mut core::ffi::c_void,
    ) -> HRESULT;
    fn SetPropertyValue(
        &self,
        a: PCWSTR,
        b: *mut core::ffi::c_void,
        c: *mut core::ffi::c_void,
    ) -> HRESULT;
    fn SetDefaultEndpoint(&self, a: PCWSTR, b: i32) -> HRESULT;
    fn SetEndpointVisibility(&self, a: PCWSTR, b: i32) -> HRESULT;
}

// 所有 stdout 寫入共用一把鎖，回應與事件不會交錯。
static OUT: Mutex<()> = Mutex::new(());

fn emit(v: &Value) -> bool {
    let line = v.to_string();
    let _guard = OUT.lock().unwrap();
    let mut out = io::stdout();
    out.write_all(line.as_bytes()).is_ok()
        && out.write_all(b"\n").is_ok()
        && out.flush().is_ok()
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

unsafe fn reg_string(subkey: &str, value: &str) -> Option<String> {
    let sub = to_wide(subkey);
    let val = to_wide(value);
    let mut buf = [0u16; 1024];
    let mut size: u32 = (buf.len() * 2) as u32;
    let mut ty = REG_VALUE_TYPE(0);
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(sub.as_ptr()),
            PCWSTR(val.as_ptr()),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
            Some(&mut ty),
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            Some(&mut size),
        )
    };
    if rc != ERROR_SUCCESS {
        return None;
    }
    Some(wide_to_string(&buf))
}

unsafe fn reg_dword(subkey: &str, value: &str) -> Option<u32> {
    let sub = to_wide(subkey);
    let val = to_wide(value);
    let mut data: u32 = 0;
    let mut size: u32 = 4;
    let mut ty = REG_VALUE_TYPE(0);
    let rc = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(sub.as_ptr()),
            PCWSTR(val.as_ptr()),
            RRF_RT_REG_DWORD,
            Some(&mut ty),
            Some(&mut data as *mut u32 as *mut core::ffi::c_void),
            Some(&mut size),
        )
    };
    if rc != ERROR_SUCCESS {
        return None;
    }
    Some(data)
}

// 取 id 尾端的 {guid} 當 registry 子機碼名。
fn guid_of(id: &str) -> Option<&str> {
    id.rfind('{').map(|p| &id[p..])
}

unsafe fn enumerator() -> Result<IMMDeviceEnumerator, String> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
        .map_err(|e| format!("CoCreateInstance(IMMDeviceEnumerator) failed: {e}"))
}

unsafe fn pwstr_free(p: windows::core::PWSTR) -> String {
    let s = unsafe { p.to_string() }.unwrap_or_default();
    unsafe { CoTaskMemFree(Some(p.0 as *const core::ffi::c_void)) };
    s
}

unsafe fn list_devices(en: &IMMDeviceEnumerator) -> Result<Vec<Value>, String> {
    let coll = unsafe { en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) }
        .map_err(|e| format!("EnumAudioEndpoints failed: {e}"))?;
    let count = unsafe { coll.GetCount() }.map_err(|e| format!("GetCount failed: {e}"))?;

    let mut devices = Vec::new();
    for i in 0..count {
        let dev = match unsafe { coll.Item(i) } {
            Ok(d) => d,
            Err(_) => continue,
        };
        let id = match unsafe { dev.GetId() } {
            Ok(p) => unsafe { pwstr_free(p) },
            Err(_) => continue,
        };
        let guid = match guid_of(&id) {
            Some(g) => g,
            None => continue,
        };
        let sub = format!("{MMDEV_RENDER}\\{guid}");
        if unsafe { reg_dword(&sub, "DeviceState") } != Some(1) {
            continue;
        }
        let props = format!("{sub}\\Properties");
        devices.push(json!({
            "id": id,
            "name": unsafe { reg_string(&props, PKEY_IFACE_NAME) }.unwrap_or_default(),
            "desc": unsafe { reg_string(&props, PKEY_DESC) }.unwrap_or_default(),
            "enumerator": unsafe { reg_string(&props, PKEY_ENUMERATOR) }.unwrap_or_default(),
        }));
    }
    Ok(devices)
}

unsafe fn default_id(en: &IMMDeviceEnumerator) -> Option<String> {
    let dev = unsafe { en.GetDefaultAudioEndpoint(eRender, eConsole) }.ok()?;
    let p = unsafe { dev.GetId() }.ok()?;
    Some(unsafe { pwstr_free(p) })
}

unsafe fn get_state() -> Result<Value, String> {
    let en = unsafe { enumerator() }?;
    let devices = unsafe { list_devices(&en) }?;
    let default = unsafe { default_id(&en) };
    Ok(json!({ "devices": devices, "defaultId": default }))
}

fn valid_id(id: &str) -> bool {
    id.starts_with("{0.0.0.00000000}.{") && id.ends_with('}')
}

unsafe fn set_default(id: &str) -> Result<Value, String> {
    if !valid_id(id) {
        return Err(format!("Invalid device id: {id}"));
    }
    let policy: IPolicyConfig = unsafe { CoCreateInstance(&POLICY_CONFIG_CLIENT, None, CLSCTX_ALL) }
        .map_err(|e| format!("CoCreateInstance(IPolicyConfig) failed: {e}"))?;
    let wid = to_wide(id);
    for role in [eConsole.0, eMultimedia.0, eCommunications.0] {
        let hr = policy.SetDefaultEndpoint(PCWSTR(wid.as_ptr()), role);
        if hr.is_err() {
            return Err(format!("SetDefaultEndpoint(role={role}) failed: {hr:?}"));
        }
    }
    let en = unsafe { enumerator() }?;
    let after = unsafe { default_id(&en) };
    Ok(json!({ "ok": true, "deviceId": id, "defaultId": after }))
}

// IMMNotificationClient：預設裝置變化時主動推事件。
#[implement(IMMNotificationClient)]
struct AudioNotifier;

impl IMMNotificationClient_Impl for AudioNotifier_Impl {
    fn OnDeviceStateChanged(
        &self,
        _device_id: &PCWSTR,
        _new_state: DEVICE_STATE,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn OnDeviceAdded(&self, _device_id: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }

    fn OnDeviceRemoved(&self, _device_id: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }

    fn OnDefaultDeviceChanged(
        &self,
        flow: EDataFlow,
        _role: ERole,
        default_device_id: &PCWSTR,
    ) -> windows::core::Result<()> {
        if flow == eRender {
            let id = unsafe { default_device_id.to_string() }.unwrap_or_default();
            emit(&json!({ "event": "defaultChanged", "deviceId": id }));
        }
        Ok(())
    }

    fn OnPropertyValueChanged(
        &self,
        _device_id: &PCWSTR,
        _key: &PROPERTYKEY,
    ) -> windows::core::Result<()> {
        Ok(())
    }
}

// 在 MTA 執行緒註冊通知，回呼由 COM RPC 執行緒送達，不需 message pump。
// 執行緒保持存活以維持註冊有效。
fn start_notifier() {
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let en = match unsafe { enumerator() } {
        Ok(e) => e,
        Err(e) => {
            emit(&json!({ "event": "notifierError", "error": e }));
            return;
        }
    };
    let client: IMMNotificationClient = AudioNotifier.into();
    if let Err(e) = unsafe { en.RegisterEndpointNotificationCallback(&client) } {
        emit(&json!({ "event": "notifierError", "error": format!("RegisterEndpointNotificationCallback failed: {e}") }));
        return;
    }
    emit(&json!({ "event": "ready" }));
    // 保留 en / client 存活；MTA 回呼由 RPC 執行緒送達。
    loop {
        thread::sleep(Duration::from_secs(3600));
        std::hint::black_box((&en, &client));
    }
}

fn main() {
    thread::spawn(start_notifier);

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");

        let res: Result<Value, String> = match op {
            "getState" => unsafe { get_state() },
            "setDefault" => {
                let device = req
                    .get("args")
                    .and_then(|a| a.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                unsafe { set_default(device) }
            }
            _ => Err(format!("Unknown op: {op}")),
        };

        match res {
            Ok(result) => {
                emit(&json!({ "id": id, "ok": true, "result": result }));
            }
            Err(e) => {
                emit(&json!({ "id": id, "ok": false, "error": e }));
            }
        }
    }
}
