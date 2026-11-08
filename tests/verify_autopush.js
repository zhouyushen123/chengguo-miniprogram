// tests/verify_autopush.js —— 自动上云守卫
//
// 用户的要求只有一句：**不要我手动推**。
// 这四条断一条，真机上就会退化成"云端空着，但没人知道为什么"：
//   1. 写落盘 → 1.5 秒后自动推（不需要任何点击）
//   2. 推失败 → 自动排退避重试（不是等下次打开小程序）
//   3. 切后台 / 断网恢复 → 立刻补推
//   4. 没推上去要看得见（首页给条数），被云端退回的要能查原因
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------- 计时器探针：既防测试挂住，又能证明"自动"真的排上了 ---------- */
const timers = [];
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
global.clearTimeout = () => {};
const timersOf = ms => timers.filter(t => t.ms === ms);

/* ---------- 模拟 wx 存储 ---------- */
const mem = {};
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; }
};

function freshModules() {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf('utils') > -1) delete require.cache[k];
  });
  Object.keys(mem).forEach(k => delete mem[k]);
  timers.length = 0;
  return { db: require('../utils/db'), api: require('../utils/api'), sync: require('../utils/sync') };
}

let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + (e && e.message)); fail++; }
}
const flushPromises = () => new Promise(r => realSetTimeout(r, 0));

