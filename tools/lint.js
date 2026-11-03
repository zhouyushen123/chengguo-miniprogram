// tools/lint.js —— 项目自检（npm run lint）
//
// 【为什么不用 ESLint】通用 linter 查的是语法风格，而这个项目真正会出事的地方是
// 「约定被悄悄绕开」：页面里写死品牌色（换肤后不跟着变）、绕过数据层读存储、
// 忘了删的 console.log（会把老师设备上的日志带上生产）、require 了却没用（死代码）。
// 这些规则用通用配置写出来又长又难维护，写成 80 行脚本反而更准。
// 架构层面的约定（依赖方向、文件规模、API 完整性）另有 tests/verify_arch.js，两边不重复。
//
// 用法：npm run lint      有错退出码 1，可挂进 CI
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const errors = [];
const warns = [];

function walk(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|wxml|wxss|json)$/.test(e.name)) out.push(p);
  });
  return out;
}

const rel = p => path.relative(ROOT, p).split(path.sep).join('/');
const files = walk(path.join(ROOT, 'pages'))
  .concat(walk(path.join(ROOT, 'utils')))
  .concat(walk(path.join(ROOT, 'components')))
  .concat([path.join(ROOT, 'app.js'), path.join(ROOT, 'app.json'), path.join(ROOT, 'app.wxss')]);

/* ---------------- 1. 空白与换行：统一 2 空格 / LF / 末尾空行 ---------------- */
files.forEach(f => {
  // 仓库里存的是 LF，工作区可能因 core.autocrlf 变成 CRLF：行尾检查要先把 \r 去掉，
  // 否则每个文件都会被报"行尾有多余空格"
  const src = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  const name = rel(f);
  if (/\t/.test(src)) errors.push(name + ': 出现制表符（项目统一 2 空格缩进）');
  const trail = src.split('\n').findIndex(l => /\s+$/.test(l) && l.trim() !== '');
  if (trail > -1) errors.push(name + ':' + (trail + 1) + ': 行尾有多余空格');
  if (src.length && !/\n$/.test(src)) errors.push(name + ': 文件末尾缺少换行');
});

/* ---------------- 2. 页面里不许写死品牌色 ---------------- */
// 品牌色只允许出现在 utils/theme.js（主题表）与 utils/icons.js（图标映射），
// 其它地方写死会让换肤留下一块不变色的角落。
const BRAND_LITERAL = /#(E8590C|59A8FF|1F2329)\b/i;
walk(path.join(ROOT, 'pages')).concat(walk(path.join(ROOT, 'components'))).forEach(f => {
  if (!f.endsWith('.js') && !f.endsWith('.wxml') && !f.endsWith('.wxss')) return;
  const src = fs.readFileSync(f, 'utf8');
  if (BRAND_LITERAL.test(src)) {
    errors.push(rel(f) + ': 写死了品牌色，请用 var(--brand) 或 theme.brand() / icons.brand()');
  }
});

/* ---------------- 3. 生产代码里不留 console.log ---------------- */
// 老师的手机上不该有调试日志；console.error / console.warn 是刻意的（降级路径的提示）不拦。
['pages', 'utils', 'components'].forEach(d => {
  walk(path.join(ROOT, d)).filter(f => f.endsWith('.js')).forEach(f => {
    const src = fs.readFileSync(f, 'utf8');
    const hit = src.split('\n').findIndex(l => /\bconsole\.log\s*\(/.test(l));
    if (hit > -1) errors.push(rel(f) + ':' + (hit + 1) + ': 残留 console.log');
  });
});

/* ---------------- 4. require 了却没用（死代码） ---------------- */
walk(path.join(ROOT, 'pages')).concat(walk(path.join(ROOT, 'utils')))
  .filter(f => f.endsWith('.js'))
  .forEach(f => {
    const src = fs.readFileSync(f, 'utf8');
    const re = /const\s+(\w+)\s*=\s*require\(/g;
    let m;
    while ((m = re.exec(src))) {
      const name = m[1];
      // 变量名出现在 require 这一行之外的地方，才算用到了
      const used = src.replace(m[0], '').indexOf(name) > -1;
      if (!used) warns.push(rel(f) + ': require 了 ' + name + ' 但没用到');
    }
  });

/* ---------------- 5. WXML 里不许出现方法调用 ---------------- */
// WXML 的表达式只支持简单运算，写 {{fmt(x)}} 真机上会静默渲染成空。
walk(path.join(ROOT, 'pages')).concat(walk(path.join(ROOT, 'components')))
  .filter(f => f.endsWith('.wxml'))
  .forEach(f => {
    const src = fs.readFileSync(f, 'utf8');
    // 先把字符串字面量抹掉：'linear-gradient(135deg,#fff,#eee)' 里的括号不是函数调用
    const stripped = src.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
    const re = /\{\{[^}]*[\w.]\s*\([^}]*\}\}/g;
    let m;
    while ((m = re.exec(stripped))) {
      // 限定白名单：模板里允许出现的"看起来像调用"的写法其实只有数组下标之类的，这里严格拦
      errors.push(rel(f) + ': WXML 里出现函数调用，真机会渲染为空 → ' + m[0].trim());
    }
  });

/* ---------------- 汇总 ---------------- */
warns.forEach(w => console.log('  ⚠ ' + w));
if (errors.length) {
  errors.forEach(e => console.log('  ✗ ' + e));
  console.log('\n自检未通过：' + errors.length + ' 个错误，' + warns.length + ' 个提醒');
  process.exit(1);
}
console.log('自检通过（' + files.length + ' 个文件，' + warns.length + ' 个提醒）');
