// verify_invite.js —— 成员绑定（邀请码加入）守卫
//
// 这一层最容易出事的地方不是"能不能加入"，而是"加入之后我是谁"：
// 家长若被解析成负责人，他就能改整个机构。所以重点测身份解析的优先级，
// 以及"本机有数据时不许加入"这条底线。
const assert = require('assert');

/* ---------- 模拟 wx 存储 ---------- */
const path = require('path');
const mem = {};
const navs = [];
const toasts = [];
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; },
  showToast: o => { toasts.push(o && o.title); },
  showLoading: () => {}, hideLoading: () => {},
  showModal: o => { o && o.success && o.success({ confirm: false }); },
  navigateTo: o => { navs.push(o && o.url); if (o && o.success) o.success(); },
  redirectTo: o => { navs.push(o && o.url); },
  reLaunch: o => { navs.push(o && o.url); },
  switchTab: o => { navs.push(o && o.url); },
  navigateBack: () => {},
  setNavigationBarTitle: () => {},
  setNavigationBarColor: () => {},
  setBackgroundColor: () => {},
  setTabBarStyle: () => {},
  setTabBarItem: () => {},
  setClipboardData: o => { o && o.success && o.success(); },
  getSystemInfoSync: () => ({ statusBarHeight: 20, windowWidth: 375 })
};
const appInst = { globalData: { pick: null } };
global.getApp = () => appInst;
global.App = () => {};
let captured = null;
global.Page = cfg => { captured = cfg; };

// 页面：把 Page({...}) 抓出来，补上 setData（支持 'a.b' 路径，页面里大量用）
function loadPage(rel) {
  captured = null;
  const full = path.join(__dirname, '..', rel);
  delete require.cache[require.resolve(full)];
  require(full);
  const cfg = captured;
  const page = Object.assign({}, cfg);
  page.data = JSON.parse(JSON.stringify(cfg.data || {}));
  page.setData = function (patch, cb) {
    Object.keys(patch).forEach(k => {
      if (k.indexOf('.') > -1) {
        const parts = k.split('.'); let o = page.data;
        for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]]) o[parts[i]] = {}; o = o[parts[i]]; }
        o[parts[parts.length - 1]] = patch[k];
      } else page.data[k] = patch[k];
    });
    if (cb) cb();
  };
  return page;
}

function reset() { for (const k in mem) delete mem[k]; navs.length = 0; toasts.length = 0; }
function freshDb() {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf('utils') > -1) delete require.cache[k];
  });
  const db = require('../utils/db');
  db.init();
  return db;
}

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

/* ================= A. schema ================= */
t('成员带 openid 字段（v8），老数据缺这个字段不会崩', () => {
  reset();
  const db = freshDb();
  const schema = require('../utils/db/schema');
  assert.ok(schema.VERSION >= 8);
  const m = schema.normalizeMember({ id: 1, orgId: 'o', userId: 'u1', role: 'parent', name: '甲', openid: '  oABC  ' }, 'o', Date.now());
  assert.strictEqual(m.openid, 'oABC', 'openid 去掉首尾空格');
  const old = schema.normalizeMember({ id: 2, orgId: 'o', userId: 'u2', role: 'parent', name: '乙' }, 'o', Date.now());
  assert.strictEqual(old.openid, '', '老数据没有 openid → 空串');
  void db;
});

/* ================= B. 认领 ================= */
t('首次上云：本机负责人认领 openid，成员列表里能按 openid 找到', () => {
  reset();
  const db = freshDb();
  const r = db.members.claimOpenid('oid-owner');
  assert.ok(r.ok, r.msg);
  assert.strictEqual(r.already, false);
  const m = db.members.ofOpenid('oid-owner');
  assert.ok(m, '应能按 openid 找回成员');
  assert.strictEqual(m.role, 'owner');
});

t('重复认领是幂等的（每次启动都会调一遍，不能反复写盘）', () => {
  reset();
  const db = freshDb();
  db.members.claimOpenid('oid-owner');
  const again = db.members.claimOpenid('oid-owner');
  assert.ok(again.ok);
  assert.strictEqual(again.already, true);
  assert.strictEqual(db.members.list().filter(m => m.openid === 'oid-owner').length, 1, '不能认领出第二条');
});

t('别人已经认领过的成员抢不走（不许顶替）', () => {
  reset();
  const db = freshDb();
  // 造一个已被占用的成员：把当前负责人挂到 oid-A，然后试图用 oid-B 再认领
  db.members.claimOpenid('oid-A');
  const r = db.members.claimOpenid('oid-B');
  assert.strictEqual(r.ok, false, '同一成员不能被第二个 openid 认领');
  assert.ok(/已被|认领/.test(r.msg || ''));
});

