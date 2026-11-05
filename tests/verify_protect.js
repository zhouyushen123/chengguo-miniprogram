// tests/verify_protect.js —— 数据保护机制
//
// 这里测的不是"能不能用"，是"机制在出事时到底拦不拦得住"：
//   A. 本地：删除是可逆的（回收站按删除批次还原），不误复活别的删除
//   B. 云端：核心资产的硬约束（学号不重、一个微信一条成员、机构不可删、一个负责人）
//   C. 云端：覆盖前留旧版，可回滚；只留最近 10 版；记录不留历史（海量数据）
const path = require('path');
const fs = require('fs');
const Module = require('module');
const assert = require('assert');

/* =====================================================================
 * A. 本地：回收站
 * ===================================================================*/
const mem = {};
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem), currentSize: 1, limitSize: 10240 }),
  showToast: () => {}, showModal: () => {}, navigateTo: () => {}
};
global.getApp = () => ({ globalData: {} });

const seed = require('./fixture').richSeed();
Object.keys(seed).forEach(k => { mem[k] = seed[k]; });

const db = require('../utils/db');
db.init();

let pass = 0;
// 同步用例直接跑；异步用例必须等它跑完再记通过（否则全都在并发抢同一份内存库）
const ok = async (name, fn) => {
  const r = fn();
  if (r && typeof r.then === 'function') await r;
  pass++;
  console.log('  ✓ ' + name);
};
const raw = (coll, id) => db.coll(coll).find(x => x.id === id);

console.log('\n【回收站：一批删除整批还原】');

// 找一个带记录的学生当小白鼠
const victim = db.students.list().find(s => db.coll('records').some(r => r.sid === s.id && !r.removed));
assert.ok(victim, '铺底数据里要有一个带记录的学生');
const victimRecs = db.coll('records').filter(r => r.sid === victim.id && !r.removed).map(r => r.id);

ok('删学生时，连带删掉的记录共用同一个 removedAt（还原靠它认批）', () => {
  const r = db.students.remove(victim.id);
  assert.ok(r.ok, JSON.stringify(r));
  const s = raw('students', victim.id);
  assert.strictEqual(s.removed, true);
  assert.ok(s.removedAt > 0, '应有删除时间');
  assert.ok(s.removedBy > 0, '应记下是谁删的');
  victimRecs.forEach(id => {
    assert.strictEqual(raw('records', id).removedAt, s.removedAt, '同一次删除必须同一批');
  });
});

ok('回收站能列出来，并写清连带影响', () => {
  const t = db.trash.list('students');
  assert.ok(t.ok, JSON.stringify(t));
  const hit = t.items.find(x => x.id === victim.id);
  assert.ok(hit, '删掉的学生要出现在回收站');
  assert.ok(hit.sub.indexOf('连带') > -1, '要说明会带走几条记录，实际：' + hit.sub);
  assert.ok(hit.by, '要显示是谁删的');
});

ok('还原学生：学生、记录、报名一起回来', () => {
  const before = db.coll('enrollments').filter(e => e.studentId === victim.id && e.removed).map(e => e.id);
  const r = db.students.restore(victim.id);
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(raw('students', victim.id).removed, false);
  assert.strictEqual(raw('students', victim.id).removedAt, 0, 'removedAt 要清 0，否则下次删除会和旧批次串起来');
  victimRecs.forEach(id => assert.strictEqual(raw('records', id).removed, false));
  before.forEach(id => assert.strictEqual(raw('enrollments', id).removed, false));
  assert.ok(!db.trash.list('students').items.some(x => x.id === victim.id), '还原后不该还在回收站');
});

ok('还原不会顺手复活"删之前就已经删掉"的记录', () => {
  const s2 = db.students.list().find(x => db.coll('records').filter(r => r.sid === x.id && !r.removed).length >= 2);
  assert.ok(s2, '需要一个有两条记录的学生');
  const [oldRec, keepRec] = db.coll('records').filter(r => r.sid === s2.id && !r.removed).map(r => r.id);
  db.records.remove(oldRec);                      // 先单独删一条
  const oldAt = raw('records', oldRec).removedAt;
  db.students.remove(s2.id);                      // 再删学生（批次不同）
  assert.notStrictEqual(raw('records', keepRec).removedAt, oldAt);
  db.students.restore(s2.id);
  assert.strictEqual(raw('records', keepRec).removed, false, '本批的要回来');
  assert.strictEqual(raw('records', oldRec).removed, true, '上一批删掉的不能跟着复活');
});

