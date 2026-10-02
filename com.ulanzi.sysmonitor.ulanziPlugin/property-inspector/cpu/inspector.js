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

function normalize(value) {
  const out = Object.assign({}, value);
  out.refresh_interval = Math.min(60, Math.max(1, Number(out.refresh_interval) || 1));
  out.history_length = Math.min(60, Math.max(10, Number(out.history_length) || 30));
  // checkbox 沒勾不會出現在 form value，補 false
  if (out.show_delta === undefined) out.show_delta = false;
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
  if (ACTION_SETTING.show_delta === 'off') ACTION_SETTING.show_delta = false;
  Utils.setFormValue(ACTION_SETTING, form);
  // 新按鍵第一次沒有 param，填預設值
  if (!params || JSON.stringify(params) === '{}') {
    const value = Utils.getFormValue(form);
    ACTION_SETTING = normalize(value);
    $UD.sendParamFromPlugin(ACTION_SETTING);
  }
}