t('空 openid 直接拒绝（云函数没返回 openid 时不能瞎写）', () => {
  reset();
  const db = freshDb();
  const r = db.members.claimOpenid('');
  assert.strictEqual(r.ok, false);
});

/* ================= C. 身份解析优先级 ================= */
// 这是本次改动最关键的一处：本机 me 是随机生成的，撞上负责人的 userId 就会提权
t('家长重装：本机 me 撞上负责人 userId，仍按 openid 认成家长（不提权）', () => {
  reset();
  const db = freshDb();
  // 本机出厂状态：me='t1'、只有一个 owner 成员（userId 也是 t1）
  assert.strictEqual(db.auth.actor().role, 'owner', '出厂时它就是负责人');
  // 造一个"云端拉回来的"家长：先建班和学生，再建家长成员并挂上 openid
  const cls = db.classes.create({ name: '书法班' }).item;
  const stu = db.students.create({ name: '小明', clsIds: [cls.id] }).item;
  const p = db.members.create({ name: '张珊珊', role: 'parent', studentIds: [stu.id] });
  assert.ok(p.ok, p.msg);
  const up = db.members.update(p.raw.id, { openid: 'oid-parent' });
  assert.ok(up.ok, up.msg);
  // 本机身份还指着出厂的 t1（这正是重装后的真实状态）
  db.patchMeta({ openid: 'oid-parent', me: 't1' });
  const a = db.auth.actor();
  assert.strictEqual(a.role, 'parent', '必须认成家长，实际：' + a.role);
  assert.strictEqual(a.name, '张珊珊');
});

t('预览切换仍然可用：本人是负责人时，切到家长能看到家长视角', () => {
  reset();
  const db = freshDb();
  db.members.claimOpenid('oid-owner');
  const cls = db.classes.create({ name: '书法班' }).item;
  const stu = db.students.create({ name: '小明', clsIds: [cls.id] }).item;
  const r = db.members.create({ name: '家长甲', role: 'parent', studentIds: [stu.id] });
  assert.ok(r.ok, r.msg);
  db.users.switchTo(r.raw.userId);
  assert.strictEqual(db.auth.actor().role, 'parent', '切过去应当是家长');
  db.users.switchHome();
  assert.strictEqual(db.auth.actor().role, 'owner', '切回来应当是负责人');
});

t('多成员机构里 me 对不上任何人：不给身份（不能默认成第一个人）', () => {
  reset();
  const db = freshDb();
  const cls = db.classes.create({ name: '书法班' }).item;
  const r = db.members.create({ name: '老师甲', role: 'teacher', clsIds: [cls.id] });
  assert.ok(r.ok, r.msg);
  db.patchMeta({ me: 'nobody', openid: '' });
  assert.strictEqual(db.auth.actor(), null, '宁可无身份，也不能默认给第一个成员');
});

/* ================= D. 加入机构的闸门 ================= */
t('本机已有学生时拒绝加入别家机构（LOCAL_DATA），不会把两份数据搅在一起', async () => {
  reset();
  const db = freshDb();
  db.students.create({ name: '小明' });
  const sync = require('../utils/sync');
  require('../utils/api').syncOn = () => true;   // 只测闸门，不测网络
  const r = await sync.join('ABCDEF', '家长甲', '1001');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'LOCAL_DATA');
});

t('加入成功：改挂机构、记住 openid 与自己的成员 id，并全量拉回一次', async () => {
  reset();
  const db = freshDb();
  const api = require('../utils/api');
  const sync = require('../utils/sync');
  api.syncOn = () => true;
  // 打桩：云端返回"家长"成员，pull 返回空增量（真实协议在真机验证）
  api.inviteJoin = () => Promise.resolve({
    ok: true, orgId: 'org-cloud',
    member: { id: 777, userId: 'x777', openid: 'oid-parent', role: 'parent', name: '张珊珊', studentIds: [12] }
  });
  let pulled = 0;
  api.syncCall = () => { pulled++; return Promise.resolve({ ok: true, docs: [], cursor: 0, more: false }); };
  const r = await sync.join('ABCDEF', '张珊珊', '1001');
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.orgId, 'org-cloud');
  const meta = db.real().meta;
  assert.strictEqual(meta.orgId, 'org-cloud', '本机改挂到云端机构');
  assert.strictEqual(meta.me, 'x777', '记住自己的成员 userId');
  assert.strictEqual(meta.openid, 'oid-parent', '记住 openid，换手机靠它找人');
  assert.ok(pulled >= 1, '加入后必须拉一次全量');
});

