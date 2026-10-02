import si from 'systeminformation';
import { execFile } from 'child_process';
import { createSVGWindow } from 'svgdom'
import { SVG, registerWindow } from '@svgdotjs/svg.js';

const window = createSVGWindow()
const document = window.document

// register window and document
registerWindow(window, document)

const BG = '#0b0f0e';
const GREEN = '#4ade80';
const YELLOW = '#facc15';
const TITLE_COLOR = '#e8e8e8';

// 雙系列顏色：讀/下傳綠，上傳/寫黃
const SERIES_COLORS = ['#4ade80', '#facc15'];
const SERIES_ARROWS = ['\u2193', '\u2191'];

// 全插件共用的更新頻率，任一 PI 或全域設定寫入後全部 instance 同步
const Shared = { ms: 1000 };

function toMs(seconds) {
  const s = Number(seconds);
  if (!s || s <= 0) return 1000;
  return Math.max(500, s * 1000);
}

export default function SysMonitor(context, $UD) {
  var settings = {},
    context = context,
    poll_timer = 0,
    allowSend = true,
    lastIcon = '',
    $UD = $UD,
    history = [],
    $UD = $UD;

  const TITLES = { cpu: 'CPU', mem: 'Memory', disk: 'Disk', diskio: 'Disk IO', net: 'Net', gpu: 'GPU' };

  function metricKey() {
    const m = settings.metric;
    if (m === 'cpu' || m === 'mem' || m === 'disk' || m === 'diskio' || m === 'net' || m === 'gpu') return m;
    if (context.indexOf('.diskio') >= 0) return 'diskio';
    if (context.indexOf('.disk') >= 0) return 'disk';
    if (context.indexOf('.net') >= 0) return 'net';
    if (context.indexOf('.gpu') >= 0) return 'gpu';
    if (context.indexOf('.mem') >= 0) return 'mem';
    return 'cpu';
  }

  function defaultTitle() {
    return TITLES[metricKey()] || 'CPU';
  }

  function refreshIntervalMs() {
    return Shared.ms;
  }

  // 走勢固定顯示過去 60 秒，靠右對齊持續捲動
  const WINDOW_MS = 60000;
  const MAX_POINTS = 180;

  function decimals() {
    const d = Number(settings.decimals);
    return Number.isFinite(d) ? d : 1;
  }

  function startPoll() {
    if (poll_timer !== 0) {
      clearInterval(poll_timer);
      poll_timer = 0;
    }
    poll_timer = setInterval(collectAndDraw, refreshIntervalMs());
  }

  // 回傳陣列：單系列 1 個值，diskio/net 雙系列 2 個值
  async function readStats() {
    const key = metricKey();
    if (key === 'cpu') {
      const load = await si.currentLoad();
      return [clamp(Number(load.currentLoad) || 0)];
    }
    if (key === 'mem') {
      const mem = await si.mem();
      if (mem.total) return [clamp(((mem.total - mem.available) / mem.total) * 100)];
      return [0];
    }
    if (key === 'disk') {
      return [await readDiskUse()];
    }
    if (key === 'diskio') {
      return await readDiskIO();
    }
    if (key === 'net') {
      return await readNet();
    }
    if (key === 'gpu') {
      return [await readGpuUse()];
    }
    return [0];
  }

  // si 只合併 nvidia-smi 的使用率，非 N 卡或抓不到就直調 nvidia-smi
  async function readGpuUse() {
    try {
      const g = await si.graphics().catch(() => null);
      const ctrls = (g && g.controllers) || [];
      const sel = pickGpu(ctrls);
      if (sel) {
        const u = Number(sel.utilizationGpu);
        if (Number.isFinite(u)) return clamp(u);
      }
    } catch (e) {
      console.log('==gpu si.graphics failed:', e && e.message);
    }
    try {
      const out = await execCmd('nvidia-smi',
        ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits']);
      const m = String(out).match(/(\d+(\.\d+)?)/);
      if (m) return clamp(Number(m[1]));
    } catch (e) {
      console.log('==gpu nvidia-smi failed:', e && e.message);
    }
    return 0;
  }

  function pickGpu(ctrls) {
    if (!ctrls || ctrls.length === 0) return null;
    const want = (settings.gpu || '').trim().toLowerCase();
    if (want) {
      if (/^\d+$/.test(want) && ctrls[Number(want)]) return ctrls[Number(want)];
      const hit = ctrls.find(c =>
        String(c.model || '').toLowerCase().includes(want) ||
        String(c.name || '').toLowerCase().includes(want) ||
        String(c.vendor || '').toLowerCase().includes(want));
      if (hit) return hit;
    }
    return ctrls.find(c => Number.isFinite(Number(c.utilizationGpu)))
        || ctrls[0];
  }

  // systeminformation v5 的 disksIO 在 Windows 沒實作，直接回 null
  // Windows 改走 PowerShell 效能計數器 _Total，單次查詢即每秒值
  async function readDiskIO() {
    if (process.platform === 'win32') {
      try {
        const out = await execPs(
          "Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk" +
          " | Where-Object { $_.Name -eq '_Total' }" +
          " | Select-Object DiskReadBytesPerSec,DiskWriteBytesPerSec" +
          " | ConvertTo-Json -Compress"
        );
        const j = JSON.parse(out);
        return [Math.max(0, Number(j.DiskReadBytesPerSec) || 0),
                Math.max(0, Number(j.DiskWriteBytesPerSec) || 0)];
      } catch (e) {
        console.log('==diskio powershell failed:', e && e.message);
        return [0, 0];
      }
    }
    const io = await si.disksIO().catch(() => null);
    return [Math.max(0, Number(io && (io.rIO_sec || io.rIO)) || 0),
            Math.max(0, Number(io && (io.wIO_sec || io.wIO)) || 0)];
  }

  function execCmd(file, args) {
    return new Promise((resolve, reject) => {
      execFile(file, args || [],
        { timeout: 5000, windowsHide: true },
        (err, stdout) => {
          if (err) reject(err);
          else resolve(String(stdout).trim());
        });
    });
  }

  function execPs(cmd) {
    return execCmd('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', cmd]);
  }
  async function readDiskUse() {
    const list = await si.fsSize().catch(() => []);
    if (!list || list.length === 0) return 0;
    const norm = s => String(s || '').toLowerCase().replace(/[\\/]+$/, '');
    const target = norm(settings.target || '');
    let pick = null;
    if (target) {
      pick = list.find(f => norm(f.mount) === target)
          || list.find(f => norm(f.fs) === target);
    }
    if (!pick) {
      pick = list.find(f => norm(f.mount) === 'c:')
          || list.find(f => norm(f.fs) === 'c:')
          || list.find(f => Number(f.size) > 0 && Number(f.use) > 0
              && !String(f.mount || '').startsWith('/usr/')
              && !String(f.mount || '').startsWith('/mnt/wsl'))
          || list.find(f => Number(f.size) > 0);
    }
    return clamp(Number(pick && pick.use) || 0);
  }

  async function readNet() {
    let list = await si.networkStats().catch(() => []);
    if (!Array.isArray(list)) list = list ? [list] : [];
    const iface = (settings.iface || '').trim().toLowerCase();
    if (iface) {
      list = list.filter(n => String(n.iface || '').toLowerCase() === iface);
    } else {
      list = list.filter(n => !n.internal && String(n.iface || '').toLowerCase() !== 'lo');
    }
    let rx = 0, tx = 0;
    for (const n of list) {
      rx += Number(n.rx_sec) || 0;
      tx += Number(n.tx_sec) || 0;
    }
    return [Math.max(0, rx), Math.max(0, tx)];
  }

  function clamp(v) {
    if (v < 0) return 0;
    if (v > 100) return 100;
    return v;
  }

  async function collectAndDraw() {
    try {
      const vals = await readStats();
      const now = Date.now();
      history.push({ t: now, vals: vals });
      // 只留過去 60 秒，外加總數上限避免記憶體膨脹
      while (history.length > 0 && now - history[0].t > WINDOW_MS) history.shift();
      while (history.length > MAX_POINTS) history.shift();
      drawIcon(vals);
    } catch (e) {
      console.log('==sysmonitor read error:', e);
    }
  }

  function formatPct(v) {
    return v.toFixed(decimals()) + '%';
  }

  function formatBytes(v) {
    const d = decimals();
    if (v >= 1073741824) return (v / 1073741824).toFixed(d) + 'G/s';
    if (v >= 1048576) return (v / 1048576).toFixed(d) + 'M/s';
    if (v >= 1024) return (v / 1024).toFixed(d) + 'K/s';
    return Math.round(v) + 'B/s';
  }

  // 每列 {text, color}，單系列 1 列，雙系列 2 列
  function labelsFor(vals) {
    const key = metricKey();
    if (vals.length > 1) {
      return vals.map((v, i) => ({
        text: SERIES_ARROWS[i] + formatBytes(v),
        color: SERIES_COLORS[i % SERIES_COLORS.length]
      }));
    }
    if (key === 'diskio' || key === 'net') {
      return [{ text: formatBytes(vals[0]), color: SERIES_COLORS[0] }];
    }
    return [{ text: formatPct(vals[0]), color: GREEN }];
  }

  function drawIcon(vals) {
    const SIZE = 200;
    const title = (settings.title || defaultTitle() || 'Request').slice(0, 12);
    const labels = labelsFor(vals);

    const draw = SVG(document.documentElement).size(SIZE, SIZE);
    draw.rect(SIZE, SIZE).fill(BG);

    // 標題置頂
    draw.text(title).font({
      family: 'sans-serif',
      size: 26,
      weight: 500,
      fill: TITLE_COLOR,
      anchor: 'middle'
    }).center(SIZE / 2, 26);

    if (labels.length > 1) {
      // 雙系列：兩列置中，讀/下傳綠，寫/上傳黃
      const rows = [
        { label: labels[0], y: 58 },
        { label: labels[1], y: 92 }
      ];
      for (const r of rows) {
        const size = r.label.text.length > 9 ? 26 : 30;
        draw.text(r.label.text).font({
          family: 'sans-serif',
          size: size,
          weight: 'bold',
          fill: r.label.color,
          anchor: 'middle'
        }).center(SIZE / 2, r.y);
      }
    } else {
      // 單系列大數字，避免 D200 爆框
      const label = labels[0].text;
      const numSize = label.length > 7 ? 34 : label.length > 5 ? 40 : 46;
      draw.text(label).font({
        family: 'sans-serif',
        size: numSize,
        weight: 'bold',
        fill: labels[0].color,
        anchor: 'middle'
      }).center(SIZE / 2, 78);
    }

    // 底部面積走勢圖
    drawTrend(draw, SIZE);

    const svgContent = draw.svg();
    const base64Svg = Buffer.from(svgContent).toString('base64');
    setIcon('data:image/svg+xml;base64,' + base64Svg);
    draw.clear();
  }

  function drawTrend(draw, SIZE) {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const pts = history.filter(p => p.t >= cutoff);
    // 圖區往上撐高，底部留 8% 空白
    const top = 112;
    const bottom = 184;

    // 全部系列共同縮放，波動再小也看得見
    let wmin = 0;
    let wmax = 0;
    let count = 0;
    for (const p of pts) {
      for (const v of p.vals) {
        if (count === 0) { wmin = v; wmax = v; }
        else {
          if (v < wmin) wmin = v;
          if (v > wmax) wmax = v;
        }
        count++;
      }
    }
    let span = wmax - wmin;
    if (span < 8 && count > 0 && wmax <= 100 && wmin >= 0) {
      // 百分比且太平时以平均為中心撐開，避免抖動炸滿全圖
      const mid = (wmax + wmin) / 2;
      wmin = mid - 4;
      wmax = mid + 4;
      span = 8;
    }
    if (span <= 0) span = 1;
    // 最大值上方留空，線不頂到頂
    const lo = Math.max(0, wmin - span * 0.15);
    const hi = wmax + span * 0.5;
    const yOf = v => Math.round(bottom - ((v - lo) / (hi - lo)) * (bottom - top));

    const seriesCount = pts.length > 0 ? pts[0].vals.length : 1;
    for (let s = 0; s < seriesCount; s++) {
      const color = SERIES_COLORS[s % SERIES_COLORS.length];
      let linePts;
      if (pts.length > 1) {
        // 有幾個點就撐滿全寬，新點進來舊點左移，立刻看得到捲動
        const stepX = SIZE / (pts.length - 1);
        linePts = pts.map((p, i) => [Math.round(i * stepX), yOf(p.vals[s] !== undefined ? p.vals[s] : p.vals[0])]);
      } else {
        const v = pts.length === 1 ? (pts[0].vals[s] !== undefined ? pts[0].vals[s] : pts[0].vals[0]) : 0;
        const y = yOf(v);
        linePts = [[0, y], [SIZE, y]];
      }

      const lineStr = linePts.map(p => p.join(',')).join(' ');
      const areaStr = `${linePts[0][0]},${bottom} ` + lineStr + ` ${linePts[linePts.length - 1][0]},${bottom}`;

      // 用 hex 加 opacity，不用 rgba，裝置渲染器相容性較好
      draw.polygon(areaStr).fill(color).attr({ 'fill-opacity': 0.2, stroke: 'none' });
      draw.polyline(lineStr).fill('none').stroke({ color: color, width: 2, linecap: 'round', linejoin: 'round' }).attr({ 'stroke-opacity': 0.9 });
    }
  }

  function setIcon(icon) {
    if (!allowSend) return
    lastIcon = icon || lastIcon
    if (!lastIcon) return;
    if (lastIcon.indexOf(';base64,') >= 0) {
      $UD.setBaseDataIcon(context, lastIcon)
    } else {
      $UD.setPathIcon(context, lastIcon)
    }
  }

  function updateSettings(new_settings, type) {
    settings = Object.assign({}, new_settings);
    // 單顆 PI 的頻率只當初始值，之後以全域共用值為準
    const s = settings.refresh_interval || settings.poll_status_frequency;
    if (s) Shared.ms = toMs(s);
    startPoll();
    // 設定一變就立刻畫一次，避免空等一個週期
    collectAndDraw();
  }

  function updateGlobalInterval(seconds) {
    Shared.ms = toMs(seconds);
    startPoll();
    collectAndDraw();
  }

  function refreshNow() {
    collectAndDraw();
    startPoll();
  }

  function setActive(active) {
    allowSend = true;
    setIcon()
    allowSend = String(active) === 'true' ? true : (active === true);
    if (allowSend) collectAndDraw();
  }

  function destroy() {
    if (poll_timer !== 0) {
      clearInterval(poll_timer);
      poll_timer = 0;
    }
  }

  // 掛上去先畫預設圖，PI 參數進來後會重啟 poll
  drawIcon((metricKey() === 'diskio' || metricKey() === 'net') ? [0, 0] : [0]);
  startPoll();
  collectAndDraw();

  return {
    refreshNow: refreshNow,
    updateSettings: updateSettings,
    updateGlobalInterval: updateGlobalInterval,
    destroy: destroy,
    setActive: setActive
  };
}
