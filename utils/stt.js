// utils/stt.js —— 语音转文字（微信同声传译插件封装）
// 使用前需在 app.json 配置 plugins（已配置）并在公众平台添加该插件
// 插件文档：https://mp.weixin.qq.com/wxopen/plugindevdoc?appid=wx069ba97219f66d99
let plugin = null;
try { plugin = requirePlugin('WechatSI'); } catch (e) { plugin = null; }

const available = () => !!plugin;

// 从录音文件识别文字（录音需为 mp3/aac，时长 <30s 内效果最佳）
function fileToText(filePath) {
  return new Promise((resolve, reject) => {
    if (!plugin) return reject(new Error('同声传译插件未配置'));
    plugin.getRecordRecognitionManager || null;
    // 插件不支持直接识别已有文件，采用「边录边转」流式接口；此方法返回提示
    reject(new Error('请使用 stream 模式（start/stop）'));
  });
}

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
module.exports = { available, createRecognizer, fileToText };
