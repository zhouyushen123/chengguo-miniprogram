// tests/verify_multi_org.js —— 多机构（一个微信多张工牌 + 家长跨机构看孩子）回归守卫
//
// 这四条一旦破了就是真事故：
//   1. 多机构不等于"打开权限"：能进 A 不代表能进 B，没工牌照样 fail-closed
//   2. 加入第二家只追加，不能把主机构顶掉、不能把两家的数据混在一起
//   3. 同步游标必须一家一个：共用一个游标，切过去就会永久漏拉历史
//   4. 家长端靠 pid 认孩子：同 pid = 一个孩子；没 pid 的各自独立，绝不猜
const path = require('path');
const fs = require('fs');
const Module = require('module');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------------- 内存假库（跑真云函数） ---------------- */
const store = {};
const rowsOf = n => (store[n] || (store[n] = []));
let curOpenid = 'oid-owner';

function match(row, cond) {
  return Object.keys(cond || {}).every(k => {
    const c = cond[k];
    if (c && typeof c === 'object' && '$gt' in c) return Number(row[k] || 0) > c.$gt;
    if (c && typeof c === 'object' && '$eq' in c) return row[k] === c.$eq;
    return row[k] === c;
  });
}
function query(name, cond) {
  return {
    _skip: 0, _limit: 100,
    skip(n) { this._skip = n; return this; },
    limit(n) { this._limit = n; return this; },
    orderBy() { return this; },
    async get() {
      const list = rowsOf(name).filter(r => match(r, cond));
      return { data: list.slice(this._skip, this._skip + this._limit).map(r => JSON.parse(JSON.stringify(r))) };
    },
    async count() { return { total: rowsOf(name).filter(r => match(r, cond)).length }; },
    async update({ data }) {
      const hits = rowsOf(name).filter(r => match(r, cond));
      hits.forEach(r => Object.assign(r, data));
      return { stats: { updated: hits.length } };
    }
  };
}
function collection(name) {
  return {
    where: c => query(name, c),
    limit: n => query(name, {}).limit(n),
    orderBy: () => query(name, {}),
    async add({ data }) {
      const rows = rowsOf(name);
      const d = Object.assign({ _id: 'id' + (rows.length + 1) }, data);
      rows.push(d);
      return { _id: d._id };
    },
    doc: id => ({
      async get() {
        const r = rowsOf(name).find(x => x._id === id);
        if (!r) throw new Error('not found');
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
      },
      async remove() {
        const i = rowsOf(name).findIndex(x => x._id === id);
        if (i > -1) rowsOf(name).splice(i, 1);
        return { stats: { removed: i > -1 ? 1 : 0 } };
      }
    })
  };
}
const fake = {
  DYNAMIC_CURRENT_ENV: 'env',
  init() {},
  getWXContext: () => ({ OPENID: curOpenid }),
  database: () => ({
    collection,
    command: { gt: v => ({ $gt: v }), eq: v => ({ $eq: v }) },
    serverDate: () => new Date(),
    createCollection: async () => ({})
  })
};
const stub = path.join(__dirname, '..', '.fake-wx-sdk-org.js');
fs.writeFileSync(stub, 'module.exports = global.__WX_SDK_ORG__;');
global.__WX_SDK_ORG__ = fake;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'wx-server-sdk') return stub;
  return origResolve.call(this, req, ...rest);
};
const syncv2 = require(path.join(ROOT, 'cloudfunctions', 'syncv2', 'index.js'));

const call = (action, extra, oid) => {
  curOpenid = oid || 'oid-owner';
  return syncv2.main(Object.assign({ action }, extra || {}));
};

