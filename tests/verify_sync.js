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

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + (e && e.message)); }
  }
  console.log(fail ? ('verify_sync: ' + fail + ' FAILED') : ('verify_sync: all ' + tests.length + ' passed'));
  process.exit(fail ? 1 : 0);
})();
