// utils/db/org.js —— 机构（当前安装对应的那一家）
// 依赖：ctx（底座）。不依赖任何其他领域模块。
const { now, org, oc, deny } = require('./ctx');
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
  Object.assign(o, next);
  core.persist('orgs');
  core.updateMeta({ orgName: o.name });
  return { ok: true, item: o };
}

module.exports = { orgCurrent, orgUpdate };
