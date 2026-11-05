// utils/db/content.js —— 内容域：学科（subjects）与知识点（knowledge_points）
//
// 【阶段一的定位】只建表、只留最小读写接口，不做任何界面。
// 学科在首次使用/升级时种子化 7 条；课程按名字猜一次 subjectId；知识点保持空表。
// 这样阶段二上题库时只是"往空表里填数据"，不需要再动一次全量历史数据。
//
// 【为什么不把这些塞进 courses.js】
// 学科与知识点是跨机构可共享的内容资产（平台资产），课程/班级是机构资产。
// 两者的隔离级别、同步策略、谁能写都不同（见 docs/architecture/data-model-plan.md 第 3 节），
// 混在一个模块里迟早会把"平台公共知识点"当成"本机构课程"来改。
//
// 【写权限】阶段一只有机构负责人在后台维护学科（org.manage）。
// 阶段二题库上线后再按"谁维护题库"细化到 admin / 教研角色，不在这里提前放开。
const { now, org, oc, deny, pushSaved, applyEdit, markRemoved } = require('./ctx');
const core = require('./core');
const schema = require('./schema');

/* ---------------- 学科 ---------------- */
function subjectList() {
  return oc('subjects').slice().sort((a, b) => (a.sort - b.sort) || (a.id - b.id));
}
function subjectGet(id) {
  return oc('subjects').find(s => s.id === Number(id)) || null;
}
function subjectByGid(gid) {
  const g = schema.str(gid).trim();
  return g ? (oc('subjects').find(s => s.gid === g) || null) : null;
}
// 给课程用：课程名 → 学科 id（猜不中 0）。做成接口是让页面不必自己 know 关键词表。
function guessFor(name) {
  return schema.guessSubjectId(name, subjectList());
}
function subjectCreate(data) {
  const err = deny('org.manage');
  if (err) return { ok: false, msg: err };
  const d = data || {};
  const e = schema.normalizeSubject({
    gid: d.gid || ('sub_' + Date.now().toString(36)),
    name: d.name, kind: d.kind, sort: d.sort
  }, org(), now());
  const ev = schema.validate('subject', e);
  if (ev) return { ok: false, msg: ev };
  if (subjectByGid(e.gid)) return { ok: false, msg: '学科标识已存在' };
  e.id = core.nextId();
  if (!pushSaved('subjects', e)) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: e };
}
// gid 一经生成永不变（阶段二题目按它引用），改名只改 name / kind / sort
function subjectUpdate(id, patch) {
  const s = subjectGet(id);
  if (!s) return { ok: false, msg: '学科不存在' };
  const err = deny('org.manage');
  if (err) return { ok: false, msg: err };
  const p = Object.assign({}, patch);
  delete p.gid; delete p.id;
  const next = schema.normalizeSubject(Object.assign({}, s, p), org(), now());
  const ev = schema.validate('subject', next);
  if (ev) return { ok: false, msg: ev };
  next.id = s.id; next.gid = s.gid; next.updatedAt = now();
  if (!applyEdit('subjects', s, next)) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: s };
}
// 还有课程挂在这个学科下就不许删：删了课程会指向一个不存在的学科，统计口径直接错
function subjectRemove(id) {
  const s = subjectGet(id);
  if (!s) return { ok: false, msg: '学科不存在' };
  const err = deny('org.manage');
  if (err) return { ok: false, msg: err };
  const used = oc('courses').filter(c => c.subjectId === s.id).length;
  if (used) return { ok: false, msg: '还有 ' + used + ' 门课程挂在这个学科下，请先改课程学科' };
  if (!applyEdit('subjects', s, markRemoved({}, now()))) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true };
}

