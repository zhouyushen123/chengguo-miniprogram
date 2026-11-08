// cloudfunctions/admin/platform.js —— 平台控制台的纯函数（不碰数据库，node 里可直接测）
//
// 【这一层和 lib.js 的分工】
//   lib.js      机构后台：口令节奏、CSV 转义、字段白名单、分页
//   platform.js 平台控制台：跨机构统计口径（趋势 / 分数分档 / 机构汇总）与平台口令校验
//
// 【为什么统计口径要单独拎出来】同一个"发布率"在机构页和平台页必须是同一个算法，
// 否则运营看到 87%、机构自己看到 84%，两边就开始互相怀疑数据。这里只留一份定义。
const lib = require('./lib');

const DAY = 86400000;
const pad2 = n => String(n).padStart(2, '0');
function ymd(d) {
  const x = d instanceof Date ? d : new Date(Number(d) || 0);
  return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
}
function todayStr(now) {
  const d = now ? new Date(Number(now)) : new Date();
  return ymd(d);
}
function addDays(ymdStr, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymdStr || ''));
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return ymd(new Date(d.getTime() + Number(n || 0) * DAY));
}
// 近 n 天（含今天）的日期表，从早到晚
function lastDays(n, endYmd) {
  const end = endYmd || todayStr();
  const out = [];
  for (let i = Number(n || 0) - 1; i >= 0; i--) out.push(addDays(end, -i));
  return out;
}

/* ---------------- 趋势 ----------------
 * 按「记录上的上课日期 date」统计，不是按 created 时间：
 * 老师周五补录周三的课，运营要看的是"周三有没有课"。
 */
function trendOf(records, days, endYmd) {
  const list = lastDays(days, endYmd);
  const idx = {};
  list.forEach((d, i) => { idx[d] = i; });
  const out = list.map(d => ({ d, n: 0, sent: 0 }));
  (records || []).forEach(r => {
    const i = idx[String(r && r.date)];
    if (i === undefined) return;
    out[i].n += 1;
    if (r.sent) out[i].sent += 1;
  });
  return out;
}

/* ---------------- 分数分档 ----------------
 * 档位名与小程序「评分五档」一致（待提高/加油/良好/优秀/最佳），
 * 分数区间按锚点 60/75/85/92/98 切，边界归入下一档，避免 85 分既是"良好"又是"优秀"。
 */
const BANDS = [
  { k: 'b1', t: '待提高', min: 0, max: 60 },
  { k: 'b2', t: '加油', min: 60, max: 75 },
  { k: 'b3', t: '良好', min: 75, max: 85 },
  { k: 'b4', t: '优秀', min: 85, max: 92 },
  { k: 'b5', t: '最佳', min: 92, max: 101 }
];
function scoreDist(records) {
  const out = BANDS.map(b => ({ k: b.k, t: b.t, n: 0 }));
  (records || []).forEach(r => {
    const s = Number(r && r.score);
    if (!isFinite(s) || s <= 0) return;      // 0 / 空 = 没打分，不进分布
    for (let i = 0; i < BANDS.length; i++) {
      if (s >= BANDS[i].min && s < BANDS[i].max) { out[i].n += 1; return; }
    }
    out[out.length - 1].n += 1;             // 超过 100 的按最高档
  });
  return out;
}
function avgScore(records) {
  const arr = (records || []).map(r => Number(r && r.score)).filter(s => isFinite(s) && s > 0);
  if (!arr.length) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}
// 等级文案分布（后台看"老师习惯用哪一档"，和分数分布是两件事）
function tagDist(records) {
  const map = {};
  (records || []).forEach(r => {
    const t = String((r && r.tag) || '').trim();
    if (!t) return;
    map[t] = (map[t] || 0) + 1;
  });
  return Object.keys(map).map(t => ({ t, n: map[t] })).sort((a, b) => b.n - a.n);
}

/* ---------------- 机构汇总 ----------------
 * agg 形如 { students:{orgId:n}, classes:{...}, records:{...}, members:{...},
 *           sent:{...}, teachers:{...}, parents:{...}, lastDate:{orgId:'2026-11-07'} }
 * orgs 是机构档案数组。输出按学生数倒序，运营第一眼要看"谁家在用"。
 */
function mergeOrgs(orgs, agg) {
  const a = agg || {};
  const get = (k, id) => Number((a[k] || {})[id]) || 0;
  return (orgs || []).filter(o => !o.removed).map(o => {
    const id = String(o.id);
    const students = get('students', id);
    const records = get('records', id);
    return {
      orgId: id,
      name: String(o.name || '未命名机构'),
      status: String(o.status || 'active'),
      owner: String(o.ownerName || ''),
      createdAt: Number(o.createdAt) || 0,
      students,
      classes: get('classes', id),
      records,
      members: get('members', id),
      teachers: get('teachers', id),
      parents: get('parents', id),
      sent: get('sent', id),
      rate: lib.pct(get('sent', id), records),
      lastDate: String((a.lastDate || {})[id] || ''),
      // 每名学生平均被记录多少次：低于 1 说明"建了档但没在上课"，比学生数更能看出活不活跃
      perStudent: students ? Math.round((records / students) * 10) / 10 : 0
    };
  }).sort((x, y) => (y.students - x.students) || (y.records - x.records));
}

