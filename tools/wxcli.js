// tools/wxcli.js —— 微信开发者工具 CLI 的薄封装（部署/上传/预览三个脚本共用）
//
// 集中处理三件容易各写一遍、又容易写错的事：
//   1. cli.bat 在哪（Windows 装在 Program Files 里，路径带空格和中文）
//   2. 怎么判断成功 —— CLI 收尾会被安全中心拦 reg.exe / WMIC.exe 并打印红字、
//      顺带把退出码带偏，但操作其实已经完成了，所以看输出里的标记，不看退出码
//   3. 云环境 ID 只有一处真相：utils/api.js 的 CLOUD_ENV
//      （手抄成结尾 456e 会报 ResourceNotFound.Namespace，看着像"环境没开通"）
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const CLI = [
  process.env.WX_CLI,
  'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
  'C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat',
  'D:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
  '/Applications/wechatwebdevtools.app/Contents/MacOS/cli'
].filter(Boolean).find(p => fs.existsSync(p));

function requireCli() {
  if (!CLI) {
    console.error('✘ 找不到微信开发者工具 CLI。\n  可用环境变量 WX_CLI 指定 cli.bat 的完整路径。');
    process.exit(1);
  }
  return CLI;
}

function envId() {
  const src = fs.readFileSync(path.join(ROOT, 'utils/api.js'), 'utf8');
  const m = src.match(/CLOUD_ENV\s*=\s*['"]([^'"]+)['"]/);
  if (!m) {
    console.error('✘ utils/api.js 里找不到 CLOUD_ENV，无法确定云环境');
    process.exit(1);
  }
  return m[1];
}

const q = s => (/[\s"]/.test(String(s)) ? '"' + String(s) + '"' : String(s));

// 同步执行一条 CLI 命令，返回 { code, out }
function run(args) {
  const cmd = [q(requireCli())].concat(args.map(q)).join(' ');
  const r = spawnSync(cmd, { shell: true, encoding: 'buffer', timeout: 600000 });
  const out = ((r.stdout || Buffer.alloc(0)).toString('utf8') + (r.stderr || Buffer.alloc(0)).toString('utf8')).trim();
  return { code: r.status, out };
}

// 成功判据：先排除明确的失败标记，再看成功标记
function judge(out) {
  if (/✘|失败|not found|Error:|errCode/i.test(out)) return false;
  return /✔|√ .*(deploy|upload|preview)|部署成功|上传成功|success/i.test(out);
}

module.exports = { ROOT, CLI, requireCli, envId, run, judge, q };
