import { UlanziApi } from './actions/ulanzi-api/index.js';
import { cycleDefaultOutput, getAudioState, classifyDevice, displayName, iconPathForCat } from './actions/AudioSwitcher.js';

const ACTION_CACHES = {};

const $UD = new UlanziApi();

$UD.connect('com.ulanzi.ulanzistudio.audiooutput');
$UD.onConnected(() => {
  console.log('[audiooutput] connected');
});

function settingsOf(jsn) {
  const p = jsn.param || {};
  return { showName: p.showName === undefined ? true : p.showName !== false && p.showName !== 'off' };
}

async function pushStateToKey(context, showName) {
  try {
    const state = await getAudioState();
    const current = state.devices.find((d) => d.id === state.defaultId) || null;
    const cat = current ? classifyDevice(current) : 'speaker';
    const label = current ? displayName({ ...current, cat }) : '';
    await $UD.setPathIcon(context, iconPathForCat(cat), showName && label ? label : '');
    ACTION_CACHES[context] = { ...(ACTION_CACHES[context] || {}), lastLabel: label };
  } catch (e) {
    console.log('[audiooutput] pushStateToKey failed:', e.message);
  }
}

$UD.onAdd((jsn) => {
  const context = jsn.context;
  if (!ACTION_CACHES[context]) ACTION_CACHES[context] = {};
  Object.assign(ACTION_CACHES[context], settingsOf(jsn));
  pushStateToKey(context, ACTION_CACHES[context].showName !== false);
});

$UD.onSetActive((jsn) => {
  const context = jsn.context;
  const instance = ACTION_CACHES[context];
  if (instance) instance.active = jsn.active;
});

$UD.onRun(async (jsn) => {
  const context = jsn.context;
  if (!ACTION_CACHES[context]) ACTION_CACHES[context] = { showName: true };
  const showName = ACTION_CACHES[context].showName !== false;
  const history = ACTION_CACHES[context].history || null;
  try {
    const result = await cycleDefaultOutput({ history });
    if (!result.switched) {
      const label = result.from ? result.from.label : '';
      const cat = result.from ? result.from.cat : 'speaker';
      await $UD.setPathIcon(context, iconPathForCat(cat), showName && label ? label : '');
      return;
    }
    await $UD.setPathIcon(context, iconPathForCat(result.to.cat), showName && result.to.label ? result.to.label : '');
    ACTION_CACHES[context].lastLabel = result.to.label;
    if (result.history) ACTION_CACHES[context].history = result.history;
  } catch (e) {
    console.log('[audiooutput] cycle failed:', e);
    try { $UD.logMessage(`cycle failed: ${e.message}`, 'error'); } catch { /* ignore */ }
    $UD.showAlert(context);
  }
});

// Live device list for the property inspector: PI -> plugin -> PI.
$UD.onSendToPlugin(async (jsn) => {
  const context = jsn.context;
  const payload = jsn.payload || jsn.param || {};
  if (payload && payload.command === 'refreshDevices') {
    try {
      const state = await getAudioState();
      const devices = state.devices.map((d) => ({ ...d, cat: classifyDevice(d), label: displayName(d) }));
      $UD.sendToPropertyInspector({ command: 'deviceList', devices, defaultId: state.defaultId }, context);
    } catch (e) {
      $UD.sendToPropertyInspector({ command: 'deviceListError', message: String(e.message || e) }, context);
    }
  }
});

$UD.onParamFromApp((jsn) => {
  const context = jsn.context;
  if (!ACTION_CACHES[context]) ACTION_CACHES[context] = {};
  Object.assign(ACTION_CACHES[context], settingsOf(jsn));
});

$UD.onParamFromPlugin((jsn) => {
  const context = jsn.context;
  if (!ACTION_CACHES[context]) ACTION_CACHES[context] = {};
  Object.assign(ACTION_CACHES[context], settingsOf(jsn));
});

$UD.onClear((jsn) => {
  if (jsn.param) {
    for (const item of jsn.param) {
      if (item && item.context) delete ACTION_CACHES[item.context];
    }
  }
});
