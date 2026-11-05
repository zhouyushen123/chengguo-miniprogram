// cloudfunctions/backup/lib.js —— 云端每日备份的纯函数
//
// 这里刻意不 require wx-server-sdk：日期、路径、保留策略、恢复时怎么盖时间戳都是纯计算，
// tests/verify_cloudbackup.js 直接 require 就能测，不用连云端。
//
// 【备份放哪】文件放云存储（chengguo/backup/<机构号>/<日期>/<集合>[-n].json），
// 清单放 backups 集合。不把整包塞进一条文档：云数据库单文档有 16MB 上限，
// 记录一多就写不进去，而这种失败发生在半夜的定时任务里，没人会发现。
// 拆成文件后每片大小可控，也能单独下载出来检查。
const KEEP_DAYS = 30;     // 保留天数：够回看一个月，又不至于把免费存储吃满
const PART_DOCS = 2000;   // 单个文件最多装多少条（约 1~3MB，远低于单文件上限）
const MAX_DOCS = 20000;   // 单次单集合最多备份多少条（防超时；超了在清单里标 truncated）
const RESTORE_CAP = 2000; // 单次单集合最多写回多少条（云函数 60 秒，宁可分几次做完）
const COLLS = ['orgs', 'members', 'terms', 'classes', 'courses', 'subjects', 'knowledge_points',
  'students', 'enrollments', 'records', 'templates'];

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

// 本地日期。不能用 toISOString：那是 UTC，早上 8 点前会算成昨天，
// 备份文件名和"保留 30 天"的判定就会整体偏一天。
function ymd(ts) {
  const d = new Date(Number(ts) || Date.now());
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 日期字符串 → 天数序号（用 UTC 零点算，避开夏令时/时区差）
function dayNum(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date === undefined || date === null ? '' : date));
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
}

function isDate(date) {
  return !isNaN(dayNum(date));
}

// 一个机构一天一份清单，用固定 id 保证"同一天重复跑"是覆盖而不是堆一堆副本。
// tag 是"同一时间点上的另一份"：恢复前快照必须和日常备份分开存，
// 否则"恢复到今天"会先把今天的好备份覆盖成坏数据，再从这个位置恢复。
function manifestId(orgId, date, tag) {
  const t = String(tag || '');
  return String(orgId) + '_' + String(date) + (t ? '_' + t : '');
}

function pathOf(orgId, date, coll, part, tag) {
  const n = Number(part) || 1;
  const t = String(tag || '');
  const dir = t ? date + '_' + t : date;
  return 'chengguo/backup/' + orgId + '/' + dir + '/' + coll + (n > 1 ? '-' + n : '') + '.json';
}

// tag 会进云存储路径，只允许字母数字，长度封顶（防止有人传 ../ 之类的东西）
function cleanTag(tag) {
  return String(tag === undefined || tag === null ? '' : tag).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
}

// 云库自己的主键 _id 不属于业务数据（换环境会变）；_openid 是"谁写的"，
// 归档到机构备份里既不必要、也不该跟着备份搬到别处。
const PRIVATE = ['_id', '_openid'];
function cleanDoc(doc) {
  const x = Object.assign({}, doc || {});
  PRIVATE.forEach(k => { delete x[k]; });
  return x;
}

function chunk(list, n) {
  const size = Math.max(1, Number(n) || 1);
  const out = [];
  for (let i = 0; i < (list || []).length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// 过期清单：超过 KEEP_DAYS 天才删。今天往前第 30 天仍保留，第 31 天清掉。
function expired(rows, today, keepDays) {
  const t = dayNum(today);
  const keep = Number(keepDays === undefined ? KEEP_DAYS : keepDays);
  if (isNaN(t)) return [];
  return (rows || []).filter(r => {
    const d = dayNum(r && r.date);
    return !isNaN(d) && t - d > keep;
  });
}

// 恢复前快照只留最近 keep 份（同一天点五次恢复不该堆五份）。
// 返回该删的清单（调用方负责连文件一起删）。
function extraSafety(rows, keep) {
  const n = Math.max(0, Number(keep) || 0);
  const byDate = {};
  (rows || []).forEach(r => {
    if (!r || !r.safety) return;
    const d = String(r.date || '');
    (byDate[d] = byDate[d] || []).push(r);
  });
  const out = [];
  Object.keys(byDate).forEach(d => {
    const list = byDate[d].slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
    list.slice(n).forEach(r => out.push(r));
  });
  return out;
}

// 谁能操作备份。孩子家长连机构有多少条记录都不该看到，更不该触发备份/恢复。
const READ_ROLES = ['owner', 'admin', 'teacher'];
const WRITE_ROLES = ['owner', 'admin'];
function canRead(role) { return READ_ROLES.indexOf(String(role || '')) > -1; }
function canWrite(role) { return WRITE_ROLES.indexOf(String(role || '')) > -1; }

// 目标机构怎么定，是这一层最要紧的判断：
//   · 有 openid（小程序里调的）→ 只认他绑定的机构，客户端传什么 orgId 都不看，
//     否则改一个参数就能备份/列举别人的机构
//   · 没有 openid（定时器 / 后台服务端调）→ 用传进来的 orgId；不传就是"全部机构"
function resolveOrg(o) {
  const x = o || {};
  if (x.openid) return { internal: false, orgId: String(x.boundOrgId || ''), all: false };
  const asked = String(x.askedOrgId || '');
  return { internal: true, orgId: asked, all: !asked };
}

// 恢复写回时盖新时间戳：
//   updatedAt 变新 → 手机端 LWW 判定"云端更新"，不会拿本地旧值反推回去
//   srvAt 严格递增 → 手机端增量游标（srvAt > since）能捞到这次恢复
// 少任何一个，都会出现"后台说恢复好了，手机上还是坏的"。
function restoreDoc(src, opt) {
  const o = opt || {};
  const d = cleanDoc(src);
  d.updatedAt = Number(o.now) || Date.now();
  d.srvAt = Number(o.srvAt) || (Date.now() + 1);
  if (o.orgId) d.orgId = String(o.orgId);
  return d;
}

function countText(counts) {
  const c = counts || {};
  return '学生 ' + (c.students || 0) + ' · 老师 ' + (c.members || 0)
    + ' · 班级 ' + (c.classes || 0) + ' · 记录 ' + (c.records || 0);
}

module.exports = {
  KEEP_DAYS, PART_DOCS, MAX_DOCS, RESTORE_CAP, COLLS,
  ymd, dayNum, isDate, manifestId, pathOf, cleanTag, cleanDoc, chunk, expired, extraSafety,
  canRead, canWrite, resolveOrg, restoreDoc, countText
};
