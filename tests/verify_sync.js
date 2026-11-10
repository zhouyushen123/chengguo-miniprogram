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

// ---------- LWW 冲突：败者不静默消失（架构体检 A2） ----------
t('mergeList：判负且内容真不同 → 返回败者副本；内容相同不算冲突', () => {
  const local = [{ id: 1, note: '老师B写的长评', updatedAt: 10 }];
  const out = merge.mergeList(local, [{ id: 1, note: '老师A的版本', updatedAt: 20 }]);
  assert.strictEqual(out.conflicts.length, 1, '败者要被交出来');
  assert.strictEqual(out.conflicts[0].note, '老师B写的长评');
  // 第二次同步同样内容（只是 srvAt 变了）：不再报冲突，否则每轮同步都误报
  const again = merge.mergeList(out.list, [{ id: 1, note: '老师A的版本', updatedAt: 21 }]);
  assert.strictEqual(again.conflicts.length, 0, '内容相同不算冲突');
});

t('mergeList：键序不同但内容相同不算冲突（云端回推不保证键序）', () => {
  const local = [{ id: 1, a: 1, b: 2, updatedAt: 10 }];
  const remote = [{ b: 2, a: 1, id: 1, updatedAt: 20 }];
  assert.strictEqual(merge.mergeList(local, remote).conflicts.length, 0);
});

t('applyRemote：冲突败者存进本地副本，找回后以新时间写回（能重新胜出）', () => {
  for (const k in mem) delete mem[k];
  const db = freshDb();
  db.init();
  db.classes.create({ name: '旧班名' });
  const doc = db.real().classes[0];
  // 本地版本是 3 秒前写的，云端版本 2 秒前（更新，所以 LWW 胜出），但都比"现在"早：
  // 这样「找回」用 Date.now() 写回才能真的重新胜出
  doc.updatedAt = Date.now() - 3000;
  const remote = Object.assign({}, doc, { name: '新班名', updatedAt: Date.now() - 2000 });
  const st = db.sync.applyRemote([{ c: 'classes', d: remote }]);
  assert.ok(st.ok && st.updated === 1, JSON.stringify(st));
  assert.strictEqual(db.real().classes[0].name, '新班名', 'LWW：新版本落盘');
  const cl = db.sync.conflicts();
  assert.strictEqual(cl.length, 1, '败者副本要留下');
  assert.strictEqual(cl[0].loser.name, '旧班名');
  assert.strictEqual(cl[0].c, 'classes');
  // 找回：旧班名以「现在」的时间戳写回，下一轮推送重新参战
  const res = db.sync.restoreConflict(0);
  assert.ok(res.ok, JSON.stringify(res));
  assert.strictEqual(db.real().classes[0].name, '旧班名');
  assert.ok(db.real().classes[0].updatedAt > remote.updatedAt, '找回后必须比云端版本新');
  assert.ok(db.sync.dirtyCols().indexOf('classes') > -1, '找回等于一次本地写，要标脏重推');
  db.sync.clearConflicts();
  assert.strictEqual(db.sync.conflicts().length, 0);
});

// ---------- 我的范围变了：游标归零重拉（架构体检 A1 客户端半边） ----------
t('applyRemote：工牌被远端改了范围（新分班）→ 机构进 rescoped 队列', () => {
  for (const k in mem) delete mem[k];
  const db = freshDb();
  db.init();
  db.patchMeta({ orgId: 'orgX', openid: 'oX' });
  db.sync.applyRemote([{ c: 'members', d: { id: 11, orgId: 'orgX', openid: 'oX', role: 'teacher', clsIds: [1], updatedAt: 10 } }]);
  assert.deepStrictEqual(db.sync.rescoped(), [], '首次拉到工牌（新增）不算范围变化');
  db.sync.applyRemote([{ c: 'members', d: { id: 11, orgId: 'orgX', openid: 'oX', role: 'teacher', clsIds: [1, 2], updatedAt: 20 } }]);
  assert.deepStrictEqual(db.sync.rescoped(), ['orgX'], 'clsIds 变化要记机构');
  // 同名/改名这类不影响范围的变化不能误报
  db.sync.clearRescoped('orgX');
  db.sync.applyRemote([{ c: 'members', d: { id: 11, orgId: 'orgX', openid: 'oX', role: 'teacher', clsIds: [1, 2], name: '张三', updatedAt: 30 } }]);
  assert.deepStrictEqual(db.sync.rescoped(), [], '改名字不算范围变化');
});

