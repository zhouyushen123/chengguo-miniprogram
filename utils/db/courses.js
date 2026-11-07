// utils/db/courses.js —— 课程（内容单元）与「班级 × 课程」绑定
//
// 【V10 起课程不再"属于"某个班级】
// 一门课只存一条，可以同时开在任意多个班里；关系存在 class_courses：
// { clsId, courseId, sort, teacherId }。
//
// 为什么要拆：以前 clsId 必填，等于"内容被组织绑死"——
// 同一门楷书开 5 个班就有 5 条课程记录，将来题库/教案/作业也要跟着复制 5 份，
// 改一道题改 5 处。拆开后题目挂在课程上，班级只负责"什么时候、谁来上"。
//
// 【可见性不再能靠 clsId 判】
// 规则：管理级全见；老师 = 自己可见班级上的绑定所指向的课程 ∪ 成员上显式授权的 courseIds；
//       家长按孩子所在班看到课程（家长端一般只读记录里的课程名文字，不读这张表）。
//
// 【课程是资产，绑定是关系】
// 删班只解绑，不删课（课程可能还开在别的班，也可能只是暂时不开）；
// 解绑后没有任何班的课程留在课程库的"未分配"里，由人决定要不要删。
const { now, org, oc, ocAll, actor, deny, pushSaved, applyEdit, markRemoved, markAlive } = require('./ctx');
const core = require('./core');
const schema = require('./schema');
const perms = require('./permissions');

/* ---------------- 绑定读取 ---------------- */

// 一个班上的课程绑定，按教学顺序排（sort 优先，没排过的按建课先后）
function bindingOf(clsId) {
  const x = Number(clsId);
  return oc('class_courses')
    .filter(b => b.clsId === x)
    .sort((a, b) => (a.sort - b.sort) || (a.id - b.id));
}

// 这个班开了哪些课（id 列表，顺序即上课选课的顺序）
function courseIdsOf(clsId) {
  return bindingOf(clsId).map(b => b.courseId);
}

// 这门课开在哪些班。班级已被删掉的不算——绑定可能还在回收站里没跟着走。
// all = true 时连"已解绑"的行也算上（回收站要判断"这门课曾开在我管的班上"）。
function classIdsOf(courseId, all) {
  const x = Number(courseId);
  const src = all ? ocAll('class_courses') : oc('class_courses');
  const out = [];
  src.forEach(b => {
    if (b.courseId !== x || out.indexOf(b.clsId) > -1) return;
    if (!oc('classes').some(c => c.id === b.clsId)) return;
    out.push(b.clsId);
  });
  return out;
}

// 某门课在某个班的那条绑定（幂等判断用）
function bindingFind(clsId, courseId) {
  const c = Number(clsId), k = Number(courseId);
  return oc('class_courses').find(b => b.clsId === c && b.courseId === k) || null;
}

/* ---------------- 可见性 ---------------- */

// 返回 null 表示不限制（管理级）；否则是 courseId 的集合
function visibleCourseIds(a) {
  if (!a) return {};
  if (a.all) return null;
  const set = {};
  oc('class_courses').forEach(b => {
    if (perms.canSeeClass(a, b.clsId)) set[b.courseId] = 1;
  });
  // 成员上直接授权的课程（历史数据里就有，保留语义：授权比绑定更优先）
  a.courseIds.forEach(id => { set[id] = 1; });
  return set;
}

const withCls = c => Object.assign({}, c, { classIds: classIdsOf(c.id) });

function courseList() {
  const a = actor();
  if (!a) return [];
  const vis = visibleCourseIds(a);
  return oc('courses')
    .filter(c => vis === null || vis[c.id])
    .sort((x, y) => (x.subjectId - y.subjectId) || (x.id - y.id))
    .map(withCls);
}

// 一个班的课程（上课选课用）。签名与 V9 一致，页面不用改。
function courseOf(clsId) {
  const x = Number(clsId);
  const a = actor();
  if (!perms.canSeeClass(a, x)) return [];
  const ids = courseIdsOf(x);
  const out = [];
  ids.forEach(id => {
    const c = oc('courses').find(y => y.id === id);
    if (c) out.push(withCls(c));
  });
  return out;
}

function courseGet(id) {
  const x = Number(id);
  const c = oc('courses').find(y => y.id === x);
  if (!c) return null;
  const vis = visibleCourseIds(actor());
  return (vis === null || vis[c.id]) ? withCls(c) : null;
}

/* ---------------- 写：课程本体 ---------------- */

