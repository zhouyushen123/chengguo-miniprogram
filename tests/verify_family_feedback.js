// tests/verify_family_feedback.js —— 家长已读回执 + 家长留言（S 组）回归守卫
//
// 这块的风险不在"能不能显示"，而在这几条一破就是事故：
//   1. 越权：家长 A 能看到家长 B 的留言；老师能看别的班/别的机构的留言
//   2. 假已读：进首页、记录未发布、老师自己打开都算成「家长已看」
//   3. 刷屏：同一张成果无限留言，或 60 秒内连发
//   4. 违规文本不拦 / 拦了却静默吞掉
//   5. 云端 -501007：set 的 data 里带了 _id
//   6. 家长端入口在云未通时仍然露出来，点下去报网络错
//
// 云函数本体用内存假库真跑；前端用假 Page / 假 wx 跑行为断言。
const path = require('path');
const fs = require('fs');
const Module = require('module');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ================= 一、内存假库 + 假 wx-server-sdk ================= */
const store = {};
const rowsOf = n => (store[n] || (store[n] = []));
let curOpenid = 'oid-owner';
// secCheck 的可控结果：pass / hit（87014 违规）/ down（接口挂了）
let secMode = 'pass';

function match(row, cond) {
  return Object.keys(cond || {}).every(k => {
    const c = cond[k];
    if (c && typeof c === 'object' && '$in' in c) {
      return c.$in.map(String).indexOf(String(row[k])) > -1;
    }
    if (c && typeof c === 'object' && '$gt' in c) return Number(row[k] || 0) > c.$gt;
    return row[k] === c;
  });
}
function query(name, cond) {
  return {
    _limit: 100,
    limit(n) { this._limit = n; return this; },
    orderBy() { return this; },
    async get() {
      const list = rowsOf(name).filter(r => match(r, cond)).slice(0, this._limit);
      return { data: JSON.parse(JSON.stringify(list)) };
    },
    async count() { return { total: rowsOf(name).filter(r => match(r, cond)).length }; }
  };
}
function collection(name) {
  return {
    where: c => query(name, c),
    limit: n => query(name, {}).limit(n),
    async add({ data }) {
      const rows = rowsOf(name);
      const d = Object.assign({ _id: 'id' + (rows.length + 1) }, data);
      rows.push(d);
      return { _id: d._id };
    },
    doc: id => ({
      async get() {
        const r = rowsOf(name).find(x => x._id === id);
        if (!r) throw new Error('document not found');
        return { data: JSON.parse(JSON.stringify(r)) };
      },
      async update({ data }) {
        const r = rowsOf(name).find(x => x._id === id);
        if (r) Object.assign(r, data);
        return { stats: { updated: r ? 1 : 0 } };
      },
      async set({ data }) {
        const rows = rowsOf(name);
        const i = rows.findIndex(x => x._id === id);
        const d = Object.assign({ _id: id }, data);
        if (i > -1) rows[i] = d; else rows.push(d);
        return { _id: id };
      }
    })
  };
}
const fakeSdk = {
  DYNAMIC_CURRENT_ENV: 'env',
  init() {},
  getWXContext: () => ({ OPENID: curOpenid }),
  callFunction: async ({ name, data }) => {
    if (name === 'secCheck' && data && data.action === 'msg') {
      if (secMode === 'hit') return { result: { ok: false, hit: true } };
      if (secMode === 'down') throw new Error('secCheck timeout');
      return { result: { ok: true, verdict: 'pass' } };
    }
    return { result: { ok: false, msg: '未知云函数' } };
  },
  database: () => ({
    collection,
    command: { in: v => ({ $in: v }), gt: v => ({ $gt: v }), eq: v => ({ $eq: v }) },
    serverDate: () => new Date(),
    createCollection: async () => ({})
  })
};
const stub = path.join(ROOT, '.fake-wx-sdk-fb.js');
fs.writeFileSync(stub, 'module.exports = global.__WX_SDK_FB__;');
global.__WX_SDK_FB__ = fakeSdk;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'wx-server-sdk') return stub;
  return origResolve.call(this, req, ...rest);
};
const family = require(path.join(ROOT, 'cloudfunctions', 'family', 'index.js'));

