// tests/verify_cloudbackup.js —— 云端每日全量备份
//
// 测三件事：
//   A. 纯计算：日期、路径、分片、30 天保留、谁能操作、目标机构怎么定（越权防护）
//   B. 真的跑一遍云函数（fake wx-server-sdk + 内存云存储）：定时器备份全部机构、
//      大集合拆片、同日重复跑覆盖不堆副本、过期清理只删备份自己的东西
//   C. 恢复：只写回不删除、时间戳盖新（手机端能拉到）、家长无权、错误码明确
const path = require('path');
const fs = require('fs');
const Module = require('module');
const assert = require('assert');

let pass = 0;
const ok = async (name, fn) => {
  const r = fn();
  if (r && typeof r.then === 'function') await r;
  pass++;
  console.log('  ✓ ' + name);
};

const lib = require(path.join(__dirname, '..', 'cloudfunctions', 'backup', 'lib.js'));

console.log('\n【A. 纯计算：日期、路径、保留策略】');

ok('日期按本地时区算（早上 7 点不会算成昨天）', () => {
  const ts = new Date(2026, 10, 5, 7, 0, 0).getTime();
  assert.strictEqual(lib.ymd(ts), '2026-11-05');
  // toISOString 在 UTC+8 会给出 2026-11-04，这正是不能用它的原因
  assert.notStrictEqual(new Date(ts).toISOString().slice(0, 10), '2026-11-05');
});

ok('日期格式校验：只认 YYYY-MM-DD', () => {
  assert.ok(lib.isDate('2026-11-05'));
  assert.ok(!lib.isDate('2026-11-5'));
  assert.ok(!lib.isDate('20261105'));
  assert.ok(!lib.isDate(''));
  assert.ok(!lib.isDate(undefined));
});

ok('清单 id：一机构一天一条，同日重复跑是覆盖不是新增', () => {
  const a = lib.manifestId('org_abc', '2026-11-05');
  const b = lib.manifestId('org_abc', '2026-11-05');
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, lib.manifestId('org_xyz', '2026-11-05'));
  assert.notStrictEqual(a, lib.manifestId('org_abc', '2026-11-06'));
});

ok('存储路径按机构分目录，第 2 片起带序号', () => {
  assert.strictEqual(lib.pathOf('org_abc', '2026-11-05', 'students', 1),
    'chengguo/backup/org_abc/2026-11-05/students.json');
  assert.strictEqual(lib.pathOf('org_abc', '2026-11-05', 'students', 3),
    'chengguo/backup/org_abc/2026-11-05/students-3.json');
  assert.ok(lib.pathOf('org_abc', '2026-11-05', 'students', 1).indexOf('org_xyz') < 0);
});

ok('归档时去掉云库主键与 _openid，业务字段一个不少', () => {
  const src = { _id: 'db1', _openid: 'oid', id: 7, orgId: 'org_abc', name: '小明', removed: true, removedAt: 9, updatedAt: 5, srvAt: 6 };
  const d = lib.cleanDoc(src);
  assert.strictEqual(d._id, undefined);
  assert.strictEqual(d._openid, undefined);
  assert.strictEqual(d.id, 7);
  assert.strictEqual(d.orgId, 'org_abc');
  assert.strictEqual(d.removed, true, '软删标记要留着，否则恢复出来会多出已删的东西');
  assert.strictEqual(d.removedAt, 9);
  assert.strictEqual(src._id, 'db1', '不能改到原对象');
});

ok('每 2000 条一片，余数单独一片', () => {
  const list = Array.from({ length: 4500 }, (_, i) => i);
  const parts = lib.chunk(list, lib.PART_DOCS);
  assert.strictEqual(parts.length, 3);
  assert.strictEqual(parts[0].length, 2000);
  assert.strictEqual(parts[2].length, 500);
  assert.strictEqual(lib.chunk([], 2000).length, 0);
});

