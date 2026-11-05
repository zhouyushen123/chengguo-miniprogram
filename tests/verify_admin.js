// verify_admin.js —— 电脑端后台的可本地验证部分
//
// 云函数本体要连着云数据库才跑得起来（HTTP 事件、集合读写都在云上），这里守的是
// 「不需要数据库也一定会错」的地方：口令生成与节流、CSV 转义（Excel 乱码/公式注入）、
// 字段白名单（前端多传一个 updatedAt 能把 LWW 弄坏）、分页边界。
// 另外用源码级断言盯住两条纪律：后台每次写都必须盖 srvAt（否则手机端看不见改动）、
// 所有读写都必须带 orgId（否则跨机构串数据）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const lib = require('../cloudfunctions/admin/lib');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'admin', 'index.js'), 'utf8');

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

/* ---------------- 账号 / 口令 / token ---------------- */
t('账号规整：忽略空格短横，统一大写', () => {
  assert.strictEqual(lib.normAccount(' a3f-7km '), 'A3F7KM');
  assert.strictEqual(lib.normAccount('a3f7km'), 'A3F7KM');
  assert.strictEqual(lib.normAccount(null), '');
});

t('账号格式：4~10 位字母数字', () => {
  assert.ok(lib.isAccount('A3F7KM'));
  assert.ok(!lib.isAccount('ABC'));            // 太短
  assert.ok(!lib.isAccount('ABCDEFGHIJK'));    // 太长
  assert.ok(!lib.isAccount('中文账号'));
});

t('生成的账号只用无歧义字符（不含 0/O/1/I/2/Z）', () => {
  for (let i = 0; i < 200; i++) {
    const a = lib.newAccount();
    assert.ok(/^[A-Z0-9]{6}$/.test(a), a);
    assert.ok(!/[0O1I2Z]/.test(a), a);
  }
});

t('口令是 6 位数字（可注入随机源，结果可控）', () => {
  let i = 0;
  const seq = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
  assert.strictEqual(lib.newPin(() => seq[i++ % seq.length]), '123456');
  assert.ok(/^\d{6}$/.test(lib.newPin()));
});

t('token 32 位十六进制', () => {
  assert.ok(/^[0-9a-f]{32}$/.test(lib.newToken()));
});

/* ---------------- 登录节流 ---------------- */
t('前 4 次错只计数，不锁', () => {
  let acc = { fail: 0, lockUntil: 0 };
  const now = 1000;
  for (let i = 1; i <= 4; i++) {
    const r = lib.afterFail(acc, now);
    acc = Object.assign({}, acc, r);
    assert.strictEqual(r.lockUntil, 0);
    assert.strictEqual(r.fail, i);
  }
});

t('第 5 次错锁 10 分钟', () => {
  const r = lib.afterFail({ fail: 4, lockUntil: 0 }, 1000);
  assert.strictEqual(r.fail, 5);
  assert.strictEqual(r.lockUntil, 1000 + lib.LOCK_MS);
});

t('锁定期内判定为锁定，过期后自动放行', () => {
  const acc = { fail: 5, lockUntil: 5000 };
  assert.strictEqual(lib.lockedUntil(acc, 4000), 5000);
  assert.strictEqual(lib.lockedUntil(acc, 5000), 0);
  assert.strictEqual(lib.lockedUntil({}, 4000), 0);
});

t('会话有效期 7 天', () => {
  assert.strictEqual(lib.SESSION_MS, 7 * 24 * 3600 * 1000);
});

/* ---------------- 字段白名单 ---------------- */
t('白名单只放行允许字段，updatedAt 之类改不动', () => {
  const p = lib.safePatch({ name: '小明', updatedAt: 1, srvAt: 1, orgId: 'x', removed: true }, lib.EDIT.students);
  assert.deepStrictEqual(Object.keys(p), ['name']);
  assert.strictEqual(p.name, '小明');
});

t('空 patch / 非对象 patch 不抛错', () => {
  assert.deepStrictEqual(lib.safePatch(null, lib.EDIT.records), {});
  assert.deepStrictEqual(lib.safePatch('x', lib.EDIT.records), {});
});

t('记录可改评语但不能改 sid/cid（换人换班要走小程序，那里管课时账本）', () => {
  const p = lib.safePatch({ note: '很好', sid: 9, cid: 3 }, lib.EDIT.records);
  assert.deepStrictEqual(p, { note: '很好' });
});

t('成员表不在可编辑清单里（后台不能提权）', () => {
  assert.strictEqual(lib.EDIT.members, undefined);
  assert.strictEqual(lib.CREATE.members, undefined);
});

/* ---------------- CSV ---------------- */
t('CSV：含逗号/引号的字段加引号并双写', () => {
  assert.strictEqual(lib.csvCell('a,b'), '"a,b"');
  assert.strictEqual(lib.csvCell('他说"好"'), '"他说""好"""');
  assert.strictEqual(lib.csvCell('普通'), '普通');
});

t('CSV：公式注入被前缀单引号挡掉', () => {
  assert.strictEqual(lib.csvCell('=1+1'), "'=1+1");
  assert.strictEqual(lib.csvCell('-2'), "'-2");
  assert.strictEqual(lib.csvCell('@A1'), "'@A1");
});

t('CSV：表头 + 行，换行用 CRLF（Excel 认这个）', () => {
  const csv = lib.csvOf([{ a: 1, b: 'x' }, { a: 2, b: 'y,z' }], [{ k: 'a', t: '甲' }, { k: 'b', t: '乙' }]);
  assert.strictEqual(csv, '甲,乙\r\n1,x\r\n2,"y,z"');
});

