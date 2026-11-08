// tests/verify_invite_card.js —— 家长免码加入「一人一卡」阶段 1 回归守卫
//
// 重点不是"能不能发卡"，而是这四条一旦破了就是真事故：
//   1. 卡片链接里只有 token，点开只回姓名，绝不回学号 / 机构码 / 手机号 / 业务数据
//   2. 一次性：两个人同时点同一张卡，只能有一个认领成功（条件更新，不是先读后写）
//   3. 过期 / 作废 / 已用过的卡必须被拒，且理由是人话
//   4. 家长还没绑定机构也要能点卡；老师发卡/作废则必须过了绑定与权限闸门
//
// 云函数本体用内存假库真跑（不是只读源码），前端用假 Page / 假 wx 跑行为断言。
const path = require('path');
const fs = require('fs');
const Module = require('module');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------------- 内存假库 ---------------- */
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
    // cardClaim 的一次性靠 where(...).update() 原子条件写，假库必须真支持
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
const stub = path.join(__dirname, '..', '.fake-wx-sdk-card.js');
fs.writeFileSync(stub, 'module.exports = global.__WX_SDK_CARD__;');
global.__WX_SDK_CARD__ = fake;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'wx-server-sdk') return stub;
  return origResolve.call(this, req, ...rest);
};
const syncv2 = require(path.join(ROOT, 'cloudfunctions', 'syncv2', 'index.js'));

function seed() {
  Object.keys(store).forEach(k => { delete store[k]; });
  rowsOf('users').push({ _id: 'u1', _openid: 'oid-owner', orgId: 'org1' });
  rowsOf('users').push({ _id: 'u2', _openid: 'oid-teacher', orgId: 'org1' });
  rowsOf('members').push({ _id: 'm1', orgId: 'org1', openid: 'oid-owner', role: 'owner', name: '负责人', clsIds: [], status: 'active' });
  rowsOf('members').push({ _id: 'm2', orgId: 'org1', openid: 'oid-teacher', role: 'teacher', name: '李老师', clsIds: [11], status: 'active' });
  rowsOf('orgs').push({ _id: 'o1', id: 'org1', name: '橙果课堂' });
  rowsOf('classes').push({ _id: 'c1', orgId: 'org1', id: 11, name: '书法一班' });
  rowsOf('classes').push({ _id: 'c2', orgId: 'org1', id: 12, name: '美术二班' });
  rowsOf('students').push({
    _id: 's1', orgId: 'org1', id: 101, name: '张小明', no: '1001',
    clsIds: [11], parentPhone: '13800001111', wechat: '', removed: false
  });
  rowsOf('students').push({
    _id: 's2', orgId: 'org1', id: 102, name: '张小妹', no: '1002',
    clsIds: [12], parentPhone: '13800001111', wechat: '', removed: false
  });
  rowsOf('students').push({
    _id: 's3', orgId: 'org1', id: 103, name: '王小刚', no: '1003',
    clsIds: [12], parentPhone: '', wechat: '', removed: false
  });
  curOpenid = 'oid-owner';
}
const call = (action, extra, oid) => {
  curOpenid = oid || 'oid-owner';
  return syncv2.main(Object.assign({ action }, extra || {}));
};
const createCard = async (sid, oid) => call('cardCreate', { sid, orgId: 'org1' }, oid || 'oid-owner');

let pass = 0, fail = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => {
  pass++; console.log('  ✓ ' + name);
}, e => { fail++; console.log('  ✘ ' + name + '\n    ' + (e && e.message)); });