ok('保留 30 天：第 30 天留，第 31 天清，跨月跨年都对', () => {
  const rows = [
    { _id: 'a', date: '2026-11-05' },
    { _id: 'b', date: '2026-10-06' },  // 30 天前
    { _id: 'c', date: '2026-10-05' },  // 31 天前
    { _id: 'd', date: '2025-12-31' },
    { _id: 'e', date: '坏日期' }
  ];
  const dead = lib.expired(rows, '2026-11-05', 30).map(x => x._id);
  assert.deepStrictEqual(dead, ['c', 'd']);
});

ok('角色门槛：家长连备份列表都看不到，老师能看不能动', () => {
  assert.ok(lib.canRead('owner') && lib.canRead('admin') && lib.canRead('teacher'));
  assert.ok(!lib.canRead('parent') && !lib.canRead(''));
  assert.ok(lib.canWrite('owner') && lib.canWrite('admin'));
  assert.ok(!lib.canWrite('teacher'), '老师可以看备份，不该能一键回滚整个机构');
  assert.ok(!lib.canWrite('parent'));
});

ok('目标机构：有 openid 只认绑定机构，客户端传的 orgId 一律不看', () => {
  const t = lib.resolveOrg({ openid: 'oid', boundOrgId: 'org_abc', askedOrgId: 'org_xyz' });
  assert.strictEqual(t.orgId, 'org_abc');
  assert.strictEqual(t.all, false);
  assert.strictEqual(t.internal, false);
});

ok('目标机构：没有 openid（定时器/后台）才允许指定或全量', () => {
  const one = lib.resolveOrg({ askedOrgId: 'org_xyz' });
  assert.strictEqual(one.internal, true);
  assert.strictEqual(one.orgId, 'org_xyz');
  assert.strictEqual(one.all, false);
  assert.strictEqual(lib.resolveOrg({}).all, true);
});

ok('恢复写回：盖新 updatedAt + 递增 srvAt，且不带 _id', () => {
  const d = lib.restoreDoc({ _id: 'db1', id: 3, orgId: 'org_old', name: '小明', srvAt: 1, updatedAt: 1 },
    { now: 1000, srvAt: 2000, orgId: 'org_abc' });
  assert.strictEqual(d._id, undefined);
  assert.strictEqual(d.updatedAt, 1000);
  assert.strictEqual(d.srvAt, 2000);
  assert.strictEqual(d.orgId, 'org_abc', '备份被搬到别的机构时要跟着改挂');
});

/* =====================================================================
 * B / C. 真的跑一遍云函数
 * ===================================================================*/
const store = {};
const files = {};
let OPENID = '';

function rowsOf(name) {
  if (!store[name]) store[name] = [];
  return store[name];
}
function match(row, cond) {
  return Object.keys(cond || {}).every(k => row[k] === cond[k]);
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
        list = list.slice().sort((a, b) => {
          if (a[k] === b[k]) return 0;
          return (d === 'desc' ? (a[k] < b[k]) : (a[k] > b[k])) ? 1 : -1;
        });
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
    skip: n => query(name, {}).skip(n),
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
      async set({ data }) {
        const rows = rowsOf(name);
        const i = rows.findIndex(x => x._id === id);
        if (i > -1) rows[i] = Object.assign({ _id: id }, data); else rows.push(Object.assign({ _id: id }, data));
        return { _id: id };
      },
      async update({ data }) {
        const r = rowsOf(name).find(x => x._id === id);
        if (r) Object.assign(r, data);
        return { stats: { updated: r ? 1 : 0 } };
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
  database: () => ({ collection, command: { gt: v => ({ $gt: v }) }, createCollection: async () => ({}) }),
  async uploadFile({ cloudPath, fileContent }) {
    const body = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(String(fileContent), 'utf8');
    files[cloudPath] = body;
    return { fileID: 'cloud://' + cloudPath };
  },
  async downloadFile({ fileID }) {
    const p = String(fileID).replace('cloud://', '');
    if (!files[p]) throw new Error('no such file');
    return { fileContent: files[p] };
  },
  async deleteFile({ fileList }) {
    (fileList || []).forEach(id => { delete files[String(id).replace('cloud://', '')]; });
    return { fileList: (fileList || []).map(id => ({ fileID: id, status: 0 })) };
  }
};
const stub = path.join(__dirname, '..', '.fake-wx-sdk-backup.js');
fs.writeFileSync(stub, 'module.exports = global.__WX_SDK_BACKUP__;');
global.__WX_SDK_BACKUP__ = fake;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'wx-server-sdk') return stub;
  return origResolve.call(this, req, ...rest);
};

