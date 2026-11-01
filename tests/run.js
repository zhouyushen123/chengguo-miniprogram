// tests/run.js —— 回归总入口：node tests/run.js
//
// 三套断言各管一层，缺一不可：
//   verify_db     数据层：迁移、字段约束、软删除、重启后数据是否还在
//   verify_perm   权限：角色×范围、fail-closed、跨机构隔离
//   verify_pages  页面级：把真实页面模块加载起来跑，能抓到"数据层没问题但页面会崩"的情况
//
// 退出码非 0 表示有套件失败，可直接用于 CI 卡点。
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['verify_db.js', '数据层'],
  ['verify_perm.js', '权限'],
  ['verify_p0.js', 'P0 止血'],
  ['verify_pages.js', '页面级']
];

let failed = 0;
const rows = [];

SUITES.forEach(([file, name]) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8', timeout: 120000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  const ok = r.status === 0;
  if (!ok) failed++;
  const lines = out ? out.split('\n') : [];
  // 各脚本最后都会打印「全部 N 项…通过」，取它作为摘要（不能用最后一行：
  // 降级路径会打印 warn 日志，可能落在末尾）
  const summary = (lines.filter(l => /全部.*通过|有 \d+ 项失败/.test(l)).pop() || lines[lines.length - 1] || '').trim();
  rows.push({ name, ok, summary, out });
});

console.log('');
rows.forEach(row => {
  console.log((row.ok ? '✔' : '✘') + '  ' + row.name + '  ' + row.summary);
  if (!row.ok) {
    console.log('--- 失败详情 ---');
    console.log(row.out.split('\n').slice(-30).join('\n'));
    console.log('---------------');
  }
});
console.log('');
console.log(failed ? '有 ' + failed + ' 个套件失败' : '全部套件通过');
process.exit(failed ? 1 : 0);