t('CSV：计算列（f）取的是函数结果', () => {
  const csv = lib.csvOf([{ photos: [1, 2, 3] }], [{ t: '照片数', f: r => r.photos.length }]);
  assert.strictEqual(csv, '照片数\r\n3');
});

/* ---------------- 分页 ---------------- */
t('分页：默认 1/50，非法值兜底', () => {
  assert.deepStrictEqual(lib.normPage(null), { page: 1, size: 50, skip: 0 });
  assert.deepStrictEqual(lib.normPage({ page: -3, size: 'x' }), { page: 1, size: 50, skip: 0 });
});

t('分页：单页上限 200，skip 按页算', () => {
  const p = lib.normPage({ page: 3, size: 999 });
  assert.strictEqual(p.size, 200);
  assert.strictEqual(p.skip, 400);
});

/* ---------------- 源码纪律 ---------------- */
t('后台写数据都盖 srvAt（否则小程序 pull 捞不到改动）', () => {
  const writes = SRC.match(/\.update\(\{[\s\S]*?\}\)/g) || [];
  assert.ok(writes.length >= 3, '写操作太少，检查是不是漏了');
  writes.forEach(w => {
    // 登录失败计数、会话清除、口令重置与业务同步无关：它们改的是后台自己的账号表，
    // 不需要 srvAt（小程序根本不拉这两张表）。
    if (/data: next|data: \{ pin|lockUntil|resetAt/.test(w)) return;
    assert.ok(/srvAt/.test(w), '有写操作没带 srvAt：' + w.replace(/\s+/g, ' ').slice(0, 80));
  });
});

t('所有业务查询都带 orgId（跨机构串数据是这类后台最容易出的事故）', () => {
  // findAll/countOf 内部是 .where(where)，范围由调用方用 alive(orgId) 拼好，单独放行；
  // members 按 openid 查、会话按 account 查，也是各自天然的范围，不是漏网。
  const wheres = (SRC.match(/\.where\(\{[^}]*\}/g) || []).map(s => s.replace(/\s+/g, ' '));
  assert.ok(wheres.length >= 6, '查询太少：' + wheres.length);
  wheres.forEach(w => {
    const okRange = /orgId/.test(w) || /openid/.test(w) || /account/.test(w) ||
      /\{ id: /.test(w) || /\.where\(\{ where \}/.test(w);
    assert.ok(okRange, '有查询没带机构范围：' + w);
  });
});

t('删除是软删（removed:true），不是物理删除', () => {
  assert.ok(/removed: true/.test(SRC));
  assert.ok(!/\.doc\([^)]*\)\.remove\(\)[\s\S]{0,40}students/.test(SRC));
});

t('后台账号只能由负责人/管理员取（服务端判角色）', () => {
  assert.ok(/role === 'owner' \|\| m\.role === 'admin'/.test(SRC));
});

t('口令错误不区分"账号不存在"和"口令错"（不给撞库探路）', () => {
  const m = SRC.match(/BAD_PIN[^\n]*/g) || [];
  const msgs = new Set(m.map(x => (x.match(/msg: '([^']+)'/) || [])[1]).filter(Boolean));
  assert.strictEqual(msgs.size, 1, '提示语不一致会把账号是否存在暴露出去：' + Array.from(msgs).join(' / '));
});

t('后台网址指向 HTTP 访问服务的 /admin 路径', () => {
  assert.strictEqual(lib.adminUrl('cloud1-x'), 'https://cloud1-x.service.tcloudbase.com/admin');
  // 没配环境变量时回落到已知环境，保证小程序里点开就能看到网址
  assert.ok(/^https:\/\/.+-env|^https:\/\/cloud1-/.test(lib.adminUrl('')) || lib.adminUrl('').indexOf('service.tcloudbase.com/admin') > 0);
});

/* ---------------- 核心资产的备份与体检 ---------------- */
t('完整备份覆盖全部核心集合（少一个就等于备份不全）', () => {
  const m = SRC.match(/BACKUP_COLLS\s*=\s*\[([^\]]*)\]/);
  assert.ok(m, '应定义 BACKUP_COLLS');
  ['orgs', 'members', 'students', 'classes', 'records'].forEach(k => {
    assert.ok(m[1].indexOf("'" + k + "'") > -1, '备份里缺少 ' + k);
  });
});

t('备份会剔除云端内部字段（_id / srvAt），恢复时不会带着别人的库内标识', () => {
  const m = SRC.match(/async function backupData\([\s\S]*?\n\}/);
  assert.ok(m, '应有 backupData');
  assert.ok(/delete x\._id/.test(m[0]), '要删 _id');
  assert.ok(/delete x\.srvAt/.test(m[0]), '要删 srvAt');
});

t('备份记录超过上限时明确告诉用户"这份不全"', () => {
  assert.ok(/truncated\s*:/.test(SRC), '要有 truncated 标记');
});

t('体检是只读的：auditData 里不能有任何写操作', () => {
  const m = SRC.match(/async function auditData\([\s\S]*?\n\}/);
  assert.ok(m, '应有 auditData');
  assert.ok(!/\.update\(|\.add\(|\.remove\(|\.set\(/.test(m[0]), '体检函数里出现了写操作');
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + (e && e.message)); }
  }
  console.log(fail ? ('verify_admin: ' + fail + ' FAILED') : ('verify_admin: all ' + tests.length + ' passed'));
  process.exit(fail ? 1 : 0);
})();