(async () => {
  console.log('\n【A. 云端：发卡与卡面】');

  await ok('ensureCollections 自动建 invite_cards（不用控制台手工点）', async () => {
    const src = read('cloudfunctions/syncv2/index.js');
    assert.ok(/COLLS\.concat\(\['users', INVITES, HISTORY, CARDS\]\)/.test(src));
    assert.ok(/const CARDS = 'invite_cards'/.test(src));
  });

  await ok('负责人发卡：卡文档带 orgId/sid/有效期，data 里没有 _id', async () => {
    seed();
    const r = await createCard(101);
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(/^[a-z0-9]{12}$/.test(r.token), 'token 应是 12 位无歧义短串：' + r.token);
    assert.strictEqual(r.stuName, '张小明');
    assert.strictEqual(r.clsName, '书法一班');
    const card = rowsOf('invite_cards').find(x => x._id === r.token);
    assert.ok(card);
    assert.strictEqual(card.sid, 101);
    assert.strictEqual(card.orgId, 'org1');
    assert.strictEqual(card.status, 'unused');
    assert.ok(card.expiresAt > Date.now());
    assert.ok(card.expiresAt - Date.now() <= 7 * 86400000 + 1000, '有效期就是 7 天');
    assert.ok(!card.photo && !card.photoUrls, '卡里不放孩子照片');
    const src = read('cloudfunctions/syncv2/index.js');
    const seg = src.slice(src.indexOf("if (action === 'cardCreate')"), src.indexOf("if (action === 'cardRevoke')"));
    const setSeg = seg.slice(seg.indexOf('.set({ data: {'));
    assert.ok(!/_id\s*:/.test(setSeg), 'set 的 data 不能带 _id（云端 -501007）');
  });

  await ok('卡面只回三个名字：不回学号 / 机构码 / 手机号 / 照片 / 成绩', async () => {
    seed();
    const c = await createCard(101);
    const r = await call('cardInfo', { token: c.token }, 'oid-parent');
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.stuName, '张小明');
    assert.strictEqual(r.orgName, '橙果课堂');
    assert.strictEqual(r.clsName, '书法一班');
    ['stuNo', 'code', 'sid', 'orgId', 'parentPhone', 'photo', 'clsId'].forEach(k => {
      assert.ok(!(k in r), 'cardInfo 不该回 ' + k);
    });
    const src = read('cloudfunctions/syncv2/index.js');
    const seg = src.slice(src.indexOf("if (action === 'cardInfo')"), src.indexOf("if (action === 'cardClaim')"));
    assert.ok(!/d\.(stuNo|code|sid|orgId|parentPhone|photo)/.test(seg), 'cardInfo 分支不得读业务字段返回');
  });

  await ok('家长没绑定机构也能点卡（cardInfo/cardClaim 在绑定闸门之前）', async () => {
    seed();
    const c = await createCard(101);
    assert.ok(!rowsOf('users').some(u => u._openid === 'oid-parent'), '前置条件：家长确实没绑定');
    const r = await call('cardInfo', { token: c.token }, 'oid-parent');
    assert.ok(r.ok, JSON.stringify(r));
    const src = read('cloudfunctions/syncv2/index.js');
    // hello / whoami 分支里也各有一次 userOf，主闸门要看最后一次出现
    const gate = src.lastIndexOf('const u = await userOf(OPENID);');
    assert.ok(src.indexOf("if (action === 'cardInfo')") < gate);
    assert.ok(src.indexOf("if (action === 'cardClaim')") < gate);
    assert.ok(src.indexOf("if (action === 'cardCreate')") > gate);
    assert.ok(src.indexOf("if (action === 'cardRevoke')") > gate);
  });

  console.log('\n【B. 云端：一次性、有效期、作废、权限】');

  await ok('确认成功后成家长、认领孩子 + 同手机号兄弟姐妹', async () => {
    seed();
    const c = await createCard(101);
    const r = await call('cardClaim', { token: c.token, name: '张珊珊' }, 'oid-parent');
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.orgId, 'org1');
    assert.strictEqual(r.member.role, 'parent');
    assert.strictEqual(r.member.status, 'active');
    assert.deepStrictEqual(r.member.studentIds.slice().sort(), [101, 102],
      'parentPhone 相同的兄妹要一起带上（F-04 双键归并已对齐云端）');
    assert.ok(rowsOf('users').some(u => u._openid === 'oid-parent' && u.orgId === 'org1'));
  });

  await ok('老入口按学号加入仍能带出同手机号兄妹（没回归）', async () => {
    seed();
    rowsOf('invites').push({ _id: 'ABCDEF', orgId: 'org1', role: 'parent', closed: false, uses: 0, expiresAt: Date.now() + 86400000 });
    const r = await call('inviteJoin', { code: 'ABCDEF', name: '张珊珊', stuNo: '1001' }, 'oid-parent2');
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepStrictEqual(r.member.studentIds.slice().sort(), [101, 102]);
  });

  await ok('同一张卡第二次确认被拒（USED）', async () => {
    seed();
    const c = await createCard(101);
    const a = await call('cardClaim', { token: c.token, name: '甲' }, 'oid-parent');
    assert.ok(a.ok);
    const b = await call('cardClaim', { token: c.token, name: '乙' }, 'oid-parent2');
    assert.strictEqual(b.ok, false);
    assert.strictEqual(b.code, 'USED');
  });

  await ok('两个家长同时点同一张卡，只有一个成功（条件更新）', async () => {
    seed();
    const c = await createCard(101);
    const src = read('cloudfunctions/syncv2/index.js');
    assert.ok(/where\(\{ _id: token, status: 'unused' \}\)\s*\.update\(/.test(src), '必须是原子条件写');
    assert.ok(/upd\.stats\.updated !== 1/.test(src));
    const rs = await Promise.all([
      call('cardClaim', { token: c.token, name: '甲' }, 'oid-parent'),
      call('cardClaim', { token: c.token, name: '乙' }, 'oid-parent2')
    ]);
    assert.strictEqual(rs.filter(x => x.ok).length, 1, '只能一个生效：' + JSON.stringify(rs));
  });

  await ok('过期卡被拒，且提示是「过 7 天有效期」', async () => {
    seed();
    const c = await createCard(101);
    rowsOf('invite_cards').find(x => x._id === c.token).expiresAt = Date.now() - 1;
    const info = await call('cardInfo', { token: c.token }, 'oid-parent');
    assert.strictEqual(info.code, 'EXPIRED');
    const claim = await call('cardClaim', { token: c.token, name: '甲' }, 'oid-parent');
    assert.strictEqual(claim.code, 'EXPIRED');
    assert.ok(/7 天/.test(info.msg));
  });

  await ok('老师作废后卡片立即失效，家长点开看到人话', async () => {
    seed();
    const c = await createCard(101);
    const rv = await call('cardRevoke', { token: c.token, orgId: 'org1' });
    assert.ok(rv.ok, JSON.stringify(rv));
    const info = await call('cardInfo', { token: c.token }, 'oid-parent');
    assert.strictEqual(info.code, 'REVOKED');
    assert.ok(/作废/.test(info.msg));
  });

  await ok('已确认过的卡不能作废（作废不会移除已加入的家长）', async () => {
    seed();
    const c = await createCard(101);
    await call('cardClaim', { token: c.token, name: '甲' }, 'oid-parent');
    const rv = await call('cardRevoke', { token: c.token, orgId: 'org1' });
    assert.strictEqual(rv.ok, false);
    assert.strictEqual(rv.code, 'USED');
  });

  await ok('家长不能发卡；老师只能给自己班上的学生发', async () => {
    seed();
    rowsOf('members').push({ _id: 'm3', orgId: 'org1', openid: 'oid-parent3', role: 'parent', clsIds: [], status: 'active' });
    rowsOf('users').push({ _id: 'u3', _openid: 'oid-parent3', orgId: 'org1' });
    const p = await createCard(101, 'oid-parent3');
    assert.strictEqual(p.ok, false);
    assert.strictEqual(p.code, 'FORBIDDEN');
    const mine = await createCard(103, 'oid-teacher');   // 美术二班不在李老师的 clsIds
    assert.strictEqual(mine.ok, false);
    assert.strictEqual(mine.code, 'FORBIDDEN');
    const okCard = await createCard(101, 'oid-teacher');
    assert.ok(okCard.ok, JSON.stringify(okCard));
  });

  await ok('云端还没有这个学生时给「先同步一轮」而不是「不存在」', async () => {
    seed();
    const r = await createCard(999);
    assert.strictEqual(r.code, 'NO_STUDENT');
    assert.ok(/同步/.test(r.msg));
  });

  await ok('已绑别家机构的微信点卡：允许，追加一张工牌，原来那家不动（多机构）', async () => {
    seed();
    rowsOf('users').push({ _id: 'u9', _openid: 'oid-other', orgId: 'org_else' });
    const c = await createCard(101);
    const r = await call('cardClaim', { token: c.token, name: '甲' }, 'oid-other');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const u = rowsOf('users').find(x => x._id === 'u9');
    // 两张工牌都在，主机构仍然是原来那家（不因为加入了新的就把旧的顶掉）
    assert.deepStrictEqual(u.orgIds, ['org_else', 'org1']);
    assert.strictEqual(u.orgId, 'org_else');
    assert.strictEqual(rowsOf('invite_cards').find(x => x._id === c.token).status, 'approved');
  });

  await ok('同一张卡被两个人抢：只有一个成功，另一个被告知已确认', async () => {
    seed();
    const c = await createCard(101);
    const a = await call('cardClaim', { token: c.token, name: '甲' }, 'oid-parent-a');
    const b = await call('cardClaim', { token: c.token, name: '乙' }, 'oid-parent-b');
    assert.strictEqual(a.ok, true, JSON.stringify(a));
    assert.strictEqual(b.code, 'USED');
  });

  await ok('没填姓名的确认直接拒，且不消耗卡片', async () => {
    seed();
    const c = await createCard(101);
    const r = await call('cardClaim', { token: c.token, name: '  ' }, 'oid-parent');
    assert.strictEqual(r.code, 'NO_NAME');
    assert.strictEqual(rowsOf('invite_cards').find(x => x._id === c.token).status, 'unused');
  });

  console.log('\n【C. 前端：链接、确认页、本机改挂】');

  const srcJoin = read('pages/join/join.js');
  const wxmlJoin = read('pages/join/join.wxml');
  const srcMgr = read('pages/mgr/mgr.js');
  const wxmlMgr = read('pages/mgr/mgr.wxml');

  await ok('分享链接只有 token，不带码 / 学号 / 照片', async () => {
    assert.ok(/path: '\/pages\/join\/join\?card=' \+ c\.token/.test(srcMgr));
    assert.ok(!/photo|stuNo|no=|code=/.test(srcMgr.slice(srcMgr.indexOf('onShareAppMessage'))));
    assert.ok(/title: c\.stuName \+ ' · 课堂成果邀请'/.test(srcMgr));
  });

  await ok('老师端弹层写明「只单独发给这一位家长」，不承诺送达', async () => {
    assert.ok(/open-type="share"/.test(wxmlMgr));
    assert.ok(/暂时不要发到班级群/.test(wxmlMgr));
    assert.ok(!/发送给家长|已发送|待发送/.test(wxmlMgr));
    assert.ok(/cardRevoke/.test(srcMgr), '作废重发要有入口');
  });

  await ok('确认页是显式二次确认：填姓名 + 点「我是，确认加入」', async () => {
    assert.ok(/stage===3/.test(wxmlJoin));
    assert.ok(/我是，确认加入/.test(wxmlJoin));
    assert.ok(/doCardClaim/.test(wxmlJoin));
    assert.ok(/你是 \{\{cardStu\}\} 的家长吗/.test(wxmlJoin));
    assert.ok(!/type="number"[^>]*bindinput="onStuNo"/.test(wxmlJoin.slice(0, wxmlJoin.indexOf('stage===0'))),
      '卡片确认页不该再问学号');
  });

  await ok('卡片态提前检测本机非空库，并走 joinByCard 而不是老入口', async () => {
    assert.ok(/q && q\.card/.test(srcJoin) && /stage: 3/.test(srcJoin));
    assert.ok(/sync\.canJoin\(\)/.test(srcJoin));
    assert.ok(/localBad/.test(wxmlJoin));
    const claimSeg = srcJoin.slice(srcJoin.indexOf('doCardClaim('), srcJoin.indexOf('goSetup()'));
    assert.ok(/sync\.joinByCard\(/.test(claimSeg));
    assert.ok(!/sync\.join\(/.test(claimSeg), '卡片态不能退回老入口');
    assert.ok(/\/pages\/index\/index/.test(claimSeg), '确认后回首页，返回路径完整');
  });

  await ok('api 四个卡片接口都导出，且都走 callFn 不经 syncOn 闸门', async () => {
    const a = read('utils/api.js');
    ['cardCreate', 'cardInfo', 'cardClaim', 'cardRevoke'].forEach(k => {
      assert.ok(new RegExp('function ' + k + '\\(').test(a), '缺 api.' + k);
      assert.ok(new RegExp('\\b' + k + '\\b').test(a.slice(a.indexOf('module.exports'))), '没导出 ' + k);
    });
    assert.ok(!/syncOn\(\)/.test(a.slice(a.indexOf('家长邀请卡（一人一卡'), a.indexOf('function pushRecord'))));
  });

  await ok('joinByCard 复用 adopt：不再打一次 inviteJoin，拉一次全量', async () => {
    const s = read('utils/sync.js');
    // 第三参 merge：'' 第一次问 / 'new' 不是同一个孩子 / <pid> 确认是同一个孩子
    assert.ok(/function joinByCard\(token, name, merge\)/.test(s));
    assert.ok(/api\.cardClaim\(token, name, merge\)/.test(s));
    assert.ok(/function adopt\(r\)/.test(s));
    assert.ok(!/api\.inviteJoin/.test(s.slice(s.indexOf('function joinByCard'), s.indexOf('function orgList'))), '卡片链路不能再走老接口');
    assert.ok(/canJoin: \(\) => isEmptyLocal\(\)/.test(s));
    assert.ok(/join, joinByCard, claim/.test(s));
  });

  /* ---------- 行为断言：真的跑一遍 joinByCard ---------- */
  const mem = {};
  global.wx = {
    getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
    setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
    removeStorageSync: k => { delete mem[k]; },
    showToast: () => {}, showLoading: () => {}, hideLoading: () => {},
    setNavigationBarColor: () => {}, setBackgroundColor: () => {},
    setTabBarStyle: () => {}, setTabBarItem: () => {},
    getSystemInfoSync: () => ({})
  };
  global.getApp = () => ({ globalData: { pick: null } });
  global.App = () => {};
  const freshDb = () => {
    Object.keys(require.cache).forEach(k => { if (k.indexOf('utils') > -1) delete require.cache[k]; });
    const d = require('../utils/db');
    d.init();
    return d;
  };

  await ok('卡片加入成功：改挂机构、记住 openid、拉一次全量、不再打 inviteJoin', async () => {
    Object.keys(mem).forEach(k => delete mem[k]);
    const dbb = freshDb();
    const api = require('../utils/api');
    const sync = require('../utils/sync');
    let inviteJoins = 0, pulls = 0;
    api.syncOn = () => true;
    api.inviteJoin = () => { inviteJoins++; return Promise.resolve({ ok: false }); };
    api.cardClaim = () => Promise.resolve({
      ok: true, orgId: 'org-card', sid: 101,
      member: { id: 778, userId: 'x778', openid: 'oid-card', role: 'parent', name: '张珊珊', studentIds: [101] }
    });
    api.syncCall = () => { pulls++; return Promise.resolve({ ok: true, docs: [], cursor: 0, more: false }); };
    const r = await sync.joinByCard('abcd23456789', '张珊珊');
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.sid, 101);
    assert.strictEqual(dbb.real().meta.orgId, 'org-card');
    assert.strictEqual(dbb.real().meta.openid, 'oid-card');
    assert.strictEqual(inviteJoins, 0, '不该再打 inviteJoin');
    assert.ok(pulls >= 1, '加入后必须拉一次全量');
  });

  await ok('本机有数据但还没绑过任何机构 → 拒绝（LOCAL_DATA），两份数据不搅在一起', async () => {
    Object.keys(mem).forEach(k => delete mem[k]);   // 用例之间必须隔离：上一个用例留下了 org-card
    const dbb = freshDb();
    dbb.students.create({ name: '小明' });
    const api = require('../utils/api');
    const sync = require('../utils/sync');
    api.syncOn = () => true;
    let called = 0;
    api.cardClaim = () => { called++; return Promise.resolve({ ok: true }); };
    const r = await sync.joinByCard('abcd23456789', '甲');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'LOCAL_DATA');
    assert.strictEqual(called, 0, '不该打网络');
  });

  await ok('已经在 A 家、又认 B 家的卡 → 走追加，不改挂当前机构（多机构）', async () => {
    Object.keys(mem).forEach(k => delete mem[k]);
    const dbb = freshDb();
    dbb.students.create({ name: '小明' });
    dbb.patchMeta({ orgId: 'org_a', openid: 'oid-x' });
    const api = require('../utils/api');
    const sync = require('../utils/sync');
    api.syncOn = () => true;
    let pulls = 0;
    api.cardClaim = () => Promise.resolve({ ok: true, orgId: 'org_b', sid: 202, pid: 'p_abc' });
    api.syncCall = () => { pulls++; return Promise.resolve({ ok: true, docs: [], cursor: 0, more: false }); };
    const r = await sync.joinByCard('abcd23456789', '甲');
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.added, true, '这是"再加一家"');
    assert.strictEqual(dbb.real().meta.orgId, 'org_a', '不许把老师/家长从手头那家拽走');
    assert.ok(pulls >= 1, 'B 家的数据要拉进本机（按 orgId 隔离，不会和 A 家混）');
    assert.strictEqual(r.pid, 'p_abc', '平台身份要带回去，家长端靠它把两家并成一页');
  });

  console.log('\nverify_invite_card: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})();