// 全局汇总：机构清单 + 记录明细 → 一张总表
function globalStat(rows, records, memberRoles) {
  const sum = (k) => (rows || []).reduce((n, r) => n + (Number(r[k]) || 0), 0);
  const recs = records || [];
  const sent = recs.filter(r => r && r.sent).length;
  const roles = memberRoles || {};
  return {
    orgs: (rows || []).length,
    students: sum('students'),
    classes: sum('classes'),
    records: sum('records'),
    members: sum('members'),
    teachers: (Number(roles.teacher) || 0),
    parents: (Number(roles.parent) || 0),
    admins: (Number(roles.admin) || 0) + (Number(roles.owner) || 0),
    sent,
    draft: Math.max(0, recs.length - sent),
    rate: lib.pct(sent, recs.length),
    avgScore: avgScore(recs),
    photos: recs.reduce((n, r) => n + ((r && r.photos || []).length), 0),
    videos: recs.reduce((n, r) => n + ((r && r.videos || []).length), 0),
    audios: recs.filter(r => r && r.audio).length
  };
}

/* ---------------- 平台口令 ----------------
 * 【为什么平台账号不走数据库生成】平台账号能看到所有机构的数据，不能靠"某个机构负责人
 * 在手机上点一下"生成。它只能来自部署者手里的环境变量：
 *   PLATFORM_PIN     必填，6 位以上；不配则平台登录直接关闭（fail-closed）
 *   PLATFORM_ACCOUNT 选填，默认 CGPLAT
 * 口令存在函数环境变量里，不在代码、不在数据库，换人时在控制台改一次即可。
 */
const PLAT_ACCOUNT = 'CGPLAT';
function platEnv(env) {
  const e = env || {};
  return {
    account: lib.normAccount(e.PLATFORM_ACCOUNT || PLAT_ACCOUNT),
    pin: String(e.PLATFORM_PIN || '').trim(),
    ready: String(e.PLATFORM_PIN || '').trim().length >= 6
  };
}
// 定长比较，避免"错第几位"从耗时上被看出来
function samePin(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
// rec 是平台账号在 admin_accounts 里的锁状态记录（可为 null）
function platAuth(data, env, rec, now) {
  const e = platEnv(env);
  if (!e.ready) {
    return { ok: false, code: 'NO_ENV', msg: '平台口令还没配置：请在云开发控制台给 admin 云函数加环境变量 PLATFORM_PIN（6 位以上）' };
  }
  const t = Number(now) || Date.now();
  const lock = lib.lockedUntil(rec, t);
  if (lock) return { ok: false, code: 'LOCKED', until: lock, msg: '试错了太多次，请 ' + Math.ceil((lock - t) / 60000) + ' 分钟后再试' };
  const account = lib.normAccount((data || {}).account);
  const pin = String((data || {}).pin || '').trim();
  // 账号对不上也按"口令错"处理：不告诉对方账号是不是存在
  if (account !== e.account || !samePin(pin, e.pin)) {
    const next = lib.afterFail(rec, t);
    if (next.lockUntil) return { ok: false, code: 'LOCKED', next, until: next.lockUntil, msg: '试错了太多次，请 10 分钟后再试' };
    return { ok: false, code: 'BAD_PIN', next, msg: '账号或口令不对' };
  }
  return { ok: true, next: { fail: 0, lockUntil: 0, lastAt: t }, account };
}

/* ---------------- 导出 ---------------- */
function orgsCsv(rows) {
  return lib.csvOf(rows || [], [
    { t: '机构名称', f: r => r.name },
    { t: '机构号', f: r => r.orgId },
    { t: '负责人', f: r => r.owner || '—' },
    { t: '学生数', f: r => r.students },
    { t: '班级数', f: r => r.classes },
    { t: '记录数', f: r => r.records },
    { t: '发布率%', f: r => r.rate },
    { t: '每生记录数', f: r => r.perStudent },
    { t: '老师数', f: r => r.teachers },
    { t: '家长数', f: r => r.parents },
    { t: '最近上课', f: r => r.lastDate || '—' },
    { t: '状态', f: r => (r.status === 'suspended' ? '已停用' : '正常') }
  ]);
}
function studentsCsv(rows) {
  return lib.csvOf(rows || [], [
    { t: '机构', f: r => r.orgName },
    { t: '学号', f: r => r.no || '' },
    { t: '姓名', f: r => r.name || '' },
    { t: '班级', f: r => (r.clsNames || []).join('、') },
    { t: '记录数', f: r => r.records },
    { t: '最近记录', f: r => r.lastDate || '—' },
    { t: '家长', f: r => r.parent || '' },
    { t: '微信/手机', f: r => r.wechat || '' },
    { t: '入学年份', f: r => r.enrollYear || '' }
  ]);
}

module.exports = {
  DAY, BANDS, PLAT_ACCOUNT,
  pad2, ymd, todayStr, addDays, lastDays,
  trendOf, scoreDist, avgScore, tagDist,
  mergeOrgs, globalStat,
  platEnv, samePin, platAuth,
  orgsCsv, studentsCsv
};