ok('删班级记下被摘掉的名单，还原后学生回班', () => {
  const cls = db.classes.list().find(c => db.coll('students').some(s => (s.clsIds || []).indexOf(c.id) > -1 && !s.removed));
  assert.ok(cls, '需要一个有学生的班级');
  const kids = db.coll('students').filter(s => (s.clsIds || []).indexOf(cls.id) > -1).map(s => s.id);
  db.classes.remove(cls.id);
  assert.deepStrictEqual(raw('classes', cls.id).detached.students.slice().sort(), kids.slice().sort(),
    '要把从哪些学生身上摘下来记清楚');
  kids.forEach(id => assert.strictEqual((raw('students', id).clsIds || []).indexOf(cls.id), -1, '删班时学生应被摘掉'));
  const r = db.classes.restore(cls.id);
  assert.ok(r.ok, JSON.stringify(r));
  kids.forEach(id => assert.ok((raw('students', id).clsIds || []).indexOf(cls.id) > -1, '还原后学生要回班'));
});

ok('成员可从回收站还原；同一微信已被别人占用时拒绝', () => {
  const t = db.members.list().find(m => m.role === 'teacher');
  if (t) {
    assert.ok(db.members.remove(t.id).ok);
    assert.ok(db.members.restore(t.id).ok);
    assert.strictEqual(raw('members', t.id).removed, false);
  }
  const ms = db.members.list().filter(m => m.role !== 'parent');
  if (ms.length >= 2) {
    ms[0].openid = 'oid-shared';
    ms[1].openid = 'oid-shared';
    db.members.remove(ms[1].id);
    const r = db.members.restore(ms[1].id);
    assert.strictEqual(r.ok, false, '同一微信两条成员会让权限判定不确定，必须拒绝');
    assert.ok(/已经是/.test(r.msg), '要说明原因，实际：' + r.msg);
  }
});

ok('家长看不到回收站（里面是别人家孩子的姓名与评语）', () => {
  const p = db.members.list().find(m => m.role === 'parent');
  if (p) {
    p.openid = 'oid-parent-x';
    db.real().meta.openid = 'oid-parent-x';
    const r = db.trash.list();
    assert.strictEqual(r.ok, false);
    db.real().meta.openid = '';
  }
});

/* =====================================================================
 * B/C. 云端：硬约束、版本历史、回滚
 * ===================================================================*/
const store = {};
let OPENID = 'openid-boss';     // 可切换：验证换个身份就看不到
const rowsOf = n => (store[n] || (store[n] = []));

function match(row, cond) {
  return Object.keys(cond || {}).every(k => {
    const c = cond[k];
    if (c && typeof c === 'object' && '$gt' in c) return Number(row[k] || 0) > c.$gt;
    return row[k] === c;
  });
}
function query(name, cond) {
  const q = {
    _skip: 0, _limit: 100, _order: null,
    skip(n) { q._skip = n; return q; },
    limit(n) { q._limit = n; return q; },
    orderBy(k, d) { q._order = [k, d]; return q; },
    async get() {
      let list = rowsOf(name).filter(r => match(r, cond));
      if (q._order) {
        const [k, d] = q._order;
        list = list.slice().sort((a, b) => (d === 'desc' ? (b[k] - a[k]) : (a[k] - b[k])));
      }
      return { data: list.slice(q._skip, q._skip + q._limit).map(r => JSON.parse(JSON.stringify(r))) };
    },
    async count() { return { total: rowsOf(name).filter(r => match(r, cond)).length }; }
  };
  return q;
}
function collection(name) {
  return {
    where: c => query(name, c),
    limit: n => query(name, {}).limit(n),
    orderBy: (k, d) => query(name, {}).orderBy(k, d),
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
        return { data: r };
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
        const rows = rowsOf(name);
        const i = rows.findIndex(x => x._id === id);
        if (i > -1) rows.splice(i, 1);
        return { stats: { removed: i > -1 ? 1 : 0 } };
      }
    })
  };
}

