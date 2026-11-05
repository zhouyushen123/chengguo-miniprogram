// tools/review.js —— 生成"代码审查包"（npm run review）
//
// 为什么需要它：审查标准写在文档里，但人不会每次翻文档。这个脚本把"这次改动该看哪几节"
// 直接算出来，顺便提醒那些机器能看见、人容易忘的事（没补断言、云函数要部署、要跑体积检查）。
// 它不做判断，也不替代审查——只是让审查从"凭记忆"变成"按清单"。
//
// 用法：
//   npm run review                     # 对比 origin/main...HEAD + 工作区改动
//   npm run review -- --check          # 同时跑 npm run check（lint + size + test）
//   npm run review -- --base HEAD~1    # 指定基准
//
// 规则在 tools/review-rules.js（纯函数，tests/verify_review.js 直接测）。
const { execSync, spawnSync } = require('child_process');
const path = require('path');
const rules = require('./review-rules');

const ROOT = path.join(__dirname, '..');

function argValue(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && v[0] !== '-' ? v : true;
}

function git(cmd) {
  try {
    return execSync('git ' + cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return '';
  }
}

function names(out) {
  return String(out || '').split('\n').map(s => s.trim()).filter(Boolean);
}

// 基准分支不存在时（新克隆/裸仓库）退到 HEAD~1，再不济就只看工作区
function pickBase(want) {
  const tries = [want, 'origin/main', 'main', 'HEAD~1'];
  for (const b of tries) {
    if (!b) continue;
    const ok = git('rev-parse --verify ' + b);
    if (ok) return b;
  }
  return '';
}

const base = pickBase(argValue('base', 'origin/main'));
const files = [];
const seen = {};
function add(list) {
  list.forEach(f => {
    if (!seen[f]) { seen[f] = 1; files.push(f); }
  });
}
if (base) add(names(git('diff --name-only ' + base + '...HEAD')));
add(names(git('diff --name-only HEAD')));          // 工作区未暂存
add(names(git('diff --name-only --cached')));      // 已暂存
add(names(git('ls-files --others --exclude-standard'))); // 新增未跟踪

// 行数统计（只用于提示"测试是不是在删断言"，粗略即可）
const stat = { added: 0, removed: 0 };
const statCmds = ['diff --numstat HEAD', 'diff --numstat --cached'];
if (base) statCmds.push('diff --numstat ' + base + '...HEAD');
statCmds.forEach(c => {
  names(git(c)).forEach(line => {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) return;
    stat.added += m[1] === '-' ? 0 : Number(m[1]);
    stat.removed += m[2] === '-' ? 0 : Number(m[2]);
  });
});

console.log('');
console.log('橙果 · 代码审查包');
console.log('基准：' + (base ? base + '...HEAD' : '仅工作区') + '（含未提交改动）');
if (!files.length) {
  console.log('没有检测到改动。');
  console.log('');
  process.exit(0);
}
console.log('改动 ' + files.length + ' 个文件：+' + stat.added + ' / -' + stat.removed);

const level = rules.overallLevel(files);
console.log('');
console.log('总体风险：' + level + ' —— ' + rules.titleOf(level));
console.log('审查深度：' + rules.depthOf(level));

['R0', 'R1', 'R2', 'R3'].forEach(lv => {
  const list = files.filter(f => rules.levelOf(f) === lv);
  if (!list.length) return;
  console.log('');
  console.log(lv + ' · ' + list.length + ' 个文件');
  list.slice(0, 40).forEach(f => console.log('  ' + f));
  if (list.length > 40) console.log('  …还有 ' + (list.length - 40) + ' 个');
});

const secs = rules.sectionsFor(files);
console.log('');
console.log('必查章节（docs/code-review-standard.md 第 5 节）：');
if (!secs.length) console.log('  无');
secs.forEach(s => console.log('  ' + s.k + ' · ' + s.title));

const warns = rules.warnings(files, stat);
console.log('');
console.log('提示：');
if (!warns.length) console.log('  没有额外提示');
warns.forEach(w => console.log('  ⚠ ' + w));

console.log('');
console.log('下一步：npm run check（或 npm run review -- --check）→ 填 PR 模板 → 请审查方读 diff 与本包');

if (argValue('check', false)) {
  console.log('');
  console.log('运行门禁：npm run check');
  console.log('');
  const r = spawnSync('npm', ['run', 'check'], { cwd: ROOT, stdio: 'inherit', shell: true });
  process.exit(r.status === 0 ? 0 : 1);
}
