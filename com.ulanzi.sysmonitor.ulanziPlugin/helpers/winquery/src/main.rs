// winquery: Windows 常駐效能查詢器，每秒吐一行 JSON 到 stdout
// 零 process 開銷：PDH 加 Win32 API 全是 in-process 呼叫
// 協定跟 PowerShell 版 WinSampler 一致，Node 端不用改解析
// 無視窗子系統：被 Node 起起來不配 console，不閃黑窗
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
use std::collections::HashMap;
use std::io::Write;
use std::time::{Duration, Instant};

use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory};
use windows::Win32::NetworkManagement::IpHelper::{
    FreeMibTable, GetIfTable2, MIB_IF_TABLE2,
};
use windows::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDriveStringsW,
};
use windows::Win32::System::Performance::{
    PdhAddCounterW, PdhCloseQuery, PdhCollectQueryData, PdhEnumObjectItemsW,
    PdhGetFormattedCounterValue, PdhOpenQueryW, PdhRemoveCounter,
    PDH_FMT_COUNTERVALUE, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PERF_DETAIL_WIZARD,
};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

mod headphone;

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
    disk_active: PDH_HCOUNTER,
    disk_insts: Vec<(String, PDH_HCOUNTER)>,
}

// 列出 PDH 物件實例，磁碟名稱形如 0 C:，GPU 形如 pid_.._phys_0_eng_0_engtype_3D
fn enum_pdh_instances(object: &str) -> Vec<String> {
    unsafe {
        let obj = HSTRING::from(object);
        let mut counter_len = 0u32;
        let mut inst_len = 0u32;
        let _rc1 = PdhEnumObjectItemsW(
            PCWSTR::null(),
            PCWSTR::null(),
            &obj,
            None,
            &mut counter_len,
            None,
            &mut inst_len,
            PERF_DETAIL_WIZARD,
            0,
        );
        if inst_len == 0 {
            return Vec::new();
        }
        let mut inst_buf = vec![0u16; inst_len as usize + 8];
        let mut inst_len2 = inst_buf.len() as u32;
        let mut counter_buf = vec![0u16; counter_len as usize + 8];
        let mut counter_len2 = counter_buf.len() as u32;
        let rc2 = PdhEnumObjectItemsW(
            PCWSTR::null(),
            PCWSTR::null(),
            &obj,
            Some(PWSTR(counter_buf.as_mut_ptr())),
            &mut counter_len2,
            Some(PWSTR(inst_buf.as_mut_ptr())),
            &mut inst_len2,
            PERF_DETAIL_WIZARD,
            0,
        );
        if rc2 != 0
        {
            return Vec::new();
        }
        inst_buf[..inst_len2 as usize]
            .split(|&c| c == 0)
            .filter(|p| !p.is_empty())
            .map(u16_to_string)
            .collect()
    }
}

impl Pdh {
    fn add_counter(&self, path: &str) -> Option<PDH_HCOUNTER> {
        unsafe {
            let h = HSTRING::from(path);
            let mut c = PDH_HCOUNTER::default();
            if PdhAddCounterW(self.query, &h, 0, &mut c) == 0 {
                Some(c)
            } else {
                None
            }
        }
    }

