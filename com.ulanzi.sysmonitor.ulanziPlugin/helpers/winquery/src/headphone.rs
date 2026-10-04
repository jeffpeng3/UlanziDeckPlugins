// headphone: 耳機電量 / 充電狀態 HID 查詢
// 協定來自 Linux hidraw POC：65 bytes output report，首 byte 為 reportID 0
// 寫 [0,2,bank,2,cmd] + pad，讀 input report 取 reply[4] | (reply[5] << 8)
//   bank8 0x13/0x12：喚醒；bank9 0x12：heartbeat；0x0F：電量(0<v<=1000, v/10=%)；0x10：充電(1=true,2=false)
// Windows 對應：SetupAPI 列舉 HID interface，vid/pid 過濾 device path，
// CreateFile + overlapped ReadFile + WaitForSingleObject 復刻 select 超時
use std::sync::{Arc, Mutex};
use std::time::Duration;

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInterfaces, SetupDiGetClassDevsW,
    SetupDiGetDeviceInterfaceDetailW, DIGCF_DEVICEINTERFACE, DIGCF_PRESENT,
    SETUP_DI_GET_CLASS_DEVS_FLAGS, SP_DEVICE_INTERFACE_DATA,
    SP_DEVICE_INTERFACE_DETAIL_DATA_W,
};
use windows::Win32::Devices::HumanInterfaceDevice::{
    HidD_FreePreparsedData, HidD_GetHidGuid, HidD_GetPreparsedData, HidP_GetCaps, HIDP_CAPS,
    PHIDP_PREPARSED_DATA,
};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_IO_PENDING, GENERIC_READ, GENERIC_WRITE, HANDLE,
    INVALID_HANDLE_VALUE, STATUS_SUCCESS, WAIT_OBJECT_0,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_FLAGS_AND_ATTRIBUTES,
    FILE_FLAG_OVERLAPPED, FILE_SHARE_MODE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows::Win32::System::Threading::WaitForSingleObject;

const FALLBACK_REPORT_LEN: usize = 65;
const DRAIN_MS: u32 = 30;
const REPLY_MS: u32 = 500;
const POLL_SECS: u64 = 10;

// POC：bytes([0, 2, bank, 2, cmd]) + pad 到 output report 長度
fn cmd_report(bank: u8, cmd: u8, out_len: usize) -> Vec<u8> {
    let mut b = vec![0u8; out_len.max(6)];
    b[1] = 2;
    b[2] = bank;
    b[3] = 2;
    b[4] = cmd;
    b
}

// 不含 reportID 版（Windows 嚴格比對長度時用）：[2, bank, 2, cmd] + pad
fn cmd_report_noid(bank: u8, cmd: u8, len: usize) -> Vec<u8> {
    let mut b = vec![0u8; len.max(5)];
    b[0] = 2;
    b[1] = bank;
    b[2] = 2;
    b[3] = cmd;
    b
}

fn hex8(buf: &[u8]) -> String {
    buf[..8.min(buf.len())]
        .iter()
        .map(|x| format!("{:02x}", x))
        .collect::<Vec<_>>()
        .join(" ")
}

fn debug_hex(label: &str, buf: &[u8]) {
    if std::env::var("WINQUERY_DEBUG").is_ok() {
        let hex: Vec<String> = buf[..8.min(buf.len())]
            .iter()
            .map(|x| format!("{:02x}", x))
            .collect();
        eprintln!("DBG hp {}: {}", label, hex.join(" "));
    }
}

pub struct HeadphoneTarget {
    pub vid: u16,
    pub pid: u16,
}

#[derive(Clone, Copy)]
pub struct HeadphoneStatus {
    pub present: bool,
    pub level: Option<u8>,
    pub charging: Option<bool>,
}

impl HeadphoneStatus {
    fn absent() -> HeadphoneStatus {
        HeadphoneStatus { present: false, level: None, charging: None }
    }
}

// Windows HID device interface path 內嵌 vid_XXXX&pid_XXXX，直接字串比對，不開錯裝置
fn debug_log(msg: &str) {
    if std::env::var("WINQUERY_DEBUG").is_ok() {
        eprintln!("DBG hp {}", msg);
    }
}

