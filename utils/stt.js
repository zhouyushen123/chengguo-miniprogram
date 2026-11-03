// utils/stt.js —— 语音转文字（微信同声传译插件封装）
// 使用前需在 app.json 配置 plugins（已配置）并在公众平台添加该插件
// 插件文档：https://mp.weixin.qq.com/wxopen/plugindevdoc?appid=wx069ba97219f66d99
let plugin = null;
try { plugin = requirePlugin('WechatSI'); } catch (e) { plugin = null; }

const available = () => !!plugin;

// 流式识别：start() 开始，stop() 结束并取全文
function createRecognizer(handlers) {
  if (!plugin) {
    handlers.onError && handlers.onError(new Error('同声传译插件未配置'));
    return { start() {}, stop() {} };
  }
  const mgr = plugin.getRecordRecognitionManager();
  let text = '';
  mgr.onRecognize = r => { handlers.onPartial && handlers.onPartial(r.result || ''); };
  mgr.onStop = r => { handlers.onDone && handlers.onDone((text + (r.result || '')).trim()); };
  mgr.onError = e => { handlers.onError && handlers.onError(e); };
  return {
    start() { text = ''; try { mgr.start({ lang: 'zh_CN', duration: 60000 }); } catch (e) { handlers.onError && handlers.onError(e); } },
    stop() { try { mgr.stop(); } catch (e) {} }
  };
}
// 只提供流式识别。「识别已有录音文件」这条路径插件不支持，以前留了个永远 reject 的
// fileToText 占位，容易被人当可用接口调用，已删除。
module.exports = { available, createRecognizer };