// 建课。clsId / clsIds 都可以不传——建的是"课程库里的一条内容"，
// 之后在任何班开课都是它，不再复制。
// 传了班级就顺手绑定（向导、快速建课的旧路径都靠这个保持一次点击完成）。
function courseCreate(data) {
  const d = data || {};
  const name = schema.str(d.name).trim();
  if (!name) return { ok: false, msg: '课程名称不能为空' };
  // 详细介绍与扩展槽也是课程本体的一部分，建课时一并落库（以前只透传 name/subjectId，填了会丢）
  const intro = schema.str(d.intro).trim().slice(0, 500);

  const clsIds = schema.numList(
    d.clsIds !== undefined ? d.clsIds : (d.clsId ? [d.clsId] : [])
  );
  // 指定了班级就按那个班鉴权；没指定也要按角色拦一次（老师不能往课程库里加东西）
  const targets = clsIds.length ? clsIds : [undefined];
  for (let i = 0; i < targets.length; i++) {
    const err = deny('course.write', targets[i] ? { clsId: targets[i] } : undefined);
    if (err) return { ok: false, msg: err };
  }
  // 绑定的班必须真实存在，否则会留下一条指向空气的绑定
  for (let i = 0; i < clsIds.length; i++) {
    if (!oc('classes').some(c => c.id === clsIds[i])) return { ok: false, msg: '班级不存在或已删除' };
  }

  const subjectId = (d.subjectId !== undefined && d.subjectId !== '')
    ? schema.num(d.subjectId, 0)
    : schema.guessSubjectId(name, oc('subjects'));

  // 课程库里去重：同名同科目就是同一门课，直接复用并绑定，不制造第二条。
  // 不这么做的话"彻底分开"只是把复制从班级挪到了课程库，问题没解决。
  const same = oc('courses').find(c => c.name === name && (!subjectId || !c.subjectId || c.subjectId === subjectId));
  if (same) {
    // 复用老课时顺手补齐空字段：学科、详细介绍。已有的内容不覆盖，免得别人写好的说明被冲掉。
    const patch = {};
    if (subjectId && !same.subjectId) patch.subjectId = subjectId;
    if (intro && !same.intro) patch.intro = intro;
    if (Object.keys(patch).length) { patch.updatedAt = now(); applyEdit('courses', same, patch); }
    for (let i = 0; i < clsIds.length; i++) bindQuiet(clsIds[i], same.id);
    return { ok: true, item: same, reused: true };
  }

  const e = schema.normalizeCourse({ name, subjectId, intro, meta: d.meta }, org(), now());
  const ev = schema.validate('course', e);
  if (ev) return { ok: false, msg: ev };
  e.id = core.nextId();
  if (!pushSaved('courses', e)) return { ok: false, msg: core.SAVE_FAIL };
  for (let i = 0; i < clsIds.length; i++) bindQuiet(clsIds[i], e.id);
  return { ok: true, item: e };
}

function courseUpdate(id, patch) {
  const c = oc('courses').find(y => y.id === Number(id));
  if (!c) return { ok: false, msg: '课程不存在' };
  const err = deny('course.write');
  if (err) return { ok: false, msg: err };
  const p = Object.assign({}, patch);
  const next = schema.normalizeCourse(Object.assign({}, c, p), org(), now());
  // 改名后没显式指定学科、原来也没归类 → 再猜一次；已有学科不因改名被冲掉
  if ((p.subjectId === undefined || p.subjectId === '') && !c.subjectId) {
    next.subjectId = schema.guessSubjectId(next.name, oc('subjects'));
  }
  const ev = schema.validate('course', next);
  if (ev) return { ok: false, msg: ev };
  next.id = c.id; next.updatedAt = now();
  if (!applyEdit('courses', c, next)) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: c };
}

// 删课：连带把它在所有班的绑定一起软删（共用同一个 removedAt，还原时认批）
function courseRemove(id) {
  const c = oc('courses').find(y => y.id === Number(id));
  if (!c) return { ok: false, msg: '课程不存在' };
  const err = deny('course.write');
  if (err) return { ok: false, msg: err };
  return core.tx(() => {
    const t = now();
    applyEdit('courses', c, markRemoved({}, t));
    oc('class_courses').forEach(b => {
      if (b.courseId === c.id && !b.removed) applyEdit('class_courses', b, markRemoved({}, t));
    });
    core.persist('class_courses');
    return { ok: true };
  });
}

