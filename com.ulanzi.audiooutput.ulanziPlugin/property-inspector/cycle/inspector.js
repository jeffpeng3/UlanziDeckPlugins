let ACTION_SETTING = { showName: true };
let form = null;

$UD.connect();

$UD.onConnected(() => {
  form = document.querySelector('#property-inspector');

  const el = document.querySelector('.udpi-wrapper');
  if (el) el.classList.remove('hidden');

  form.addEventListener(
    'input',
    Utils.debounce(() => {
      const value = Utils.getFormValue(form);
      ACTION_SETTING = { showName: !!value.showName };
      $UD.sendParamFromPlugin(ACTION_SETTING);
    })
  );

  document.getElementById('refresh-btn').addEventListener('click', () => {
    $UD.sendToPlugin({ command: 'refreshDevices' });
    const list = document.getElementById('device-list');
    if (list) list.textContent = '...';
  });

  // Ask the plugin for a live list on open.
  $UD.sendToPlugin({ command: 'refreshDevices' });
});

function settingSaveParam(params) {
  if (!params) return;
  ACTION_SETTING = { showName: params.showName === undefined ? true : !!params.showName };
  if (form) {
    const box = form.querySelector('#showName');
    if (box) box.checked = ACTION_SETTING.showName;
  }
}

$UD.onAdd((jsonObj) => {
  if (jsonObj && jsonObj.param) settingSaveParam(jsonObj.param);
});

$UD.onParamFromApp((jsonObj) => {
  if (jsonObj && jsonObj.param) settingSaveParam(jsonObj.param);
});

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

$UD.onSendToPropertyInspector((jsonObj) => {
  const payload = (jsonObj && (jsonObj.payload || jsonObj.param)) || {};
  if (payload.command === 'deviceList' && Array.isArray(payload.devices)) {
    const current = document.getElementById('current-device');
    const list = document.getElementById('device-list');
    const cur = payload.devices.find((d) => d.id === payload.defaultId);
    if (current) current.textContent = cur ? cur.label || cur.name : '-';
    if (list) {
      if (!payload.devices.length) {
        list.textContent = $UD.t('No devices found');
        return;
      }
      list.innerHTML = payload.devices.map((d) => {
        const isCur = d.id === payload.defaultId;
        return `<div class="dev${isCur ? ' cur' : ''}">${isCur ? '&#9679; ' : '&#9675; '}`
          + `${escapeHtml(d.label || d.name)} <span class="cat">[${escapeHtml(d.cat || '')}]</span></div>`;
      }).join('');
    }
  } else if (payload.command === 'deviceListError') {
    const list = document.getElementById('device-list');
    if (list) list.textContent = String(payload.message || 'error');
  }
});
