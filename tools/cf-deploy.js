// tools/cf-deploy.js —— 一条命令部署云函数（串行，云端装依赖）
//
// 为什么要有这个：在开发者工具里右键「上传并部署」要点好几次，而且同时点会撞
// ResourceInUse.FunctionName（看着像配置错，其实是并发抢通道）。命令行串行跑没这问题。
//
// ★ 部署清单不手写，从 utils/api.js 里"客户端真正调用到的函数名"自动推导。
//   这样新加一个云函数、在 api.js 里调一次，`npm run cloud` 自动带上它，
//   不会再出现"代码里有、云端没部署、调用静默失败"这种情况（stuImport 就是这么漏了两个月）。
//
// 用法：
//   npm run cloud                   部署「被引用到的」全部函数
//   npm run cloud -- syncv2 admin   只部署指定函数
//   npm run cloud -- --all          连未被引用的目录也一起部署（慎用）
//   npm run cloud:ls                只看云端现状与差异（不部署）
//
// 退出码：0 全部成功 / 1 有函数失败（打印是哪一个，可单独重试）
const fs = require('fs');
const path = require('path');
const wx = require('./wxcli');

const ROOT = wx.ROOT;
const CF_DIR = path.join(ROOT, 'cloudfunctions');
const ENV = wx.envId();
const run = wx.run;
const judge = wx.judge;

// 同步睡眠（脚本是线性的，不需要事件循环）
const sleep = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// 本地有目录的函数（有 package.json 或 index.js 才算）
function localFns() {
  if (!fs.existsSync(CF_DIR)) return [];
  return fs.readdirSync(CF_DIR)
    .filter(n => fs.existsSync(path.join(CF_DIR, n, 'package.json')) || fs.existsSync(path.join(CF_DIR, n, 'index.js')))
    .sort();
}

// 客户端真正调用到的函数名：callFn('x' / callSync 里 callFunction name / name: 'x'
function referencedFns() {
  const src = fs.readFileSync(path.join(ROOT, 'utils/api.js'), 'utf8');
  const names = new Set();
  const push = s => { if (s && !s.includes('{')) names.add(s); };
  let m;
  const re1 = /callFn\(\s*'([a-zA-Z0-9_]+)'/g;
  while ((m = re1.exec(src))) push(m[1]);
  const re2 = /name:\s*'([a-zA-Z0-9_]+)'/g;
  while ((m = re2.exec(src))) push(m[1]);
  return [...names];
}

// 云端现有函数：list 输出形如 "* syncv2"，没有 JSON
function cloudFns() {
  const r = run(['cloud', 'functions', 'list', '-e', ENV, '--project', ROOT]);
  const names = (r.out.match(/^\*\s+(\S+)\s*$/gm) || []).map(s => s.replace(/^\*\s+/, '').trim());
  return { names, raw: r.out };
}

const argv = process.argv.slice(2);

if (argv.indexOf('--list') >= 0) {
  const local = localFns();
  const used = referencedFns();
  const { names, raw } = cloudFns();
  console.log('云环境：' + ENV);
  console.log('云端现存：' + (names.length ? names.join('、') : '（读取失败）'));
  console.log('客户端引用：' + used.join('、'));
  const need = used.filter(n => names.length && names.indexOf(n) < 0);
  const orphan = names.filter(n => used.indexOf(n) < 0);
  const noDir = used.filter(n => local.indexOf(n) < 0).concat(['backup']).filter(n => local.indexOf(n) < 0);
  if (need.length) console.log('⚠ 代码要调、云端没有：' + need.join('、') + '  →  npm run cloud');
  if (orphan.length) console.log('· 云端有、代码不再调用（可留着）：' + orphan.join('、'));
  if (noDir.length) console.log('⚠ 代码要调、本地没目录：' + noDir.join('、') + '  → 补代码，否则部署脚本带不上');
  const idle = local.filter(n => used.indexOf(n) < 0 && !(n === 'backup'));
  if (idle.length) console.log('· 本地有目录但没被引用（不部署）：' + idle.join('、'));
  if (!names.length) console.log(raw.slice(-600));
  process.exit(need.length || noDir.length ? 2 : 0);
}

const local = localFns();
const used = referencedFns();
// backup 靠定时触发器跑，客户端不调用，但必须部署
const baseline = used.concat(['backup']).filter((v, i, a) => a.indexOf(v) === i);
const wantAll = argv.indexOf('--all') >= 0;
const pick = argv.filter(a => !a.startsWith('-'));
const todo = pick.length ? pick : (wantAll ? local : baseline.filter(n => local.indexOf(n) >= 0));
const unknown = todo.filter(n => local.indexOf(n) < 0);
if (unknown.length) {
  console.error('✘ cloudfunctions/ 下没有这些函数：' + unknown.join('、'));
  process.exit(1);
}
if (!todo.length) {
  console.error('✘ 没有可部署的函数');
  process.exit(1);
}

console.log('云环境：' + ENV);
console.log('待部署：' + todo.join('、') + '（' + todo.length + ' 个，串行）\n');

const failed = [];
todo.forEach((name, i) => {
  process.stdout.write('[' + (i + 1) + '/' + todo.length + '] ' + name + ' … ');
  // 首次创建的函数偶尔在 deploy 阶段直接失败（同一个包单独重试就过），
  // 所以每个函数最多尝试 2 次。串行 + 短退避，不并发，避免撞 ResourceInUse。
  let r = null, ok = false;
  for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
    r = run(['cloud', 'functions', 'deploy',
      '-e', ENV, '-n', name,
      '--path', path.join(CF_DIR, name),
      '--remote-npm-install',
      '--project', ROOT]);
    ok = judge(r.out);
    if (!ok && attempt < 2) {
      process.stdout.write('重试 … ');
      sleep(3000);
    }
  }
  console.log(ok ? '✔' : '✘');
  if (!ok) {
    failed.push(name);
    console.log((r && r.out ? r.out : '（无输出）').split('\n').slice(-14).join('\n'));
  }
});

console.log('');
if (failed.length) {
  console.error('✘ 失败 ' + failed.length + ' 个：' + failed.join('、'));
  console.error('  单个重试：npm run cloud -- ' + failed[0]);
  process.exit(1);
}
console.log('✔ 全部 ' + todo.length + ' 个云函数部署完成');
console.log('  收尾若出现 reg.exe / WMIC.exe 被拦的红字属正常：部署已完成，别去撤黑名单。');
