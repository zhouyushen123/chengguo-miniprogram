// tests/verify_review.js —— 代码审查机制本身的自检
//
// 审查标准如果只写在文档里，第一次赶时间就会被绕过。这里把"分级/清单/提示"变成断言：
//   A. 风险分级：地基文件不能因为只改几行就降级；认不出来的文件宁可算高
//   B. 必查章节：改了同步就得出 C，改了备份就得出 D，不能靠人记
//   C. 提示：没补断言、云函数要部署、备份要能恢复——这些机器看得见
//   D. 文档与模板确实存在且与工具口径一致（文档删了，工具就成了唯一标准）
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const rules = require('../tools/review-rules');

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };
const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

console.log('\n【A. 风险分级】');

ok('地基文件一律 R0（不看改了几行）', () => {
  ['utils/db/permissions.js', 'utils/db/core.js', 'utils/db/storage.js', 'utils/db/schema.js', 'utils/db/ctx.js']
    .forEach(f => assert.strictEqual(rules.levelOf(f), 'R0', f + ' 应当是 R0'));
});

ok('同步 / 备份 / 后台 / CI 目录里的任何文件都是 R0', () => {
  ['cloudfunctions/syncv2/index.js', 'cloudfunctions/backup/lib.js', 'cloudfunctions/admin/public/index.html',
    '.github/workflows/deploy.yml'].forEach(f => assert.strictEqual(rules.levelOf(f), 'R0', f + ' 应当是 R0'));
});

ok('其余数据层与云函数是 R1', () => {
  ['utils/db/students.js', 'utils/db/records.js', 'utils/sync.js', 'utils/api.js',
    'cloudfunctions/aiEval/index.js', 'deploy.js'].forEach(f => assert.strictEqual(rules.levelOf(f), 'R1', f + ' 应当是 R1'));
});

ok('页面 / 组件 / 资源是 R2', () => {
  ['pages/index/index.js', 'components/ava/ava.wxml', 'app.json', 'assets/icons/a.png']
    .forEach(f => assert.strictEqual(rules.levelOf(f), 'R2', f + ' 应当是 R2'));
});

ok('认不出来的文件按 R2 处理（宁可多看，不可漏看）', () => {
  assert.strictEqual(rules.levelOf('some-new-dir/x.js'), 'R2');
});

ok('文档 / 测试 / 工具是 R3，但混合改动取最严', () => {
  assert.strictEqual(rules.levelOf('docs/handoff.md'), 'R3');
  assert.strictEqual(rules.levelOf('tests/verify_db.js'), 'R3');
  assert.strictEqual(rules.overallLevel(['docs/handoff.md', 'utils/db/students.js']), 'R1');
  assert.strictEqual(rules.overallLevel(['utils/db/students.js', 'utils/db/permissions.js']), 'R0');
  assert.strictEqual(rules.overallLevel([]), 'R3');
});

console.log('\n【B. 必查章节】');

const keys = files => rules.sectionsFor(files).map(s => s.k).join('');

ok('改数据层：写入路径 A + 测试 F', () => {
  const k = keys(['utils/db/records.js']);
  assert.ok(k.indexOf('A') > -1 && k.indexOf('F') > -1, k);
});

ok('改权限：必须带上权限与机构隔离 B', () => {
  assert.ok(keys(['utils/db/permissions.js']).indexOf('B') > -1);
});

ok('改同步：必须带上云端一致 C', () => {
  assert.ok(keys(['cloudfunctions/syncv2/index.js']).indexOf('C') > -1);
});

ok('改备份：必须带上"能不能真的恢复" D', () => {
  const k = keys(['cloudfunctions/backup/index.js']);
  assert.ok(k.indexOf('D') > -1, k);
});

ok('改后台：写入路径 + 权限 + 同步三节都要看（后台能在服务端改任何机构）', () => {
  const k = keys(['cloudfunctions/admin/index.js']);
  assert.ok(k.indexOf('A') > -1 && k.indexOf('B') > -1 && k.indexOf('C') > -1, k);
});