// 从回收站还原课程。记录上的课程名是独立文字，不受影响；绑定按同一批次的 removedAt 认回来，
// 但只还原"班级还在"的那些——班还在回收站里就先把班还原。
function courseRestore(id) {
  const c = ocAll('courses').find(x => x.id === Number(id) && x.removed);
  if (!c) return { ok: false, msg: '回收站里没有这门课' };
  // 已合并的副本不能还原：还原它等于把刚收拢的重复课又造回来
  if (c.mergedInto) {
    const keep = oc('courses').find(x => x.id === c.mergedInto);
    return { ok: false, msg: '这门课已合并到「' + ((keep && keep.name) || '同名课程') + '」' };
  }
  const err = deny('course.write');
  if (err) return { ok: false, msg: err };
  return core.tx(() => {
    const t = now();
    const at = c.removedAt;
    markAlive(c, t);
    let n = 0;
    ocAll('class_courses').forEach(b => {
      if (b.courseId !== c.id || !b.removed) return;
      if (at && b.removedAt !== at) return;
      if (!oc('classes').some(x => x.id === b.clsId)) return;
      markAlive(b, t); n++;
    });
    core.persist('class_courses');
    return { ok: true, bindings: n };
  });
}

/* ---------------- 写：绑定（在哪个班开这门课） ---------------- */

// 内部用：已鉴权过的场景（建课顺手绑、迁移）直接绑，失败也不抛
function bindQuiet(clsId, courseId) {
  const c = Number(clsId), k = Number(courseId);
  if (!c || !k) return { ok: false };
  if (bindingFind(c, k)) return { ok: true, existed: true };
  const rows = bindingOf(c);
  const e = schema.normalizeClassCourse({
    id: core.nextId(), clsId: c, courseId: k,
    sort: rows.length ? (rows[rows.length - 1].sort + 1) : 0
  }, org(), now());
  if (!pushSaved('class_courses', e)) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: e };
}

// 给某个班开一门课。幂等：已经开过就直接返回那条绑定，不报错。
function courseBind(clsId, courseId) {
  const c = Number(clsId), k = Number(courseId);
  const err = deny('course.write', { clsId: c });
  if (err) return { ok: false, msg: err };
  if (!oc('classes').some(x => x.id === c)) return { ok: false, msg: '班级不存在或已删除' };
  if (!oc('courses').some(x => x.id === k)) return { ok: false, msg: '课程不存在或已删除' };
  return bindQuiet(c, k);
}

// 从某个班撤掉一门课：只解绑，课程本身留着（可能还开在别的班）
function courseUnbind(clsId, courseId) {
  const c = Number(clsId), k = Number(courseId);
  const err = deny('course.write', { clsId: c });
  if (err) return { ok: false, msg: err };
  const b = bindingFind(c, k);
  if (!b) return { ok: true, existed: false };
  const left = bindingOf(c).length - 1;
  if (!applyEdit('class_courses', b, markRemoved({}, now()))) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, left, classIds: classIdsOf(k) };
}

// 把某门课的开设班级整体设成 clsIds（多选保存用）：多的绑上、少的解开。
// 页面上的"勾选班级"就是这么落地的——它描述的是结果状态，不是一串增量操作。
function courseSetClasses(courseId, clsIds) {
  const k = Number(courseId);
  if (!oc('courses').some(x => x.id === k)) return { ok: false, msg: '课程不存在或已删除' };
  const want = schema.numList(clsIds);
  const err = deny('course.write');
  if (err) return { ok: false, msg: err };
  return core.tx(() => {
    const have = classIdsOf(k);
    let added = 0, removed = 0;
    for (let i = 0; i < want.length; i++) {
      const cid = want[i];
      if (!oc('classes').some(x => x.id === cid)) continue;
      const r = bindQuiet(cid, k);
      if (r.ok && !r.existed) added++;
    }
    // 解开不在 want 里的绑定（oc 已经滤掉软删行，这里只处理"当前有效"的）
    have.forEach(cid => {
      if (want.indexOf(cid) > -1) return;
      const b = bindingFind(cid, k);
      if (b) { applyEdit('class_courses', b, markRemoved({}, now())); removed++; }
    });
    core.persist('class_courses');
    return { ok: true, added, removed };
  });
}

// 未被任何班开设的课程（课程库的"未分配"分组，也是清理提示的来源）
function courseOrphans() {
  return courseList().filter(c => !c.classIds.length);
}

