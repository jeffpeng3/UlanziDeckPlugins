import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { Utils } from './ulanzi-api/index.js';

const EXE_REL = '/bin/win-x64/audiohost.exe';
const PS_BASE_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const REQUEST_TIMEOUT = 10000;
const EXE_RETRY_MS = 5 * 60 * 1000;

function exePath() {
  try {
    return `${String(Utils.getPluginPath() || '').replace(/\\/g, '/').replace(/\/$/, '')}${EXE_REL}`;
  } catch {
    return null;
  }
}

function findScriptsDir() {
  try {
    const root = String(Utils.getPluginPath() || '').replace(/\\/g, '/').replace(/\/$/, '');
    for (const cand of [`${root}/scripts`, `${root}/plugin/scripts`]) {
      try {
        if (cand && fs.existsSync(`${cand}/AudioHost.ps1`)) return cand;
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return path.join(path.dirname(process.argv[1] || '.'), 'scripts');
}

let child = null;
let rl = null;
let nextId = 1;
let disposed = false;
let useExe = true;
let exeRetryAt = 0;
let loggedBackend = '';
const pending = new Map();
const eventListeners = new Set();

function rejectAll(err) {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
}

function spawnExe() {
  const exe = exePath();
  if (!exe) return null;
  try {
    if (!fs.existsSync(exe)) return null;
    return spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

function spawnPs() {
  const file = `${findScriptsDir()}/AudioHost.ps1`;
  return spawn('powershell.exe', [...PS_BASE_ARGS, '-File', file], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

function attach(proc, backend) {
  child = proc;
  if (loggedBackend !== backend) {
    loggedBackend = backend;
    console.log(`===audiohost backend: ${backend}`);
  }
  proc.stderr.on('data', () => { /* drain; errors come back as JSON */ });

  const gone = (err) => {
    if (child !== proc) return;
    child = null;
    if (rl) { rl.close(); rl = null; }
    rejectAll(err || new Error('Audio host exited.'));
  };

  rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t.startsWith('{')) return;
    let msg;
    try { msg = JSON.parse(t); } catch { return; }
    if (!msg) return;
    if (msg.event !== undefined) {
      for (const cb of eventListeners) {
        try { cb(msg); } catch { /* listener errors must not kill the host */ }
      }
      return;
    }
    if (msg.id === undefined) return;
    const p = pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'Audio host error'));
  });

  proc.on('error', (e) => {
    if (backend === 'exe') { useExe = false; exeRetryAt = Date.now() + EXE_RETRY_MS; }
    gone(e);
  });
  proc.on('exit', () => {
    if (backend === 'exe') exeRetryAt = Date.now() + EXE_RETRY_MS;
    gone(new Error('Audio host exited.'));
  });
}

function ensure() {
  if (disposed) return Promise.reject(new Error('Audio host disposed.'));
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Audio output switching is only supported on Windows.'));
  }
  if (child) return Promise.resolve();

  if (!useExe && Date.now() >= exeRetryAt) useExe = true;

  if (useExe) {
    const exe = spawnExe();
    if (exe) {
      attach(exe, 'exe');
      return Promise.resolve();
    }
    useExe = false;
    exeRetryAt = Date.now() + EXE_RETRY_MS;
  }

  attach(spawnPs(), 'powershell');
  return Promise.resolve();
}

/** Prewarm the host so the first switch does not pay the cold-start cost. */
export function prewarm() {
  return ensure().catch(() => { /* best-effort warmup */ });
}

/** Subscribe to unsolicited host events (defaultChanged / notifierError / ready). */
export function onEvent(cb) {
  eventListeners.add(cb);
  return () => eventListeners.delete(cb);
}

async function once(op, args) {
  await ensure();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Audio host timeout on ${op}`));
    }, REQUEST_TIMEOUT);
    pending.set(id, { resolve, reject, timer });
    try {
      if (!child || !child.stdin || !child.stdin.writable) {
        throw new Error('Audio host not writable.');
      }
      child.stdin.write(`${JSON.stringify({ id, op, args: args || {} })}\n`, 'utf8');
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e);
    }
  });
}

/** Send one request; retry once if the host died before answering. */
export async function request(op, args) {
  try {
    return await once(op, args);
  } catch (e) {
    const dead = /exited|not writable|disposed/i.test(String(e && e.message));
    if (dead && !disposed && process.platform === 'win32') {
      try { if (child) child.kill(); } catch { /* ignore */ }
      child = null;
      return once(op, args);
    }
    throw e;
  }
}

/** Close the host cleanly (stdin EOF makes it exit on its own). */
export function dispose() {
  disposed = true;
  rejectAll(new Error('Audio host disposed.'));
  const proc = child;
  child = null;
  if (rl) { rl.close(); rl = null; }
  if (proc) {
    try { proc.stdin.end(); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
  }
}