t('pullNow：新分班 → 游标归零并自动重拉一轮，新班的历史补得回来', async () => {
  for (const k in mem) delete mem[k];
  const db = freshDb();
  db.init();
  db.patchMeta({ orgId: 'orgX', openid: 'oX' });
  // 先铺底：本地已有一张只带 1 班的工牌（上一轮同步拉到的）
  db.sync.applyRemote([{ c: 'members', d: { id: 11, orgId: 'orgX', openid: 'oX', role: 'teacher', clsIds: [1], updatedAt: 10 } }]);
  db.sync.setCursor(0, 'orgX');
  const api = require('../utils/api');
  api.syncOn = () => true;
  let call = 0;
  const mV2 = { c: 'members', d: { id: 11, orgId: 'orgX', openid: 'oX', role: 'teacher', clsIds: [1, 2], name: '老师', updatedAt: 20 }, srvAt: 110 };
  const rec = { c: 'records', d: { id: 1, orgId: 'orgX', cid: 2, sid: 1, note: '新班的历史记录', updatedAt: 30 }, srvAt: 150 };
  api.syncCall = (action) => {
    if (action !== 'pull') return Promise.resolve({ ok: true });
    call++;
    // 每次都返回：被分了 2 班 + 新班的历史（历史数据的 srvAt 早就过去，只有归零重拉才拿得到）
    return Promise.resolve({ ok: true, more: false, cursor: 100, docs: [mV2, rec] });
  };
  const sync = require('../utils/sync');
  const r = await sync.pullNow('orgX');
  assert.ok(r.more === false);
  // 第 1 次拉到范围变化 → 游标归零 → 第 2 次重拉。没有重拉的话新班历史永远拉不到。
  assert.strictEqual(call, 2, '应自动重拉一轮，实际调用 ' + call + ' 次');
  assert.deepStrictEqual(db.sync.rescoped(), [], '重拉完成后标记要消费掉');
  assert.ok(db.sync.cursor('orgX') >= 150, '游标推进到重拉后的最新位置');
  assert.ok((db.real().records || []).some(x => x.note === '新班的历史记录'), '新班的历史记录要进本机');
});

// ---------- 重置纪元：机构被云端整体重置 → 本机这一家作废重拉（resetOrg 客户端半边） ----------
t('applyRemote：第一次见到 epoch 只登记不动数据；变了才作废', () => {
  for (const k in mem) delete mem[k];
  const db = freshDb();
  db.init();
  db.patchMeta({ orgId: 'orgX', openid: 'oX' });
  // 本地数据与 epoch 都是上一轮 pull 拉下来的（不绕登录闸，直接走同步通道铺底）
  db.sync.applyRemote([{ c: 'orgs', d: { id: 'orgX', orgId: 'orgX', name: '机构', epoch: 3, updatedAt: 10 } }]);
  db.sync.applyRemote([{ c: 'students', d: { id: 9, orgId: 'orgX', name: '试用孩子', updatedAt: 15 } }]);
  assert.ok((db.real().students || []).some(s => s.name === '试用孩子'), '铺底：本地有试用数据');
  db.sync.setCursor(500, 'orgX');
  assert.strictEqual(db.sync.epochs()['orgX'], 3, 'epoch 已登记');
  assert.strictEqual(db.sync.cursor('orgX'), 500, '首次登记不动游标');
  assert.deepStrictEqual(db.sync.rescoped(), [], '首次登记不触发重拉');
  // epoch 变了：本机这一家全部作废（旧试用数据不能继续冒充真实数据）
  db.sync.applyRemote([{ c: 'orgs', d: { id: 'orgX', orgId: 'orgX', name: '机构', epoch: 4, updatedAt: 20 } }]);
  assert.strictEqual((db.real().students || []).filter(s => String(s.orgId) === 'orgX').length, 0, '这一家的学生要清掉');
  assert.strictEqual(db.sync.cursor('orgX'), 0, '游标归零');
  assert.deepStrictEqual(db.sync.rescoped(), ['orgX'], '要走重拉路径');
  assert.strictEqual(db.sync.epochs()['orgX'], 4);
});