t('空库不抢先绑定机构（只读探测，绝不建绑定）', async () => {
  reset();
  freshDb();
  const api = require('../utils/api');
  const sync = require('../utils/sync');
  let hellos = 0, whoami = 0;
  api.syncOn = () => true;
  api.syncCall = action => {
    if (action === 'whoami') { whoami++; return Promise.resolve({ ok: true, bound: false, orgId: '' }); }
    if (action === 'hello') hellos++;
    return Promise.resolve({ ok: true, orgId: 'org-local' });
  };
  const r = await sync.init();
  assert.strictEqual(r.skipped, true, '空库应跳过');
  assert.strictEqual(r.code, 'EMPTY');
  assert.strictEqual(hellos, 0, '一次 hello 都不该发（发了就把家长绑到出厂机构上了）');
  assert.strictEqual(whoami, 1, '应该只读探测一次，判断是不是换手机');
});

t('换手机：空库但云端已绑定 → 按云端机构号恢复，不从零开始', async () => {
  reset();
  freshDb();
  const db = require('../utils/db');
  db.init();
  const api = require('../utils/api');
  const sync = require('../utils/sync');
  api.syncOn = () => true;
  api.syncCall = action => {
    if (action === 'whoami') return Promise.resolve({ ok: true, bound: true, orgId: 'org_mine', openid: 'openid-x' });
    if (action === 'pull') return Promise.resolve({ ok: true, cursor: 5, more: false, docs: [
      { c: 'classes', srvAt: 1, d: { id: 11, orgId: 'org_mine', name: '恢复班', session: 1, updatedAt: 1 } },
      { c: 'members', srvAt: 2, d: { id: 21, orgId: 'org_mine', openid: 'openid-x', role: 'owner', name: '张老师', userId: 'u1', clsIds: [], courseIds: [], studentIds: [], status: 'active', updatedAt: 2 } },
      { c: 'students', srvAt: 3, d: { id: 12, orgId: 'org_mine', name: '恢复的孩子', clsIds: [11], no: '1001', updatedAt: 3 } }
    ] });
    return Promise.resolve({ ok: true });
  };
  const r = await sync.syncNow({ force: true });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(db.real().meta.orgId, 'org_mine', '机构号要采纳云端的');
  assert.strictEqual(db.students.list().length, 1, '云端数据要拉回本地');
  assert.strictEqual(db.students.list()[0].name, '恢复的孩子');
  assert.strictEqual(db.classes.list().length, 1);
});

/* ================= E. 页面与入口 ================= */
t('加入页：只留大写字母数字，6 位截断；不足 4 位不发起请求', () => {
  reset();
  freshDb();
  const join = loadPage('pages/join/join.js');
  let called = 0;
  const api = require('../utils/api');
  api.inviteInfo = () => { called++; return Promise.resolve({ ok: false }); };
  join.setData({ code: '' });
  const kept = join.onCode({ detail: { value: 'ab-12 cd!' } });
  assert.strictEqual(kept, 'AB12CD', '过滤非法字符并转大写');
  join.setData({ code: 'AB', err: '' });
  api.enabled = () => true;
  join.check();
  assert.strictEqual(called, 0, '码太短不该打网络');
  assert.ok(/邀请码/.test(join.data.err));
});

t('加入页：家长必须填学号，没填不提交', () => {
  reset();
  freshDb();
  const join = loadPage('pages/join/join.js');
  join.setData({ stage: 2, role: 'parent', name: '张珊珊', stuNo: '', busy: false, err: '' });
  let called = 0;
  require('../utils/api').inviteJoin = () => { called++; return Promise.resolve({ ok: false }); };
  join.doJoin();
  assert.strictEqual(called, 0);
  assert.ok(/学号/.test(join.data.err), '应提示填学号，实际：' + join.data.err);
});

t('首页首次进入跳的是"老师还是家长"选择，而不是直接建机构', () => {
  reset();
  freshDb();
  const index = loadPage('pages/index/index.js');
  index.onShow();
  assert.ok(navs.some(u => u.indexOf('/pages/join/join?pick=1') > -1), '实际跳转：' + navs.join(','));
});

/* ---------- 执行 ---------- */
(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      pass++;
      console.log('  ✔ ' + name);
    } catch (e) {
      fail++;
      console.log('  ✘ ' + name + '\n    ' + (e && e.message));
    }
  }
  console.log('\nverify_invite: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})();