function seed() {
  Object.keys(store).forEach(k => { delete store[k]; });
  secMode = 'pass';
  rowsOf('members').push({ _id: 'm1', orgId: 'org1', openid: 'oid-owner', role: 'owner', name: '负责人', userId: 'x1', clsIds: [], studentIds: [], status: 'active' });
  rowsOf('members').push({ _id: 'm2', orgId: 'org1', openid: 'oid-teacher', role: 'teacher', name: '李老师', userId: 'x2', clsIds: [11], studentIds: [], status: 'active' });
  rowsOf('members').push({ _id: 'm3', orgId: 'org1', openid: 'oid-parent', role: 'parent', name: '张妈妈', userId: 'x3', clsIds: [], studentIds: [101], status: 'active' });
  rowsOf('members').push({ _id: 'm4', orgId: 'org1', openid: 'oid-parent2', role: 'parent', name: '王爸爸', userId: 'x4', clsIds: [], studentIds: [102], status: 'active' });
  rowsOf('students').push({ _id: 's1', orgId: 'org1', id: 101, name: '张小明', clsIds: [11], removed: false });
  rowsOf('students').push({ _id: 's2', orgId: 'org1', id: 102, name: '王小刚', clsIds: [12], removed: false });
  rowsOf('records').push({ _id: 'r1', orgId: 'org1', id: 201, sid: 101, cid: 11, course: '软笔书法', date: '2026-11-07', session: 3, sent: true, removed: false });
  rowsOf('records').push({ _id: 'r2', orgId: 'org1', id: 202, sid: 102, cid: 12, course: '创意美术', date: '2026-11-07', session: 2, sent: true, removed: false });
  rowsOf('records').push({ _id: 'r3', orgId: 'org1', id: 203, sid: 101, cid: 11, course: '软笔书法', date: '2026-11-07', session: 3, sent: false, removed: false });
  curOpenid = 'oid-owner';
}
const call = (action, extra, oid) => {
  curOpenid = oid || 'oid-owner';
  return family.main(Object.assign({ action }, extra || {}));
};

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => {
  pass++; console.log('  ok - ' + name);
}, e => { fail++; console.log('  FAIL - ' + name + '\n    ' + (e && e.message)); });