// 同一 VID/PID 可能有多個 HID interface（控制/廠商自定各一），全部列出逐一握手
fn find_device_paths(target: &HeadphoneTarget) -> Vec<String> {
    unsafe {
        let guid = HidD_GetHidGuid();
        let flags = SETUP_DI_GET_CLASS_DEVS_FLAGS(DIGCF_PRESENT.0 | DIGCF_DEVICEINTERFACE.0);
        let set = match SetupDiGetClassDevsW(Some(&guid as *const _), PCWSTR::null(), None, flags)
            .ok()
        {
            Some(s) if !s.is_invalid() => s,
            _ => return Vec::new(),
        };
        let needle = format!("vid_{:04x}&pid_{:04x}", target.vid, target.pid);
        let mut idx = 0u32;
        let mut found = Vec::new();
        loop {
            let mut ifdata: SP_DEVICE_INTERFACE_DATA = std::mem::zeroed();
            ifdata.cbSize = std::mem::size_of::<SP_DEVICE_INTERFACE_DATA>() as u32;
            if SetupDiEnumDeviceInterfaces(set, None, &guid as *const _, idx, &mut ifdata)
                .is_err()
            {
                break;
            }
            idx += 1;
            let mut need = 0u32;
            let _ = SetupDiGetDeviceInterfaceDetailW(
                set,
                &ifdata as *const _,
                None,
                0,
                Some(&mut need),
                None,
            );
            if need == 0 {
                continue;
            }
            let mut raw = vec![0u8; need as usize];
            let detail = raw.as_mut_ptr() as *mut SP_DEVICE_INTERFACE_DETAIL_DATA_W;
            // x64 上 cbSize = 8（只編 x86_64 target）
            (*detail).cbSize = 8;
            if SetupDiGetDeviceInterfaceDetailW(
                set,
                &ifdata as *const _,
                Some(detail),
                need,
                None,
                None,
            )
            .is_err()
            {
                continue;
            }
            let p = (*detail).DevicePath.as_ptr();
            let mut len = 0usize;
            while len < 512 && *p.add(len) != 0 {
                len += 1;
            }
            let path =
                String::from_utf16_lossy(std::slice::from_raw_parts(p, len));
            if path.to_lowercase().contains(&needle) {
                found.push(path);
            }
        }
        let _ = SetupDiDestroyDeviceInfoList(set);
        found
    }
}

struct HidDev(HANDLE);

