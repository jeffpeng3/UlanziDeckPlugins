
import { UlanziApi } from './actions/ulanzi-api/index.js';

import SysMonitor from './actions/SysMonitor.js'


const ACTION_CACHES = {}

const $UD = new UlanziApi();

$UD.connect('com.ulanzi.ulanzistudio.sysmonitor')
$UD.onConnected(conn => {
  // 啟動時拉一次已存的全域更新頻率
  try { $UD.getGlobalSettings(); } catch (e) { console.log('getGlobalSettings failed:', e); }
})


//把插件某个功能配置到按键上
$UD.onAdd(jsn => {
  const context = jsn.context; //唯一id
  const instance = ACTION_CACHES[context];
  if (!instance) {
    ACTION_CACHES[context] = new SysMonitor(context, $UD);
    onSetSettings(jsn, 'init')
  } else {
    onSetSettings(jsn, 'init')
  }
})

//插件功能活跃状态设置
$UD.onSetActive(jsn => {
  const context = jsn.context
  const instance = ACTION_CACHES[context];
  if (instance) {
    instance.setActive(jsn.active)
  }
})

//按键按下时发送的事件：立即刷新一次
$UD.onRun(jsn => {
  const context = jsn.context
  const instance = ACTION_CACHES[context];

  if (!instance) $UD.emit('add', jsn);
  else instance.refreshNow();
})

//移除插件的功能配置信息
$UD.onClear(jsn => {
  if (jsn.param) {
    for (let i = 0; i < jsn.param.length; i++) {
      const context = jsn.param[i].context
      if (ACTION_CACHES[context]) {
        ACTION_CACHES[context].destroy()
        delete ACTION_CACHES[context]
      }
    }
  }
})

//重载插件功能配置信息变化
$UD.onParamFromApp(jsn => {
  onSetSettings(jsn)
})

//监听插件功能配置信息变化
$UD.onParamFromPlugin(jsn => {
  onSetSettings(jsn)
})

//全域更新频率：任一 PI 修改后同步全部按键
$UD.onDidReceiveGlobalSettings(jsn => {
  const settings = jsn.settings || jsn.param || {};
  const seconds = settings.refresh_interval;
  if (seconds === undefined) return;
  console.log('===onDidReceiveGlobalSettings:', seconds)
  for (const context of Object.keys(ACTION_CACHES)) {
    const instance = ACTION_CACHES[context];
    if (instance && instance.updateGlobalInterval) {
      instance.updateGlobalInterval(seconds);
    }
  }
})


//更新参数
function onSetSettings(jsn, type) {
  console.log('===onSetSettings:', jsn, type)
  const settings = jsn.param || {}
  const context = jsn.context
  const instance = ACTION_CACHES[context];
  if (!settings || !instance) return;
  if (JSON.stringify(settings) === '{}' && type === undefined) return;

  instance.updateSettings(settings, type);
}
