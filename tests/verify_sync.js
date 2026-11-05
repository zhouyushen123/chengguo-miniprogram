// verify_sync.js —— 记录上云（同步引擎）守卫
// 守纯逻辑与数据层半边（合并/LWW/脏集合/游标/软删同步）；云端协议只能在真机+已部署环境验证。
const assert = require('assert');

/* ---------- 模拟 wx 存储 ---------- */
const mem = {};
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; }
};

function freshDb() {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf('utils') > -1) delete require.cache[k];
  });
  return require('../utils/db');
}

const merge = require('../utils/syncmerge');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// ---------- 纯函数：LWW ----------
t('pickWinner：远的更新则取远端，本地的更新则守本地，平局取远端', () => {
  assert.strictEqual(merge.pickWinner({ id: 1, v: 'l', updatedAt: 10 }, { id: 1, v: 'r', updatedAt: 20 }).v, 'r');
  assert.strictEqual(merge.pickWinner({ id: 1, v: 'l', updatedAt: 30 }, { id: 1, v: 'r', updatedAt: 20 }).v, 'l');
  assert.strictEqual(merge.pickWinner({ id: 1, v: 'l', updatedAt: 20 }, { id: 1, v: 'r', updatedAt: 20 }).v, 'r');
  assert.strictEqual(merge.pickWinner(null, { id: 9 }).id, 9);
  assert.strictEqual(merge.pickWinner({ id: 8 }, null).id, 8);
});

t('mergeList：新增/覆盖/保留旧值/不重复，且不改入参', () => {
  const local = [{ id: 1, name: '旧', updatedAt: 10 }, { id: 2, name: '本地较新', updatedAt: 99 }];
  const remote = [{ id: 1, name: '新', updatedAt: 20 }, { id: 2, name: '云端较旧', updatedAt: 5 }, { id: 3, name: '新增', updatedAt: 7 }];
  const out = merge.mergeList(local, remote);
  assert.strictEqual(out.added, 1);
  assert.strictEqual(out.updated, 1);
  assert.strictEqual(out.list.length, 3);
  assert.strictEqual(out.list.find(x => x.id === 1).name, '新');
  assert.strictEqual(out.list.find(x => x.id === 2).name, '本地较新');
  assert.strictEqual(local.length, 2, '入参不能被改（回滚快照还指望它）');
  assert.strictEqual(local[0].name, '旧');
});

t('mergeList：软删除作为普通字段同步（removed 会被远端覆盖）', () => {
  const out = merge.mergeList([{ id: 1, name: 'A', removed: false, updatedAt: 10 }],
    [{ id: 1, name: 'A', removed: true, updatedAt: 20 }]);
  assert.strictEqual(out.list[0].removed, true);
  assert.strictEqual(out.updated, 1);
});

t('chunk：按 50 切包，空数组不产生包', () => {
  assert.strictEqual(merge.chunk([], 50).length, 0);
  assert.strictEqual(merge.chunk(new Array(120).fill(0), 50).length, 3);
  assert.strictEqual(merge.chunk(new Array(120).fill(0), 50)[2].length, 20);
});

t('cursorOf：取最大 srvAt，只增不减', () => {
  const docs = [{ c: 'records', d: { id: 1 }, srvAt: 100 }, { c: 'records', d: { id: 2 }, srvAt: 300 }];
  assert.strictEqual(merge.cursorOf(docs, 0), 300);
  assert.strictEqual(merge.cursorOf(docs, 500), 500, '游标不能倒退');
});

// ---------- 数据层半边：脏集合 / 快照 / 合并 ----------
t('脏集合：一次真实写入被记下，clearDirty 后清空', () => {
  for (const k in mem) delete mem[k];
  const db = freshDb();
  db.init();
  db.sync.clearDirty(db.sync.COLLS);
  assert.deepStrictEqual(db.sync.dirtyCols(), []);
  db.classes.create({ name: '同步班' });
  assert.ok(db.sync.dirtyCols().indexOf('classes') > -1, '写班级后 classes 应变脏');
  db.sync.clearDirty(['classes']);
  assert.deepStrictEqual(db.sync.dirtyCols(), []);
});

t('脏集合：演示模式的写入不算本地改动', () => {
  const db = freshDb();
  db.init();
  db.sync.clearDirty(db.sync.COLLS);
  const r = db.demo.enter();
  assert.ok(r.ok, r.msg);
  assert.deepStrictEqual(db.sync.dirtyCols(), [], '演示数据不该触发同步');
  db.demo.exit();
});

