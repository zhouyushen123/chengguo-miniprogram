#!/usr/bin/env node
/**
 * 主包体积检查（CI 门禁用）
 *
 * 为什么要自己算：微信开发者工具的上传体积只有上传那一刻才知道，
 * 等 Actions 跑到 deploy.js 才报「包太大」，那时已经发过版了。
 * 这里在本地/CI 用同一套排除规则先算一遍，超线当场失败。
 *
 * 排除规则与 project.config.json 的 packOptions.ignore 保持一致，
 * 另外固定排除：node_modules / cloudfunctions（云函数目录不参与小程序包）。
 *
 * 【2026-11-09 踩坑】以前运默「点开头的隐藏项不进包」直接跳过 .workbuddy/，
 * 结果门禁绿着、IDE 上传却报 7770KB 超限：开发者工具会打包点开头目录，
 * 只认 packOptions.ignore。修复：不再无条件跳过隐藏项，只有显式忽略的才跳，
 * 没被忽略的点开头目录照算体积——它一定会进上传包，门禁不能再瞎。
 *
 * 用法：
 *   node tools/size.js          正常检查，超过 WARN 提示、超过 LIMIT 失败
 *   node tools/size.js --list   额外打印体积最大的 10 个文件
 *
 * 注意：这里算的是「未压缩源码体积」，开发者工具会做 minify，
 * 真实上传包通常更小。所以 LIMIT 取官方上限 2MB（不是 1.9MB 那种收紧值），
 * 只当粗筛用：这里都超了，上传必然超。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIMIT = 2 * 1024 * 1024;      // 主包上限 2MB（官方）
const WARN = Math.floor(LIMIT * 0.8); // 超过 80% 提醒

// 固定排除（不依赖配置，防止配置被改坏后静默放行）
// 注意：点开头的目录（.git/.workbuddy/.preview…）不在这里默认排除——
// IDE 会打包它们，必须显式写进 packOptions.ignore，否则这里会被量出来拦下
const ALWAYS_SKIP_DIRS = new Set([
  'node_modules', 'cloudfunctions',
]);
const ALWAYS_SKIP_FILES = new Set([
  'project.private.config.json',
  // 依赖锁文件只是给本地 npm 用的，进包白占 500KB+（2026-11 装 automator 时踩过）
  'package-lock.json',
]);

/** 读 project.config.json 的 packOptions.ignore，转成 { dirs:Set, files:Set } */
function loadIgnore() {
  const dirs = new Set();
  const files = new Set();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'));
    const list = (cfg.packOptions && cfg.packOptions.ignore) || [];
    for (const it of list) {
      if (!it || !it.value) continue;
      if (it.type === 'folder') dirs.add(it.value.replace(/\/+$/, ''));
      else files.add(it.value);
    }
  } catch (e) {
    console.error('读 project.config.json 失败：' + e.message);
    process.exit(2);
  }
  return { dirs, files };
}

function walk(dir, rel, ignore, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const ent of entries) {
    const name = ent.name;
    const relPath = rel ? rel + '/' + name : name;
    if (ent.isDirectory()) {
      if (ALWAYS_SKIP_DIRS.has(name)) continue;
      if (ignore.dirs.has(relPath)) continue;
      walk(path.join(dir, name), relPath, ignore, acc);
    } else if (ent.isFile()) {
      if (ALWAYS_SKIP_FILES.has(relPath)) continue;
      if (ignore.files.has(relPath)) continue;
      let size = 0;
      try {
        size = fs.statSync(path.join(dir, name)).size;
      } catch (e) {
        continue;
      }
      acc.total += size;
      acc.files.push({ path: relPath, size });
    }
  }
}

function kb(n) {
  return (n / 1024).toFixed(1) + ' KB';
}

const ignore = loadIgnore();

// 【分包感知】app.json 的 subPackages 根目录不算主包，各自有独立的 2MB 上限。
// 以前门禁把整个仓库当一个包算：拆了分包后主包被虚报，门禁口径与上传口径分叉。
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const SUB_ROOTS = ((app.subPackages || []).map(s => String(s.root || '')).filter(Boolean));

const mainAcc = { total: 0, files: [] };
const subAccs = SUB_ROOTS.map(() => ({ total: 0, files: [] }));

// 一次 walk 拿全部文件，按 relPath 前缀分流到主包 / 各分包
(function split() {
  const all = { total: 0, files: [] };
  walk(ROOT, '', ignore, all);
  for (const f of all.files) {
    const si = SUB_ROOTS.findIndex(r => f.path === r || f.path.indexOf(r + '/') === 0);
    if (si > -1) { subAccs[si].total += f.size; subAccs[si].files.push(f); }
    else { mainAcc.total += f.size; mainAcc.files.push(f); }
  }
  mainAcc.files.sort((a, b) => b.size - a.size);
})();

const acc = mainAcc;

const pct = ((mainAcc.total / LIMIT) * 100).toFixed(1);
console.log('主包体积：' + kb(mainAcc.total) + ' / 上限 ' + kb(LIMIT) + '（' + pct + '%）');
SUB_ROOTS.forEach((r, i) => {
  console.log('分包 ' + r + '：' + kb(subAccs[i].total) + ' / 上限 ' + kb(LIMIT) + '（' + ((subAccs[i].total / LIMIT) * 100).toFixed(1) + '%）');
});

if (acc.files.length && acc.files[0].size > 200 * 1024) {
  console.log('最大文件：' + acc.files[0].path + ' ' + kb(acc.files[0].size));
}

if (process.argv.includes('--list')) {
  console.log('\n体积 Top 10：');
  acc.files.slice(0, 10).forEach((f, i) => {
    console.log('  ' + String(i + 1).padStart(2) + '. ' + kb(f.size).padStart(10) + '  ' + f.path);
  });
}

if (mainAcc.total > LIMIT) {
  console.error('\n✖ 主包超过 2MB，上传会失败。');
  console.error('  先看 `node tools/size.js --list` 找大头，再决定分包 / 压图 / 移出主包。');
  process.exit(1);
}
for (let i = 0; i < SUB_ROOTS.length; i++) {
  if (subAccs[i].total > LIMIT) {
    console.error('\n✖ 分包 ' + SUB_ROOTS[i] + ' 超过 2MB，上传会失败。');
    process.exit(1);
  }
}
if (mainAcc.total > WARN) {
  console.log('⚠ 已用超过 80%，注意控制新增资源体积。');
  process.exit(0);
}
console.log('✔ 体积正常');
