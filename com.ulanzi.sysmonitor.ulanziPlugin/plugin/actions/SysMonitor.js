import si from 'systeminformation';
import { execFile } from 'child_process';
import { createSVGWindow } from 'svgdom'
import { SVG, registerWindow } from '@svgdotjs/svg.js';
import sampler from './WinSampler.js';

const IS_WIN = process.platform === 'win32';

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

  const TITLES = { cpu: 'CPU', mem: 'Memory', disk: 'Disk', diskio: 'Disk IO', net: 'Net', gpu: 'GPU', batt: 'Battery' };

  function metricKey() {
    const m = settings.metric;
    if (m === 'cpu' || m === 'mem' || m === 'disk' || m === 'diskio' || m === 'net' || m === 'gpu' || m === 'batt') return m;
    if (context.indexOf('.batt') >= 0) return 'batt';
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
    // Windows 讀快取不花 process，全部跟隨共用間隔
    // 非 Windows 照舊，si 每次呼叫都會起 process所以保底
    const floors = IS_WIN
      ? {}
      : { disk: 2000, diskio: 2000, net: 2000, gpu: 3000 };
    const floor = floors[metricKey()] || 0;
    return Math.max(Shared.ms, floor);
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
  // Windows 讀常駐採樣快取，不起 process；其他系統走 si
  async function readStats() {
    const key = metricKey();
    if (key === 'cpu') {
      if (IS_WIN) return [sampleCpu()];
      const load = await si.currentLoad();
      return [clamp(Number(load.currentLoad) || 0)];
    }
    if (key === 'mem') {
      if (IS_WIN) return [sampleMem()];
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

  function sampleCpu() {
    const s = sampler.get();
    if (!s || s.cpu == null) return 0;
    return clamp(Number(s.cpu) || 0);
  }

  function sampleMem() {
    const s = sampler.get();
    const total = Number(s && s.memTotal) || 0;
    const free = Number(s && s.memFree) || 0;
    if (!total) return 0;
    return clamp(((total - free) / total) * 100);
  }

  function normId(s) {
    return String(s || '').toLowerCase().replace(/[\\/]+$/, '');
  }

  // Windows：active time，找名稱含目標磁碟機代號的實例如 1 C:
  // 找不到退回 _Total；active time 可破百只保底不封頂
  function sampleDiskUse() {
    const s = sampler.get();
    let list = (s && s.diskActives) || [];
    if (!Array.isArray(list)) list = [];
    const target = normId(settings.target || '').replace(/:$/, '');
    let v = null;
    if (list.length > 0) {
      let hit = null;
      if (target) {
        hit = list.find(d => String(d.name || '').toLowerCase().includes(target));
      }
      if (!hit) {
        hit = list.find(d => String(d.name || '').toLowerCase().includes('c:'))
            || list[0];
      }
      if (hit) v = Number(hit.active);
    }
    if (v == null || !Number.isFinite(v)) {
      const total = Number(s && s.diskActive);
      v = Number.isFinite(total) ? total : 0;
    }
    return Math.max(0, v);
  }

  function sampleDiskIO() {
    const s = sampler.get();
    if (!s) return [0, 0];
    return [Math.max(0, Number(s.dioR) || 0),
            Math.max(0, Number(s.dioW) || 0)];
  }

  function sampleNet() {
    const s = sampler.get();
    let list = (s && s.net) || [];
    if (!Array.isArray(list)) list = list ? [list] : [];
    const iface = (settings.iface || '').trim().toLowerCase();
    if (iface) {
      list = list.filter(n => String(n.Name || '').toLowerCase().includes(iface));
    } else {
      // 排除虛擬和隧道介面，避免流量重複計算
      list = list.filter(n => !/loopback|tunnel|pseudo|isatap|bluetooth|hyper-v|virtual|vethernet|vpn|tap-|miniport|xbox/i.test(String(n.Name || '')));
    }
    let rx = 0, tx = 0;
    for (const n of list) {
      rx += Number(n.BytesReceivedPerSec) || 0;
      tx += Number(n.BytesSentPerSec) || 0;
    }
    return [Math.max(0, rx), Math.max(0, tx)];
  }

  // nvidia-smi 單一 process 最省，優先用；拿不到才用 si.graphics
  async function readGpuUse() {
    if (IS_WIN) {
      const u = sampleGpu();
      if (u != null) return u;
    }
    const want = (settings.gpu || '').trim();
    // 有指定名稱關鍵字就走 si.graphics 才選得到卡
    if (want && !/^\d+$/.test(want)) {
      const u = await readGpuSi();
      if (u != null) return u;
    }
    try {
      const args = /^\d+$/.test(want)
        ? ['-i', want, '--query-gpu=utilization.gpu', '--format=csv,noheader,nounits']
        : ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'];
      const out = await execCmd('nvidia-smi', args);
      const m = String(out).match(/(\d+(\.\d+)?)/);
      if (m) return clamp(Number(m[1]));
    } catch (e) {
      console.log('==gpu nvidia-smi failed:', e && e.message);
    }
    const u = await readGpuSi();
    return u != null ? u : 0;
  }

  // helper 的 NVML 讀數，in-process 零開銷；沒資料回 null 走舊備援
  function sampleGpu() {
    const s = sampler.get();
    let list = (s && s.gpus) || [];
    if (!Array.isArray(list)) list = [];
    if (list.length === 0) return null;
    const want = (settings.gpu || '').trim().toLowerCase();
    let sel = null;
    if (want) {
      if (/^\d+$/.test(want) && list[Number(want)]) sel = list[Number(want)];
      else sel = list.find(g => String(g.name || '').toLowerCase().includes(want));
    }
    if (!sel) sel = list[0];
    const u = Number(sel && sel.util);
    return Number.isFinite(u) ? clamp(u) : null;
  }

  async function readGpuSi() {
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
    return null;
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

  // Windows 讀常駐採樣快取；si v5 的 disksIO 在 Windows 沒實作
  // 非 Windows 用 si，_sec 為 null 代表還沒建立基準就等下次
  async function readDiskIO() {
    if (IS_WIN) return sampleDiskIO();
    const io = await si.disksIO().catch(() => null);
    if (!io || io.rIO_sec == null || io.wIO_sec == null) return [0, 0];
    return [Math.max(0, Number(io.rIO_sec) || 0),
            Math.max(0, Number(io.wIO_sec) || 0)];
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
  async function readDiskUse() {
    if (IS_WIN) return sampleDiskUse();
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
    if (IS_WIN) return sampleNet();
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

  // 耳機電量：讀 helper 的 hp 快取；present=false 或沒啟動都回 null 畫 --
  function readBatt() {
    if (!IS_WIN) return null;
    const s = sampler.get();
    const hp = s && s.hp;
    if (!hp || !hp.present) return null;
    const level = Number(hp.level);
    return {
      level: Number.isFinite(level) ? Math.max(0, Math.min(100, Math.round(level))) : null,
      charging: hp.charging === true ? true : (hp.charging === false ? false : null)
    };
  }

  function clamp(v) {
    if (v < 0) return 0;
    if (v > 100) return 100;
    return v;
  }

  var busy = false;

  async function collectAndDraw() {
    // 上次讀取還沒回來就跳過，避免 process 堆積
    if (busy) return;
    busy = true;
    // 常駐採樣死掉超過 10 秒就重起，內有重試節流
    if (IS_WIN && sampler.age() > 10000) sampler.start();
    try {
      // batt 走圓環專用畫法，不進走勢歷史
      if (metricKey() === 'batt') {
        drawBattery(readBatt());
        return;
      }
      const vals = await readStats();
      const now = Date.now();
      history.push({ t: now, vals: vals });
      // 只留過去 60 秒，外加總數上限避免記憶體膨脹
      while (history.length > 0 && now - history[0].t > WINDOW_MS) history.shift();
      while (history.length > MAX_POINTS) history.shift();
      drawIcon(vals);
    } catch (e) {
      console.log('==sysmonitor read error:', e);
    } finally {
      busy = false;
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

  // 耳機電量圓環：level% 填滿圓環，充電中綠色，未充電白色，無資料灰色 --
  function drawBattery(st) {
    const SIZE = 200;
    const TRACK = '#2a2f2d';
    const WHITE = '#e8e8e8';
    const GRAY = '#6b7280';
    const title = (settings.title || defaultTitle() || 'Request').slice(0, 12);
    const has = !!(st && st.level != null);
    const pct = has ? st.level : 0;
    const charging = !!(st && st.charging === true);
    const color = has ? (charging ? GREEN : WHITE) : GRAY;

    const draw = SVG(document.documentElement).size(SIZE, SIZE);
    draw.rect(SIZE, SIZE).fill(BG);

    draw.text(title).font({
      family: 'sans-serif',
      size: 26,
      weight: 500,
      fill: TITLE_COLOR,
      anchor: 'middle'
    }).center(SIZE / 2, 26);

    const cx = SIZE / 2, cy = 118, r = 62, w = 14;
    draw.circle(r * 2).center(cx, cy).fill('none').stroke({ color: TRACK, width: w });
    if (has && pct > 0) {
      if (pct >= 100) {
        draw.circle(r * 2).center(cx, cy).fill('none')
          .stroke({ color: color, width: w, linecap: 'round' });
      } else {
        // 從 12 點鐘方向順時針畫弧
        const a0 = -Math.PI / 2;
        const a1 = a0 + (pct / 100) * Math.PI * 2;
        const large = pct > 50 ? 1 : 0;
        const x0 = (cx + r * Math.cos(a0)).toFixed(1);
        const y0 = (cy + r * Math.sin(a0)).toFixed(1);
        const x1 = (cx + r * Math.cos(a1)).toFixed(1);
        const y1 = (cy + r * Math.sin(a1)).toFixed(1);
        draw.path(`M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`)
          .fill('none').stroke({ color: color, width: w, linecap: 'round' });
      }
    }

    const label = has ? Math.round(pct) + '%' : '--';
    draw.text(label).font({
      family: 'sans-serif',
      size: label.length > 4 ? 32 : 44,
      weight: 'bold',
      fill: color,
      anchor: 'middle'
    }).center(cx, cy + 2);

    // 充電中：數字下方畫閃電
    if (has && charging) {
      const bx = cx, by = cy + 40;
      draw.polygon(`${bx + 2},${by - 10} ${bx - 6},${by + 2} ${bx - 1},${by + 2} ` +
        `${bx - 3},${by + 10} ${bx + 6},${by - 2} ${bx + 1},${by - 2}`)
        .fill(GREEN).attr({ stroke: 'none' });
    }

    const svgContent = draw.svg();
    const base64Svg = Buffer.from(svgContent).toString('base64');
    setIcon('data:image/svg+xml;base64,' + base64Svg);
    draw.clear();
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
    // 種類變了就重登記採樣，歷史清空避免單位混雜
    ensureSampler();
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
    if (IS_WIN && acquiredKind) {
      sampler.release(acquiredKind);
      acquiredKind = null;
    }
  }

  // 追蹤已登記的種類，PI 換種類就重登記，沒人要的查詢就不跑
  var acquiredKind = null;

  function ensureSampler() {
    if (!IS_WIN) return;
    const k = metricKey();
    if (k === acquiredKind) return;
    if (acquiredKind) sampler.release(acquiredKind);
    sampler.acquire(k);
    acquiredKind = k;
    history.length = 0;
  }

  // 掛上去先畫預設圖，PI 參數進來後會重啟 poll
  ensureSampler();
  if (metricKey() === 'batt') drawBattery(null);
  else drawIcon((metricKey() === 'diskio' || metricKey() === 'net') ? [0, 0] : [0]);
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
