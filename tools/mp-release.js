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
  try {
    const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    // 版本号必须是数字形态，否则当作没记录过（见 bump 的注释）
    if (!/^\d+(\.\d+)*$/.test(String(st.version || ''))) return { version: '1000', desc: st.desc || '' };
    return st;
  } catch (e) { return { version: '1000' }; }
}

function bump(v) {
  // 纯数字就 +1；带点的按最后一段 +1（1.0.7 → 1.0.8）
  const s = String(v || '').trim();
  if (/^\d+$/.test(s)) return String(Number(s) + 1);
  const parts = s.split('.');
  // 状态文件被写坏（比如把中文描述当版本号写进去）时不能算出 "1"，
  // 那种版本号在后台无法排序也不好认，直接退回一个干净的起点。
  if (!/^\d+$/.test(parts[parts.length - 1])) return '1001';
  parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
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
  // 参数顺序放宽：只有"像版本号"的才当版本，否则整串当描述。
  // （之前写成 rest[0] 一律当版本，`ship "修某问题"` 会把中文描述传成版本号。）
  const isVer = s => /^\d+(\.\d+)*$/.test(String(s || ''));
  const version = isVer(rest[0]) ? rest[0] : bump(st.version);
  const desc = isVer(rest[0]) ? (rest[1] || st.desc || ('体验版 ' + version)) : (rest[0] || st.desc || ('体验版 ' + version));

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
  // IDE 的编译启动偶尔会直接 × compile_start（跟代码无关，重跑即过）。
  // 只在输出里没有成功标记时重试，最多两次，避免把一个版本传成两条记录。
  const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const ok = out => wx.judge(out) && !/上传失败|上传代码失败/.test(out);
  let r = null;
  for (let i = 0; i < 3; i++) {
    r = wx.run(['upload', '--project', ROOT, '-v', version, '-d', desc]);
    if (ok(r.out)) break;
    if (i < 2) {
      console.log('  上传没起来（IDE 编译启动偶发失败），2 秒后重试 ' + (i + 1) + '/2 …');
      sleep(2000);
    }
  }
  if (!ok(r.out)) {
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