    fn open() -> Option<Pdh> {
        unsafe {
            let mut query = PDH_HQUERY::default();
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
                return None;
            }
            let mut cpu = PDH_HCOUNTER::default();
            let mut dio_r = PDH_HCOUNTER::default();
            let mut dio_w = PDH_HCOUNTER::default();
            let mut disk_active = PDH_HCOUNTER::default();
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
                ) == 0
                && PdhAddCounterW(
                    query,
                    windows::core::w!(r"\PhysicalDisk(_Total)\% Disk Time"),
                    0,
                    &mut disk_active,
                ) == 0;
            if !ok {
                PdhCloseQuery(query);
                return None;
            }
            let mut pdh = Pdh {
                query,
                cpu,
                dio_r,
                dio_w,
                disk_active,
                disk_insts: Vec::new(),
            };
            // 每顆實體碟各加一個 active time，名稱形如 0 C:
            for inst in enum_pdh_instances("PhysicalDisk") {
                if inst == "_Total" {
                    continue;
                }
                let path = format!(r"\PhysicalDisk({})\% Disk Time", inst);
                if let Some(c) = pdh.add_counter(&path) {
                    pdh.disk_insts.push((inst, c));
                }
            }
            Some(pdh)
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

fn counter_value(c: PDH_HCOUNTER) -> f64 {
    unsafe {
        let mut v = std::mem::zeroed::<PDH_FMT_COUNTERVALUE>();
        let rc = PdhGetFormattedCounterValue(c, PDH_FMT_DOUBLE, None, &mut v);
        if std::env::var("WINQUERY_DEBUG").is_ok() {
            eprintln!(
                "DBG getval rc={:#x} v={}",
                rc,
                v.Anonymous.doubleValue
            );
        }
        if rc == 0 {
            return v.Anonymous.doubleValue;
        }
    }
    0.0
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
    util: f64,
}

// PDH GPU Engine：不分廠牌都吃得到
// 實例形如 pid_10992_luid_0x00000000_0x0000D3D0_phys_0_eng_0_engtype_3D
// pid 會變，只拿 phys 和 luid 配對，名稱用 DXGI 轉出真正卡名
struct GpuMon {
    query: PDH_HQUERY,
    // norm key 去掉 pid，value 是全名
    counters: HashMap<String, (u32, PDH_HCOUNTER)>,
    names: HashMap<u32, String>,
}

fn parse_gpu_inst(name: &str) -> Option<(u32, u32, i32)> {
    let p: Vec<&str> = name.split('_').collect();
    let mut phys = None;
    let mut low = None;
    let mut high = None;
    let mut i = 0;
    while i < p.len() {
        if p[i] == "phys" && i + 1 < p.len() {
            phys = p[i + 1].parse::<u32>().ok();
            i += 2;
        } else if p[i] == "luid" && i + 2 < p.len() {
            high = u32::from_str_radix(p[i + 1].trim_start_matches("0x"), 16)
                .ok()
                .map(|v| v as i32);
            low = u32::from_str_radix(p[i + 2].trim_start_matches("0x"), 16).ok();
            i += 3;
        } else {
            i += 1;
        }
    }
    Some((phys?, low?, high?))
}

fn dxgi_adapters() -> Vec<(u32, i32, String)> {
    let mut out = Vec::new();
    unsafe {
        let factory: IDXGIFactory = match CreateDXGIFactory1() {
            Ok(f) => f,
            Err(_) => return out,
        };
        let mut i = 0u32;
        while let Ok(a) = factory.EnumAdapters(i) {
            if let Ok(d) = a.GetDesc() {
                out.push((
                    d.AdapterLuid.LowPart,
                    d.AdapterLuid.HighPart,
                    u16_to_string(&d.Description),
                ));
            }
            i += 1;
        }
        out
    }
}

impl GpuMon {
    fn open() -> GpuMon {
        let mut mon = GpuMon {
            query: PDH_HQUERY::default(),
            counters: HashMap::new(),
            names: HashMap::new(),
        };
        unsafe {
            let mut query = PDH_HQUERY::default();
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) == 0 && !query.is_invalid() {
                mon.query = query;
                mon.rebuild();
            }
        }
        mon
    }

    fn add_counter(&self, path: &str) -> Option<PDH_HCOUNTER> {
        unsafe {
            let h = HSTRING::from(path);
            let mut c = PDH_HCOUNTER::default();
            if PdhAddCounterW(self.query, &h, 0, &mut c) == 0 {
                Some(c)
            } else {
                None
            }
        }
    }

    // 全量綁定：每個 (行程, 引擎) 實例各一個計數器，按 phys 加總
    // 不去 pid 重複，因為不同行程的用量是獨立的，少綁就少算
    // 列舉取空代表失敗，直接保留現有計數器
    fn rebuild(&mut self) {
        if self.query.is_invalid() {
            return;
        }
        let insts = enum_pdh_instances("GPU Engine");
        if insts.is_empty() {
            return;
        }
        let live: std::collections::HashSet<String> = insts.into_iter().collect();
        // 先砍已死實例的計數器
        let dead: Vec<String> = self
            .counters
            .keys()
            .filter(|k| !live.contains(*k))
            .cloned()
            .collect();
        for k in dead {
            if let Some((_, c)) = self.counters.remove(&k) {
                unsafe {
                    PdhRemoveCounter(c);
                }
            }
        }
        // 再補上活著但還沒綁的
        let mut ordered: Vec<String> = live.into_iter().collect();
        ordered.sort();
        for full in ordered {
            if self.counters.contains_key(&full) {
                continue;
            }
            let path = format!(r"\GPU Engine({})\Utilization Percentage", full);
            if let Some(c) = self.add_counter(&path) {
                let phys = parse_gpu_inst(&full).map(|(p, _, _)| p).unwrap_or(999);
                self.counters.insert(full, (phys, c));
            }
        }
        self.resolve_names();
    }

