// utils/db/org.js —— 机构（当前安装对应的那一家）
// 依赖：ctx（底座）。不依赖任何其他领域模块。
const { now, org, oc, deny, applyEdit } = require('./ctx');
const core = require('./core');
const schema = require('./schema');

function orgCurrent() {
  return oc('orgs').find(o => o.id === org()) || null;
}
function orgUpdate(patch) {
  const err = deny('org.manage');
  if (err) return { ok: false, msg: err };
  const o = orgCurrent();
  if (!o) return { ok: false, msg: '机构不存在' };
  const next = schema.normalizeOrg(Object.assign({}, o, patch), now());
  const e = schema.validate('org', next);
  if (e) return { ok: false, msg: e };
  next.id = o.id; next.updatedAt = now();
  if (!applyEdit('orgs', o, next)) return { ok: false, msg: core.SAVE_FAIL };
  core.updateMeta({ orgName: o.name });
  return { ok: true, item: o };
}

// 机构名的合法性判定，只回错误文案（空串=通过）。
// 申请页（还没权限写机构表）与设置页（真要写）共用这一份，
// 免得两边各写一套长度规则，一边改了另一边忘了。
function orgCheckName(name) {
  return schema.validate('org', { name: schema.str(name).trim() }) || '';
}

module.exports = { orgCurrent, orgUpdate, orgCheckName };
