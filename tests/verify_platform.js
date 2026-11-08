// verify_platform.js —— 平台控制台的可本地验证部分
//
// 平台控制台跨机构且只读，翻车的代价远大于机构后台，所以两条纪律用源码级断言钉死：
//   1. 平台会话调任何写接口必须被 default 分支拒绝（apiPlatform 里不许出现写函数）
//   2. 平台登录在 PLATFORM_PIN 没配置时必须直接拒绝（fail-closed，不能有默认口令）
// 统计口径（趋势/分档/机构汇总/CSV）是纯函数，直接跑真数据断言。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const lib = require('../cloudfunctions/admin/lib');
const plat = require('../cloudfunctions/admin/platform');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'admin', 'index.js'), 'utf8');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

/* ---------------- 日期 ---------------- */
t('addDays 跨月不跳天', () => {
  assert.strictEqual(plat.addDays('2026-11-01', -1), '2026-10-31');
  assert.strictEqual(plat.addDays('2026-03-01', -1), '2026-02-28');
  assert.strictEqual(plat.addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(plat.addDays('垃圾', 1), '');
});
t('lastDays 从早到晚、含今天', () => {
  const days = plat.lastDays(3, '2026-11-08');
  assert.deepStrictEqual(days, ['2026-11-06', '2026-11-07', '2026-11-08']);
});

/* ---------------- 趋势与分布 ---------------- */
t('trendOf 按上课日期统计，草稿/已发布分开', () => {
  const rows = plat.trendOf([
    { date: '2026-11-07', sent: true },
    { date: '2026-11-07', sent: false },
    { date: '2026-11-06', sent: true },
    { date: '2026-11-01' }                      // 窗口外
  ], 3, '2026-11-08');
  assert.deepStrictEqual(rows, [
    { d: '2026-11-06', n: 1, sent: 1 },
    { d: '2026-11-07', n: 2, sent: 1 },
    { d: '2026-11-08', n: 0, sent: 0 }
  ]);
});
t('scoreDist 五档边界归下一档，0 分不算', () => {
  const d = plat.scoreDist([
    { score: 59 }, { score: 60 }, { score: 74 }, { score: 75 },
    { score: 85 }, { score: 91 }, { score: 92 }, { score: 100 },
    { score: 0 }, { tag: '良好' }
  ]);
  assert.deepStrictEqual(d.map(x => x.n), [1, 2, 1, 2, 2]);
  assert.deepStrictEqual(d.map(x => x.t), ['待提高', '加油', '良好', '优秀', '最佳']);
});
t('avgScore 忽略 0 分', () => {
  assert.strictEqual(plat.avgScore([{ score: 80 }, { score: 90 }, { score: 0 }]), 85);
  assert.strictEqual(plat.avgScore([]), 0);
});

/* ---------------- 机构汇总 ---------------- */
t('mergeOrgs 按学生数倒序，rate/perStudent 口径正确', () => {
  const rows = plat.mergeOrgs(
    [{ id: 'org_a', name: 'A' }, { id: 'org_b', name: 'B', removed: true }, { id: 'org_c', name: 'C' }],
    { students: { org_a: 10, org_c: 30 }, records: { org_a: 40, org_c: 30 }, sent: { org_a: 20, org_c: 30 } }
  );
  assert.strictEqual(rows.length, 2);                       // 软删机构不出现
  assert.strictEqual(rows[0].orgId, 'org_c');
  assert.strictEqual(rows[0].rate, 100);
  assert.strictEqual(rows[0].perStudent, 1);
  assert.strictEqual(rows[1].rate, 50);
  assert.strictEqual(rows[1].perStudent, 4);
});
t('globalStat 汇总与发布率', () => {
  const g = plat.globalStat(
    [{ students: 10, records: 8, sent: 6, classes: 2, members: 5 }],
    [{ sent: true, photos: [1, 2] }, { sent: false }, { sent: true, audio: 1 }],
    { teacher: 3, parent: 7, owner: 1 }
  );
  assert.strictEqual(g.orgs, 1);
  assert.strictEqual(g.students, 10);
  assert.strictEqual(g.teachers, 3);
  assert.strictEqual(g.parents, 7);
  assert.strictEqual(g.admins, 1);
  assert.strictEqual(g.photos, 2);
  assert.strictEqual(g.audios, 1);
  assert.strictEqual(g.rate, 67);                            // 2/3
});

/* ---------------- 平台口令 ---------------- */
t('没配 PLATFORM_PIN 必须拒绝（fail-closed）', () => {
  const r = plat.platAuth({ account: 'CGPLAT', pin: '123456' }, {}, null, 1000);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'NO_ENV');
  const r2 = plat.platAuth({ account: 'CGPLAT', pin: '123456' }, { PLATFORM_PIN: 'abc' }, null, 1000);
  assert.strictEqual(r2.code, 'NO_ENV');                     // 太短也不行
});
t('口令对 → 通过；账号错 → 按口令错回，不泄露账号是否存在', () => {
  const ok = plat.platAuth({ account: 'cgplat', pin: ' 123456 ' }, { PLATFORM_PIN: '123456' }, null, 1000);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.account, 'CGPLAT');
  const bad = plat.platAuth({ account: 'AAAAAA', pin: '123456' }, { PLATFORM_PIN: '123456' }, null, 1000);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.code, 'BAD_PIN');
});
t('连错 5 次锁 10 分钟（复用机构后台同一套节奏）', () => {
  let rec = null;
  const env = { PLATFORM_PIN: '123456' };
  for (let i = 1; i <= 5; i++) {
    const r = plat.platAuth({ account: 'CGPLAT', pin: '000000' }, env, rec, 1000 + i);
    assert.strictEqual(r.ok, false);
    rec = Object.assign({}, rec, r.next);
    if (i < 5) assert.strictEqual(rec.lockUntil, 0);
    else assert.ok(rec.lockUntil > 0);
  }
  const locked = plat.platAuth({ account: 'CGPLAT', pin: '123456' }, env, rec, 2000);
  assert.strictEqual(locked.code, 'LOCKED');                 // 锁着的时候口令对也不放行
});
t('samePin 长度不同直接不等', () => {
  assert.ok(!plat.samePin('123456', '1234567'));
  assert.ok(plat.samePin('123456', '123456'));
});

