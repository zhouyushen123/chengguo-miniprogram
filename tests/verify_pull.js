// tests/verify_pull.js —— 云端增量拉取：分页边界绝不漏数据
//
// 这类 bug 的特点是"不报错、不崩、只是少了几条"，等老师发现时早已过了几周。
// 所以这里直接把云函数跑起来，用一个内存假库把边界情况一个个摆出来：
//   1. 同一时间戳的文档正好跨在 100 条的分页边界上 → 一条都不能漏
//   2. 一次拉不完时，游标只能停在"确定完整"的位置
//   3. push 写进去的每条文档时间戳必须不同（否则上面的边界永远会踩到）
//   4. 反复拉直到 more=false，拿到的总数必须等于全部
const path = require('path');
const fs = require('fs');
const Module = require('module');
const assert = require('assert');

/* ---------------- 内存假库 ---------------- */
const store = {};
const OPENID = 'openid-a';
const rowsOf = n => (store[n] || (store[n] = []));

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
    async count() { return { total: rowsOf(name).filter(r => match(r, cond)).length }; }
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
      async remove() { return { stats: { removed: 0 } }; }
    })
  };
}

const fake = {
  DYNAMIC_CURRENT_ENV: 'env',
  init() {},
  getWXContext: () => ({ OPENID }),
  database: () => ({
    collection,
    command: { gt: v => ({ $gt: v }), eq: v => ({ $eq: v }) },
    serverDate: () => new Date(),
    createCollection: async () => ({})
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

const syncv2 = require(path.join(__dirname, '..', 'cloudfunctions', 'syncv2', 'index.js'));

function reset() {
  Object.keys(store).forEach(k => { delete store[k]; });
  rowsOf('users').push({ _id: 'u1', _openid: OPENID, orgId: 'org1' });
}

let pass = 0;
const ok = (name, fn) => fn().then(() => { pass++; console.log('  ✓ ' + name); });

// 循环拉完，返回全部条目
async function pullAll(since) {
  let cursor = since || 0;
  const out = [];
  for (let i = 0; i < 50; i++) {
    const r = await syncv2.main({ action: 'pull', orgId: 'org1', since: cursor });
    assert.ok(r.ok, JSON.stringify(r));
    out.push.apply(out, r.docs);
    if (Number(r.cursor) > cursor) cursor = Number(r.cursor);
    if (!r.more) break;
    // 没有进展 = 死循环，直接失败
    if (!r.docs.length) throw new Error('拉取没有进展，游标卡在 ' + cursor);
  }
  return out;
}

(async () => {
  console.log('\n【增量拉取：分页边界】');

  await ok('同一时间戳正好跨在 100 条边界上：一条都不漏', async () => {
    reset();
    // 98 条同一时刻（旧版本批量写入的样子）+ 5 条更晚的
    for (let i = 0; i < 98; i++) rowsOf('records').push({ _id: 'a' + i, orgId: 'org1', id: 1000 + i, srvAt: 1000 });
    for (let i = 0; i < 5; i++) rowsOf('records').push({ _id: 'b' + i, orgId: 'org1', id: 2000 + i, srvAt: 2000 });
    // 另外还有别的集合的数据，混在一起更接近真实情况
    rowsOf('students').push({ _id: 's1', orgId: 'org1', id: 1, name: '小明', srvAt: 1500 });

    const all = await pullAll(0);
    const recIds = all.filter(x => x.c === 'records').map(x => x.d.id);
    assert.strictEqual(recIds.length, 103, '记录应一条不少，实际 ' + recIds.length);
    assert.strictEqual(new Set(recIds).size, 103, '不应有重复');
    assert.ok(all.some(x => x.c === 'students'), '别的集合也要一起拉回来');
  });

  await ok('游标只停在"确定完整"的位置（不会跳过没取完的那一组）', async () => {
    reset();
    for (let i = 0; i < 98; i++) rowsOf('records').push({ _id: 'a' + i, orgId: 'org1', id: 1000 + i, srvAt: 1000 });
    for (let i = 0; i < 5; i++) rowsOf('records').push({ _id: 'b' + i, orgId: 'org1', id: 2000 + i, srvAt: 2000 });

    const first = await syncv2.main({ action: 'pull', orgId: 'org1', since: 0 });
    assert.strictEqual(first.more, true, '应该告诉客户端还有');
    assert.ok(Number(first.cursor) <= 1000, '第一次游标不能越过 1000，实际 ' + first.cursor);
    assert.strictEqual(first.docs.filter(x => x.c === 'records').length, 98, '第一次只交完整的那一组');
  });

  await ok('150 条不同时间戳：分两轮拉完，顺序与条数都对', async () => {
    reset();
    for (let i = 0; i < 150; i++) rowsOf('records').push({ _id: 'r' + i, orgId: 'org1', id: 3000 + i, srvAt: 5000 + i });
    const all = await pullAll(0);
    const ids = all.filter(x => x.c === 'records').map(x => x.d.id).sort((a, b) => a - b);
    assert.strictEqual(ids.length, 150);
    assert.strictEqual(ids[0], 3000);
    assert.strictEqual(ids[149], 3149);
  });

  await ok('重复拉同一段不会产生重复（客户端幂等的前提）', async () => {
    reset();
    for (let i = 0; i < 10; i++) rowsOf('records').push({ _id: 'r' + i, orgId: 'org1', id: 4000 + i, srvAt: 9000 + i });
    const a = await pullAll(0);
    const b = await pullAll(0);
    assert.strictEqual(a.length, b.length);
  });

  console.log('\n【写入：时间戳必须唯一】');

  await ok('一次 push 50 条，每条 srvAt 都不同且严格递增', async () => {
    reset();
    const docs = [];
    for (let i = 0; i < 50; i++) docs.push({ c: 'records', d: { id: 5000 + i, orgId: 'org1', note: 'n' + i, updatedAt: Date.now() } });
    const r = await syncv2.main({ action: 'push', orgId: 'org1', docs });
    assert.ok(r.ok && r.accepted === 50, JSON.stringify(r));
    const at = rowsOf('records').map(x => Number(x.srvAt)).sort((a, b) => a - b);
    assert.strictEqual(at.length, 50);
    assert.strictEqual(new Set(at).size, 50, 'srvAt 有重复 → pull 分页会漏数据');
    for (let i = 1; i < at.length; i++) assert.ok(at[i] > at[i - 1], '必须严格递增');
  });

  await ok('连推两批（同一毫秒内）也不会撞号', async () => {
    reset();
    const mk = base => Array.from({ length: 50 }, (_, i) => ({ c: 'records', d: { id: base + i, orgId: 'org1', updatedAt: Date.now() } }));
    await syncv2.main({ action: 'push', orgId: 'org1', docs: mk(6000) });
    await syncv2.main({ action: 'push', orgId: 'org1', docs: mk(6100) });
    const at = rowsOf('records').map(x => Number(x.srvAt));
    assert.strictEqual(new Set(at).size, 100, '两批之间也不能撞号，实际唯一值 ' + new Set(at).size);
  });

  await ok('推完之后立刻拉，100 条一条不少（这就是最容易丢的场景）', async () => {
    const all = await pullAll(0);
    assert.strictEqual(all.length, 100, '应拉回 100 条，实际 ' + all.length);
  });

  console.log('\n全部 ' + pass + ' 项拉取断言通过');
  fs.unlinkSync(stub);
  Module._resolveFilename = origResolve;
})().catch(e => {
  try { fs.unlinkSync(stub); } catch (x) {}
  console.error(e);
  process.exit(1);
});
