// verify_sec.js —— 内容安全 + 订阅触达的纯逻辑守卫
// 云函数本体（openapi 调用）只能在微信云上验证，这里守可本地验证的部分：
// 去重送检、fail-open 语义、命中映射回原文、发布报文组装、订阅标记的存取。
const assert = require('assert');

// ---- 先垫 wx 再 require（utils/sec.js 顶部用到 wx）----
let store = {};
global.wx = {
  setStorageSync: (k, v) => { store[k] = v; },
  getStorageSync: k => (k in store ? store[k] : ''),
  removeStorageSync: k => { delete store[k]; }
};
const sec = require('../utils/sec');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// ---- checkMany ----
t('checkMany：空/全空文本直接零送检', async () => {
  let calls = 0;
  const out = await sec.checkMany(['', '   ', null], async () => { calls++; return { ok: true }; });
  assert.strictEqual(calls, 0);
  assert.strictEqual(out.checked, 0);
  assert.strictEqual(out.risky.size, 0);
});

t('checkMany：重复文本去重，只送检一次', async () => {
  let calls = 0;
  const out = await sec.checkMany(['好孩子', ' 好孩子 ', '好孩子', '要努力'], async () => { calls++; return { ok: true }; });
  assert.strictEqual(calls, 2);           // "好孩子"（trim 后相同）+ "要努力"
  assert.strictEqual(out.checked, 2);
  assert.strictEqual(out.risky.size, 0);
});

t('checkMany：命中映射回原文，未命中不误伤', async () => {
  const out = await sec.checkMany(['正常评语', '违规词'], async s => (s === '违规词' ? { ok: false, hit: true } : { ok: true }));
  assert.strictEqual(out.risky.size, 1);
  assert.ok(out.risky.has('违规词'));
  assert.ok(!out.risky.has('正常评语'));
});

t('checkMany：检查接口崩溃 = fail-open（放行不阻塞业务）', async () => {
  const out = await sec.checkMany(['任何文本'], async () => { throw new Error('接口挂了'); });
  assert.strictEqual(out.risky.size, 0);
});

t('checkMany：云关闭（skipped）与接口抖动（warn）都算通过', async () => {
  const a = await sec.checkMany(['x'], async () => ({ ok: true, skipped: true }));
  const b = await sec.checkMany(['y'], async () => ({ ok: true, warn: true }));
  assert.strictEqual(a.risky.size + b.risky.size, 0);
});

// ---- itemsFromRecords ----
t('itemsFromRecords：只收已发布、截断长文本、缺省兜底', () => {
  const recs = [
    { sid: 3, sent: true, score: 92, tag: '优秀', note: 'x'.repeat(300), cid: 7, date: '2026-11-05' },
    { sid: 4, sent: false, score: 60, note: '未发布不该出现', cid: 7 },
    null
  ];
  const items = sec.itemsFromRecords(recs, sid => '同学' + sid, () => '素描提高班');
  assert.strictEqual(items.length, 1);
  const it = items[0];
  assert.strictEqual(it.sid, 3);
  assert.strictEqual(it.name, '同学3');
  assert.strictEqual(it.clsName, '素描提高班');
  assert.ok(it.note.length <= 100);
  assert.strictEqual(it.date, '2026-11-05');
});

t('itemsFromRecords：上限 100 条 + 无名字兜底"同学"', () => {
  const recs = [];
  for (let i = 0; i < 130; i++) recs.push({ sid: i, sent: true, cid: 1 });
  const items = sec.itemsFromRecords(recs, () => '', () => '');
  assert.strictEqual(items.length, 100);
  assert.strictEqual(items[0].name, '同学');
});

// ---- 订阅标记（本地存储） ----
t('订阅标记：默认未开 → 标记后不再提示', () => {
  store = {}; // 重置
  assert.strictEqual(sec.subscribed(), false);
  sec.markSubscribed();
  assert.strictEqual(sec.subscribed(), true);
});

t('订阅标记：存储异常时按已开处理（不再骚扰用户）', () => {
  store = {};
  const orig = global.wx.getStorageSync;
  global.wx.getStorageSync = () => { throw new Error('存储炸了'); };
  try { assert.strictEqual(sec.subscribed(), true); }
  finally { global.wx.getStorageSync = orig; }
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + (e && e.message)); }
  }
  console.log(fail ? ('verify_sec: ' + fail + ' FAILED') : ('verify_sec: all ' + tests.length + ' passed'));
  process.exit(fail ? 1 : 0);
})();
