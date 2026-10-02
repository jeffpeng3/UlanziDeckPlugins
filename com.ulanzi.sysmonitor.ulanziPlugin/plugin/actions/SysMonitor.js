import si from 'systeminformation';
import { createSVGWindow } from 'svgdom'
import { SVG, registerWindow } from '@svgdotjs/svg.js';

const window = createSVGWindow()
const document = window.document

// register window and document
registerWindow(window, document)

const BG = '#0b0f0e';
const GREEN = '#4ade80';
const GREEN_AREA = '#22c55e';
const TITLE_COLOR = '#e8e8e8';

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

  const IS_CPU = context.indexOf('.cpu') >= 0;
  const DEFAULT_TITLE = IS_CPU ? 'CPU' : 'Memory';

  function metricKey() {
    if (settings.metric === 'mem' || settings.metric === 'memory') return 'mem';
    if (settings.metric === 'cpu') return 'cpu';
    return IS_CPU ? 'cpu' : 'mem';
  }

  function refreshIntervalMs() {
    return Shared.ms;
  }

  // 走勢固定顯示過去 60 秒，靠右對齊持續捲動
  const WINDOW_MS = 60000;
  const MAX_POINTS = 180;

  function decimals() {
    const d = Number(settings.decimals);
    if (settings.metric === undefined && IS_CPU) return 1;
    return Number.isFinite(d) ? d : 1;
  }

  function startPoll() {
    if (poll_timer !== 0) {
      clearInterval(poll_timer);
      poll_timer = 0;
    }
    poll_timer = setInterval(collectAndDraw, refreshIntervalMs());
  }

  async function readValue() {
    const key = metricKey();
    if (key === 'cpu') {
      const load = await si.currentLoad();
      return clamp(Number(load.currentLoad) || 0);
    }
    const mem = await si.mem();
    if (mem.total) {
      return clamp(((mem.total - mem.available) / mem.total) * 100);
    }
    return 0;
  }

  function clamp(v) {
    if (v < 0) return 0;
    if (v > 100) return 100;
    return v;
  }

  async function collectAndDraw() {
    try {
      const v = await readValue();
      const now = Date.now();
      history.push({ t: now, v: v });
      // 只留過去 60 秒，外加總數上限避免記憶體膨脹
      while (history.length > 0 && now - history[0].t > WINDOW_MS) history.shift();
      while (history.length > MAX_POINTS) history.shift();
      drawIcon(v);
    } catch (e) {
      console.log('==sysmonitor read error:', e);
    }
  }

  function formatValue(v) {
    const d = decimals();
    const s = v.toFixed(d);
    // Memory 用 GB 顯示會擠不下，統一用 %，跟圖片的大數字語意一致
    return s + '%';
  }

  function drawIcon(value) {
    const SIZE = 200;
    const title = (settings.title || DEFAULT_TITLE || 'Request').slice(0, 12);
    const numColor = GREEN;

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

    // 中間數字，比之前縮小避免 D200 爆框
    const label = formatValue(value);
    const numSize = label.length > 7 ? 34 : label.length > 5 ? 40 : 46;
    draw.text(label).font({
      family: 'sans-serif',
      size: numSize,
      weight: 'bold',
      fill: numColor,
      anchor: 'middle'
    }).center(SIZE / 2, 78);

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
    // 圖區往上撐高，底部留 15% 空白
    const top = 112;
    const bottom = 170;

    // 依窗口最大最小縮放，波動再小也看得見
    let wmin = 0;
    let wmax = 0;
    if (pts.length > 0) {
      wmin = pts[0].v;
      wmax = pts[0].v;
      for (const p of pts) {
        if (p.v < wmin) wmin = p.v;
        if (p.v > wmax) wmax = p.v;
      }
    }
    let span = wmax - wmin;
    if (span < 8) {
      // 太平时以平均為中心撐開，避免抖動炸滿全圖
      const mid = (wmax + wmin) / 2;
      wmin = mid - 4;
      wmax = mid + 4;
      span = 8;
    }
    // 最大值上方留空，線不頂到頂
    const lo = Math.max(0, wmin - span * 0.15);
    const hi = wmax + span * 0.5;
    const yOf = v => Math.round(bottom - ((v - lo) / (hi - lo)) * (bottom - top));

    let linePts;
    if (pts.length > 1) {
      // 有幾個點就撐滿全寬，新點進來舊點左移，立刻看得到捲動
      const stepX = SIZE / (pts.length - 1);
      linePts = pts.map((p, i) => [Math.round(i * stepX), yOf(p.v)]);
    } else {
      const y = yOf(pts.length === 1 ? pts[0].v : 0);
      linePts = [[0, y], [SIZE, y]];
    }

    const lineStr = linePts.map(p => p.join(',')).join(' ');
    const areaStr = `${linePts[0][0]},${bottom} ` + lineStr + ` ${linePts[linePts.length - 1][0]},${bottom}`;

    // 用 hex 加 opacity，不用 rgba，裝置渲染器相容性較好
    draw.polygon(areaStr).fill(GREEN_AREA).attr({ 'fill-opacity': 0.25, stroke: 'none' });
    draw.polyline(lineStr).fill('none').stroke({ color: GREEN, width: 2, linecap: 'round', linejoin: 'round' }).attr({ 'stroke-opacity': 0.9 });
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
  drawIcon(0);
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