/* ---------------- 云端种子：两家机构 + 一个家长 ---------------- */
function seed() {
  Object.keys(store).forEach(k => { delete store[k]; });
  rowsOf('orgs').push({ _id: 'o1', id: 'org_a', name: '橙果美术' });
  rowsOf('orgs').push({ _id: 'o2', id: 'org_b', name: '小星星钢琴' });
  // 负责人两边各有一个
  rowsOf('users').push({ _id: 'u1', _openid: 'oid-owner', orgId: 'org_a', orgIds: ['org_a'] });
  rowsOf('members').push({ _id: 'm1', orgId: 'org_a', openid: 'oid-owner', role: 'owner', name: '王负责人', clsIds: [], status: 'active' });
  rowsOf('members').push({ _id: 'm2', orgId: 'org_b', openid: 'oid-owner2', role: 'owner', name: '李负责人', clsIds: [], status: 'active' });
  // 家长：已在 A 家绑了张小明（老数据，没有 pid）
  rowsOf('users').push({ _id: 'up', _openid: 'oid-parent', orgId: 'org_a', orgIds: ['org_a'] });
  rowsOf('members').push({ _id: 'mp', orgId: 'org_a', openid: 'oid-parent', role: 'parent', name: '张妈妈', studentIds: [201], status: 'active' });
  rowsOf('students').push({ _id: 's201', orgId: 'org_a', id: 201, name: '张小明', no: '1001', clsIds: [11], parentPhone: '', wechat: '', removed: false });
  rowsOf('classes').push({ _id: 'c11', orgId: 'org_a', id: 11, name: '美术一班' });
  // B 家也给张小明建了档案
  rowsOf('students').push({ _id: 's301', orgId: 'org_b', id: 301, name: '张小明', no: '2001', clsIds: [21], parentPhone: '', wechat: '', removed: false });
  rowsOf('classes').push({ _id: 'c21', orgId: 'org_b', id: 21, name: '钢琴启蒙' });
  curOpenid = 'oid-owner';
}
const CARD = 'cardtoken001';
function putCard(orgId, sid, stuName) {
  rowsOf('invite_cards').push({
    _id: CARD, orgId, sid, stuName, status: 'unused',
    expiresAt: Date.now() + 86400000, clsId: 21, orgName: '', clsName: ''
  });
  return CARD;
}

let pass = 0, fail = 0;
async function ok(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + (e && e.message)); fail++; }
}