t('snapshot：只推本机构文档，且软删的也要带上', () => {
  const db = freshDb();
  db.init();
  const c = db.classes.create({ name: '要删的班' }).item;
  const c2 = db.classes.create({ name: '留着的班' }).item;
  db.classes.remove(c.id);
  const docs = db.sync.snapshot(['classes']).filter(x => x.c === 'classes');
  const ids = docs.map(x => x.d.id);
  assert.ok(ids.indexOf(c2.id) > -1, '正常班级要推');
  assert.ok(ids.indexOf(c.id) > -1, '软删的班级也要推（否则云端以为它还在）');
  assert.ok(docs.every(x => String(x.d.orgId || db.real().meta.orgId) === String(db.real().meta.orgId)));
});

t('applyRemote：远端较新覆盖，本地较新保留，合并期间不产生脏标记', () => {
  const db = freshDb();
  db.init();
  const s = db.students.create({ name: '甲' }).item;
  db.students.update(s.id, { name: '本地新名字' });
  db.sync.clearDirty(db.sync.COLLS);

  const remoteOlder = { c: 'students', srvAt: 1, d: Object.assign({}, s, { name: '云端旧名字', updatedAt: 1 }) };
  const st1 = db.sync.applyRemote([remoteOlder]);
  assert.strictEqual(st1.updated, 0, '云端更旧不能覆盖本地');

  const remoteNewer = { c: 'students', srvAt: 2, d: Object.assign({}, s, { name: '云端新名字', updatedAt: Date.now() + 10000 }) };
  const st2 = db.sync.applyRemote([remoteNewer]);
  assert.strictEqual(st2.updated, 1, '云端更新应覆盖');
  assert.strictEqual(db.students.get(s.id).name, '云端新名字');

  assert.deepStrictEqual(db.sync.dirtyCols(), [], '拉取合并不能把自己标记成待推送');
});

t('applyRemote：未知集合/坏条目被忽略，不炸', () => {
  const db = freshDb();
  db.init();
  const st = db.sync.applyRemote([{ c: 'nope', d: { id: 1 } }, null, { c: 'records' }]);
  assert.strictEqual(st.added + st.updated, 0);
});

t('游标：setCursor 落 meta，重启后还在（脏标记同理）', () => {
  const db = freshDb();
  db.init();
  db.sync.setCursor(12345);
  db.sync.markDirty('records');
  const db2 = freshDb();
  db2.init();
  assert.strictEqual(db2.sync.cursor(), 12345, '游标要能跨重启');
  assert.ok(db2.sync.dirtyCols().indexOf('records') > -1, '脏标记要能跨重启，否则杀进程就漏推');
});

t('markAllDirty：首次上云把全部集合标脏', () => {
  const db = freshDb();
  db.init();
  db.sync.clearDirty(db.sync.COLLS);
  db.sync.markAllDirty();
  assert.deepStrictEqual(db.sync.dirtyCols().slice().sort(), db.sync.COLLS.slice().sort());
});

t('门面完整：同步能力都挂在 db.sync 上（页面不得自己拼协议）', () => {
  const db = freshDb();
  ['dirtyCols', 'snapshot', 'applyRemote', 'markAllDirty', 'clearDirty', 'cursor', 'setCursor'].forEach(k => {
    assert.strictEqual(typeof db.sync[k], 'function', 'db.sync.' + k + ' 缺失');
  });
});

// ---------- 多机构：机构号换代（reorg） ----------
// 背景：出厂号 org1 是所有新装设备共用的，不能当真实机构号。首次上云时服务端发一个新号，
// 客户端把本机全部数据整体改挂过去。这一段守的就是"改挂不许丢、不许漏、不许把演示数据带进去"。
t('机构号：格式规整、随机不重复、能认出出厂号', () => {
  const schema = require('../utils/db/schema');
  const seen = {};
  for (let i = 0; i < 200; i++) {
    const id = schema.newOrgId();
    assert.ok(/^org_[a-z2-9]{10}$/.test(id), '格式不对：' + id);
    assert.ok(!/[0o1li]/.test(id.slice(4)), '不该出现易混字符：' + id);
    assert.ok(!seen[id], '机构号撞了：' + id);
    seen[id] = 1;
  }
  assert.ok(schema.isFactoryOrg('org1'));
  assert.ok(!schema.isFactoryOrg('org_abcdefghjk'));
  assert.ok(!schema.isFactoryOrg(''));
});

t('reorg：本机所有集合整体改挂到新机构号', () => {
  for (const k in mem) delete mem[k];
  const db = freshDb();
  db.init();
  const c = db.classes.create({ name: '改挂班' }).item;
  const s = db.students.create({ name: '小朋友', clsIds: [c.id] }).item;
  db.records.save({ sid: s.id, cid: c.id, note: '一条记录' });

  const before = { cls: db.classes.list().length, stu: db.students.list().length, rec: db.records.list().length };
  const newId = 'org_abcdefghjk';
  const r = db.sync.reorg(newId);
  assert.ok(r.ok, r.msg);
  assert.ok(r.moved >= 3, '至少班级/学生/记录各一条被改挂，实际 ' + r.moved);

  // 读取口径（orgColl 按 meta.orgId 过滤）：改挂后原来的数据必须仍然看得见
  assert.strictEqual(db.real().meta.orgId, newId);
  assert.strictEqual(db.classes.list().length, before.cls, '班级改挂后不见了');
  assert.strictEqual(db.students.list().length, before.stu, '学生改挂后不见了');
  assert.strictEqual(db.records.list().length, before.rec, '记录改挂后不见了');
});

