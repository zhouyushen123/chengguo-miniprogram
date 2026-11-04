#!/usr/bin/env node
/**
 * 主包体积检查（CI 门禁用）
 *
 * 为什么要自己算：微信开发者工具的上传体积只有上传那一刻才知道，
 * 等 Actions 跑到 deploy.js 才报「包太大」，那时已经发过版了。
 * 这里在本地/CI 用同一套排除规则先算一遍，超线当场失败。
 *
 * 排除规则与 project.config.json 的 packOptions.ignore 保持一致，
 * 另外固定排除：.git / .github / .workbuddy / node_modules / cloudfunctions
 * （云函数目录不参与小程序包）以及所有点开头的隐藏项。
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
const ALWAYS_SKIP_DIRS = new Set([
  '.git', '.github', '.workbuddy', 'node_modules', 'cloudfunctions',
]);
const ALWAYS_SKIP_FILES = new Set([
  'project.private.config.json',
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
    if (name.startsWith('.')) continue;             // 隐藏项不进包
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
const acc = { total: 0, files: [] };
walk(ROOT, '', ignore, acc);

// 按体积排序，用于 --list 和超线时的定位
acc.files.sort((a, b) => b.size - a.size);

const pct = ((acc.total / LIMIT) * 100).toFixed(1);
console.log('主包体积：' + kb(acc.total) + ' / 上限 ' + kb(LIMIT) + '（' + pct + '%）');

if (acc.files.length && acc.files[0].size > 200 * 1024) {
  console.log('最大文件：' + acc.files[0].path + ' ' + kb(acc.files[0].size));
}

if (process.argv.includes('--list')) {
  console.log('\n体积 Top 10：');
  acc.files.slice(0, 10).forEach((f, i) => {
    console.log('  ' + String(i + 1).padStart(2) + '. ' + kb(f.size).padStart(10) + '  ' + f.path);
  });
}

if (acc.total > LIMIT) {
  console.error('\n✖ 主包超过 2MB，上传会失败。');
  console.error('  先看 `node tools/size.js --list` 找大头，再决定分包 / 压图 / 移出主包。');
  process.exit(1);
}
if (acc.total > WARN) {
  console.log('⚠ 已用超过 80%，注意控制新增资源体积。');
  process.exit(0);
}
console.log('✔ 体积正常');