    fn resolve_names(&mut self) {
        // phys 配 DXGI 的 luid 拿真正卡名
        let adapters = dxgi_adapters();
        let mut phys_luid: HashMap<u32, (u32, i32)> = HashMap::new();
        for (full, _) in self.counters.iter() {
            if let Some((phys, low, high)) = parse_gpu_inst(full) {
                phys_luid.entry(phys).or_insert((low, high));
            }
        }
        self.names.clear();
        for (phys, (low, high)) in &phys_luid {
            let mut name = format!("GPU {}", phys);
            for (alow, ahigh, desc) in &adapters {
                if alow == low && ahigh == high && !desc.is_empty() {
                    name = desc.clone();
                    break;
                }
            }
            self.names.insert(*phys, name);
        }
    }

    fn collect(&self) -> bool {
        if self.query.is_invalid() {
            return false;
        }
        unsafe { PdhCollectQueryData(self.query) == 0 }
    }

    fn read(&self) -> Vec<Gpu> {
        let mut sums: HashMap<u32, f64> = HashMap::new();
        let mut raw_total = 0.0;
        for (phys, c) in self.counters.values() {
            let v = counter_value(*c);
            raw_total += v;
            *sums.entry(*phys).or_insert(0.0) += v;
        }
        if std::env::var("WINQUERY_DEBUG").is_ok() {
            eprintln!(
                "DBG gpu counters={} raw_total={:.2}",
                self.counters.len(),
                raw_total
            );
        }
        let mut phys_list: Vec<u32> = sums.keys().copied().collect();
        phys_list.sort_unstable();
        phys_list
            .into_iter()
            .map(|p| {
                let util = (sums[&p].min(100.0) * 10.0).round() / 10.0;
                let name = self
                    .names
                    .get(&p)
                    .cloned()
                    .unwrap_or_else(|| format!("GPU {}", p));
                Gpu { name, util }
            })
            .collect()
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
    disk_active: f64,
    disk_actives: Vec<(String, f64)>,
    nics: Vec<(String, u64, u64)>,
    gpus: Vec<Gpu>,
    hp: Option<headphone::HeadphoneStatus>,
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
    s.push(']');
    s.push_str(",\"diskActive\":");
    s.push_str(&format!("{:.1}", smp.disk_active));
    s.push_str(",\"diskActives\":[");
    for (i, (name, v)) in smp.disk_actives.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{{\"name\":\"{}\",\"active\":{:.1}}}",
            json_escape(name),
            v
        ));
    }
    s.push(']');
    s.push_str(",\"gpus\":[");
    for (i, g) in smp.gpus.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{{\"name\":\"{}\",\"util\":{:.1}}}",
            json_escape(&g.name),
            g.util
        ));
    }
    s.push_str("]");
    // hp：耳機電量接口（VID/PID 寫死在 helper 內）
    s.push_str(",\"hp\":");
    match &smp.hp {
        Some(h) => {
            let level = h.level.map(|v| v.to_string()).unwrap_or_else(|| "null".to_string());
            let charging = h
                .charging
                .map(|v| if v { "true" } else { "false" })
                .unwrap_or("null");
            s.push_str(&format!(
                "{{\"present\":{},\"level\":{},\"charging\":{}}}",
                h.present, level, charging
            ));
        }
        None => s.push_str("null"),
    }
    s.push('}');
    println!("{}", s);
    std::io::stdout().flush().is_ok()
}

fn main() {
    // 耳機 HID 目標寫死（headphone.rs 的 HID_VID/HID_PID），背景執行緒常駐查詢
    let hp_mon = headphone::HeadphoneMon::start();
    let pdh = match Pdh::open() {
        Some(p) => p,
        None => std::process::exit(1),
    };
    // 熱身一次，速率計數器要有兩次採樣才準
    pdh.collect();
    let mut gpu_mon = GpuMon::open();
    gpu_mon.collect();
    let mut prev_nic: HashMap<String, (u64, u64)> = HashMap::new();
    let mut prev_t = Instant::now();
    let mut tick = 0u32;
    loop {
        std::thread::sleep(Duration::from_secs(1));
        tick += 1;
        if !pdh.collect() {
            continue;
        }
        gpu_mon.collect();
        // pid 會變，每 10 秒重建 GPU 計數器集合
        if tick.is_multiple_of(10) {
            gpu_mon.rebuild();
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
        let disk_active = (pdh.value(pdh.disk_active) * 10.0).round() / 10.0;
        let mut disk_actives = Vec::with_capacity(pdh.disk_insts.len());
        for (name, c) in &pdh.disk_insts {
            let v = (pdh.value(*c) * 10.0).round() / 10.0;
            disk_actives.push((name.clone(), v));
        }
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
        let gpus = gpu_mon.read();
        let sample = Sample {
            cpu,
            mem_total,
            mem_free,
            drives,
            dio_r,
            dio_w,
            disk_active,
            disk_actives,
            nics,
            gpus,
            hp: Some(hp_mon.get()),
        };
        // stdout 斷掉代表上層已死，直接退出不留孤兒
        if !emit(&sample) {
            break;
        }
    }
}
