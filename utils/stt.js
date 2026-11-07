// utils/stt.js —— 语音转文字（微信同声传译插件封装）
// 使用前需在 app.json 配置 plugins（已配置）并在公众平台添加该插件
// 插件文档：https://mp.weixin.qq.com/wxopen/plugindevdoc?appid=wx069ba97219f66d99
let plugin = null;
try { plugin = requirePlugin('WechatSI'); } catch (e) { plugin = null; }

const available = () => !!plugin;

// 把插件回调给的文本收敛成「从开录到此刻的整段文字」。
//
// 【真机 bug 2026-11-07】同声传译的 onRecognize 每次回调给的是**累计全文**，不是新增的几个字。
// 调用方若把每次回调都往输入框里追加一遍，同一句话就会被叠成一串越来越长的重复行
// （「很不错哦」→「很不错哦整体的表」→「很不错哦整体的表现很丰富」…）。
// 这里统一只吐「当前全文」，调用方负责整体替换，永远不要累加。
// 累计全文只会越来越长（分词修正时可能等长换字）；比已有全文短的，一律当作
// 旧片段/重放直接忽略 —— 绝不能拼上去，那正是「越叠越长」的来源。
function mergeText(full, incoming) {
  const f = String(full || '');
  const t = String(incoming || '').trim();
  if (!t) return f;
  return t.length >= f.length ? t : f;
}

// 流式识别：start() 开始，stop() 结束并取全文
// 合约：onPartial / onDone 收到的都是「本次识别的全文」，语义是替换而不是追加。
function createRecognizer(handlers) {
  if (!plugin) {
    handlers.onError && handlers.onError(new Error('同声传译插件未配置'));
    return { start() {}, stop() {} };
  }
  const mgr = plugin.getRecordRecognitionManager();
  let full = '';
  const take = r => { full = mergeText(full, r && r.result); return full; };
  mgr.onRecognize = r => { handlers.onPartial && handlers.onPartial(take(r)); };
  mgr.onStop = r => { handlers.onDone && handlers.onDone(take(r)); };
  mgr.onError = e => { handlers.onError && handlers.onError(e); };
  return {
    start() { full = ''; try { mgr.start({ lang: 'zh_CN', duration: 60000 }); } catch (e) { handlers.onError && handlers.onError(e); } },
    stop() { try { mgr.stop(); } catch (e) {} }
  };
}
// 只提供流式识别。「识别已有录音文件」这条路径插件不支持，以前留了个永远 reject 的
// fileToText 占位，容易被人当可用接口调用，已删除。
module.exports = { available, createRecognizer, mergeText };
