// utils/db/schema-base.js —— 数据模型的地基：机构号、类型工具、审计字段
//
// 为什么单独成文件：schema.js 有 500 行规模上限（tests/verify_arch.js 守着），
// 而"课程/绑定的规范化"这类纯字段逻辑又必须能在不 import 整个 schema 的情况下复用。
// 这里只放不依赖任何实体定义的东西，方向永远是 schema-base ← schema ← 领域模块。

// 出厂机构号：每台新装设备的本地库都挂它，**它不是一个真实机构**。
// 首次上云时由服务端发一个随机机构号（见 syncv2 的 hello），本地整体改挂过去。
// 以前它被当成真实机构号用，结果所有客户的数据都落在 org1 里混成一团——
// 那在单客户测试期看不出来，第二个客户进来就是灾难。
const DEFAULT_ORG = 'org1';
const FACTORY_ORG = DEFAULT_ORG;
// 机构号字符集：去掉容易看错的 0/o/1/l/i，它是会被人从日志里念出来的
const ORG_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function newOrgId(rand) {
  const r = rand || Math.random;
  let s = '';
  for (let i = 0; i < 10; i++) {
    const x = Math.min(0.999999, Math.max(0, Number(r()) || 0));
    s += ORG_CHARS[Math.floor(x * ORG_CHARS.length)];
  }
  return 'org_' + s;
}
// 还挂在出厂号上 = 这台设备的机构号还没被服务端换成真实值
const isFactoryOrg = id => String(id || '') === FACTORY_ORG;

/* ---------------- 基础类型工具（容错优先，脏数据不抛错） ---------------- */
const str = (v, d) => (typeof v === 'string' ? v : (v === null || v === undefined ? (d || '') : String(v)));
const num = (v, d) => { const x = Number(v); return isFinite(x) ? x : d; };
const list = v => (Array.isArray(v) ? v : []);
const numList = v => list(v).map(Number).filter(x => isFinite(x));
const txtList = v => list(v).map(x => str(x).trim()).filter(Boolean);
const pad2 = n => (n < 10 ? '0' : '') + n;

// 统一日期格式 YYYY-MM-DD（历史数据里有 2026-11-1 这种没补零的写法，字符串排序会错位）
function ymd(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
}
function normDate(v) {
  const m = str(v).trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  return m ? m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]) : '';
}

// 公共审计字段：所有实体强制携带
//
// 【orgId 必须听调用方的】领域层新建时都传 org()（当前机构号）。这里以前写死回落
// DEFAULT_ORG('org1')，把参数 orgId 整个丢了：设备首次上云后 meta.orgId 已被服务端换成
// org_xxx，此后每新建一条行都还挂 org1，被 orgColl() 立刻过滤掉——页面表现为
// 「刚建的班级查不到」「班级不存在或已删除」，重启后又被收编冒出来变成重复数据。
// 顺序：行上已有 orgId 优先保留（迁移/编辑不改写归属）→ 调用方给的 → 出厂号兜底。
function audit(raw, orgId, stamp) {
  const r = raw || {};
  const created = num(r.createdAt, 0) || stamp;
  const removed = r.removed === true;
  const owner = str(r.orgId, '').trim() || str(orgId, '').trim() || DEFAULT_ORG;
  return {
    orgId: owner,
    createdAt: created,
    updatedAt: num(r.updatedAt, 0) || stamp,
    removed,
    // 删除痕迹：removedAt 是「哪一次删除」的标记。删学生/删班级会连带软删记录、报名、班级课程绑定，
    // 它们共用同一个 removedAt —— 回收站靠这个值把一整批认出来，一起还原。
    // 已经删过的行不改写原值，否则后来的一次删除会把两次删的东西混成一批，还原时"复活"错的条目。
    removedAt: removed ? (num(r.removedAt, 0) || num(r.updatedAt, 0) || stamp) : 0,
    removedBy: removed ? num(r.removedBy, 0) : 0
  };
}

module.exports = {
  DEFAULT_ORG, FACTORY_ORG, ORG_CHARS, newOrgId, isFactoryOrg,
  str, num, list, numList, txtList, pad2, ymd, normDate, audit
};