impl Drop for HidDev {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn open_device(path: &str) -> Option<HidDev> {
    unsafe {
        let wpath = HSTRING::from(path);
        let h = CreateFileW(
            &wpath,
            GENERIC_READ.0 | GENERIC_WRITE.0,
            FILE_SHARE_MODE(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0),
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(FILE_FLAG_OVERLAPPED.0 | FILE_ATTRIBUTE_NORMAL.0),
            None,
        )
        .ok()?;
        if h == INVALID_HANDLE_VALUE {
            return None;
        }
        Some(HidDev(h))
    }
}

// 讀 HID caps 拿真正的 input/output report 長度；拿不到就退回 POC 的 65
// buffer 寫死 65 但裝置 report 更大時 ReadFile 會寫爆 stack
fn report_lengths(h: HANDLE) -> (usize, usize) {
    unsafe {
        let mut ppd = PHIDP_PREPARSED_DATA(0);
        if !HidD_GetPreparsedData(h, &mut ppd) {
            return (FALLBACK_REPORT_LEN, FALLBACK_REPORT_LEN);
        }
        let mut caps: HIDP_CAPS = std::mem::zeroed();
        let lens = if HidP_GetCaps(ppd, &mut caps) == STATUS_SUCCESS
            && caps.InputReportByteLength >= 6
            && caps.OutputReportByteLength >= 6
        {
            (
                caps.InputReportByteLength as usize,
                caps.OutputReportByteLength as usize,
            )
        } else {
            (FALLBACK_REPORT_LEN, FALLBACK_REPORT_LEN)
        };
        HidD_FreePreparsedData(ppd);
        debug_log(&format!("report in={} out={}", lens.0, lens.1));
        lens
    }
}

fn write_report(h: HANDLE, data: &[u8]) -> u32 {
    unsafe {
        let mut ov: OVERLAPPED = std::mem::zeroed();
        let mut n = 0u32;
        match WriteFile(h, Some(data), Some(&mut n), Some(&mut ov)) {
            Ok(()) => 0,
            Err(_) => {
                let e = GetLastError().0;
                if e != ERROR_IO_PENDING.0 {
                    return e;
                }
                let mut n2 = 0u32;
                if GetOverlappedResult(h, &ov as *const _, &mut n2, true).is_ok() {
                    0
                } else {
                    GetLastError().0
                }
            }
        }
    }
}

// hEvent 留 null 時系統用 file handle 本身 signal，WaitForSingleObject 等 input report
fn read_report(h: HANDLE, in_len: usize, timeout_ms: u32) -> Option<Vec<u8>> {
    unsafe {
        let mut buf = vec![0u8; in_len];
        let mut ov: OVERLAPPED = std::mem::zeroed();
        let mut n = 0u32;
        match ReadFile(h, Some(&mut buf), Some(&mut n), Some(&mut ov)) {
            Ok(()) => {
                debug_hex("sync", &buf);
                Some(buf)
            }
            Err(_) => {
                if GetLastError() != ERROR_IO_PENDING {
                    return None;
                }
                if WaitForSingleObject(h, timeout_ms) != WAIT_OBJECT_0 {
                    let _ = CancelIoEx(h, Some(&ov as *const _));
                    let mut n2 = 0u32;
                    let _ = GetOverlappedResult(h, &ov as *const _, &mut n2, true);
                    return None;
                }
                let mut n2 = 0u32;
                if GetOverlappedResult(h, &ov as *const _, &mut n2, false).is_err() {
                    return None;
                }
                debug_hex("async", &buf);
                Some(buf)
            }
        }
    }
}

fn parse_value(reply: &[u8]) -> u16 {
    if reply.len() < 6 {
        return 0;
    }
    (reply[4] as u16) | ((reply[5] as u16) << 8)
}

fn parse_level(reply: &[u8]) -> Option<u8> {
    let v = parse_value(reply);
    if v > 0 && v <= 1000 {
        Some((v / 10) as u8)
    } else {
        None
    }
}

fn parse_charge(reply: &[u8]) -> Option<bool> {
    match parse_value(reply) {
        1 => Some(true),
        2 => Some(false),
        _ => None,
    }
}

pub const HID_VID: u16 = 0x1b1c;
pub const HID_PID: u16 = 0x0a40;

// 完整跑一次 POC 序列；每輪開關 handle，熱插拔友善
// 每個候選 interface 都試 heartbeat，有回才繼續讀電量
pub fn query_once(target: &HeadphoneTarget) -> HeadphoneStatus {
    let paths = find_device_paths(target);
    debug_log(&format!(
        "vid_{:04x}&pid_{:04x} candidates={}",
        target.vid,
        target.pid,
        paths.len()
    ));
    if paths.is_empty() {
        return HeadphoneStatus::absent();
    }
    for path in paths.iter() {
        if let Some(st) = query_path(path) {
            return st;
        }
    }
    HeadphoneStatus::absent()
}

fn query_path(path: &str) -> Option<HeadphoneStatus> {
    let dev = match open_device(path) {
        Some(d) => d,
        None => {
            debug_log("open failed");
            return None;
        }
    };
    let h = dev.0;
    let (in_len, out_len) = report_lengths(h);
    // 初始化 + 吐掉陳舊 input（POC：6 次 0.03s drain）
    let _ = write_report(h, &cmd_report(8, 0x13, out_len));
    let _ = write_report(h, &cmd_report(8, 0x12, out_len));
    for _ in 0..6 {
        if read_report(h, in_len, DRAIN_MS).is_none() {
            break;
        }
    }
    // heartbeat 試兩種寫法：65B 含 reportID（POC 原樣），再試 64B 不含 ID
    // Windows WriteFile 嚴格比對長度，錯就 87；寫進去了才有回音
    let mut use_noid = false;
    let mut hb_reply: Option<Vec<u8>> = None;
    for attempt in 0..2 {
        let req = if attempt == 0 {
            cmd_report(9, 0x12, out_len)
        } else {
            cmd_report_noid(9, 0x12, out_len.saturating_sub(1))
        };
        let werr = write_report(h, &req);
        if werr != 0 {
            continue;
        }
        if let Some(r) = read_report(h, in_len, REPLY_MS) {
            debug_log(&format!("heartbeat ok rx={}", hex8(&r)));
            hb_reply = Some(r);
            use_noid = attempt == 1;
            break;
        }
        for _ in 0..6 {
            if read_report(h, in_len, DRAIN_MS).is_none() {
                break;
            }
        }
    }
    if hb_reply.is_none() {
        debug_log("heartbeat silent, next");
        return None;
    }
    debug_log("heartbeat ok");
    for _ in 0..6 {
        if read_report(h, in_len, DRAIN_MS).is_none() {
            break;
        }
    }
    // 屬性讀取沿用 heartbeat 成功的寫法
    let prop_req = |cmd: u8| {
        if use_noid {
            cmd_report_noid(9, cmd, out_len.saturating_sub(1))
        } else {
            cmd_report(9, cmd, out_len)
        }
    };
    let _ = write_report(h, &prop_req(0x0F));
    let level = read_report(h, in_len, REPLY_MS).and_then(|r| parse_level(&r));
    let _ = write_report(h, &prop_req(0x10));
    let charging = read_report(h, in_len, REPLY_MS).and_then(|r| parse_charge(&r));
    debug_log(&format!("level={:?} charging={:?}", level, charging));
    Some(HeadphoneStatus {
        present: level.is_some() || charging.is_some(),
        level,
        charging,
    })
}

pub struct HeadphoneMon {
    target: HeadphoneTarget,
    last: Mutex<HeadphoneStatus>,
}

impl HeadphoneMon {
    pub fn start() -> Arc<HeadphoneMon> {
        let mon = Arc::new(HeadphoneMon {
            target: HeadphoneTarget { vid: HID_VID, pid: HID_PID },
            last: Mutex::new(HeadphoneStatus::absent()),
        });
        let c = mon.clone();
        // 背景執行緒慢輪詢，UI 讀快取；電池變化慢，5 秒一輪
        std::thread::spawn(move || loop {
            let s = query_once(&c.target);
            if let Ok(mut l) = c.last.lock() {
                *l = s;
            }
            std::thread::sleep(Duration::from_secs(POLL_SECS));
        });
        mon
    }

    pub fn get(&self) -> HeadphoneStatus {
        self.last
            .lock()
            .map(|l| *l)
            .unwrap_or_else(|_| HeadphoneStatus::absent())
    }
}