/* ---------------- 合并同名课程 ---------------- */
//
// V10 之前"一个班一条课"，同一门楷书开 5 个班就是 5 条课程记录。解耦后同名即同一门课，
// 这些副本必须能收拢——否则课程库里永远躺着「楷书 ×3」，将来挂题库要挂三份。
//
// 合并要改三处指针，一处漏了就会"记录不见了/老师突然看不到课"：
//   ① class_courses.courseId  班级开设关系
//   ② records.courseId        成果记录的课程指针（记录上的课程名文字不动，历史原样可读）
//   ③ members.courseIds       成员的课程授权
// 副本不物理删除，而是标 mergedInto + 软删：同步靠 removed 传播删除，
// 本地抹掉云端还活着，下次合并又长回来。

const nameKey = c => String(c.name || '').trim().toLowerCase();

// 课程库里的同名分组（每组按 id 升序，第一条当"留下的那门"）
// 同名但学科明确不同的不算重复：那可能是两门同名的课（"基础"在书法和数学里各有一门），
// 合了就是把题目挂错学科。
function courseDuplicates() {
  const groups = {};
  courseList().forEach(c => {
    const k = nameKey(c);
    if (!k) return;
    (groups[k] = groups[k] || []).push(c);
  });
  return Object.keys(groups)
    .map(k => groups[k].sort((a, b) => a.id - b.id))
    .filter(g => g.length > 1)
    .filter(g => {
      const subs = g.map(c => c.subjectId).filter(Boolean);
      return subs.filter((v, i) => subs.indexOf(v) === i).length < 2;
    });
}

// 把 dropIds 并进 keepId。幂等：重复调用第二次就是 no-op。
function courseMerge(keepId, dropIds) {
  const keep = oc('courses').find(c => c.id === Number(keepId));
  if (!keep) return { ok: false, msg: '课程不存在' };
  const err = deny('course.write');
  if (err) return { ok: false, msg: err };
  const ids = schema.numList(dropIds).filter(id => id !== keep.id);
  const drops = oc('courses').filter(c => ids.indexOf(c.id) > -1);
  if (!drops.length) return { ok: true, merged: 0, bindings: 0, records: 0 };

  return core.tx(() => {
    const t = now();
    let bindings = 0, records = 0, members = 0;
    // 留下的那门没学科、副本有 → 继承过来（题库按学科筛，别丢）
    const sub = keep.subjectId || (drops.find(c => c.subjectId) || {}).subjectId || 0;
    if (sub && sub !== keep.subjectId) applyEdit('courses', keep, { subjectId: sub, updatedAt: t });

    oc('class_courses').forEach(b => {
      if (ids.indexOf(b.courseId) < 0) return;
      // 这个班本来就开了 keep → 副本那条直接作废，不然同一个班会开出两遍同名课
      if (bindingFind(b.clsId, keep.id)) { applyEdit('class_courses', b, markRemoved({}, t)); return; }
      applyEdit('class_courses', b, { courseId: keep.id, updatedAt: t });
      bindings++;
    });

    oc('records').forEach(r => {
      if (ids.indexOf(r.courseId) < 0) return;
      applyEdit('records', r, { courseId: keep.id, updatedAt: t });
      records++;
    });

    core.coll('members').forEach(m => {
      const list = m.courseIds || [];
      if (!list.some(id => ids.indexOf(id) > -1)) return;
      const next = [];
      list.forEach(id => {
        const to = ids.indexOf(id) > -1 ? keep.id : id;
        if (next.indexOf(to) < 0) next.push(to);
      });
      applyEdit('members', m, { courseIds: next, updatedAt: t });
      members++;
    });

    drops.forEach(c => applyEdit('courses', c, markRemoved({ mergedInto: keep.id }, t)));

    core.persist('class_courses'); core.persist('records'); core.persist('members');
    return { ok: true, merged: drops.length, bindings, records, members, keep: keep.id };
  });
}

// 一键整理：把所有同名分组各并成一条。返回处理了几组、共并掉几条。
function courseMergeAll() {
  const err = deny('course.write');
  if (err) return { ok: false, msg: err };
  const groups = courseDuplicates();
  if (!groups.length) return { ok: true, groups: 0, merged: 0 };
  let merged = 0, done = 0;
  groups.forEach(g => {
    const r = courseMerge(g[0].id, g.slice(1).map(c => c.id));
    if (r.ok) { merged += r.merged; done++; }
  });
  return { ok: true, groups: done, merged };
}

module.exports = {
  courseList, courseOf, courseGet, courseCreate, courseUpdate, courseRemove, courseRestore,
  courseBind, courseUnbind, courseSetClasses, courseIdsOf, classIdsOf, bindingOf, courseOrphans,
  courseDuplicates, courseMerge, courseMergeAll
};