(async () => {
  console.log('\n【A. 自动推送：不用人点】');

  await ok('写入落盘后自己排一轮推送（1.5 秒防抖），不依赖任何按钮', async () => {
    const { db } = freshModules();
    db.init();
    // 把 init 期间排上的那一轮"跑掉"（真实环境里到点会先把自己置空再同步），
    // 再标一个新集合为脏，看是不是真从"脏标记"一路连到了"排同步"。
    const first = timers.filter(t => t.ms === 1500).pop();
    assert.ok(first, 'init 之后就应有自动同步排队');
    first.fn();
    timers.length = 0;
    db.sync.markDirty('records');
    assert.ok(timersOf(1500).length > 0, '脏标记之后必须再排一次自动同步');
  });

  await ok('数据层有"待推送"可数：PENDING 是能看见的，不是心里的', async () => {
    const { db, api, sync } = freshModules();
    db.init();
    db.students.create({ name: '张小明' });
    // 云没通时 pending 不计（那条数据仍在 meta.dirty 里，等云通了再算）
    api.syncOn = () => true;
    assert.ok(sync.pending() >= 1, '刚写的学生应算作待上传，实际 ' + sync.pending());
  });

  await ok('flush 只推不拉：推成功后待上传归零', async () => {
    const { db, api, sync } = freshModules();
    db.init();
    db.students.create({ name: '张小明' });
    api.syncOn = () => true;
    const actions = [];
    api.syncCall = (action, data) => {
      actions.push(action);
      if (action === 'hello') return Promise.resolve({ ok: true, orgId: 'org1', openid: 'oid-1' });
      if (action === 'push') return Promise.resolve({ ok: true, accepted: (data.docs || []).length });
      if (action === 'pull') return Promise.resolve({ ok: true, docs: [], cursor: 0, more: false });
      return Promise.resolve({ ok: true });
    };
    const r = await sync.flush();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(actions.indexOf('push') > -1, '必须真的推了');
    assert.strictEqual(actions.indexOf('pull'), -1, 'flush 不该拉全量（慢且没必要）');
    assert.strictEqual(sync.pending(), 0, '推成功后不该还有待上传');
  });

  await ok('推失败时不清脏、并且自动排下一次重试（30 秒）', async () => {
    const { db, api, sync } = freshModules();
    db.init();
    db.students.create({ name: '张小明' });
    api.syncOn = () => true;
    api.syncCall = action => {
      if (action === 'hello') return Promise.resolve({ ok: true, orgId: 'org1', openid: 'oid-1' });
      if (action === 'push') return Promise.resolve({ ok: false, msg: '网络不通' });
      return Promise.resolve({ ok: true, docs: [], cursor: 0 });
    };
    const before = timersOf(30000).length;
    const r = await sync.flush();
    await flushPromises();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'PUSH_FAIL');
    assert.ok(sync.pending() >= 1, '失败后待上传必须还在（否则等于假装传成功）');
    assert.ok(timersOf(30000).length > before, '失败后必须自己排一次 30 秒重试');
  });

  await ok('云端退回的条目单独记账（退不回来的，等下去也不会好）', async () => {
    const { db, api, sync } = freshModules();
    db.init();
    db.students.create({ name: '张小明' });
    api.syncOn = () => true;
    api.syncCall = (action, data) => {
      if (action === 'hello') return Promise.resolve({ ok: true, orgId: 'org1', openid: 'oid-1' });
      if (action === 'push') {
        return Promise.resolve({
          ok: true, accepted: 0, denied: 1,
          rejected: [{ c: 'students', id: 1, code: 'DUP_NO', msg: '学号重复' }]
        });
      }
      return Promise.resolve({ ok: true, docs: [], cursor: 0 });
    };
    await sync.flush();
    assert.ok(sync.rejectedCount() >= 2, '退回 + 丢弃都要记，实际 ' + sync.rejectedCount());
  });

  console.log('\n【B. 三个时机的兜底（源码守卫）】');

  await ok('切后台补一刀：App.onHide 调 flush', () => {
    const src = read('app.js');
    const seg = src.slice(src.indexOf('onHide()'));
    assert.ok(/onHide\(\)\s*\{[\s\S]{0,200}sync\.flush\(\)/.test(seg), 'onHide 必须调 sync.flush()');
  });

  await ok('断网恢复立刻补推：注册 onNetworkStatusChange 且只在连上时推', () => {
    const src = read('app.js');
    assert.ok(/wx\.onNetworkStatusChange\s*\(/.test(src), '必须注册网络状态监听');
    const seg = src.slice(src.indexOf('onNetworkStatusChange'));
    assert.ok(/isConnected/.test(seg.slice(0, 200)), '没网时不该空推');
    assert.ok(/sync\.flush\(\)/.test(seg.slice(0, 400)), '连着网就必须立刻补推');
  });

  await ok('同步失败必须有人接着试：syncNow 失败分支调 retryLater', () => {
    const src = read('utils/sync.js');
    assert.ok(/retryLater\(\)/.test(src), 'retryLater 得真的被调用（历史上它写了却一次没被调）');
    const seg = src.slice(src.indexOf('function syncNow'));
    assert.ok(/dirtyCols\(\)\.length\) retryLater\(\)/.test(seg.slice(0, 3000)), '同步失败且还有脏数据时要排重试');
  });

  await ok('退避阶梯不在两处重复排（一次失败只走一级）', () => {
    const src = read('utils/sync.js');
    const seg = src.slice(src.indexOf('function retryLater'), src.indexOf('function retryLater') + 900);
    assert.ok(!/retryLater\(\);\s*\}/.test(seg), 'retryLater 内部不该再递归排自己，交给 syncNow 判断');
  });

  await ok('首页把"没传上去"说出来：待上传与退回两条提示都在', () => {
    const wxml = read('pages/index/index.wxml');
    assert.ok(/pendingN > 0/.test(wxml), '待上传提示不见了');
    assert.ok(/rejectN > 0/.test(wxml), '被退回的提示不见了');
    const js = read('pages/index/index.js');
    assert.ok(/sync\.pending\(\)/.test(js) && /sync\.rejectedCount\(\)/.test(js));
    assert.ok(/doFlush/.test(js), '提示条上要能催一下（可选，不是必须）');
  });

  console.log('\nverify_autopush: ' + pass + ' passed, ' + fail + ' failed');
  global.setTimeout = realSetTimeout;
  process.exit(fail ? 1 : 0);
})();
