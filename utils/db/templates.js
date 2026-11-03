// utils/db/templates.js —— 评价模板（机构统一话术）
// 依赖：ctx（底座）。模板是独立聚合，不依赖任何其他领域模块。
const { now, org, oc, deny } = require('./ctx');
const core = require('./core');
const schema = require('./schema');

function tplList() {
  return oc('templates').slice().sort((a, b) => (a.sort - b.sort) || (a.id - b.id));
}
function tplGet(id) {
  const x = Number(id);
  return oc('templates').find(t => t.id === x) || null;
}
function tplCreate(data) {
  const err = deny('template.write');
  if (err) return { ok: false, msg: err };
  const list = tplList();
  const e = schema.normalizeTemplate({
    name: data && data.name, options: data && data.options, sort: list.length
  }, org(), now());
  const ev = schema.validate('template', e);
  if (ev) return { ok: false, msg: ev };
  e.id = core.nextId();
  core.coll('templates').push(e);
  core.persist('templates');
  return { ok: true, item: e };
}
function tplUpdate(id, patch) {
  const err = deny('template.write');
  if (err) return { ok: false, msg: err };
  const t = tplGet(id);
  if (!t) return { ok: false, msg: '模板不存在' };
  const next = schema.normalizeTemplate(Object.assign({}, t, patch), org(), now());
  const ev = schema.validate('template', next);
  if (ev) return { ok: false, msg: ev };
  next.id = t.id; next.updatedAt = now();
  Object.assign(t, next);
  core.persist('templates');
  return { ok: true, item: t };
}
function tplRemove(id) {
  const err = deny('template.write');
  if (err) return { ok: false, msg: err };
  const t = tplGet(id);
  if (!t) return { ok: false, msg: '模板不存在' };
  t.removed = true; t.updatedAt = now();
  core.persist('templates');
  return { ok: true };
}
function tplAddOption(id, text) {
  const err = deny('template.write');
  if (err) return { ok: false, msg: err };
  const t = tplGet(id);
  const v = schema.str(text).trim();
  if (!t) return { ok: false, msg: '模板不存在' };
  if (!v) return { ok: false, msg: '内容不能为空' };
  if (t.options.indexOf(v) > -1) return { ok: false, msg: '已有相同选项' };
  t.options.push(v); t.updatedAt = now();
  core.persist('templates');
  return { ok: true, item: t, index: t.options.length - 1 };
}
function tplUpdateOption(id, index, text) {
  const err = deny('template.write');
  if (err) return { ok: false, msg: err };
  const t = tplGet(id);
  const v = schema.str(text).trim();
  if (!t) return { ok: false, msg: '模板不存在' };
  if (!v) return { ok: false, msg: '内容不能为空' };
  if (index < 0 || index >= t.options.length) return { ok: false, msg: '选项不存在' };
  t.options[index] = v; t.updatedAt = now();
  core.persist('templates');
  return { ok: true, item: t };
}
function tplRemoveOption(id, index) {
  const err = deny('template.write');
  if (err) return { ok: false, msg: err };
  const t = tplGet(id);
  if (!t) return { ok: false, msg: '模板不存在' };
  if (index < 0 || index >= t.options.length) return { ok: false, msg: '选项不存在' };
  t.options.splice(index, 1); t.updatedAt = now();
  core.persist('templates');
  return { ok: true };
}
// 整表覆盖（兼容旧接口 saveTpls 用）
function tplReplaceAll(list) {
  const err = deny('template.write');
  if (err) return { ok: false, msg: err };
  const cur = tplList();
  const next = (Array.isArray(list) ? list : []).map((t, i) => {
    const e = schema.normalizeTemplate({
      id: (cur[i] && cur[i].id) || 0, name: t.n || t.name, options: t.opts || t.options, sort: i
    }, org(), now());
    if (!e.id) e.id = core.nextId();
    return e;
  });
  core.setColl('templates', next);
  return { ok: true };
}

module.exports = {
  tplList, tplGet, tplCreate, tplUpdate, tplRemove,
  tplAddOption, tplUpdateOption, tplRemoveOption, tplReplaceAll
};
