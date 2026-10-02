import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { Utils } from './ulanzi-api/index.js';

const POWERSHELL = 'powershell.exe';
const PS_BASE_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const ID_PATTERN = /^\{0\.0\.0\.00000000\}\.\{[0-9a-fA-F-]+\}$/;

// Generic adapter names: the interface name is useless, prefer DeviceDesc.
const GENERIC_ADAPTER = /high definition audio|usb audio|realtek|intel ss?s?t? audio|amd high definition/i;

function findScriptsDir() {
  try {
    const root = String(Utils.getPluginPath() || '').replace(/\\/g, '/').replace(/\/$/, '');
    for (const cand of [`${root}/scripts`, `${root}/plugin/scripts`]) {
      try {
        if (cand && fs.existsSync(`${cand}/Get-AudioState.ps1`)) return cand;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return path.join(path.dirname(process.argv[1] || '.'), 'scripts');
}

function runPs(script, extraArgs = []) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Audio output switching is only supported on Windows.'));
  }
  const file = `${findScriptsDir()}/${script}`;
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL,
      [...PS_BASE_ARGS, '-File', file, ...extraArgs],
      { timeout: 25000, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || err).trim().slice(0, 500);
          reject(new Error(`PowerShell ${script} failed: ${detail}`));
          return;
        }
        resolve(String(stdout || '').replace(/^\uFEFF/, '').trim());
      }
    );
  });
}

export async function getAudioState() {
  const out = await runPs('Get-AudioState.ps1');
  let state;
  try {
    state = JSON.parse(out);
  } catch (e) {
    throw new Error(`Cannot parse audio state: ${String(out).slice(0, 200)}`);
  }
  if (!state || !Array.isArray(state.devices)) throw new Error('Invalid audio state payload.');
  return state;
}

export async function setDefaultDevice(id) {
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid device id: ${id}`);
  const out = await runPs('Set-DefaultAudioDevice.ps1', ['-DeviceId', id]);
  let res;
  try {
    res = JSON.parse(out);
  } catch (e) {
    throw new Error(`Cannot parse switch result: ${String(out).slice(0, 200)}`);
  }
  if (!res || res.ok !== true) throw new Error(`Switch rejected: ${String(out).slice(0, 200)}`);
  return res;
}

/**
 * Classify a raw endpoint into speaker | bluetooth | bluetooth-hf | headphone.
 * - Bluetooth first: Enumerator BTHENUM / BTHHFENUM (one physical headset
 *   exposes both; the hands-free endpoint is never a switch target).
 * - Then headphone by generic class / name keywords (headsets with mic
 *   included: 耳麥式耳機 contains 耳機).
 * - Everything else (HDMI monitor, SPDIF, line-out, unknown) is speaker.
 */
export function classifyDevice(d = {}) {
  const hay = `${d.name || ''} ${d.desc || ''} ${d.enumerator || ''}`.toLowerCase();
  if (hay.includes('bthenum') || hay.includes('bthhf') || hay.includes('bluetooth') || /\bbth\b/.test(hay)) {
    if (hay.includes('hands-free') || hay.includes('handsfree') || hay.includes('bthhf')) return 'bluetooth-hf';
    return 'bluetooth';
  }
  if (/耳機|耳麦|headphone|headset|earphone|earbud|airpod/.test(hay)) return 'headphone';
  return 'speaker';
}

/** Human label: interface name, unless it is a generic adapter name. */
export function displayName(d = {}) {
  const name = String(d.name || '').trim();
  const desc = String(d.desc || '').trim();
  if (name && !(desc && GENERIC_ADAPTER.test(name))) return name;
  return desc || name || d.id || 'Unknown';
}

/**
 * Icon file per device category, relative to the plugin root.
 * Used with setPathIcon so the key image follows the device directly and
 * never depends on the manifest States snapshot cached on the key.
 */
export const ICON_PATH_FOR_CAT = {
  speaker: 'assets/icons/action-speaker.svg',
  bluetooth: 'assets/icons/action-bluetooth.svg',
  'bluetooth-hf': 'assets/icons/action-bluetooth.svg',
  headphone: 'assets/icons/action-headphone.svg'
};

export function iconPathForCat(cat) {
  return ICON_PATH_FOR_CAT[cat] || ICON_PATH_FOR_CAT.speaker;
}

function firstDifferent(list, excludeId) {
  if (!list.length) return null;
  return list.find((d) => d.id !== excludeId) || null;
}

/**
 * Three-state resolution:
 * speaker -> bluetooth (else headphone) -> headphone (else speaker) -> speaker.
 * bluetooth-hf counts as bluetooth and is never selected as a target.
 * Unknown current state falls back to a generic next-device step.
 */
export function resolveTarget({ devices = [], defaultId = null } = {}) {
  const by = { speaker: [], bluetooth: [], headphone: [] };
  for (const d of devices) {
    if (d.cat === 'bluetooth') by.bluetooth.push(d);
    else if (d.cat === 'headphone') by.headphone.push(d);
    else if (d.cat === 'speaker') by.speaker.push(d);
  }
  const current = devices.find((d) => d.id === defaultId) || null;
  // bluetooth-hf counts as bluetooth and is never selected as a target.
  const cur = current ? current.cat : 'unknown';

  if (cur === 'speaker') {
    return firstDifferent(by.bluetooth, defaultId)
      || firstDifferent(by.headphone, defaultId)
      || null;
  }
  if (cur === 'bluetooth' || cur === 'bluetooth-hf') {
    return firstDifferent(by.headphone, defaultId)
      || firstDifferent(by.speaker, defaultId)
      || null;
  }
  if (cur === 'headphone') {
    return firstDifferent(by.speaker, defaultId) || null;
  }
  return devices.find((d) => d.id !== defaultId) || null;
}

export async function cycleDefaultOutput() {
  const state = await getAudioState();
  const devices = state.devices.map((d) => ({ ...d, cat: classifyDevice(d), label: displayName(d) }));
  const from = devices.find((d) => d.id === state.defaultId) || null;
  const target = resolveTarget({ devices, defaultId: state.defaultId });
  if (!target) {
    return { switched: false, from, to: null, devices, defaultId: state.defaultId };
  }
  await setDefaultDevice(target.id);
  let verified = false;
  try {
    const after = await getAudioState();
    verified = after.defaultId === target.id;
  } catch { /* verification is best-effort */ }
  return { switched: true, from, to: target, devices, defaultId: target.id, verified };
}
