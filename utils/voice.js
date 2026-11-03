// utils/voice.js —— 输入框语音输入
// 交互：点输入框右端麦克风 → 说话（识别文字实时上屏）→ 说完再点一次麦克风结束。
// 依赖微信同声传译插件（app.json plugins.WechatSI；需先在小程序后台「插件管理」添加）。
// 范围约定：只给自由文本输入框配麦克风（姓名/备注/机构名/搜索词…）；
// 手机号、微信号、日期（YYYY-MM-DD）这类格式化字段不配——语音识别出来是自然语言中文，
// 念一遍也得不到合法格式，配了反而制造废数据。
const stt = require('./stt');

// 读当前值，支持 'stuForm.name' 这类路径
function current(page, key) {
  const parts = key.split('.');
  let v = page.data;
  for (let i = 0; i < parts.length; i++) v = v ? v[parts[i]] : '';
  return typeof v === 'string' ? v : '';
}

function dictate(page, key) {
  if (!stt.available()) {
    wx.showToast({ title: '语音输入不可用：请先在小程序后台添加「同声传译」插件', icon: 'none', duration: 2500 });
    return;
  }
  // 正在聆听时再点一次 = 结束（此时麦克风就是停止键）
  if (page._rec) { page._rec.stop(); return; }
  const base = current(page, key);
  wx.showToast({ title: '请说话…（说完再点一下麦克风）', icon: 'none', duration: 60000 });
  let done = false;
  const rec = stt.createRecognizer({
    // 识别中间结果实时拼在已输入内容后面，所见即所得
    onPartial(t) { if (!done) page.setData({ [key]: base + t }); },
    onDone(t) {
      if (done) return;
      done = true; page._rec = null;
      page.setData({ [key]: (base + (t || '')).trim() });
      wx.hideToast();
      if (!(t || '').trim()) wx.showToast({ title: '没听清，再试一次？', icon: 'none' });
    },
    onError() {
      if (done) return;
      done = true; page._rec = null;
      page.setData({ [key]: base }); // 回滚到进入时的内容，不留半截中间结果
      wx.hideToast();
      wx.showToast({ title: '语音识别失败了，请重试或手动输入', icon: 'none' });
    }
  });
  page._rec = rec;
  rec.start();
}

// 页面隐藏/卸载时停掉录音，别让麦克风在后台一直开着
function stop(page) {
  if (page && page._rec) { page._rec.stop(); page._rec = null; }
}

module.exports = { dictate, stop };