const bf = require(path.join(__dirname, '..', 'cloudfunctions', 'backup', 'index.js'));

function resetCloud() {
  Object.keys(store).forEach(k => { delete store[k]; });
  Object.keys(files).forEach(k => { delete files[k]; });
  OPENID = '';
}
function put(name, doc) {
  rowsOf(name).push(Object.assign({ _id: name + (rowsOf(name).length + 1) }, doc));
}

(async () => {
  console.log('\n【B. 定时备份：所有机构各一份，互不混】');

  await ok('没有 openid 的定时调用会备份全部机构，文件按机构分目录', async () => {
    resetCloud();
    put('orgs', { id: 'org_a', name: '甲机构' });
    put('orgs', { id: 'org_b', name: '乙机构' });
    put('students', { id: 1, orgId: 'org_a', name: '小明', updatedAt: 1, srvAt: 1 });
    put('students', { id: 2, orgId: 'org_b', name: '小红', updatedAt: 1, srvAt: 1 });
    const r = await bf.main({});
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.orgs, 2);
    const a = rowsOf('backups').find(x => x.orgId === 'org_a');
    const b = rowsOf('backups').find(x => x.orgId === 'org_b');
    assert.ok(a && b, '每个机构一条清单');
    assert.strictEqual(a.counts.students, 1);
    assert.ok(files['chengguo/backup/org_a/' + a.date + '/students.json']);
    assert.ok(files['chengguo/backup/org_b/' + b.date + '/students.json']);
    const packA = JSON.parse(files['chengguo/backup/org_a/' + a.date + '/students.json'].toString('utf8'));
    assert.strictEqual(packA.docs.length, 1);
    assert.strictEqual(packA.docs[0].name, '小明', '甲机构的文件里不能出现乙机构的孩子');
    assert.strictEqual(packA.docs[0]._id, undefined, '归档不带云库主键');
  });

  await ok('大集合按 2000 条拆片，清单里逐片记文件', async () => {
    resetCloud();
    put('orgs', { id: 'org_a' });
    for (let i = 1; i <= 2500; i++) put('records', { id: i, orgId: 'org_a', sid: 1, updatedAt: 1 });
    const r = await bf.main({});
    assert.ok(r.ok, JSON.stringify(r));
    const man = rowsOf('backups')[0];
    const parts = man.files.filter(f => f.c === 'records');
    assert.strictEqual(parts.length, 2, JSON.stringify(parts.map(p => p.fileID)));
    assert.strictEqual(parts[0].count, 2000);
    assert.strictEqual(parts[1].count, 500);
    assert.strictEqual(man.counts.records, 2500);
    assert.ok(parts[1].fileID.indexOf('records-2.json') > -1);
  });

  await ok('同一天重复跑：清单只有一条（覆盖），文件路径不变', async () => {
    resetCloud();
    put('orgs', { id: 'org_a' });
    put('students', { id: 1, orgId: 'org_a', name: '小明' });
    await bf.main({});
    const n1 = rowsOf('backups').length;
    await bf.main({});
    assert.strictEqual(rowsOf('backups').length, n1, '不能堆副本');
    assert.strictEqual(n1, 1);
  });

  await ok('分步备份（一次一个集合）会合并进同一天的清单，不互相覆盖', async () => {
    resetCloud();
    put('orgs', { id: 'org_a' });
    put('students', { id: 1, orgId: 'org_a', name: '小明' });
    put('records', { id: 1, orgId: 'org_a', sid: 1, date: '2026-11-05' });
    await bf.main({ action: 'run', orgId: 'org_a', coll: 'students' });
    const r = await bf.main({ action: 'run', orgId: 'org_a', coll: 'records' });
    assert.ok(r.ok, JSON.stringify(r));
    const man = rowsOf('backups')[0];
    assert.strictEqual(man.counts.students, 1, '前一步备的学生不能被后一步冲掉');
    assert.strictEqual(man.counts.records, 1);
    assert.ok(man.files.some(f => f.c === 'students' && f.fileID));
    assert.ok(man.files.some(f => f.c === 'records' && f.fileID));
    assert.strictEqual(man.status, 'partial');
    assert.ok(r.items[0].missing.length > 1, '还差哪些集合要如实报出来');
  });

  await ok('过期清理：只删 30 天前的备份清单与文件，业务数据一个字节不动', async () => {
    resetCloud();
    put('orgs', { id: 'org_a' });
    put('students', { id: 1, orgId: 'org_a', name: '小明' });
    const oldDate = lib.ymd(Date.now() - 40 * 86400000);
    files['chengguo/backup/org_a/' + oldDate + '/students.json'] = Buffer.from('{"docs":[]}');
    put('backups', {
      _id: lib.manifestId('org_a', oldDate), orgId: 'org_a', date: oldDate, at: 1, total: 1, bytes: 9,
      counts: { students: 1 }, files: [{ c: 'students', part: 1, count: 1, bytes: 9, fileID: 'cloud://chengguo/backup/org_a/' + oldDate + '/students.json' }],
      status: 'ok'
    });
    const r = await bf.main({});
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(rowsOf('backups').filter(m => m.date === oldDate).length, 0, '过期清单要清掉');
    assert.strictEqual(files['chengguo/backup/org_a/' + oldDate + '/students.json'], undefined, '过期文件要清掉');
    assert.strictEqual(rowsOf('students').length, 1, '业务数据不能被清理波及');
    assert.strictEqual(rowsOf('backups').length, 1, '今天的备份留着');
  });

  await ok('小程序里调用：只备份自己机构，传别人的 orgId 无效', async () => {
    resetCloud();
    OPENID = 'oid_owner_a';
    put('orgs', { id: 'org_a' });
    put('orgs', { id: 'org_b' });
    put('users', { _openid: 'oid_owner_a', orgId: 'org_a' });
    put('members', { id: 1, orgId: 'org_a', openid: 'oid_owner_a', role: 'owner', removed: false });
    put('students', { id: 1, orgId: 'org_a', name: '小明' });
    put('students', { id: 2, orgId: 'org_b', name: '小红' });
    const r = await bf.main({ action: 'run', orgId: 'org_b' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.orgs, 1);
    assert.ok(rowsOf('backups').every(m => m.orgId === 'org_a'), '不能备份到别人机构');
    assert.ok(!files['chengguo/backup/org_b/' + r.items[0].date + '/students.json'], '乙机构的目录下不该出现文件');
  });

  await ok('家长调用：拒绝，连列表都不给看', async () => {
    resetCloud();
    OPENID = 'oid_parent';
    put('orgs', { id: 'org_a' });
    put('users', { _openid: 'oid_parent', orgId: 'org_a' });
    put('members', { id: 1, orgId: 'org_a', openid: 'oid_parent', role: 'parent', removed: false });
    const a = await bf.main({ action: 'run' });
    const b = await bf.main({ action: 'list' });
    assert.strictEqual(a.code, 'FORBIDDEN');
    assert.strictEqual(b.code, 'FORBIDDEN');
  });

  await ok('老师能看备份列表，但不能触发全量备份', async () => {
    resetCloud();
    OPENID = 'oid_teacher';
    put('orgs', { id: 'org_a' });
    put('users', { _openid: 'oid_teacher', orgId: 'org_a' });
    put('members', { id: 1, orgId: 'org_a', openid: 'oid_teacher', role: 'teacher', removed: false });
    const a = await bf.main({ action: 'list' });
    const b = await bf.main({ action: 'run' });
    assert.ok(a.ok, JSON.stringify(a));
    assert.strictEqual(b.code, 'FORBIDDEN');
  });

  console.log('\n【C. 恢复：只写回，不删数据】');

  await ok('恢复把改坏的内容写回，并盖新时间戳（手机端增量拉得到）', async () => {
    resetCloud();
    put('orgs', { id: 'org_a' });
    put('students', { id: 1, orgId: 'org_a', name: '小明', updatedAt: 10, srvAt: 10 });
    put('students', { id: 2, orgId: 'org_a', name: '小红', updatedAt: 10, srvAt: 10 });
    await bf.main({});
    const date = rowsOf('backups')[0].date;

    // 模拟"被改坏了"：名字被改成乱码
    rowsOf('students').forEach(s => { s.name = '乱码'; s.updatedAt = 999; s.srvAt = 999; });

    const r = await bf.main({ action: 'restore', orgId: 'org_a', date, coll: 'students' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.written, 2);
    const names = rowsOf('students').map(s => s.name).sort();
    assert.deepStrictEqual(names, ['小明', '小红']);
    assert.strictEqual(rowsOf('students').length, 2, '不能因为恢复多出一条');
    const s1 = rowsOf('students').find(x => x.id === 1);
    assert.ok(s1.updatedAt > 999, '恢复要算"比本地新"，否则手机会拿旧值覆盖回去');
    assert.ok(s1.srvAt > 999, 'srvAt 要变新，手机端增量游标才捞得到');
  });

  await ok('恢复不会删掉备份之后新录的数据', async () => {
    resetCloud();
    put('orgs', { id: 'org_a' });
    put('students', { id: 1, orgId: 'org_a', name: '小明' });
    await bf.main({});
    const date = rowsOf('backups')[0].date;
    put('students', { id: 9, orgId: 'org_a', name: '新来的' });
    const r = await bf.main({ action: 'restore', orgId: 'org_a', date, coll: 'students' });
    assert.ok(r.ok);
    assert.strictEqual(rowsOf('students').filter(s => s.id === 9).length, 1, '恢复不是回档，不该删新数据');
  });

  await ok('没有这一天的备份 / 日期不合法：给出明确错误码，不静默', async () => {
    resetCloud();
    put('orgs', { id: 'org_a' });
    const a = await bf.main({ action: 'restore', orgId: 'org_a', date: '2020-01-01', coll: 'students' });
    const b = await bf.main({ action: 'restore', orgId: 'org_a', date: '2020/01/01', coll: 'students' });
    const c = await bf.main({ action: 'restore', orgId: 'org_a', date: '2020-01-01', coll: 'nope' });
    assert.strictEqual(a.code, 'NO_BACKUP');
    assert.strictEqual(b.code, 'BAD_DATE');
    assert.strictEqual(c.code, 'BAD_COLL');
  });

  await ok('恢复按集合分次调用（单次不超过 RESTORE_CAP），剩余量如实报', async () => {
    resetCloud();
    put('orgs', { id: 'org_a' });
    for (let i = 1; i <= 2100; i++) put('records', { id: i, orgId: 'org_a', sid: 1 });
    await bf.main({});
    const date = rowsOf('backups')[0].date;
    rowsOf('records').forEach(r => { r.sid = 0; });
    const r = await bf.main({ action: 'restore', orgId: 'org_a', date, coll: 'records' });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.written, lib.RESTORE_CAP);
    assert.strictEqual(r.skipped, 100, '剩下的要如实报出来，不能装作全恢复了');
  });

  console.log('\n全部 ' + pass + ' 项云端备份断言通过');
  fs.unlinkSync(stub);
  Module._resolveFilename = origResolve;
})().catch(e => {
  try { fs.unlinkSync(stub); } catch (x) {}
  console.error(e);
  process.exit(1);
});
