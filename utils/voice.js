// utils/voice.js —— 输入框语音输入
// 交互：点输入框右端麦克风 → 说话（识别文字实时上屏）→ 说完再点一次麦克风结束。
// 依赖微信同声传译插件（app.json plugins.WechatSI；需先在小程序后台「插件管理」添加）。
// 范围约定：只给自由文本输入框配麦克风（姓名/备注/机构名/搜索词…）；
// 手机号、微信号、日期（YYYY-MM-DD）这类格式化字段不配——语音识别出来是自然语言中文，
// 念一遍也得不到合法格式，配了反而制造废数据。
const stt = require('./stt');

// 读当前值：支持 'stuForm.name' 和 'rows[0].note'（批量成绩单每行一个评语框）。
// 小程序 setData 原生就认 'rows[0].note' 这种路径，所以读也按同一套路径解析，
// 页面不必为语音输入单独造一份扁平数据。
function current(page, key) {
  const parts = String(key || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let v = page.data;
  for (let i = 0; i < parts.length; i++) v = v ? v[parts[i]] : '';
  return typeof v === 'string' ? v : '';
}

// 麦克风状态要给 WXML 绑定用：正在听哪个输入框，页面据此把对应图标变红脉冲。
// 之前只存在 page._rec（JS 变量）里，界面上完全看不出「正在录音」，用户不知道点了有没有效。
function setMic(page, key) {
  try { page.setData({ micKey: key || '' }); } catch (e) { /* 页面已卸载 */ }
}

function dictate(page, key) {
  if (!stt.available()) {
    wx.showToast({ title: '语音输入不可用：请先在小程序后台添加「同声传译」插件', icon: 'none', duration: 2500 });
    return;
  }
  // 正在聆听时再点一次 = 结束（此时麦克风就是停止键）
  if (page._rec) { page._rec.stop(); return; }
  const base = current(page, key);
  // 输入框里已经有字时，识别结果另起一段接在后面，不要黏成一团
  const glue = base && !/\s$/.test(base) ? ' ' : '';
  setMic(page, key);
  wx.showToast({ title: '请说话…（说完再点一下麦克风）', icon: 'none', duration: 60000 });
  let done = false;
  const rec = stt.createRecognizer({
    // stt 给的一直是「本次识别的全文」，整体替换，绝不逐次追加
    onPartial(t) { if (!done) page.setData({ [key]: base + glue + t }); },
    onDone(t) {
      if (done) return;
      done = true; page._rec = null; setMic(page, '');
      page.setData({ [key]: (base + glue + (t || '')).trim() });
      wx.hideToast();
      if (!(t || '').trim()) wx.showToast({ title: '没听清，再试一次？', icon: 'none' });
    },
    onError() {
      if (done) return;
      done = true; page._rec = null; setMic(page, '');
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
  if (page) setMic(page, '');
}

module.exports = { dictate, stop, current };