/* ---------------- 知识点（阶段一只建结构） ---------------- */
function kpBase() {
  return oc('knowledge_points').slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : (a.sort - b.sort)));
}
function kpList(subjectId) {
  const sid = Number(subjectId) || 0;
  return kpBase().filter(k => !sid || k.subjectId === sid);
}
function kpGet(id) {
  return oc('knowledge_points').find(k => k.id === Number(id)) || null;
}
function kpByGid(gid) {
  const g = schema.str(gid).trim();
  return g ? (oc('knowledge_points').find(k => k.gid === g) || null) : null;
}
function kpChildren(parentId) {
  const pid = Number(parentId) || 0;
  return kpBase().filter(k => k.parentId === pid);
}
// 子树：云开发没有递归查询，只能靠物化路径前缀（这正是 path 必须存在的理由）
function kpSubtree(path) {
  const p = schema.str(path).trim();
  if (!p) return [];
  return kpBase().filter(k => k.path === p || k.path.indexOf(p + '/') === 0);
}
function kpCreate(data) {
  const err = deny('org.manage');
  if (err) return { ok: false, msg: err };
  const d = data || {};
  const parent = d.parentId ? kpGet(d.parentId) : null;
  if (d.parentId && !parent) return { ok: false, msg: '父知识点不存在' };
  const name = schema.str(d.name).trim();
  if (!name) return { ok: false, msg: '知识点名称不能为空' };
  const e = schema.normalizeKnowledgePoint({
    gid: d.gid || ('kp_' + Date.now().toString(36)),
    subjectId: d.subjectId !== undefined ? d.subjectId : (parent && parent.subjectId),
    parentId: parent ? parent.id : 0,
    // path 一律由父节点推导，不让调用方手拼：手拼的路径少一层，子树查询就漏一片
    path: parent ? (parent.path + '/' + name) : name,
    depth: parent ? parent.depth + 1 : 0,
    name, grade: d.grade, code: d.code, sort: d.sort,
    source: d.source || 'org'
  }, org(), now());
  const ev = schema.validate('knowledgePoint', e);
  if (ev) return { ok: false, msg: ev };
  if (kpByGid(e.gid)) return { ok: false, msg: '知识点标识已存在' };
  if (kpBase().some(k => k.subjectId === e.subjectId && k.path === e.path)) {
    return { ok: false, msg: '同一学科下已有同名知识点' };
  }
  e.id = core.nextId();
  if (!pushSaved('knowledge_points', e)) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: e };
}
// 改名字要连带改自己与全部子孙的 path，否则前缀查询找不到它们（阶段二真正录入后才有用）
function kpUpdate(id, patch) {
  const k = kpGet(id);
  if (!k) return { ok: false, msg: '知识点不存在' };
  const err = deny('org.manage');
  if (err) return { ok: false, msg: err };
  const p = Object.assign({}, patch);
  delete p.gid; delete p.id; delete p.path; delete p.depth; delete p.parentId; delete p.subjectId;
  const name = schema.str(p.name === undefined ? k.name : p.name).trim();
  if (!name) return { ok: false, msg: '知识点名称不能为空' };
  // path 一定以自身 name 结尾（kpCreate 就是这么拼的），直接换尾巴，不用正则
  const nextPath = k.path.slice(0, k.path.length - k.name.length) + name;
  const next = schema.normalizeKnowledgePoint(Object.assign({}, k, p, { name, path: nextPath }), org(), now());
  next.id = k.id; next.gid = k.gid; next.updatedAt = now();
  return core.tx(() => {
    if (!applyEdit('knowledge_points', k, next)) return { ok: false, msg: core.SAVE_FAIL };
    if (nextPath !== k.path) {
      const oldPrefix = k.path + '/';
      kpBase().forEach(x => {
        if (x.id === k.id || x.path.indexOf(oldPrefix) !== 0) return;
        x.path = nextPath + x.path.slice(k.path.length);
        x.updatedAt = now();
      });
      if (!core.persist('knowledge_points')) return { ok: false, msg: core.SAVE_FAIL };
    }
    return { ok: true, item: k };
  });
}
// 有子节点不许删：删父留子会让子节点的 path 指向一个不存在的上级
function kpRemove(id) {
  const k = kpGet(id);
  if (!k) return { ok: false, msg: '知识点不存在' };
  const err = deny('org.manage');
  if (err) return { ok: false, msg: err };
  if (kpChildren(k.id).length) return { ok: false, msg: '请先删除它的子知识点' };
  if (!applyEdit('knowledge_points', k, markRemoved({}, now()))) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true };
}

module.exports = {
  subjectList, subjectGet, subjectByGid, guessFor, subjectCreate, subjectUpdate, subjectRemove,
  kpList, kpGet, kpByGid, kpChildren, kpSubtree, kpCreate, kpUpdate, kpRemove
};
