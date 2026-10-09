import { spawn } from 'child_process';
import { Utils } from './ulanzi-api/index.js';

// Windows 常駐採樣：只起一個 powershell process，每秒吐一次數據
// 只查畫面上有在顯示的項目，不需要的查詢不跑
// 各按鍵讀快取，不再每輪各起 process
const QUERY_DEFS = {
  cpu: [
    "  $c=Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor | Where-Object{$_.Name -eq '_Total'}"
  ],
  mem: [
    '  $o=Get-CimInstance -ClassName Win32_OperatingSystem'
  ],
  disk: [
    '  $d=Get-CimInstance -ClassName Win32_LogicalDisk | Select-Object DeviceID,Size,FreeSpace',
    "  $da=Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Select-Object @{Name='name';Expression={$_.Name}},@{Name='active';Expression={$_.PercentDiskTime}}"
  ],
  diskio: [
    "  $i=Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object{$_.Name -eq '_Total'}"
  ],
  net: [
    '  $n=Get-CimInstance -ClassName Win32_PerfFormattedData_Tcpip_NetworkInterface | Select-Object Name,BytesReceivedPerSec,BytesSentPerSec'
  ]
};

const EMIT = '  $diskActive=($da | Where-Object{$_.name -eq \'_Total\'} | Select-Object -ExpandProperty active); [pscustomobject]@{cpu=$c.PercentProcessorTime;memFree=$o.FreePhysicalMemory;memTotal=$o.TotalVisibleMemorySize;disks=$d;dioR=$i.DiskReadBytesPerSec;dioW=$i.DiskWriteBytesPerSec;net=$n;diskActive=$diskActive;diskActives=$da} | ConvertTo-Json -Compress -Depth 3';

function buildScript(kinds) {
  const lines = ["$ErrorActionPreference='SilentlyContinue'", 'while($true){'];
  for (const k of kinds) {
    const def = QUERY_DEFS[k];
    if (def) lines.push(...def);
  }
  lines.push(EMIT);
  lines.push('  Start-Sleep -Seconds 1');
  lines.push('}');
  return lines.join('\n');
}

class WinSampler {
  constructor() {
    this.proc = null;
    this.buf = '';
    this.sample = null;
    this.sampleAt = 0;
    this.counts = {};
    this.retryAt = 0;
    this.gotData = false;
    this.useExe = true;
    // exe 失敗退回 ps 後，每 5 分鐘重試一次（安裝中途起不來也能自癒）
    this.exeRetryAt = 0;
    // 診斷 log（進 Studio log 檔）：只在後端切換與 hp 變化時印
    this._loggedBackend = '';
    this._lastHpKey = '';
  }

  // Rust 版 exe 優先，跑不起來就退回 powershell 迴圈
  exePath() {
    try {
      return Utils.getPluginPath() + '/bin/win-x64/winquery.exe';
    } catch (e) {
      return null;
    }
  }

  kinds() {
    return Object.keys(this.counts).filter(k => this.counts[k] > 0 && QUERY_DEFS[k]);
  }

  // gpu 吃 helper 的 NVML，不用加查詢，但要算活人數
  alive() {
    return Object.keys(this.counts).some(k => this.counts[k] > 0);
  }

  acquire(kind) {
    if (!QUERY_DEFS[kind] && kind !== 'gpu' && kind !== 'batt') return;
    this.counts[kind] = (this.counts[kind] || 0) + 1;
    this.rebuild();
  }

  release(kind) {
    if (!QUERY_DEFS[kind] && kind !== 'gpu' && kind !== 'batt') return;
    this.counts[kind] = Math.max(0, (this.counts[kind] || 0) - 1);
    this.rebuild();
  }

  // 顯示項目變化就重建迴圈，沒人要就砍掉 process
  rebuild() {
    this.stop();
    if (this.alive()) this.start();
  }

  start() {
    if (this.proc) return;
    // process 意外死掉不要立刻重起，避免重試風暴
    if (Date.now() < this.retryAt) return;
    if (!this.alive()) return;
    if (!this.useExe && Date.now() >= this.exeRetryAt) {
      this.exeRetryAt = Date.now() + 5 * 60 * 1000;
      this.useExe = true;
    }
    if (this.useExe) {
      if (this.startExe()) return;
      // exe 不存在或起不來，退回 powershell，下次重試時間已約好
      this.useExe = false;
    }
    this.startPs();
  }

  // Rust 查詢器：同樣一行一包 JSON，零 process 開銷
  startExe() {
    const exe = this.exePath();
    if (!exe) return false;
    try {
      const proc = spawn(exe, [], { windowsHide: true });
      this.proc = proc;
      this.buf = '';
      this.gotData = false;
      if (this._loggedBackend !== 'exe') {
        this._loggedBackend = 'exe';
        console.log('===sampler backend: exe', exe);
      }
      proc.stdout.on('data', chunk => this.onData(String(chunk)));
      proc.on('close', () => {
        if (this.proc === proc) this.proc = null;
        // 有成功吐過資料才值得重試，否則退回 powershell
        if (this.gotData) {
          this.retryAt = Date.now() + 5000;
        } else {
          this.useExe = false;
        }
      });
      proc.on('error', () => {
        if (this.proc === proc) this.proc = null;
        this.useExe = false;
      });
      return true;
    } catch (e) {
      this.proc = null;
      this.useExe = false;
      return false;
    }
  }

  // 備援：powershell 迴圈，協定相同
  startPs() {
    if (this._loggedBackend !== 'ps') {
      this._loggedBackend = 'ps';
      console.log('===sampler backend: powershell (hp unavailable)');
    }
    try {
      const proc = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', buildScript(this.kinds())],
        { windowsHide: true });
      this.proc = proc;
      this.buf = '';
      proc.stdout.on('data', chunk => this.onData(String(chunk)));
      proc.on('close', () => {
        if (this.proc === proc) this.proc = null;
        this.retryAt = Date.now() + 5000;
      });
      proc.on('error', () => {
        if (this.proc === proc) this.proc = null;
        this.retryAt = Date.now() + 5000;
      });
    } catch (e) {
      this.proc = null;
      this.retryAt = Date.now() + 5000;
    }
  }

  stop() {
    if (this.proc) {
      try { this.proc.kill(); } catch (e) { /* ignore */ }
      this.proc = null;
    }
  }

  onData(chunk) {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('{')) continue;
      try {
        this.sample = JSON.parse(s);
        this.sampleAt = Date.now();
        this.gotData = true;
        // hp 有變化才印（進 Studio log 檔），方便追蹤耳機狀態
        const hpKey = JSON.stringify((this.sample && this.sample.hp) || null);
        if (hpKey !== this._lastHpKey) {
          this._lastHpKey = hpKey;
          console.log('===hp sample:', hpKey);
        }
      } catch (e) { /* 半包等下次 */ }
    }
  }

  get() {
    return this.sample;
  }

  age() {
    if (!this.sample) return Infinity;
    return Date.now() - this.sampleAt;
  }
}

export default new WinSampler();
