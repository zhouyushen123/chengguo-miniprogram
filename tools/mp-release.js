// tools/mp-release.js —— 手机上看最新代码 / 上传体验版，各一条命令
//
// 两种日常场景，别混用：
//   npm run preview   生成预览二维码，手机扫码直接看**当前代码**（不上传、不占用版本号、秒级）
//                     —— 改完代码想马上在真机看效果，用这个，别去动上传
//   npm run ship      先跑门禁（lint + 体积 + 29 套测试）再上传体验版，版本号自动 +1
//                     —— 要给别人（老师/家长）用、或要提审时才用
//
// 为什么版本号自动加：手工敲 1123 → 1124 这种数字，敲错就得去后台删版本；
// 上一次成功的版本号记在 .release.json，成功才写回，失败不会污染。
//
// ★ 唯一无法自动化的一步：mp.weixin.qq.com → 版本管理 → 把新版本「设为体验版」，
//   以及最后的「提交审核 / 发布」。微信没有开放这两个接口，只能在后台点一次。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const wx = require('./wxcli');

const ROOT = wx.ROOT;
const STATE = path.join(ROOT, '.release.json');
const QR = path.join(ROOT, '.preview', 'qr.png');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return { version: '1000' }; }
}

function bump(v) {
  // 纯数字就 +1；带点的按最后一段 +1（1.0.7 → 1.0.8）
  const s = String(v || '1000');
  if (/^\d+$/.test(s)) return String(Number(s) + 1);
  const parts = s.split('.');
  parts[parts.length - 1] = String((Number(parts[parts.length - 1]) || 0) + 1);
  return parts.join('.');
}

const mode = process.argv[2];
const rest = process.argv.slice(3);

function preview() {
  fs.mkdirSync(path.dirname(QR), { recursive: true });
  console.log('生成预览二维码（用当前代码，不占用版本号）…');
  const r = wx.run(['preview', '--project', ROOT, '-f', 'image', '-o', QR]);
  if (!fs.existsSync(QR)) {
    console.error('✘ 二维码没生成，CLI 输出：\n' + r.out.split('\n').slice(-14).join('\n'));
    process.exit(1);
  }
  console.log('✔ 二维码已生成：' + QR);
  console.log('  手机微信扫这个码即可打开最新代码（和开发者工具的「预览」是同一件事）。');
}

function ship() {
  const st = loadState();
  const version = rest[0] || bump(st.version);
  const desc = rest[1] || st.desc || ('体验版 ' + version);

  console.log('① 门禁：lint + 体积 + 全量测试');
  try {
    execFileSync('node', [path.join(ROOT, 'tools/lint.js')], { stdio: 'inherit' });
    execFileSync('node', [path.join(ROOT, 'tools/size.js')], { stdio: 'inherit' });
    execFileSync('node', [path.join(ROOT, 'tests/run.js')], { stdio: 'inherit' });
  } catch (e) {
    console.error('\n✘ 门禁没过，不上传。先把上面红的改掉。');
    process.exit(1);
  }

  console.log('\n② 上传体验版 ' + version + '（' + desc + '）');
  const r = wx.run(['upload', '--project', ROOT, '-v', version, '-d', desc]);
  if (!wx.judge(r.out) || /上传失败|上传代码失败/.test(r.out)) {
    console.error('✘ 上传失败，CLI 输出：\n' + r.out.split('\n').slice(-16).join('\n'));
    process.exit(1);
  }
  fs.writeFileSync(STATE, JSON.stringify({ version, desc, at: new Date().toISOString() }, null, 2) + '\n');
  const kb = (r.out.match(/(\d+(?:\.\d+)?)\s*KB/) || [])[1];
  console.log('✔ 已上传版本 ' + version + (kb ? '（' + kb + ' KB）' : '') + '，已记到 .release.json');
  console.log('\n剩最后一步（微信没有接口，只能后台点）：');
  console.log('  mp.weixin.qq.com → 版本管理 → 把 ' + version + ' 设为体验版');
  console.log('  收尾若出现 reg.exe / WMIC.exe 被拦的红字属正常，不影响上传结果。');
}

if (mode === 'preview') preview();
else if (mode === 'ship') ship();
else {
  console.log('用法：');
  console.log('  node tools/mp-release.js preview          生成预览二维码（手机扫码看当前代码）');
  console.log('  node tools/mp-release.js ship [版本] [描述]  门禁 + 上传体验版（版本号自动 +1）');
  process.exit(1);
}
