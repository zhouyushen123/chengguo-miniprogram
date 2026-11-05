// tools/review-rules.js —— 代码审查的判定规则（纯函数，可单测）
//
// 这里只回答三个问题，不碰 git、不打印、不跑测试：
//   1. 这个文件属于哪个风险层（决定审查深度）
//   2. 这次改动该过哪几节人工清单
//   3. 有哪些"机器能看见、人容易忘"的提示
//
// 规则依据：docs/code-review-standard.md 第 4 节（风险分级）与第 5 节（清单）。
// 改这里等于改审查标准，必须同步改文档。

const ORDER = { R0: 0, R1: 1, R2: 2, R3: 3 };

// 地基文件：改一个字也要按最高级别审。命中即 R0，不看 diff 行数。
const R0_FILES = [
  'utils/db/permissions.js',
  'utils/db/core.js',
  'utils/db/storage.js',
  'utils/db/schema.js',
  'utils/db/ctx.js'
];
// 地基目录：同步协议、备份、后台（后台能在服务端改任何机构的数据）
const R0_DIRS = [
  'cloudfunctions/syncv2/',
  'cloudfunctions/backup/',
  'cloudfunctions/admin/',
  '.github/workflows/'
];

const R1_DIRS = ['cloudfunctions/'];
const R1_FILES = [
  'utils/sync.js',
  'utils/syncmerge.js',
  'utils/api.js',
  'utils/photocloud.js',
  'deploy.js',
  'package.json'
];

const R2_DIRS = ['pages/', 'components/', 'assets/', 'images/'];
const R2_FILES = ['app.js', 'app.json', 'app.wxss', 'project.config.json', 'sitemap.json'];

const R3_DIRS = ['docs/', 'tests/', 'tools/', '.github/'];
const R3_EXT = /\.(md|txt)$/;

const norm = p => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
const starts = (p, dirs) => dirs.some(d => p === d || p.indexOf(d) === 0);

function levelOf(file) {
  const p = norm(file);
  if (!p) return 'R3';
  if (R0_FILES.indexOf(p) > -1 || starts(p, R0_DIRS)) return 'R0';
  if (R1_FILES.indexOf(p) > -1 || starts(p, R1_DIRS)) return 'R1';
  if (starts(p, ['utils/'])) return 'R1';
  if (R2_FILES.indexOf(p) > -1 || starts(p, R2_DIRS)) return 'R2';
  if (starts(p, R3_DIRS) || R3_EXT.test(p)) return 'R3';
  // 认不出来的当界面级处理（宁可多看一眼，也不要漏）
  return 'R2';
}

function overallLevel(files) {
  const list = files || [];
  if (!list.length) return 'R3';
  return list.map(levelOf).sort((a, b) => ORDER[a] - ORDER[b])[0];
}

const SECTIONS = [
  { k: 'A', title: '写入路径（数据会不会静默丢 / 越权写）' },
  { k: 'B', title: '权限与机构隔离' },
  { k: 'C', title: '同步与云端一致（updatedAt / srvAt / 游标）' },
  { k: 'D', title: '备份与恢复（能不能真的恢复）' },
  { k: 'E', title: '页面层（WXML 表达式 / setData / 连点 / 资源释放）' },
  { k: 'F', title: '测试质量（失败路径 / await / 共享状态）' },
  { k: 'G', title: '合规（隐私 / 未成年人 / 内容安全）' },
  { k: 'H', title: '交付（部署步骤 / 迁移 / 真机清单 / 回滚）' }
];