t('reorg：机构表主键也跟着改（id 与 orgId 同为机构号）', () => {
  const db = freshDb();
  db.init();
  db.sync.reorg('org_zzzzzzzzzz');
  const o = db.orgs.current();
  assert.ok(o, '机构表里找不到当前机构');
  assert.strictEqual(o.id, 'org_zzzzzzzzzz');
  assert.strictEqual(o.orgId, 'org_zzzzzzzzzz');
});

t('reorg：改完把所有集合都标脏（下一步要全量推上去）', () => {
  const db = freshDb();
  db.init();
  db.sync.clearDirty(db.sync.COLLS);
  db.sync.reorg('org_qqqqqqqqqq');
  const dirty = db.sync.dirtyCols();
  db.sync.COLLS.forEach(c => assert.ok(dirty.indexOf(c) > -1, c + ' 没标脏，推不上去'));
});

t('reorg：落盘了（下次启动不会又回到出厂号）', () => {
  const db = freshDb();
  db.init();
  db.sync.reorg('org_kkkkkkkkkk');
  const again = freshDb();   // 重新加载（读的是同一份模拟存储）
  again.init();
  assert.strictEqual(again.real().meta.orgId, 'org_kkkkkkkkkk');
});

t('reorg：幂等 —— 同一个号再改一次不动任何数据', () => {
  const db = freshDb();
  db.init();
  db.classes.create({ name: '幂等班' });
  db.sync.reorg('org_wwwwwwwwww');
  const second = db.sync.reorg('org_wwwwwwwwww');
  assert.ok(second.ok);
  assert.strictEqual(second.moved, 0, '第二次不该再有数据被改');
});

t('reorg：空号直接拒绝（否则数据会挂到一个不存在的机构上）', () => {
  const db = freshDb();
  db.init();
  const r = db.sync.reorg('');
  assert.strictEqual(r.ok, false);
  assert.ok(r.msg);
});

t('reorg：演示模式下拒绝（样板间不能改机构号）', () => {
  const db = freshDb();
  db.init();
  db.demo.enter();
  const r = db.sync.reorg('org_dddddddddd');
  assert.strictEqual(r.ok, false);
  db.demo.exit();
});

t('init：服务端发号（minted）→ 本机整体改挂，不是冲突', async () => {
  for (const k in mem) delete mem[k];
  const db = freshDb();
  db.init();
  const c = db.classes.create({ name: '首次上云班' }).item;
  db.students.create({ name: '第一个孩子', clsIds: [c.id] });

  const api = require('../utils/api');
  api.syncOn = () => true;
  api.syncCall = action => {
    if (action === 'hello') return Promise.resolve({ ok: true, orgId: 'org_mintmintmi', firstTime: true, minted: true, openid: 'openid-x' });
    return Promise.reject(new Error('STOP'));
  };
  const sync = require('../utils/sync');
  const r = await sync.init();
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.minted, true);
  assert.strictEqual(db.real().meta.orgId, 'org_mintmintmi', '本机机构号要换成服务端发的号');
  assert.strictEqual(db.classes.list().length, 1, '改挂后班级必须还看得见');
  assert.strictEqual(db.students.list().length, 1, '改挂后学生必须还看得见');
  assert.strictEqual(sync.isConflict(), false, '发号不是冲突');
});

t('init：云端已是别人的号 + 本机有数据 → 冲突并停手（绝不自动合并）', async () => {
  for (const k in mem) delete mem[k];
  const db = freshDb();
  db.init();
  const c = db.classes.create({ name: '本机班' }).item;
  db.students.create({ name: '本机孩子', clsIds: [c.id] });

  const api = require('../utils/api');
  api.syncOn = () => true;
  api.syncCall = action => {
    if (action === 'hello') return Promise.resolve({ ok: true, orgId: 'org_otherother', firstTime: false, openid: 'openid-x' });
    return Promise.reject(new Error('STOP'));
  };
  const sync = require('../utils/sync');
  const r = await sync.init();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'ORG_CONFLICT');
  assert.strictEqual(sync.isConflict(), true);
  // 冲突时一个字段都不能动：既不改机构号，也不清本地数据
  assert.strictEqual(db.real().meta.orgId, 'org1');
  assert.strictEqual(db.students.list().length, 1);
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + (e && e.message)); }
  }
  console.log(fail ? ('verify_sync: ' + fail + ' FAILED') : ('verify_sync: all ' + tests.length + ' passed'));
  process.exit(fail ? 1 : 0);
})();
