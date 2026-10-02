let ACTION_SETTING = {}
let form = ''
$UD.connect()

$UD.onConnected(conn => {
  form = document.querySelector('#property-inspector');

  const el = document.querySelector('.udpi-wrapper');
  el.classList.remove('hidden');

  form.addEventListener(
    'input',
    Utils.debounce(() => {
      const value = Utils.getFormValue(form);
      ACTION_SETTING = normalize(value);
      $UD.sendParamFromPlugin(ACTION_SETTING);
      // 更新頻率全插件共用，寫入全域設定同步全部按鍵
      $UD.setGlobalSettings({ refresh_interval: ACTION_SETTING.refresh_interval });
    })
  );
});

$UD.onAdd(jsonObj => {
  if (jsonObj && jsonObj.param) {
    settingSaveParam(jsonObj.param)
  }
})

$UD.onParamFromApp(jsonObj => {
  if (jsonObj && jsonObj.param) {
    settingSaveParam(jsonObj.param)
  }
})

// 別顆按鍵改了頻率，這裡跟著同步顯示
$UD.onDidReceiveGlobalSettings(jsonObj => {
  const settings = (jsonObj && (jsonObj.settings || jsonObj.param)) || {};
  if (settings.refresh_interval === undefined || !form) return;
  const input = form.querySelector('[name="refresh_interval"]');
  if (input && String(input.value) !== String(settings.refresh_interval)) {
    input.value = settings.refresh_interval;
  }
  ACTION_SETTING.refresh_interval = settings.refresh_interval;
})

function normalize(value) {
  const out = Object.assign({}, value);
  out.refresh_interval = Math.min(60, Math.max(1, Number(out.refresh_interval) || 1));
  delete out.history_length;
  if (!out.metric) {
    out.metric = document.querySelector('input[name="metric"]')
      ? document.querySelector('input[name="metric"]').value
      : 'cpu';
  }
  if (!out.title) out.title = out.metric === 'mem' ? 'Memory' : 'CPU';
  return out;
}

function settingSaveParam(params) {
  ACTION_SETTING = Object.assign({}, params);
  // 舊存檔殘留的 show_delta 直接丟掉
  delete ACTION_SETTING.show_delta;
  Utils.setFormValue(ACTION_SETTING, form);
  // 新按鍵第一次沒有 param，填預設值
  if (!params || JSON.stringify(params) === '{}') {
    const value = Utils.getFormValue(form);
    ACTION_SETTING = normalize(value);
    $UD.sendParamFromPlugin(ACTION_SETTING);
    $UD.setGlobalSettings({ refresh_interval: ACTION_SETTING.refresh_interval });
  }
}