function sectionsFor(files) {
  const list = (files || []).map(norm);
  const hit = {};
  const on = (k, cond) => { if (cond) hit[k] = 1; };
  const has = dir => list.some(p => p.indexOf(dir) === 0);
  const any = fn => list.some(fn);

  on('A', has('utils/db/') || has('cloudfunctions/syncv2/') || has('cloudfunctions/admin/'));
  on('B', any(p => /utils\/db\/(permissions|identity|members|ctx)\.js$/.test(p))
    || has('cloudfunctions/syncv2/') || has('cloudfunctions/admin/'));
  on('C', has('cloudfunctions/syncv2/') || has('cloudfunctions/admin/') || has('cloudfunctions/backup/')
    || any(p => /^utils\/(sync|syncmerge|api)\.js$/.test(p)));
  on('D', has('cloudfunctions/backup/') || any(p => /utils\/db\/(storage|maintenance|trash)\.js$/.test(p)));
  on('E', has('pages/') || has('components/'));
  on('F', has('tests/') || overallLevel(list) === 'R0' || overallLevel(list) === 'R1');
  on('G', has('pages/') || list.indexOf('app.json') > -1);
  on('H', has('cloudfunctions/') || list.indexOf('deploy.js') > -1 || list.indexOf('.github/workflows/deploy.yml') > -1
    || list.indexOf('utils/db/schema.js') > -1);

  // 只返回这张表里存在的章节，顺序固定，避免输出每次不一样
  return SECTIONS.filter(s => hit[s.k]);
}

// 机器看得见、人容易忘的提示。文案直接给"下一步动作"，不是提醒"注意一下"
function warnings(files, stat) {
  const list = (files || []).map(norm);
  const s = stat || {};
  const out = [];
  const has = dir => list.some(p => p.indexOf(dir) === 0);
  const hasFile = f => list.indexOf(f) > -1;
  const core = list.filter(p => levelOf(p) === 'R0' || levelOf(p) === 'R1');
  const touchedTests = has('tests/');

  if (core.length && !touchedTests) {
    out.push('G3：改了核心代码（R0/R1）但没有新增或修改断言 —— 至少补一条失败路径的断言');
  }
  if (has('tests/') && Number(s.removed || 0) > Number(s.added || 0)) {
    out.push('断言只增不减：这次测试文件的删除行多于新增行，确认没有悄悄删掉断言（删了要在提交信息里写原因）');
  }
  if (has('cloudfunctions/')) {
    out.push('部署：云函数改动需要「上传并部署：云端安装依赖」；新增/改定时器还要「上传触发器」；改逻辑记得在控制台核对超时与环境变量');
  }
  if (hasFile('utils/db/schema.js')) {
    out.push('迁移：schema.VERSION 加一 + migrate 写升级路径；真实新库不能重播演示数据');
  }
  if (has('pages/') || has('components/') || has('assets/') || has('images/')) {
    out.push('体积：跑 npm run size（上限 2 MB，主包超过 1.9 MB 就要处理）');
  }
  if (has('.github/workflows/')) {
    out.push('R0：改 CI 等于改发版闸门 —— 确认 verify（lint/test/size）仍排在 upload 之前，PR 仍只跑门禁不发版');
  }
  if (has('cloudfunctions/backup/')) {
    out.push('备份：新增或改动备份，必须有一条"真的恢复一次"的断言；只写不读的备份等于没有');
  }
  if (has('cloudfunctions/admin/')) {
    out.push('后台：每次写入都要带 updatedAt + srvAt，每个 where 都要带 orgId（有源码纪律断言盯着，别为了过测试放宽它）');
  }
  return out;
}

function titleOf(level) {
  return ({
    R0: 'R0 地基（权限/存储/schema/同步/备份/CI）',
    R1: 'R1 领域（其余 utils/db、api、其他云函数、deploy.js）',
    R2: 'R2 界面（pages / components / 资源）',
    R3: 'R3 外围（docs / tests / tools）'
  })[level] || level;
}

// 审查深度：R0 要独立审查 + 冷却；R1 要独立审查；R2/R3 自审 + 门禁
function depthOf(level) {
  if (level === 'R0') return '全清单 + 独立审查 + 放满 24 小时再合并 + 真机验证';
  if (level === 'R1') return '对应章节 + 一次独立审查 + npm run check';
  return '自审 + npm run check';
}

module.exports = {
  ORDER, R0_FILES, R0_DIRS, levelOf, overallLevel, sectionsFor, warnings, titleOf, depthOf
};
