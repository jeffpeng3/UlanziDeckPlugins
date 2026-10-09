import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDevice, displayName, resolveTarget, iconPathForCat } from '../plugin/actions/AudioSwitcher.js';

const CORSAIR = {
  id: '{0.0.0.00000000}.{8014a4b8-17ef-4a38-9f4c-21b47434a027}',
  name: 'CORSAIR Slipstream Multi-Device Receiver',
  desc: '耳麥式耳機',
  enumerator: 'USB'
};
const BENQ = {
  id: '{0.0.0.00000000}.{cbee23bb-54a6-4abb-af94-a2aca38a957f}',
  name: 'NVIDIA High Definition Audio',
  desc: 'BenQ EX2510',
  enumerator: 'HDAUDIO'
};
const BUDS = {
  id: '{0.0.0.00000000}.{42e93140-2b09-4db1-a12e-96d4880ade50}',
  name: 'Pixel Buds',
  desc: '耳機',
  enumerator: 'BTHENUM'
};
const BUDS_HF = {
  id: '{0.0.0.00000000}.{c0b56ecf-f386-4659-af55-ed5b57322ddf}',
  name: 'Pixel Buds Hands-Free',
  desc: '耳機',
  enumerator: 'BTHHFENUM'
};
const EARBUDS = {
  id: '{0.0.0.00000000}.{aaaaaaaa-0000-0000-0000-000000000001}',
  name: 'Realtek Audio',
  desc: '耳機',
  enumerator: 'HDAUDIO'
};

const withCat = (d) => ({ ...d, cat: classifyDevice(d), label: displayName(d) });

test('classify real devices', () => {
  assert.equal(classifyDevice(CORSAIR), 'headphone');
  assert.equal(classifyDevice(BENQ), 'speaker');
  assert.equal(classifyDevice(BUDS), 'bluetooth');
  assert.equal(classifyDevice(BUDS_HF), 'bluetooth-hf');
  assert.equal(classifyDevice(EARBUDS), 'headphone');
});

test('displayName prefers specific desc over generic adapter name', () => {
  assert.equal(displayName(BENQ), 'BenQ EX2510');
  assert.equal(displayName(CORSAIR), 'CORSAIR Slipstream Multi-Device Receiver');
  assert.equal(displayName(BUDS), 'Pixel Buds');
});

test('speaker -> bluetooth (priority)', () => {
  const devices = [BENQ, BUDS, BUDS_HF, CORSAIR].map(withCat);
  const t = resolveTarget({ devices, defaultId: BENQ.id });
  assert.equal(t.id, BUDS.id);
});

test('speaker -> headphone when no bluetooth', () => {
  const devices = [BENQ, CORSAIR].map(withCat);
  const t = resolveTarget({ devices, defaultId: BENQ.id });
  assert.equal(t.id, CORSAIR.id);
});

test('bluetooth -> headphone, never hands-free', () => {
  const devices = [BENQ, BUDS, BUDS_HF, CORSAIR].map(withCat);
  const t = resolveTarget({ devices, defaultId: BUDS.id });
  assert.equal(t.id, CORSAIR.id);
});

test('headphone -> speaker', () => {
  const devices = [BENQ, BUDS, BUDS_HF, CORSAIR].map(withCat);
  const t = resolveTarget({ devices, defaultId: CORSAIR.id });
  assert.equal(t.id, BENQ.id);
});

test('plain headphone resolves through the headphone slot', () => {
  const devices = [BENQ, EARBUDS].map(withCat);
  const t = resolveTarget({ devices, defaultId: EARBUDS.id });
  assert.equal(t.id, BENQ.id);
});

test('hands-free current counts as bluetooth', () => {
  const devices = [BENQ, BUDS, BUDS_HF, CORSAIR].map(withCat);
  const t = resolveTarget({ devices, defaultId: BUDS_HF.id });
  assert.equal(t.id, CORSAIR.id);
});

test('single device stays', () => {
  const devices = [BENQ].map(withCat);
  assert.equal(resolveTarget({ devices, defaultId: BENQ.id }), null);
});

test('icon path follows category', () => {
  assert.equal(iconPathForCat('speaker'), 'assets/icons/action-speaker.svg');
  assert.equal(iconPathForCat('bluetooth'), 'assets/icons/action-bluetooth.svg');
  assert.equal(iconPathForCat('bluetooth-hf'), 'assets/icons/action-bluetooth.svg');
  assert.equal(iconPathForCat('headphone'), 'assets/icons/action-headphone.svg');
  assert.equal(iconPathForCat('unknown'), 'assets/icons/action-speaker.svg');
});

test('unknown current falls back to next device', () => {
  const devices = [BENQ, CORSAIR].map(withCat);
  const t = resolveTarget({ devices, defaultId: '{0.0.0.00000000}.{deadbeef-0000-0000-0000-000000000000}' });
  assert.equal(t.id, BENQ.id);
});

test('headphone + non-bt history prefers bluetooth', () => {
  const devices = [BENQ, BUDS, BUDS_HF, CORSAIR].map(withCat);
  const t = resolveTarget({
    devices,
    defaultId: CORSAIR.id,
    history: { fromCat: 'speaker', toCat: 'headphone' }
  });
  assert.equal(t.id, BUDS.id);
});

test('headphone + bt history keeps speaker', () => {
  const devices = [BENQ, BUDS, BUDS_HF, CORSAIR].map(withCat);
  const t = resolveTarget({
    devices,
    defaultId: CORSAIR.id,
    history: { fromCat: 'bluetooth', toCat: 'headphone' }
  });
  assert.equal(t.id, BENQ.id);
});

test('on bluetooth history does not override', () => {
  const devices = [BENQ, BUDS, BUDS_HF, CORSAIR].map(withCat);
  const t = resolveTarget({
    devices,
    defaultId: BUDS.id,
    history: { fromCat: 'speaker', toCat: 'speaker' }
  });
  assert.equal(t.id, CORSAIR.id);
});