ok('改页面：页面层 E + 合规 G', () => {
  const k = keys(['pages/record/record.js']);
  assert.ok(k.indexOf('E') > -1 && k.indexOf('G') > -1, k);
});

ok('只改文档不出清单', () => {
  assert.strictEqual(rules.sectionsFor(['docs/handoff.md']).length, 0);
});

console.log('\n【C. 提示：机器看得见、人容易忘】');

const has = (list, word) => list.some(x => x.indexOf(word) > -1);

ok('改了核心代码却没动测试 → 提醒补断言', () => {
  assert.ok(has(rules.warnings(['utils/db/students.js'], { added: 20, removed: 0 }), 'G3'));
  assert.ok(!has(rules.warnings(['utils/db/students.js', 'tests/verify_db.js'], { added: 30, removed: 0 }), 'G3'));
});

ok('测试文件删除行多于新增 → 提醒断言只增不减', () => {
  assert.ok(has(rules.warnings(['tests/verify_db.js'], { added: 3, removed: 12 }), '只增不减'));
});

ok('云函数改动 → 提醒部署（依赖 / 触发器 / 超时）', () => {
  assert.ok(has(rules.warnings(['cloudfunctions/backup/index.js'], {}), '部署'));
});

ok('改备份 → 提醒必须有一条真的恢复断言', () => {
  assert.ok(has(rules.warnings(['cloudfunctions/backup/index.js'], {}), '恢复'));
});

ok('改后台 → 提醒 updatedAt + srvAt、where 带 orgId', () => {
  const w = rules.warnings(['cloudfunctions/admin/index.js'], {});
  assert.ok(has(w, 'srvAt') && has(w, 'orgId'));
});

ok('改 schema → 提醒迁移与演示数据', () => {
  assert.ok(has(rules.warnings(['utils/db/schema.js'], {}), 'VERSION'));
});

ok('改界面 → 提醒跑体积检查', () => {
  assert.ok(has(rules.warnings(['pages/index/index.js'], {}), 'size'));
});

ok('改 CI → 提醒 verify 必须在 upload 之前', () => {
  assert.ok(has(rules.warnings(['.github/workflows/deploy.yml'], {}), 'verify'));
});

console.log('\n【D. 审查深度与配套文件】');

ok('审查深度随级别变化：R0 要冷却，R2 自审即可', () => {
  assert.ok(rules.depthOf('R0').indexOf('24') > -1);
  assert.ok(rules.depthOf('R1').indexOf('独立审查') > -1);
  assert.ok(rules.depthOf('R2').indexOf('自审') > -1);
});

ok('标准文档在，且写了四条红线 / 风险分级 / 反模式', () => {
  const doc = read('docs/code-review-standard.md');
  assert.ok(/v2\.0/.test(doc), '文档版本要能看出是 v2');
  assert.ok(/四条红线/.test(doc));
  assert.ok(/R0 地基/.test(doc));
  assert.ok(/反模式黑名单/.test(doc));
});

ok('PR 模板在，四项证据缺一不可', () => {
  const t = read('.github/pull_request_template.md');
  ['改了什么', '风险等级', '验证证据', '回滚或止血'].forEach(k => assert.ok(t.indexOf(k) > -1, '模板缺少：' + k));
});

ok('审查工具只认一份规则（不把分级抄第二遍）', () => {
  const src = read('tools/review.js');
  assert.ok(/require\('\.\/review-rules'\)/.test(src), 'review.js 必须 require review-rules');
  assert.ok(!/R0_DIRS|R0_FILES/.test(src), '分级规则不能复制到 review.js');
  assert.ok(/--check/.test(src) || /argValue\('check'/.test(src));
});

ok('npm run review 已接线', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.scripts.review, 'node tools/review.js');
});

console.log('\n全部 ' + pass + ' 项审查机制断言通过');