t('applyRemote：orgX 被重置不影响 orgY（多机构互不牵连）', () => {
  for (const k in mem) delete mem[k];
  const db = freshDb();
  db.init();
  db.patchMeta({ orgId: 'orgX', openid: 'oX' });
  // 两家各登记过 epoch，各有学生
  ['orgX', 'orgY'].forEach(o => {
    db.sync.applyRemote([{ c: 'orgs', d: { id: o, orgId: o, name: '机构' + o, epoch: 1, updatedAt: 10 } }]);
    db.sync.applyRemote([{ c: 'students', d: { id: o === 'orgX' ? 1 : 2, orgId: o, name: '孩子' + o, updatedAt: 15 } }]);
  });
  // orgX 重置（epoch 2）
  db.sync.applyRemote([{ c: 'orgs', d: { id: 'orgX', orgId: 'orgX', name: '机构orgX', epoch: 2, updatedAt: 20 } }]);
  const left = (db.real().students || []).map(s => String(s.orgId));
  assert.ok(left.indexOf('orgX') < 0, 'orgX 的学生要清掉');
  assert.ok(left.indexOf('orgY') > -1, 'orgY 的学生必须还在');
});

t('pullNow：纪元变化 → 本机作废并自动重拉一轮（其他设备视角）', async () => {
  for (const k in mem) delete mem[k];
  const db = freshDb();
  db.init();
  db.patchMeta({ orgId: 'orgX', openid: 'oX' });
  // 铺底：本地已有旧数据 + 已登记 epoch=1 + 游标已推进
  db.sync.applyRemote([{ c: 'orgs', d: { id: 'orgX', orgId: 'orgX', name: '机构', epoch: 1, updatedAt: 10 } }]);
  db.sync.applyRemote([{ c: 'students', d: { id: 9, orgId: 'orgX', name: '旧试用孩子', updatedAt: 15 } }]);
  db.sync.setCursor(500, 'orgX');
  db.sync.clearRescoped('orgX');
  const api = require('../utils/api');
  api.syncOn = () => true;
  let call = 0;
  api.syncCall = (action) => {
    if (action !== 'pull') return Promise.resolve({ ok: true });
    call++;
    // 第 1 次：只带回带着新纪元的 orgs 文档（这一刻旧数据全部作废）
    if (call === 1) return Promise.resolve({
      ok: true, more: false, cursor: 600,
      docs: [{ c: 'orgs', d: { id: 'orgX', orgId: 'orgX', name: '机构', epoch: 2, updatedAt: 600 }, srvAt: 600 }]
    });
    // 第 2 次（归零重拉）：重置后新录的数据
    return Promise.resolve({
      ok: true, more: false, cursor: 700,
      docs: [{ c: 'students', d: { id: 20, orgId: 'orgX', name: '重置后的新孩子', updatedAt: 700 }, srvAt: 700 }]
    });
  };
  const sync = require('../utils/sync');
  const r = await sync.pullNow('orgX');
  assert.ok(r.more === false);
  assert.strictEqual(call, 2, '纪元变化要自动重拉一轮，实际调用 ' + call + ' 次');
  assert.strictEqual((db.real().students || []).filter(s => s.name === '旧试用孩子').length, 0, '旧试用数据必须清掉');
  assert.ok((db.real().students || []).some(s => s.name === '重置后的新孩子'), '重置后的新数据要拉回来');
  assert.deepStrictEqual(db.sync.rescoped(), [], '重拉完成后标记要消费掉');
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
