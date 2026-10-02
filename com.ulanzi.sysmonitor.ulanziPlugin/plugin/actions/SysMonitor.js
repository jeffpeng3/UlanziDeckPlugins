import si from 'systeminformation';
import { createSVGWindow } from 'svgdom'
import { SVG, registerWindow } from '@svgdotjs/svg.js';

const window = createSVGWindow()
const document = window.document

// register window and document
registerWindow(window, document)

const BG = '#0b0f0e';
const GREEN = '#4ade80';
const GREEN_FILL = 'rgba(34,197,94,0.25)';
const GREEN_DIM = 'rgba(74,222,128,0.6)';
const RED = '#f87171';
const TITLE_COLOR = '#e8e8e8';

export default function SysMonitor(context, $UD) {
  var settings = {},
    context = context,
    poll_timer = 0,
    allowSend = true,
    lastIcon = '',
    $UD = $UD,
    history = [],
    prevValue = null,
    lastDelta = 0;

  const IS_CPU = context.indexOf('.cpu') >= 0;
  const DEFAULT_TITLE = IS_CPU ? 'CPU' : 'Memory';

  function metricKey() {
    if (settings.metric === 'mem' || settings.metric === 'memory') return 'mem';
    if (settings.metric === 'cpu') return 'cpu';
    return IS_CPU ? 'cpu' : 'mem';
  }

  function refreshIntervalMs() {
    const s = Number(settings.refresh_interval || settings.poll_status_frequency || 1);
    if (!s || s <= 0) return 1000;
    return Math.max(500, s * 1000);
  }

  function historyLength() {
    const n = Number(settings.history_length || 30);
    return Math.min(60, Math.max(10, n || 30));
  }

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
      const delta = prevValue === null || prevValue === 0
        ? 0
        : ((v - prevValue) / Math.abs(prevValue)) * 100;
      prevValue = v;
      lastDelta = delta;
      history.push(v);
      while (history.length > historyLength()) history.shift();
      drawIcon(v, delta);
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

  function formatDelta(delta) {
    const arrow = delta >= 0 ? '\u2191' : '\u2193';
    return arrow + Math.abs(delta).toFixed(2) + '%';
  }

  function drawIcon(value, delta) {
    const SIZE = 200;
    const title = (settings.title || DEFAULT_TITLE || 'Request').slice(0, 12);
    const showDelta = settings.show_delta === false || settings.show_delta === 'off' ? false : true;
    const up = delta >= 0;
    const numColor = GREEN;
    const deltaColor = up ? GREEN : RED;

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

    // 中間大數字
    const label = formatValue(value);
    const numSize = label.length > 7 ? 44 : label.length > 5 ? 54 : 62;
    draw.text(label).font({
      family: 'sans-serif',
      size: numSize,
      weight: 'bold',
      fill: numColor,
      anchor: 'middle'
    }).center(SIZE / 2, 92);

    // 變化率
    if (showDelta) {
      draw.text(formatDelta(delta)).font({
        family: 'sans-serif',
        size: 24,
        weight: 'bold',
        fill: deltaColor,
        anchor: 'middle'
      }).center(SIZE / 2, 140);
    }

    // 底部面積走勢圖
    drawTrend(draw, SIZE);

    const svgContent = draw.svg();
    const base64Svg = Buffer.from(svgContent).toString('base64');
    setIcon('data:image/svg+xml;base64,' + base64Svg);
    draw.clear();
  }

  function drawTrend(draw, SIZE) {
    const pts = history.length > 1 ? history.slice() : [0, 0];
    const top = 158;
    const bottom = SIZE;
    const n = pts.length;
    const stepX = SIZE / Math.max(n - 1, 1);

    const linePts = pts.map((v, i) => {
      const x = Math.round(i * stepX);
      const y = Math.round(bottom - (clamp(v) / 100) * (bottom - top));
      return [x, y];
    });

    const lineStr = linePts.map(p => p.join(',')).join(' ');
    const areaStr = `0,${bottom} ` + lineStr + ` ${SIZE},${bottom}`;

    draw.polygon(areaStr).fill(GREEN_FILL).stroke('none');
    draw.polyline(lineStr).fill('none').stroke({ color: GREEN_DIM, width: 2, linecap: 'round', linejoin: 'round' });
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
    // 相容舊版 PI 欄位名稱
    if (settings.poll_status_frequency && !settings.refresh_interval) {
      settings.refresh_interval = settings.poll_status_frequency;
    }
    startPoll();
    // 設定一變就立刻畫一次，避免空等一個週期
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
  drawIcon(0, 0);
  startPoll();
  collectAndDraw();

  return {
    refreshNow: refreshNow,
    updateSettings: updateSettings,
    destroy: destroy,
    setActive: setActive
  };
}