const fake = {
  DYNAMIC_CURRENT_ENV: 'env',
  init() {},
  getWXContext: () => ({ OPENID }),
  database: () => ({
    collection, command: { gt: v => ({ $gt: v }) },
    serverDate: () => new Date(), createCollection: async () => ({})
  })
};
const stub = path.join(__dirname, '..', '.fake-wx-sdk.js');
fs.writeFileSync(stub, 'module.exports = global.__WX_SDK__;');
global.__WX_SDK__ = fake;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'wx-server-sdk') return stub;
  return origResolve.call(this, req, ...rest);
};

const sv = require(path.join(__dirname, '..', 'cloudfunctions', 'syncv2', 'index.js'));

function resetCloud() {
  Object.keys(store).forEach(k => { delete store[k]; });
  rowsOf('users').push({ _id: 'u1', _openid: OPENID, orgId: 'org1' });
  rowsOf('members').push({ _id: 'm1', orgId: 'org1', id: 1, openid: OPENID, role: 'owner', name: '老板', removed: false, srvAt: 1 });
}
const push = docs => sv.main({ action: 'push', orgId: 'org1', docs });
const all = async (name, cond) => (await query(name, cond || {}).limit(500).get()).data;

(async () => {
  console.log('\n【云端硬约束：核心资产不能被改成不一致】');

  await ok('学号重复：拒绝，并且不改云端已有的那条', async () => {
    resetCloud();
    rowsOf('students').push({ _id: 's1', orgId: 'org1', id: 11, no: '1001', name: '小明', removed: false, updatedAt: 1, srvAt: 1 });
    const r = await push([{ c: 'students', d: { id: 12, orgId: 'org1', no: '1001', name: '小红', updatedAt: 5 } }]);
    assert.ok(r.ok);
    assert.strictEqual(r.accepted, 0, '应被拒');
    assert.strictEqual(r.rejected.length, 1);
    assert.strictEqual(r.rejected[0].code, 'DUP_NO');
    assert.ok(/小明/.test(r.rejected[0].msg), '要指出被谁占用：' + r.rejected[0].msg);
    assert.strictEqual((await all('students', { id: 12 })).length, 0, '不能写进去');
  });

  await ok('学号重复的判定排除已删除的学生（回收站里的不该挡路）', async () => {
    resetCloud();
    rowsOf('students').push({ _id: 's1', orgId: 'org1', id: 11, no: '1001', removed: true, updatedAt: 1, srvAt: 1 });
    const r = await push([{ c: 'students', d: { id: 12, orgId: 'org1', no: '1001', name: '小红', updatedAt: 5 } }]);
    assert.strictEqual(r.accepted, 1, JSON.stringify(r));
  });

  await ok('同一个微信第二条成员：拒绝', async () => {
    resetCloud();
    rowsOf('members').push({ _id: 'm2', orgId: 'org1', id: 9, openid: 'oid-x', role: 'teacher', name: '张老师', removed: false, srvAt: 2 });
    const r = await push([{ c: 'members', d: { id: 10, orgId: 'org1', openid: 'oid-x', role: 'teacher', name: '李老师', updatedAt: 9 } }]);
    assert.strictEqual(r.rejected.length, 1, JSON.stringify(r));
    assert.strictEqual(r.rejected[0].code, 'MEM_TAKEN');
  });

  await ok('机构档案不能删（删了学生和老师就全成孤儿）', async () => {
    resetCloud();
    rowsOf('orgs').push({ _id: 'o1', orgId: 'org1', id: 'org1', name: '我的机构', removed: false, updatedAt: 1, srvAt: 1 });
    const r = await push([{ c: 'orgs', d: { id: 'org1', orgId: 'org1', name: '我的机构', removed: true, updatedAt: 9 } }]);
    assert.strictEqual(r.rejected[0].code, 'ORG_ROOT', JSON.stringify(r));
    assert.strictEqual((await all('orgs'))[0].removed, false);
  });

  await ok('一个机构只能有一个负责人', async () => {
    resetCloud();
    const r = await push([{ c: 'members', d: { id: 5, orgId: 'org1', openid: 'oid-y', role: 'owner', name: '另一个老板', updatedAt: 9 } }]);
    assert.strictEqual(r.rejected[0].code, 'OWNER_EXISTS', JSON.stringify(r));
  });

  console.log('\n【云端版本历史：改之前长什么样留得住】');

  await ok('覆盖核心资产前留一版旧值，内容是改之前的样子', async () => {
    resetCloud();
    rowsOf('students').push({ _id: 's1', orgId: 'org1', id: 21, no: '2001', name: '原名', parent: '妈妈', removed: false, updatedAt: 1, srvAt: 1 });
    await push([{ c: 'students', d: { id: 21, orgId: 'org1', no: '2001', name: '新名', parent: '妈妈', updatedAt: 9 } }]);
    const h = await all('history');
    assert.strictEqual(h.length, 1, '应留一版');
    assert.strictEqual(h[0].c, 'students');
    assert.strictEqual(h[0].doc.name, '原名', '留的必须是旧值');
    assert.strictEqual(h[0].by, OPENID, '要记下是谁改的');
  });

  await ok('只是同步了一下（内容没变）不留历史，否则历史会被无意义刷新挤满', async () => {
    resetCloud();
    rowsOf('students').push({ _id: 's1', orgId: 'org1', id: 22, no: '2002', name: '小明', removed: false, updatedAt: 1, srvAt: 1 });
    await push([{ c: 'students', d: { id: 22, orgId: 'org1', no: '2002', name: '小明', updatedAt: 99 } }]);
    assert.strictEqual((await all('history')).length, 0, '内容相同不该留历史');
  });

  await ok('记录不留历史（海量增长，留了会把库撑爆）', async () => {
    resetCloud();
    rowsOf('records').push({ _id: 'r1', orgId: 'org1', id: 31, note: '旧评语', removed: false, updatedAt: 1, srvAt: 1 });
    await push([{ c: 'records', d: { id: 31, orgId: 'org1', note: '新评语', updatedAt: 9 } }]);
    assert.strictEqual((await all('history')).length, 0);
  });

  await ok('历史只留最近 10 版', async () => {
    resetCloud();
    for (let i = 0; i < 15; i++) {
      await push([{ c: 'students', d: { id: 41, orgId: 'org1', no: '3001', name: '第' + i + '版', updatedAt: 10 + i } }]);
    }
    const h = await all('history', { c: 'students', id: 41 });
    assert.ok(h.length <= 10, '实际 ' + h.length + ' 版');
    assert.ok(h.length >= 8, '不该只剩一两版，实际 ' + h.length);
  });

  await ok('回滚：值退回去，并且把回滚前的值也留一版（滚错了能再滚回来）', async () => {
    resetCloud();
    rowsOf('students').push({ _id: 's1', orgId: 'org1', id: 51, no: '4001', name: '第一版', removed: false, updatedAt: 1, srvAt: 1 });
    await push([{ c: 'students', d: { id: 51, orgId: 'org1', no: '4001', name: '第二版', updatedAt: 9 } }]);
    const h = await all('history', { c: 'students', id: 51 });
    const at = Number(h[0].at);
    const r = await sv.main({ action: 'revert', orgId: 'org1', c: 'students', id: 51, at });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual((await all('students', { id: 51 }))[0].name, '第一版', '要退回旧值');
    const h2 = await all('history', { c: 'students', id: 51 });
    assert.ok(h2.length >= 2, '回滚前的那一版也要留，否则退错了没法回来');
    assert.ok(h2.some(x => x.doc.name === '第二版'));
  });

  await ok('家长看不到历史（里面是别的孩子的档案变动）', async () => {
    resetCloud();
    rowsOf('users').push({ _id: 'u2', _openid: 'oid-parent', orgId: 'org1' });
    rowsOf('members').push({ _id: 'm3', orgId: 'org1', id: 7, openid: 'oid-parent', role: 'parent', name: '家长', removed: false, srvAt: 2 });
    const saved = OPENID;
    OPENID = 'oid-parent';
    const r = await sv.main({ action: 'history', orgId: 'org1', c: 'students', id: 1 });
    OPENID = saved;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'FORBIDDEN');
  });

  await ok('没绑定的账号连历史都读不到', async () => {
    resetCloud();
    const saved = OPENID;
    OPENID = 'nobody';
    const r = await sv.main({ action: 'history', orgId: 'org1', c: 'students', id: 1 });
    OPENID = saved;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'NO_BIND');
  });

  console.log('\n全部 ' + pass + ' 项数据保护断言通过');
  fs.unlinkSync(stub);
  Module._resolveFilename = origResolve;
})().catch(e => {
  try { fs.unlinkSync(stub); } catch (x) {}
  console.error(e);
  process.exit(1);
});