(async () => {
  console.log('\n【A. 云端：已读回执】');

  await ok('A01 两张表自动建，且不在同步集合里（家长端拉不到别人家反馈）', async () => {
    const src = read('cloudfunctions/family/index.js');
    assert.ok(/const VIEWS = 'record_views'/.test(src));
    assert.ok(/const NOTES = 'parent_notes'/.test(src));
    assert.ok(/for \(const c of \[VIEWS, NOTES\]\)/.test(src));
    const sync = read('cloudfunctions/syncv2/index.js');
    assert.ok(!/record_views|parent_notes/.test(sync), '不能把这两张表塞进同步集合');
  });

  await ok('A02 家长打开自家已发布成果 → 记一条已读，重复打开不重复记', async () => {
    seed();
    const a = await call('fbView', { rid: 201, sid: 101 }, 'oid-parent');
    assert.ok(a.ok, JSON.stringify(a));
    assert.strictEqual(rowsOf('record_views').length, 1);
    const b = await call('fbView', { rid: 201, sid: 101 }, 'oid-parent');
    assert.ok(b.ok);
    assert.strictEqual(rowsOf('record_views').length, 1, '同一条记录同一家长只留一条（doc(id).set 幂等）');
    const v = rowsOf('record_views')[0];
    assert.strictEqual(v.orgId, 'org1');
    assert.strictEqual(Number(v.rid), 201);
    assert.strictEqual(Number(v.sid), 101);
    assert.ok(v.viewedAt > 0);
  });

  await ok('A03 set 的 data 里绝不能带 _id（admin 踩过 -501007）', async () => {
    const src = read('cloudfunctions/family/index.js');
    const seg = src.slice(src.indexOf("if (action === 'fbView')"), src.indexOf("if (action === 'fbNote')"));
    const setSeg = seg.slice(seg.indexOf('.set({'));
    assert.ok(!/_id\s*:/.test(setSeg), 'fbView 的 set data 带了 _id');
  });

  await ok('A04 家长看别人孩子 / 老师冒充家长 / 未发布记录 → 全部拒绝', async () => {
    seed();
    const other = await call('fbView', { rid: 202, sid: 102 }, 'oid-parent');
    assert.strictEqual(other.code, 'FORBIDDEN', '别家孩子必须拒绝');
    const t = await call('fbView', { rid: 201, sid: 101 }, 'oid-teacher');
    assert.strictEqual(t.code, 'NOT_PARENT');
    const draft = await call('fbView', { rid: 203, sid: 101 }, 'oid-parent');
    assert.strictEqual(draft.code, 'NO_RECORD', '未发布的不该产生回执');
    const noMem = await call('fbView', { rid: 201, sid: 101 }, 'oid-stranger');
    assert.strictEqual(noMem.code, 'NO_MEMBER');
    assert.strictEqual(rowsOf('record_views').length, 0, '被拒的都不该落库');
  });

  console.log('\n【B. 云端：家长留言】');

  await ok('B01 留言落库：只存 sid/rid/文字，不存姓名学号手机号', async () => {
    seed();
    const r = await call('fbNote', { rid: 201, sid: 101, text: '谢谢老师，孩子进步很大' }, 'oid-parent');
    assert.ok(r.ok, JSON.stringify(r));
    const n = rowsOf('parent_notes')[0];
    assert.ok(n);
    assert.strictEqual(n.orgId, 'org1');
    assert.strictEqual(Number(n.rid), 201);
    assert.strictEqual(Number(n.sid), 101);
    assert.strictEqual(n.text, '谢谢老师，孩子进步很大');
    assert.strictEqual(n.handled, 0);
    ['name', 'stuNo', 'phone', 'photo', 'score'].forEach(k => {
      assert.ok(!(k in n), '留言表不该存 ' + k);
    });
  });

  await ok('B02 空文本 / 超 200 字 / 别家孩子 / 未发布 → 拒绝且不落库', async () => {
    seed();
    const empty = await call('fbNote', { rid: 201, sid: 101, text: '   ' }, 'oid-parent');
    assert.strictEqual(empty.code, 'EMPTY');
    const long = await call('fbNote', { rid: 201, sid: 101, text: 'a'.repeat(201) }, 'oid-parent');
    assert.strictEqual(long.code, 'TOO_LONG');
    const other = await call('fbNote', { rid: 202, sid: 102, text: '我是别家家长' }, 'oid-parent');
    assert.strictEqual(other.code, 'FORBIDDEN');
    const draft = await call('fbNote', { rid: 203, sid: 101, text: '还没发布' }, 'oid-parent');
    assert.strictEqual(draft.code, 'NO_RECORD');
    assert.strictEqual(rowsOf('parent_notes').length, 0);
  });

  await ok('B03 同一张成果最多 3 条（第 4 条被拒）', async () => {
    seed();
    for (let i = 1; i <= 3; i++) {
      const r = await call('fbNote', { rid: 201, sid: 101, text: '第' + i + '条' }, 'oid-parent');
      assert.ok(r.ok, '第 ' + i + ' 条应该成功：' + JSON.stringify(r));
      // 每条错开 61 秒，避免撞上防刷屏限流
      rowsOf('parent_notes').forEach(n => { n.createdAt -= 61000; });
    }
    const fourth = await call('fbNote', { rid: 201, sid: 101, text: '第4条' }, 'oid-parent');
    assert.strictEqual(fourth.code, 'LIMIT');
    assert.strictEqual(rowsOf('parent_notes').length, 3);
  });

  await ok('B04 60 秒内最多 2 条（防刷屏）', async () => {
    seed();
    const a = await call('fbNote', { rid: 201, sid: 101, text: '第一条' }, 'oid-parent');
    const b = await call('fbNote', { rid: 201, sid: 101, text: '第二条' }, 'oid-parent');
    assert.ok(a.ok && b.ok);
    const c = await call('fbNote', { rid: 201, sid: 101, text: '第三条' }, 'oid-parent');
    assert.strictEqual(c.code, 'FLOOD');
  });

  await ok('B05 命中违规词 → UNSAFE（明确提示改一下，不静默吞）', async () => {
    seed();
    secMode = 'hit';
    const r = await call('fbNote', { rid: 201, sid: 101, text: '违规内容' }, 'oid-parent');
    assert.strictEqual(r.code, 'UNSAFE');
    assert.ok(/改一下/.test(r.msg));
    assert.strictEqual(rowsOf('parent_notes').length, 0, '违规文本不能落库');
  });

  await ok('B06 内容安全接口挂了时不把家长堵在门外（fail-open）', async () => {
    seed();
    secMode = 'down';
    const r = await call('fbNote', { rid: 201, sid: 101, text: '老师辛苦了' }, 'oid-parent');
    assert.ok(r.ok, 'secCheck 抖动应放行：' + JSON.stringify(r));
    assert.strictEqual(rowsOf('parent_notes').length, 1);
  });

  console.log('\n【C. 云端：列表 / 统计 / 处理】');

  await ok('C01 家长只拿到自己的留言（看不到别家孩子的）', async () => {
    seed();
    await call('fbNote', { rid: 201, sid: 101, text: '我家孩子的话' }, 'oid-parent');
    await call('fbNote', { rid: 202, sid: 102, text: '别人家的话' }, 'oid-parent2');
    const r = await call('fbList', {}, 'oid-parent');
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.scope, 'parent');
    assert.strictEqual(r.notes.length, 1);
    assert.strictEqual(r.notes[0].text, '我家孩子的话');
    assert.strictEqual(r.notes[0].course, '软笔书法', '列表要带上是哪节课');
  });

  await ok('C02 老师只拿到自己班学生的留言；负责人拿全机构', async () => {
    seed();
    await call('fbNote', { rid: 201, sid: 101, text: '一班的' }, 'oid-parent');
    await call('fbNote', { rid: 202, sid: 102, text: '二班的' }, 'oid-parent2');
    const t = await call('fbList', {}, 'oid-teacher');
    assert.ok(t.ok, JSON.stringify(t));
    assert.strictEqual(t.notes.length, 1, '李老师只带 11 班，不该看到 12 班的留言');
    assert.strictEqual(t.notes[0].stuName, '张小明');
    const o = await call('fbList', {}, 'oid-owner');
    assert.strictEqual(o.notes.length, 2, '负责人应看到全机构');
    assert.strictEqual(o.unhandled, 2);
  });

  await ok('C03 家长不能调 fbStats（不存在的入口不给数据）', async () => {
    seed();
    const r = await call('fbStats', { rids: [201] }, 'oid-parent');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'NOT_TEACHER');
  });

  await ok('C04 fbStats 只算可见范围：已看人数 / 留言数 / 待处理数', async () => {
    seed();
    await call('fbView', { rid: 201, sid: 101 }, 'oid-parent');
    await call('fbNote', { rid: 201, sid: 101, text: '收到' }, 'oid-parent');
    await call('fbView', { rid: 202, sid: 102 }, 'oid-parent2');
    const t = await call('fbStats', { rids: [201, 202] }, 'oid-teacher');
    assert.ok(t.ok, JSON.stringify(t));
    assert.strictEqual(t.stats[201].viewed, 1);
    assert.strictEqual(t.stats[201].notes, 1);
    assert.strictEqual(t.stats[201].unhandled, 1);
    assert.strictEqual(t.stats[202].viewed, 0, '12 班的回执不该算进李老师的统计');
  });

  await ok('C05 标记已处理：本班可标，别班拒绝，家长不行', async () => {
    seed();
    const a = await call('fbNote', { rid: 201, sid: 101, text: '一班留言' }, 'oid-parent');
    const b = await call('fbNote', { rid: 202, sid: 102, text: '二班留言' }, 'oid-parent2');
    const p = await call('fbHandle', { id: b.id }, 'oid-parent');
    assert.strictEqual(p.code, 'NOT_TEACHER');
    const wrong = await call('fbHandle', { id: b.id }, 'oid-teacher');
    assert.strictEqual(wrong.code, 'FORBIDDEN', '别班留言不该能标');
    const good = await call('fbHandle', { id: a.id }, 'oid-teacher');
    assert.ok(good.ok, JSON.stringify(good));
    const row = rowsOf('parent_notes').find(x => x._id === a.id);
    assert.strictEqual(row.handled, 1);
    assert.strictEqual(row.handledBy, 'x2');
    assert.ok(row.handledAt > 0);
  });

  await ok('C06 跨机构的留言按「不存在」处理，不泄露存在性', async () => {
    seed();
    const a = await call('fbNote', { rid: 201, sid: 101, text: '自家' }, 'oid-parent');
    rowsOf('parent_notes').push({ _id: 'x9', orgId: 'org_else', rid: 201, sid: 101, text: '别家', openid: 'oid-x', createdAt: Date.now(), handled: 0 });
    const r = await call('fbHandle', { id: 'x9' }, 'oid-owner');
    assert.strictEqual(r.code, 'NOT_FOUND');
    const okr = await call('fbHandle', { id: a.id }, 'oid-owner');
    assert.ok(okr.ok);
  });

  console.log('\n【D. 部署与前端契约】');

  await ok('D01 family 的 config.json 带 timeout:20（否则重部署被打回 3 秒）', async () => {
    const c = JSON.parse(read('cloudfunctions/family/config.json'));
    assert.strictEqual(c.timeout, 20);
    assert.ok(c.permissions && c.permissions.openapi.indexOf('subscribeMessage.send') > -1, '原有订阅消息权限不能丢');
  });

  await ok('D02 api 五个封装都导出，且云未通时返回 CLOUD_OFF 而不是抛错', async () => {
    const a = read('utils/api.js');
    ['fbView', 'fbNote', 'fbList', 'fbStats', 'fbHandle'].forEach(k => {
      assert.ok(new RegExp('function ' + k + '\\(').test(a), '缺 api.' + k);
      assert.ok(new RegExp('\\b' + k + '\\b').test(a.slice(a.indexOf('module.exports'))), '没导出 ' + k);
    });
    assert.ok(/code: 'CLOUD_OFF'/.test(a.slice(a.indexOf('function fbView'), a.indexOf('module.exports'))));
  });

  await ok('D03 有独立的「家长反馈」页，且已注册进 app.json', async () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'pages/feedback/feedback.js')));
    ['wxml', 'wxss', 'json'].forEach(ext => assert.ok(fs.existsSync(path.join(ROOT, 'pages/feedback/feedback.' + ext)), '缺 .' + ext));
    assert.ok(/"pages\/feedback\/feedback"/.test(read('app.json')));
    assert.ok(/markHandled/.test(read('pages/feedback/feedback.js')));
  });

  await ok('D04 家长端只在「已发布成果详情」出现留言入口，并带全站通用麦克风', async () => {
    const wxml = read('pages/student/student.wxml');
    assert.ok(/wx:if="\{\{fbOn && (rec|latest)\.sent\}\}"/.test(wxml), '入口要限定家长 + 已发布');
    assert.ok(/给老师留句话/.test(wxml));
    assert.ok(/vmic \{\{micKey==='fbText'\?'rec':''\}\}/.test(wxml));
    assert.ok(/maxlength="200"/.test(wxml));
    assert.ok(/老师已看/.test(wxml), '家长要能看到处理状态');
  });

  await ok('D05 老师端三处回执：记录列表小标 / 班级页已看比例 / 首页入口红点', async () => {
    assert.ok(/家长已看/.test(read('pages/records/records.wxml')));
    assert.ok(/_loadFb/.test(read('pages/records/records.js')));
    assert.ok(/家长已看 \{\{fbSeen\}\}\/\{\{fbSent\}\}/.test(read('pages/cls/cls.wxml')));
    assert.ok(/家长反馈/.test(read('pages/index/index.wxml')));
    assert.ok(/fbUnread/.test(read('pages/index/index.js')));
    assert.ok(/家长反馈/.test(read('pages/mine/mine.js')));
  });

  await ok('D06 页面不直连数据库 / 不自己调 family 云函数（全部走 api 封装）', async () => {
    ['pages/student/student.js', 'pages/feedback/feedback.js', 'pages/records/records.js', 'pages/cls/cls.js']
      .forEach(f => {
        const s = read(f);
        assert.ok(!/wx\.cloud\.callFunction/.test(s), f + ' 直接调云函数了');
        assert.ok(!/collection\(/.test(s), f + ' 直连数据库了');
      });
  });

  /* ================= 二、前端行为：真的跑一遍家长页 ================= */
  console.log('\n【E. 家长页行为】');
  const mem = {};
  global.wx = {
    getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
    setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
    removeStorageSync: k => { delete mem[k]; },
    showToast: () => {}, showModal: () => {}, showLoading: () => {}, hideLoading: () => {},
    getSystemInfoSync: () => ({}), getWindowInfo: () => ({ statusBarHeight: 20 }),
    setNavigationBarColor: () => {}, setNavigationBarTitle: () => {}, setBackgroundColor: () => {},
    setTabBarStyle: () => {}, setTabBarItem: () => {},
    navigateTo: () => {}, navigateBack: () => {}, switchTab: () => {},
    getImageInfo: o => o && o.fail && o.fail(),
    createInnerAudioContext: () => ({ onEnded() {}, onError() {}, play() {}, stop() {}, destroy() {} }),
    previewImage: () => {}, stopPullDownRefresh: () => {}
  };
  global.getApp = () => ({ globalData: { pick: null } });
  global.App = () => {};
  let captured = null;
  global.Page = cfg => { captured = cfg; };
  function loadPage(rel) {
    captured = null;
    const full = path.join(ROOT, rel);
    delete require.cache[require.resolve(full)];
    require(full);
    const cfg = captured;
    const page = Object.assign({}, cfg);
    page.data = JSON.parse(JSON.stringify(cfg.data || {}));
    page.setData = function (patch, cb) {
      Object.keys(patch).forEach(k => { page.data[k] = patch[k]; });
      if (cb) cb();
    };
    return page;
  }
  const tick = () => new Promise(r => setTimeout(r, 0));

  const dbSeed = require('./fixture').richSeed();
  Object.keys(dbSeed).forEach(k => { mem[k] = dbSeed[k]; });
  const db = require('../utils/db');
  db.init();
  const api = require('../utils/api');

  // 造一个家长 + 一条已发布记录
  let parentUid = '', stuId = 0, rid = 0;
  const setupParent = () => {
    const cls = db.classes.list()[0];
    assert.ok(cls, '夹具里应该有班级');
    const s = db.students.create({ name: '张小明', clsIds: [cls.id] });
    assert.ok(s.ok, '学生建失败：' + (s.msg || ''));
    stuId = s.item.id;
    const r = db.records.save({ sid: stuId, cls: cls.id, score: 90, tag: '优秀', note: '表现很好', course: '软笔书法' }, false);
    assert.ok(r.ok, '记录建失败：' + (r.msg || ''));
    rid = r.rid;
    db.records.markSent([rid]);
    const m = db.members.create({ role: 'parent', name: '张妈妈', studentIds: [stuId] });
    assert.ok(m.ok, '家长建失败：' + (m.msg || ''));
    parentUid = m.raw.userId;
    db.users.switchTo(parentUid);
  };

  await ok('E01 家长打开已发布成果 → 静默上报一次已读', async () => {
    const calls = [];
    api.enabled = () => true;
    api.fbList = () => Promise.resolve({ ok: true, notes: [] });
    api.fbView = (r, s) => { calls.push([r, s]); return Promise.resolve({ ok: true }); };
    setupParent();
    assert.ok(parentUid, '前置：家长建成功');
    assert.ok(rid, '前置：记录建成功');
    const page = loadPage('pages/student/student.js');
    page.onLoad({ rid: String(rid), sid: String(stuId) });
    page.onShow();
    await tick(); await tick();
    assert.strictEqual(page.data.fbOn, true, '云通且是家长，入口应出现');
    assert.deepStrictEqual(calls, [[rid, stuId]], '打开详情应上报一次：' + JSON.stringify(calls));
  });

  await ok('E02 同一页面重复 onShow 不重复上报', async () => {
    const calls = [];
    api.enabled = () => true;
    api.fbList = () => Promise.resolve({ ok: true, notes: [] });
    api.fbView = (r, s) => { calls.push([r, s]); return Promise.resolve({ ok: true }); };
    const page = loadPage('pages/student/student.js');
    page.onLoad({ rid: String(rid), sid: String(stuId) });
    page.onShow();
    await tick(); await tick();
    page.onShow();
    await tick(); await tick();
    assert.strictEqual(calls.length, 1);
  });

  await ok('E03 云未通时入口不出现，也不发任何请求', async () => {
    const calls = [];
    api.enabled = () => false;
    api.fbView = () => { calls.push(1); return Promise.resolve({ ok: true }); };
    const page = loadPage('pages/student/student.js');
    page.onLoad({ rid: String(rid), sid: String(stuId) });
    page.onShow();
    await tick();
    assert.strictEqual(page.data.fbOn, false);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(page.data.fbCard.length, 0);
  });

  await ok('E04 老师打开同一条记录不上报（那是老师自己看的，不是家长已读）', async () => {
    const calls = [];
    api.enabled = () => true;
    api.fbList = () => Promise.resolve({ ok: true, notes: [] });
    api.fbView = () => { calls.push(1); return Promise.resolve({ ok: true }); };
    db.users.switchTo(db.members.list().filter(m => m.role !== 'parent')[0].userId);
    const page = loadPage('pages/student/student.js');
    page.onLoad({ rid: String(rid), sid: String(stuId) });
    page.onShow();
    await tick(); await tick();
    assert.strictEqual(page.data.fbOn, false);
    assert.strictEqual(calls.length, 0);
    db.users.switchTo(parentUid);
  });

  await ok('E05 留言：写 → 发送 → 输入清空、出现在自己那条记录下、状态是「等老师看」', async () => {
    let sent = null;
    api.enabled = () => true;
    api.fbList = () => Promise.resolve({ ok: true, notes: [] });
    api.fbView = () => Promise.resolve({ ok: true });
    api.fbNote = (r, s, t) => { sent = [r, s, t]; return Promise.resolve({ ok: true, id: 'n1', createdAt: Date.now() }); };
    const page = loadPage('pages/student/student.js');
    page.onLoad({ rid: String(rid), sid: String(stuId) });
    page.onShow();
    await tick(); await tick();
    page.openNote({ currentTarget: { dataset: { rid: String(rid), course: '软笔书法', date: '2026-11-07' } } });
    assert.strictEqual(page.data.fbSheet, true);
    page.onFbInput({ detail: { value: '谢谢老师' } });
    page.sendNote();
    await tick();
    assert.deepStrictEqual(sent, [rid, stuId, '谢谢老师']);
    assert.strictEqual(page.data.fbText, '', '发完要清空输入');
    assert.strictEqual(page.data.fbCard.length, 1);
    assert.strictEqual(page.data.fbCard[0].text, '谢谢老师');
  });

  await ok('E06 留言失败要把服务端的真实原因显示出来（不吞成「网络错误」）', async () => {
    api.enabled = () => true;
    api.fbList = () => Promise.resolve({ ok: true, notes: [] });
    api.fbView = () => Promise.resolve({ ok: true });
    api.fbNote = () => Promise.resolve({ ok: false, code: 'UNSAFE', msg: '这段话发不出去，请改一下再发' });
    const page = loadPage('pages/student/student.js');
    page.onLoad({ rid: String(rid), sid: String(stuId) });
    page.onShow();
    await tick(); await tick();
    page.openNote({ currentTarget: { dataset: { rid: String(rid) } } });
    page.onFbInput({ detail: { value: '嗯' } });
    page.sendNote();
    await tick();
    assert.ok(/改一下/.test(page.data.fbErr), '应显示服务端原因：' + page.data.fbErr);
    assert.strictEqual(page.data.fbText, '嗯', '失败要保留用户写的内容');
  });

  console.log('\nverify_family_feedback: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})();
