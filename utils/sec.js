// utils/sec.js —— 线上安全与触达的纯工具（逻辑在 api.js 云链路，这里只做可测试的编排）
const api = require('./api');

// 把一组文本去重后并行送检（内容安全接口按条计费且限流，重复文本只查一次），
// 返回 { risky:Set<原文>, checked:number }。fail-open：api 挂了当全部通过。
// injector 仅供测试注入伪 api，生产恒用真 api。
function checkMany(texts, injector) {
  const call = injector || api.secText;
  const list = (texts || []).map(t => String(t || '').trim()).filter(t => t);
  const uniq = Array.from(new Set(list));
  return Promise.all(uniq.map(t => call(t).catch(() => ({ ok: true, warn: true }))))
    .then(results => {
      const risky = new Set();
      results.forEach((r, i) => { if (r && r.ok === false && r.hit) risky.add(uniq[i]); });
      return { risky, checked: uniq.length };
    });
}

// 发布触达报文：从已发布记录组装 family/send 的 items（超长截断交给云函数再兜一层）
function itemsFromRecords(recs, nameOf, clsNameOf) {
  return (recs || []).filter(r => r && r.sent).slice(0, 100).map(r => ({
    sid: r.sid,
    name: String(nameOf ? nameOf(r.sid) : '') || '同学',
    score: r.score,
    tag: r.tag || '',
    note: String(r.note || '').slice(0, 100),
    clsName: String(clsNameOf ? clsNameOf(r.cid) : '').slice(0, 20),
    date: r.date || ''
  }));
}

// 家长是否已开过成绩通知（本地标记；云端额度才是真相，这里只是不重复打扰）
const SUB_KEY = 'chengguo_subscribed_v1';
function subscribed() {
  try { return wx.getStorageSync(SUB_KEY) === 1; } catch (e) { return true; }
}
function markSubscribed() {
  try { wx.setStorageSync(SUB_KEY, 1); } catch (e) { /* 存不上只是横幅会再现，无害 */ }
}

module.exports = { checkMany, itemsFromRecords, subscribed, markSubscribed };
