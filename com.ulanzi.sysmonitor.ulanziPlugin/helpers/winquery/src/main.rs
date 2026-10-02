// winquery: Windows 常駐效能查詢器，每秒吐一行 JSON 到 stdout
// 零 process 開銷：PDH 加 Win32 API 全是 in-process 呼叫
// 協定跟 PowerShell 版 WinSampler 一致，Node 端不用改解析
// 無視窗子系統：被 Node 起起來不配 console，不閃黑窗
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
use std::collections::HashMap;
use std::io::Write;
use std::time::{Duration, Instant};

use nvml_wrapper::Nvml;

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::NetworkManagement::IpHelper::{
    FreeMibTable, GetIfTable2, MIB_IF_TABLE2,
};
use windows::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDriveStringsW,
};
use windows::Win32::System::Performance::{
    PdhAddCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterValue,
    PdhOpenQueryW, PDH_FMT_COUNTERVALUE, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

const DRIVE_FIXED: u32 = 3;
const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;
const IF_TYPE_TUNNEL: u32 = 131;

const SKIP_IFACE: &[&str] = &[
    "loopback", "tunnel", "pseudo", "isatap", "bluetooth", "hyper-v", "virtual",
    "vethernet", "vpn", "tap-", "tap_", "miniport", "xbox",
    // GetIfTable2 會列出 NDIS filter 子介面，流量跟實體卡重複，排除
    "lightweight", "scheduler", "filter driver", "-0000", "kernel debug",
];

fn u16_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

struct Pdh {
    query: PDH_HQUERY,
    cpu: PDH_HCOUNTER,
    dio_r: PDH_HCOUNTER,
    dio_w: PDH_HCOUNTER,
}

impl Pdh {
    fn open() -> Option<Pdh> {
        unsafe {
            let mut query = PDH_HQUERY::default();
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
                return None;
            }
            let mut cpu = PDH_HCOUNTER::default();
            let mut dio_r = PDH_HCOUNTER::default();
            let mut dio_w = PDH_HCOUNTER::default();
            let ok = PdhAddCounterW(
                query,
                windows::core::w!(r"\Processor(_Total)\% Processor Time"),
                0,
                &mut cpu,
            ) == 0
                && PdhAddCounterW(
                    query,
                    windows::core::w!(r"\PhysicalDisk(_Total)\Disk Read Bytes/sec"),
                    0,
                    &mut dio_r,
                ) == 0
                && PdhAddCounterW(
                    query,
                    windows::core::w!(r"\PhysicalDisk(_Total)\Disk Write Bytes/sec"),
                    0,
                    &mut dio_w,
                ) == 0;
            if !ok {
                PdhCloseQuery(query);
                return None;
            }
            Some(Pdh { query, cpu, dio_r, dio_w })
        }
    }

    fn collect(&self) -> bool {
        unsafe { PdhCollectQueryData(self.query) == 0 }
    }

    fn value(&self, c: PDH_HCOUNTER) -> f64 {
        unsafe {
            let mut v = std::mem::zeroed::<PDH_FMT_COUNTERVALUE>();
            if PdhGetFormattedCounterValue(c, PDH_FMT_DOUBLE, None, &mut v) == 0 {
                return v.Anonymous.doubleValue;
            }
        }
        0.0
    }
}

impl Drop for Pdh {
    fn drop(&mut self) {
        unsafe {
            PdhCloseQuery(self.query);
        }
    }
}

struct Drive {
    id: String,
    size: u64,
    free: u64,
}

fn read_drives() -> Vec<Drive> {
    let mut out = Vec::new();
    unsafe {
        let mut buf = [0u16; 1024];
        let n = GetLogicalDriveStringsW(Some(&mut buf));
        if n == 0 {
            return out;
        }
        for part in buf[..n as usize].split(|&c| c == 0) {
            if part.is_empty() {
                continue;
            }
            let root = u16_to_string(part);
            let hroot = HSTRING::from(&root);
            // 只收本機固定磁碟，跟 Node 版行為一致
            if GetDriveTypeW(&hroot) != DRIVE_FIXED {
                continue;
            }
            let mut avail = 0u64;
            let mut total = 0u64;
            let mut free = 0u64;
            let ok = GetDiskFreeSpaceExW(
                &hroot,
                Some(&mut avail),
                Some(&mut total),
                Some(&mut free),
            )
            .is_ok();
            if ok && total > 0 {
                out.push(Drive {
                    id: root.trim_end_matches('\\').to_string(),
                    size: total,
                    free,
                });
            }
        }
    }
    out
}

fn read_mem() -> (u64, u64) {
    unsafe {
        let mut st = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..std::mem::zeroed()
        };
        if GlobalMemoryStatusEx(&mut st).is_ok() {
            return (st.ullTotalPhys, st.ullAvailPhys);
        }
    }
    (0, 0)
}

struct Gpu {
    name: String,
    util: u32,
}

struct NvmlState {
    nvml: Nvml,
}

impl NvmlState {
    fn init() -> Option<NvmlState> {
        match Nvml::init() {
            Ok(nvml) => Some(NvmlState { nvml }),
            Err(_) => None,
        }
    }