/* ---------------- 导出 ---------------- */
t('CSV 带 BOM 由前端负责，公式注入仍由 lib 转义', () => {
  const csv = plat.orgsCsv([{ name: '=cmd|a', orgId: 'org_x', rate: 50, perStudent: 1 }]);
  assert.ok(csv.split('\r\n')[1].includes("'=cmd|a"));
  const scsv = plat.studentsCsv([{ orgName: 'A', name: '张三', clsNames: ['楷书班'], records: 3 }]);
  assert.ok(scsv.startsWith('机构,学号,姓名,班级'));
});

/* ---------------- 源码级纪律 ---------------- */
t('平台会话在 api() 里必须先于 orgId 分叉，且 default 拒绝写', () => {
  assert.ok(SRC.indexOf("str(s.scope) === 'platform'") >= 0, '平台分支缺失');
  const body = SRC.slice(SRC.indexOf('async function apiPlatform'), SRC.indexOf('/* ============================ 路由'));
  ['updateData(', 'removeData(', 'createData(', 'resetPin(', 'cbRestore('].forEach(fn => {
    assert.ok(body.indexOf(fn) < 0, '平台分支里出现了写函数：' + fn);
  });
  assert.ok(body.indexOf("code: 'READONLY'") >= 0, '缺少只读拒绝分支');
});
t('platLogin 不需要 token 就能到（否则没人能登录），平台页有独立路由', () => {
  assert.ok(/if \(action === 'platLogin'\) return doPlatformLogin/.test(SRC));
  assert.ok(SRC.indexOf("str(q.view) === 'platform'") >= 0, '平台页路由缺失');
});
t('平台口令只能来自环境变量，不允许代码里写死默认口令', () => {
  assert.ok(!/PLATFORM_PIN\s*[=:]\s*['"]\d{4,}['"]/.test(SRC), '代码里不允许出现平台口令字面量');
  assert.ok(!/PLATFORM_PIN\s*[=:]\s*['"]\d{4,}['"]/.test(fs.readFileSync(
    path.join(__dirname, '..', 'cloudfunctions', 'admin', 'platform.js'), 'utf8')));
});
t('分页仍然走 lib.normPage（上限 200/页，不许绕过）', () => {
  assert.ok(SRC.indexOf('lib.normPage') >= 0);
  assert.ok(typeof lib.normPage({ page: 99, size: 9999 }).skip === 'number');
});

module.exports = { tests, name: '平台控制台' };
if (require.main === module) {
  let fail = 0;
  tests.forEach(([name, fn]) => {
    try { fn(); console.log('  ✓', name); } catch (e) { fail++; console.log('  ✗', name, '\n    ', e.message); }
  });
  process.exit(fail ? 1 : 0);
}