(async () => {
  console.log('\n【A. 云端：一个微信多张工牌】');

  await ok('加入第二家机构：追加一张工牌，主机构不变，两家各一条成员关系', async () => {
    seed();
    rowsOf('invites').push({ _id: 'ABCDEF', orgId: 'org_b', role: 'teacher', closed: false, uses: 0, expiresAt: Date.now() + 86400000 });
    const r = await call('inviteJoin', { code: 'ABCDEF', name: '王老师' }, 'oid-owner');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const u = rowsOf('users').find(x => x._id === 'u1');
    assert.deepStrictEqual(u.orgIds, ['org_a', 'org_b'], '两张工牌都要在');
    assert.strictEqual(u.orgId, 'org_a', '主机构不能被顶掉');
    const mem = rowsOf('members').filter(x => x.openid === 'oid-owner');
    assert.strictEqual(mem.length, 2, '两家各一条成员关系，互不覆盖');
    assert.deepStrictEqual(mem.map(m => m.orgId).sort(), ['org_a', 'org_b']);
  });

  await ok('没有工牌的机构一律拒绝（多机构不等于放开越权）', async () => {
    seed();
    // oid-owner 只有 org_a 的工牌，拿 org_b 的号去读数据
    const r = await call('pull', { orgId: 'org_b', since: 0 }, 'oid-owner');
    assert.strictEqual(r.code, 'FORBIDDEN');
  });

  await ok('myOrgs 回我能进的机构清单（带角色），没绑过的人回空数组', async () => {
    seed();
    const a = await call('myOrgs', {}, 'oid-owner');
    assert.strictEqual(a.ok, true);
    assert.deepStrictEqual(a.orgs.map(o => o.orgId), ['org_a']);
    assert.strictEqual(a.orgs[0].role, 'owner');
    assert.strictEqual(a.orgs[0].orgName, '橙果美术');
    const b = await call('myOrgs', {}, 'oid-nobody');
    assert.strictEqual(b.ok, true);
    assert.deepStrictEqual(b.orgs, []);
  });

  await ok('hello 带哪家就回哪家（有工牌才行），没工牌落回主机构', async () => {
    seed();
    const u = rowsOf('users').find(x => x._id === 'up');
    u.orgIds = ['org_a', 'org_b'];
    const a = await call('hello', { orgId: 'org_b' }, 'oid-parent');
    assert.strictEqual(a.orgId, 'org_b');
    assert.deepStrictEqual(a.orgIds, ['org_a', 'org_b']);
    const b = await call('hello', { orgId: 'org_evil' }, 'oid-parent');
    assert.strictEqual(b.orgId, 'org_a', '点名的不是我家 → 落回主机构，绝不因为客户端说了算就换空间');
  });

  console.log('\n【B. 云端：认得出是同一个孩子】');

  await ok('第二家发卡给同一个孩子：先停下来问，不替家长决定', async () => {
    seed();
    putCard('org_b', 301, '张小明');
    const r = await call('cardClaim', { token: CARD, name: '张妈妈', merge: '' }, 'oid-parent');
    assert.strictEqual(r.code, 'SAME_KID', JSON.stringify(r));
    assert.strictEqual(r.sameName, '张小明');
    assert.ok(r.pid, '老数据那条要顺手补上平台身份，否则家长确认时没有东西可传回');
    // 卡没被消耗：家长可能还要想一想
    assert.strictEqual(rowsOf('invite_cards').find(x => x._id === CARD).status, 'unused');
    // A 家那条已经补了 pid
    assert.strictEqual(rowsOf('students').find(x => x._id === 's201').pid, r.pid);
  });

  await ok('家长确认「是同一个孩子」→ 两家的档案共用一个 pid', async () => {
    seed();
    putCard('org_b', 301, '张小明');
    const q = await call('cardClaim', { token: CARD, name: '张妈妈', merge: '' }, 'oid-parent');
    const r = await call('cardClaim', { token: CARD, name: '张妈妈', merge: q.pid }, 'oid-parent');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.merged, true);
    assert.strictEqual(r.pid, q.pid);
    assert.strictEqual(rowsOf('students').find(x => x._id === 's201').pid, q.pid);
    assert.strictEqual(rowsOf('students').find(x => x._id === 's301').pid, q.pid);
    // 两张工牌都拿到了
    const u = rowsOf('users').find(x => x._id === 'up');
    assert.deepStrictEqual(u.orgIds, ['org_a', 'org_b']);
  });

  await ok('家长说「不是同一个孩子」→ 各发各的 pid，绝不并到一起', async () => {
    seed();
    putCard('org_b', 301, '张小明');
    const q = await call('cardClaim', { token: CARD, name: '张妈妈', merge: '' }, 'oid-parent');
    const r = await call('cardClaim', { token: CARD, name: '张妈妈', merge: 'new' }, 'oid-parent');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.merged, false);
    const pa = rowsOf('students').find(x => x._id === 's201').pid;
    const pb = rowsOf('students').find(x => x._id === 's301').pid;
    assert.ok(pa && pb && pa !== pb, '两个孩子的平台身份必须不同');
  });

  await ok('回传一个不属于自己孩子的 pid → 当没确认，不许并到别人孩子名下', async () => {
    seed();
    putCard('org_b', 301, '张小明');
    const r = await call('cardClaim', { token: CARD, name: '张妈妈', merge: 'p_hacker1234' }, 'oid-parent');
    assert.strictEqual(r.code, 'STALE_MERGE');
    assert.strictEqual(rowsOf('invite_cards').find(x => x._id === CARD).status, 'unused');
  });

  console.log('\n【C. 数据层：游标一家一个 / 家长跨机构视图】');

  /* 客户端数据层：假 wx + 假 storage */
  const mem = {};
  global.wx = {
    getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
    setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
    removeStorageSync: k => { delete mem[k]; },
    showToast: () => {}, showLoading: () => {}, hideLoading: () => {},
    setNavigationBarColor: () => {}, setBackgroundColor: () => {},
    setTabBarStyle: () => {}, setTabBarItem: () => {}, getSystemInfoSync: () => ({})
  };
  global.getApp = () => ({ globalData: { pick: null } });
  global.App = () => {};
  const freshDb = () => {
    Object.keys(require.cache).forEach(k => { if (k.indexOf('utils') > -1) delete require.cache[k]; });
    const d = require('../utils/db');
    d.init();
    return d;
  };

  await ok('同步游标按机构分开：A 拉到 100，切到 B 必须从 0 开始', async () => {
    Object.keys(mem).forEach(k => delete mem[k]);
    const dbb = freshDb();
    dbb.patchMeta({ orgId: 'org_a' });
    dbb.sync.setCursor(100);
    assert.strictEqual(dbb.sync.cursor(), 100);
    dbb.patchMeta({ orgId: 'org_b' });
    assert.strictEqual(dbb.sync.cursor(), 0, '拿 A 家的进度去拉 B 家 → 比它早的数据永远拉不到');
    dbb.sync.setCursor(50);
    dbb.patchMeta({ orgId: 'org_a' });
    assert.strictEqual(dbb.sync.cursor(), 100, '切回来还是原来的进度');
    dbb.patchMeta({ orgId: 'org_b' });
    assert.strictEqual(dbb.sync.cursor(), 50);
  });

  // 两家机构的数据同时躺在同一个本地库里，靠 orgId 过滤
  const seedLocal = dbb => {
    const raw = dbb.real();
    raw.students.push({ id: 201, orgId: 'org_a', pid: 'p_1', name: '张小明', clsIds: [11], removed: false, updatedAt: 1 });
    raw.students.push({ id: 301, orgId: 'org_b', pid: 'p_1', name: '张小明', clsIds: [21], removed: false, updatedAt: 1 });
    raw.students.push({ id: 302, orgId: 'org_b', pid: '', name: '张老二', clsIds: [21], removed: false, updatedAt: 1 });
    // 两家都有 id=11 的班：只按 id 查班级名就会张冠李戴
    raw.classes.push({ id: 11, orgId: 'org_a', name: '美术一班', removed: false });
    raw.classes.push({ id: 11, orgId: 'org_b', name: '钢琴一对一', removed: false });
    raw.classes.push({ id: 21, orgId: 'org_b', name: '钢琴启蒙', removed: false });
    raw.members.push({ id: 1, orgId: 'org_a', openid: 'oid_p', userId: 'u1', role: 'parent', studentIds: [201], status: 'active', removed: false });
    raw.members.push({ id: 2, orgId: 'org_b', openid: 'oid_p', userId: 'u2', role: 'parent', studentIds: [301, 302], status: 'active', removed: false });
    raw.records.push({ id: 1, orgId: 'org_a', sid: 201, cid: 11, sent: true, date: '2026-11-01', course: '素描', note: 'A 家', removed: false });
    raw.records.push({ id: 2, orgId: 'org_b', sid: 301, cid: 21, sent: true, date: '2026-11-02', course: '音阶', note: 'B 家', removed: false });
    raw.records.push({ id: 3, orgId: 'org_b', sid: 301, cid: 21, sent: false, date: '2026-11-03', course: '音阶', note: '草稿', removed: false });
    dbb.patchMeta({ openid: 'oid_p', orgId: 'org_a' });
  };

  await ok('family.kids：同 pid 的两条档案合成一个孩子，不同 pid 各算各的', async () => {
    Object.keys(mem).forEach(k => delete mem[k]);
    const dbb = freshDb();
    seedLocal(dbb);
    const kids = dbb.family.kids();
    assert.strictEqual(kids.length, 2, '张小明一个 + 张老二一个');
    const xm = kids.find(k => k.name === '张小明');
    assert.strictEqual(xm.orgs.length, 2, '两家各有一条档案');
    assert.deepStrictEqual(xm.orgs.map(o => o.orgId).sort(), ['org_a', 'org_b']);
  });

  await ok('family.records：两家并在一起、只算已发布、标清哪条是谁给的', async () => {
    Object.keys(mem).forEach(k => delete mem[k]);
    const dbb = freshDb();
    seedLocal(dbb);
    const recs = dbb.family.records('p_1');
    assert.strictEqual(recs.length, 2, '草稿不能进家长视野');
    assert.deepStrictEqual(recs.map(r => r.orgId), ['org_b', 'org_a'], '按日期倒序');
    assert.strictEqual(recs[0].clsName, '钢琴启蒙');
    assert.strictEqual(recs[1].clsName, '美术一班', '两家都有 id=11 附近的班，必须按 orgId 查');
  });

  await ok('family 只认我自己绑的孩子：同机构别人家的孩子看不到', async () => {
    Object.keys(mem).forEach(k => delete mem[k]);
    const dbb = freshDb();
    seedLocal(dbb);
    dbb.real().students.push({ id: 299, orgId: 'org_a', name: '别人家孩子', clsIds: [11], removed: false, updatedAt: 1 });
    const kids = dbb.family.kids();
    assert.ok(!kids.some(k => k.name === '别人家孩子'), 'member.studentIds 之外的一律不碰');
  });

  console.log('\n【D. 界面守卫：切换器只在需要时出现】');
  const srcIndex = read('pages/index/index.js');
  const wxmlIndex = read('pages/index/index.wxml');
  const srcJoin = read('pages/join/join.js');

  await ok('切换器只在"两家以上"时出现，一家时不占地方', async () => {
    assert.ok(/orgs\.length>1/.test(wxmlIndex), '模板要按机构数决定显不显示');
    assert.ok(/r\.orgs\.length < 2/.test(srcIndex), '只有一家时不该把切换器塞进页面');
  });

  await ok('家长端不出现机构切换器（家长只认孩子，不认机构）', async () => {
    const seg = srcIndex.slice(srcIndex.indexOf('_loadOrgs()'), srcIndex.indexOf('openOrgPick()'));
    assert.ok(/this\.data\.isParent/.test(seg), '家长端要直接跳过机构清单');
  });

  await ok('「再加一家」从首页进 join 页，加完不擅自切走', async () => {
    assert.ok(/join\/join\?add=1/.test(srcIndex));
    assert.ok(/q && q\.add/.test(srcJoin), 'add 模式直接问机构码，不摆"创建机构"');
    assert.ok(/switchOrg/.test(srcJoin), '加完问一句要不要切过去，别替人做主');
  });

  await ok('云端合并按「机构 + id」索引：两家撞同一个 id 也不会互相顶掉', () => {
    Object.keys(require.cache).forEach(k => { if (k.indexOf('utils') > -1) delete require.cache[k]; });
    const sm = require('../utils/syncmerge');
    // 一家机构一份 id 空间时，撞号只影响自己；多机构之后影响的是别人，这个概率不值得赌
    const r = sm.mergeList(
      [{ id: 500, orgId: 'org_a', name: '我们班的', updatedAt: 1 }],
      [{ id: 500, orgId: 'org_b', name: '别家的', updatedAt: 2 }]
    );
    assert.strictEqual(r.list.length, 2, '同 id 不同机构 → 两条都得留');
    assert.strictEqual(r.added, 1);
    assert.ok(r.list.some(x => x.name === '别家的'));
  });

  console.log('\nverify_multi_org: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})();