    fn read_gpus(&self) -> Vec<Gpu> {
        let mut out = Vec::new();
        let count = match self.nvml.device_count() {
            Ok(c) => c,
            Err(_) => return out,
        };
        for i in 0..count {
            let dev = match self.nvml.device_by_index(i) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let name = dev.name().unwrap_or_else(|_| format!("GPU{}", i));
            let util = dev
                .utilization_rates()
                .map(|u| u.gpu)
                .unwrap_or(0);
            out.push(Gpu { name, util });
        }
        out
    }
}

struct Nic {
    name: String,
    rx: u64,
    tx: u64,
}

fn read_nics() -> Vec<Nic> {
    let mut out = Vec::new();
    unsafe {
        let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
        if GetIfTable2(&mut table).is_err() || table.is_null() {
            return out;
        }
        let num = (*table).NumEntries as usize;
        let base = (*table).Table.as_ptr();
        for i in 0..num {
            let row = &*base.add(i);
            if row.Type == IF_TYPE_SOFTWARE_LOOPBACK || row.Type == IF_TYPE_TUNNEL {
                continue;
            }
            let name = u16_to_string(&row.Description);
            let lower = name.to_lowercase();
            if SKIP_IFACE.iter().any(|k| lower.contains(k)) {
                continue;
            }
            out.push(Nic {
                name,
                rx: row.InOctets,
                tx: row.OutOctets,
            });
        }
        FreeMibTable(table as *const std::ffi::c_void);
    }
    out
}

struct Sample {
    cpu: f64,
    mem_total: u64,
    mem_free: u64,
    drives: Vec<Drive>,
    dio_r: u64,
    dio_w: u64,
    nics: Vec<(String, u64, u64)>,
    gpus: Vec<Gpu>,
}

fn emit(smp: &Sample) -> bool {
    let mut s = String::with_capacity(1024);
    s.push_str(&format!(
        "{{\"cpu\":{:.1},\"memFree\":{},\"memTotal\":{},\"disks\":[",
        smp.cpu, smp.mem_free, smp.mem_total
    ));
    for (i, d) in smp.drives.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{{\"DeviceID\":\"{}\",\"Size\":{},\"FreeSpace\":{}}}",
            json_escape(&d.id),
            d.size,
            d.free
        ));
    }
    s.push_str(&format!(
        "],\"dioR\":{},\"dioW\":{},\"net\":[",
        smp.dio_r, smp.dio_w
    ));
    for (i, (name, rx, tx)) in smp.nics.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{{\"Name\":\"{}\",\"BytesReceivedPerSec\":{},\"BytesSentPerSec\":{}}}",
            json_escape(name),
            rx,
            tx
        ));
    }
    s.push_str("]}");
    s.push_str(",\"gpus\":[");
    for (i, g) in smp.gpus.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{{\"name\":\"{}\",\"util\":{}}}",
            json_escape(&g.name),
            g.util
        ));
    }
    s.push_str("]}");
    println!("{}", s);
    std::io::stdout().flush().is_ok()
}

fn main() {
    let pdh = match Pdh::open() {
        Some(p) => p,
        None => std::process::exit(1),
    };
    // 熱身一次，速率計數器要有兩次採樣才準
    pdh.collect();
    // NVML 失敗就當沒顯卡，不影響其他數據
    let nvml = NvmlState::init();
    let mut prev_nic: HashMap<String, (u64, u64)> = HashMap::new();
    let mut prev_t = Instant::now();
    loop {
        std::thread::sleep(Duration::from_secs(1));
        if !pdh.collect() {
            continue;
        }
        let dt = prev_t.elapsed().as_secs_f64();
        prev_t = Instant::now();
        if dt <= 0.0 {
            continue;
        }
        let cpu = (pdh.value(pdh.cpu) * 10.0).round() / 10.0;
        let (mem_total, mem_free) = read_mem();
        let drives = read_drives();
        let dio_r = pdh.value(pdh.dio_r).round() as u64;
        let dio_w = pdh.value(pdh.dio_w).round() as u64;
        let nics_now = read_nics();
        let mut nics = Vec::with_capacity(nics_now.len());
        for n in &nics_now {
            let (prx, ptx) = prev_nic.get(&n.name).copied().unwrap_or((n.rx, n.tx));
            let rx = ((n.rx.saturating_sub(prx)) as f64 / dt).round() as u64;
            let tx = ((n.tx.saturating_sub(ptx)) as f64 / dt).round() as u64;
            nics.push((n.name.clone(), rx, tx));
        }
        prev_nic.clear();
        for n in &nics_now {
            prev_nic.insert(n.name.clone(), (n.rx, n.tx));
        }
        let gpus = match &nvml {
            Some(n) => n.read_gpus(),
            None => Vec::new(),
        };
        let sample = Sample {
            cpu,
            mem_total,
            mem_free,
            drives,
            dio_r,
            dio_w,
            nics,
            gpus,
        };
        // stdout 斷掉代表上層已死，直接退出不留孤兒
        if !emit(&sample) {
            break;
        }
    }
}
