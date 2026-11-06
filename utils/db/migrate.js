// utils/db/migrate.js —— 版本迁移
//
// 两条入口，绝不混淆：
//   有 meta（已有数据）→ upgrade()：就地加字段 / 加集合 / 搬权限，一条数据都不重建
//   无 meta（全新安装）→ buildFresh()：建默认班级与演示账号
//   v2 大对象（chengguo_v2）→ build()：从旧的单对象搬家
//
// 铁律：升级只做加法。任何"重建集合"的写法都等于把老师手机上的学生和记录清零。
const schema = require('./schema');

const ORG = schema.DEFAULT_ORG;

// 内置「长期班」学期：老数据升级时自动创建、收编全部历史班级。
// 它永远进行中、不参与结转向导——老用户升级后行为与升级前完全一致。
// 同一机构只允许一个 builtIn（重复调用直接复用）。
function ensureBuiltinTerm(terms, classes, orgId, stamp) {
  let t = terms.find(x => x.builtIn && !x.removed);
  // changed 只表示"真改了东西"。以前这里写成 `!!terms.find(x => x === t)`，
  // 内置学期存在时恒为 true —— 于是每次启动都判"有改动"，把全部集合白落一遍盘；
  // 现在维护期改动会标脏，恒真是会天天把整机构重新推上云的。
  let changed = false;
  if (!t) {
    t = schema.normalizeTerm({
      id: coreNextId(terms), name: '长期班', status: 'active', builtIn: true
    }, orgId, stamp);
    terms.push(t);
    changed = true;
  }
  classes.forEach(c => {
    if (!c.termId) { c.termId = t.id; c.updatedAt = stamp; changed = true; }
  });
  return { term: t, changed };
}
// terms 集合内的自增 id（迁移期尚不能用 core.nextId， hydrate 还没发生）
function coreNextId(list) {
  let max = 0;
  (list || []).forEach(e => { if (e.id > max) max = e.id; });
  return max + 1;
}

// 学科种子（v9）：内置 7 条按 gid 合并——已存在的保留原 id 与改名，缺的补上。
// 幂等：连跑两次不会出现第二套"数学"；机构删过内置学科也会被补回来（课程可能还挂着它）。
function ensureSubjects(list, orgId, stamp) {
  const arr = Array.isArray(list) ? list : [];
  let max = 0;
  arr.forEach(x => { if (x && x.id > max) max = x.id; });
  schema.SUBJECT_SEEDS.forEach((s, i) => {
    if (arr.some(x => x && !x.removed && x.gid === s.gid)) return;
    const want = i + 1;
    const id = arr.some(x => x && x.id === want) ? (max += 1) : want;
    if (id > max) max = id;
    arr.push(schema.normalizeSubject({ id, gid: s.gid, name: s.name, kind: s.kind, sort: s.sort }, orgId, stamp));
  });
  return arr;
}

// 老课程补学科（v9）：只填 0 的行，按课程名猜一次；猜不中保持 0。
// 不覆盖已有值——机构手工指定的学科不该被一次升级改掉。
function ensureCourseSubjects(courses, subjects, stamp) {
  (courses || []).forEach(c => {
    if (!c || c.subjectId) return;
    const sid = schema.guessSubjectId(c.name, subjects);
    if (sid) { c.subjectId = sid; c.updatedAt = stamp; }
  });
  return courses;
}

// 课程与班级解耦（v10）：老课程每条带 clsId，等于"一个班一条课"。
// 这里只做一件事——把 clsId 派生成一条 class_courses 绑定，课程实体本身一条不重建。
//
// 【为什么不在迁移里自动合并同名课程】合并要重写 records.courseId 与 member.courseIds，
// 是唯一会动历史指针的动作，一旦判断错就找不回来。所以迁移保持纯加法，
// 合并做成课程库里由人点的一次显式操作（maintenance.mergeSameNameCourses）。
function ensureClassCourses(rawCourses, classCourses, classRemovedAt, orgId, stamp) {
  const arr = Array.isArray(classCourses) ? classCourses : [];
  let max = 0;
  arr.forEach(x => { if (x && x.id > max) max = x.id; });
  (rawCourses || []).forEach(c => {
    const cid = Number(c && c.clsId);
    const kid = Number(c && c.id);
    if (!cid || !kid) return;
    if (arr.some(b => b && b.clsId === cid && b.courseId === kid)) return;   // 幂等
    max += 1;
    const b = { id: max, clsId: cid, courseId: kid };
    // 课程或班级已经在回收站里 → 绑定跟着一起删，还原时才认得回来
    const at = (c && c.removed && c.removedAt) || classRemovedAt[cid] || 0;
    if (at) { b.removed = true; b.removedAt = at; }
    arr.push(schema.normalizeClassCourse(b, orgId, stamp));
  });
  return arr;
}

// 同名课程合并（v10 一次性收拢）。
//
// 解耦前"一个班一条课"，同一门楷书开 5 个班就有 5 条课程行。V10 起同名即同一门课，
// 这里把副本并进 id 最小（建得最早）的那条，并把三处指针一起改过去：
// class_courses.courseId / records.courseId / members.courseIds。
// 副本标 mergedInto + 软删（墓碑），不物理删除——同步靠 removed 传播删除。
//
// 只在 v10 以下的库上跑一次（见 upgrade）；之后新增的重复走课程页「一键合并同名课程」，
// 由人决定，不在启动时悄悄动数据。
function mergeSameNameCourses(courses, classCourses, records, members, stamp) {
  const groups = {};
  (courses || []).forEach(c => {
    if (!c || c.removed) return;
    const k = String(c.name || '').trim().toLowerCase();
    if (!k) return;
    (groups[k] = groups[k] || []).push(c);
  });
  let merged = 0;
  Object.keys(groups).forEach(k => {
    const g = groups[k].sort((a, b) => a.id - b.id);
    if (g.length < 2) return;
    // 同名但学科明确不同 → 两门课，别合（合了等于把内容挂错学科）
    const subs = g.map(c => c.subjectId).filter(Boolean);
    if (subs.filter((v, i) => subs.indexOf(v) === i).length > 1) return;
    const keep = g[0];
    const map = {};
    g.slice(1).forEach(c => {
      map[c.id] = keep.id;
      if (!keep.subjectId && c.subjectId) keep.subjectId = c.subjectId;
      c.removed = true;
      c.removedAt = stamp;
      c.mergedInto = keep.id;
      merged++;
    });
    (classCourses || []).forEach(b => { if (map[b.courseId]) b.courseId = keep.id; });
    (records || []).forEach(r => { if (map[r.courseId]) r.courseId = keep.id; });
    (members || []).forEach(m => {
      const list = m.courseIds || [];
      if (!list.some(id => map[id])) return;
      const next = [];
      list.forEach(id => {
        const to = map[id] || id;
        if (next.indexOf(to) < 0) next.push(to);
      });
      m.courseIds = next;
    });
  });
  // 同一个班同一门课只留一条绑定（副本的绑定挪过来后可能和 keep 原有的撞上）
  const seen = {};
  (classCourses || []).forEach(b => {
    if (b.removed) return;
    const key = b.clsId + '/' + b.courseId;
    if (seen[key] === undefined) { seen[key] = b.id; return; }
    b.removed = true; b.removedAt = stamp;
  });
  return merged;
}


// 全新安装的骨架。
// opts.sample === false：不带「书法班/素描班/楷书/素描」这些示例内容。
//   真实新用户第一次进来看到两个自己没建过的班，只会以为是别人的数据或系统坏了；
//   所以真实库不带示例，示例只给演示数据包用（maintenance.buildDemoData 依赖这两个班）。
// opts.demoParent：演示包才需要的家长演示账号。真实新库里不该有一个"家长演示"的成员，
//   否则统计里永远挂着 1 个家长，老师会以为自己请了人。默认不给。
// 出厂姓名一律留空：以前默认叫「测试老师」，用户填完向导前，首页、成员列表、记录署名
// 全是"测试老师"，真人一看就以为这是个半成品。空名字由页面兜底显示（如「老师」）。
function buildFresh(stamp, opts) {
  const withSample = !(opts && opts.sample === false);
  const withDemoParent = !!(opts && opts.demoParent);
  const terms = [schema.normalizeTerm({
    id: 1, name: '长期班', status: 'active', builtIn: true
  }, ORG, stamp)];
  const cls = withSample ? [
    schema.normalizeClass({ id: 1, name: '书法班', termId: 1 }, ORG, stamp),
    schema.normalizeClass({ id: 2, name: '素描班', termId: 1 }, ORG, stamp)
  ] : [];
  const courses = withSample ? [
    schema.normalizeCourse({ id: 1, name: '楷书', clsId: 1 }, ORG, stamp),
    schema.normalizeCourse({ id: 2, name: '素描', clsId: 2 }, ORG, stamp)
  ] : [];
  // v9：学科种子 + 课程归类；知识点空表先建好（阶段二才有数据）
  const subjects = ensureSubjects([], ORG, stamp);
  ensureCourseSubjects(courses, subjects, stamp);
  const knowledgePoints = [];
  // v10：示例课程与示例班级的绑定（楷书→书法班，素描→素描班）
  const classCourses = withSample ? [
    schema.normalizeClassCourse({ id: 1, clsId: 1, courseId: 1, sort: 0 }, ORG, stamp),
    schema.normalizeClassCourse({ id: 2, clsId: 2, courseId: 2, sort: 0 }, ORG, stamp)
  ] : [];
  const users = [
    schema.normalizeUser({ id: 't1', name: '', role: 'owner' }, ORG, stamp)
  ];
  if (withDemoParent) users.push(schema.normalizeUser({ id: 'p1', name: '家长演示', role: 'parent' }, ORG, stamp));
  const templates = schema.DEFAULT_TEMPLATES.map((t, i) =>
    schema.normalizeTemplate({ id: i + 1, name: t.name, options: t.options, sort: i }, ORG, stamp));

  // 机构创建者即负责人；负责人不受数据范围限制，不需要分配班级
  const orgs = [schema.normalizeOrg({ id: ORG, name: '我的机构', ownerId: 't1', status: 'active' }, stamp)];
  const members = [
    schema.normalizeMember({ id: stamp + 1, orgId: ORG, userId: 't1', role: 'owner', name: '' }, ORG, stamp)
  ];
  if (withDemoParent) {
    // 家长在绑定孩子之前没有可见数据，status 置 invited，绑定后转 active
    members.push(schema.normalizeMember({ id: stamp + 2, orgId: ORG, userId: 'p1', role: 'parent', name: '家长演示', status: 'invited' }, ORG, stamp));
  }

  return {
    meta: {
      version: schema.VERSION, orgId: ORG, orgName: '我的机构',
      teacher: '', me: 't1', createdAt: stamp, updatedAt: stamp
    },
    orgs, members, terms, classes: cls, courses, class_courses: classCourses, subjects,
    knowledge_points: knowledgePoints,
    students: [], enrollments: [], records: [], users, templates
  };
}

/* ---------------- 已有数据就地升级（v3 → v4：user 上的权限搬到 member） ---------------- */
function upgrade(loaded, stamp) {
  const meta = loaded.meta || {};
  const orgId = schema.str(meta.orgId, ORG) || ORG;

  // 除权限两类之外，全部按当前 schema 过一遍（保留 id，不重建）
  const classes = (loaded.classes || []).map(c => schema.normalizeClass(c, orgId, stamp));
  const allClsIds = classes.filter(c => !c.removed).map(c => c.id);

  const rawUsers = Array.isArray(loaded.users) ? loaded.users : [];
  const users = rawUsers.map(u => schema.normalizeUser(u, orgId, stamp));

  // 机构：没有就按现有信息补一个，负责人取第一个非家长用户
  const orgs = (Array.isArray(loaded.orgs) && loaded.orgs.length)
    ? loaded.orgs.map(o => schema.normalizeOrg(o, stamp))
    : [schema.normalizeOrg({
      id: orgId,
      name: meta.orgName || '我的机构',
      ownerId: ((users.find(u => u.role !== 'parent') || users[0] || {}).id) || '',
      status: 'active'
    }, stamp)];

  let seq = 0;
  const nextMemberId = () => { seq += 1; return stamp + seq; };

  const source = (Array.isArray(loaded.members) && loaded.members.length)
    ? loaded.members
    : rawUsers.map((u, i) => {
      const oldRole = u.role === 'admin' ? 'admin' : u.role === 'parent' ? 'parent' : 'teacher';
      // 第一个老师升为负责人：他就是这个机构唯一的经营者
      const role = (oldRole === 'teacher' && i === 0) ? 'owner' : oldRole;
      const staff = role !== 'parent';
      const clsIds = schema.numList(u.clsIds);
      return {
        id: nextMemberId(), orgId, userId: u.id, role, name: u.name,
        // 关键：旧版「没分配班级 = 看到全部」是隐式放行。新版 fail-closed，
        // 这里把隐式授权显式化，否则老师升级后会突然什么都看不到。
        clsIds: staff ? (clsIds.length ? clsIds : allClsIds) : [],
        courseIds: staff ? schema.numList(u.courseIds) : [],
        studentIds: role === 'parent' ? schema.numList(u.studentIds) : [],
        status: (role === 'parent' && !schema.numList(u.studentIds).length) ? 'invited' : 'active'
      };
    });

  const members = source.map(m => schema.normalizeMember(m, orgId, stamp));

  // v5：内置「长期班」学期 + 收编全部未挂靠班级（老数据一条不重建）
  const terms = (loaded.terms || []).map(t => schema.normalizeTerm(t, orgId, stamp));
  ensureBuiltinTerm(terms, classes, orgId, stamp);

  // v7：老记录按「同班同一天 = 同一课」补算课次号，班级 session 对齐到最新一课
  const records = (loaded.records || []).map(r => schema.normalizeRecord(r, orgId, stamp));
  schema.assignRecordSessions(classes, records);

  // v9：补学科种子、课程归类、知识点空表（老库没有这三样，行为不变）
  const subjects = ensureSubjects((loaded.subjects || []).map(s => schema.normalizeSubject(s, orgId, stamp)), orgId, stamp);
  const courses = (loaded.courses || []).map(c => schema.normalizeCourse(c, orgId, stamp));
  ensureCourseSubjects(courses, subjects, stamp);

  // v10：课程与班级解耦。normalizeCourse 已经把 clsId 丢掉，所以绑定要从原始行派生。
  const classRemovedAt = {};
  (loaded.classes || []).forEach(c => { if (c && c.removed && c.removedAt) classRemovedAt[c.id] = c.removedAt; });
  const classCourses = ensureClassCourses(
    loaded.courses,
    (loaded.class_courses || []).map(b => schema.normalizeClassCourse(b, orgId, stamp)),
    classRemovedAt, orgId, stamp
  );
  // v10：同名课程收拢成一条（只在 v10 以下的库上做一次）
  if (Number(loaded.meta.version) < 10) mergeSameNameCourses(courses, classCourses, records, members, stamp);
  const knowledgePoints = (loaded.knowledge_points || []).map(k => schema.normalizeKnowledgePoint(k, orgId, stamp));

  return {
    meta: Object.assign({}, meta, {
      version: schema.VERSION,
      orgId,
      orgName: (orgs[0] && orgs[0].name) || meta.orgName || '我的机构',
      updatedAt: stamp
    }),
    orgs, members,
    terms,
    classes,
    courses,
    class_courses: classCourses,
    subjects, knowledge_points: knowledgePoints,
    students: schema.assignStudentNos((loaded.students || []).map(s => schema.normalizeStudent(s, orgId, stamp))),
    enrollments: (loaded.enrollments || []).map(e => schema.normalizeEnrollment(e, orgId, stamp)),
    records,
    users,
    templates: (loaded.templates || []).map(t => schema.normalizeTemplate(t, orgId, stamp))
  };
}

// 遗留模板结构 [{n, opts[]}] → 实体 [{id, name, options[]}]
function buildTemplates(legacyTpls, stamp) {
  if (!Array.isArray(legacyTpls) || !legacyTpls.length) {
    return schema.DEFAULT_TEMPLATES.map((t, i) =>
      schema.normalizeTemplate({ id: i + 1, name: t.name, options: t.options, sort: i }, ORG, stamp));
  }
  return legacyTpls.map((t, i) => schema.normalizeTemplate({
    id: i + 1,
    // 历史改名：知识点掌握→知识掌握，下次课程注意→课程注意
    name: (t.n === '知识点掌握' ? '知识掌握' : t.n === '下次课程注意' ? '课程注意' : t.n),
    options: t.opts || t.options || [],
    sort: i
  }, ORG, stamp));
}

function build(loaded) {
  const stamp = Date.now();

  // 【必须先判这个】已有数据且版本不符 → 就地升级。
  // 老代码在这里直接落到 buildFresh，升一次版本就把学生和记录全清零。
  if (loaded && loaded.meta) {
    if (loaded.meta.version === schema.VERSION) return loaded;
    return upgrade(loaded, stamp);
  }

  const legacy = require('./storage').readLegacy();
  const old = (legacy && legacy.db) || null;

  if (!old) return buildFresh(stamp, { sample: false });

  // id 只需在各自集合内唯一：每类实体各用一个去重器，避免班级占号把课程 id 顶走
  const uniqOf = () => {
    const used = new Set();
    return id => { let x = Number(id) || 0; while (used.has(x)) x++; used.add(x); return x; };
  };
  const uniqCls = uniqOf(), uniqCrs = uniqOf(), uniqStu = uniqOf(), uniqRec = uniqOf();

  const classes = (old.classes || []).map(c =>
    schema.normalizeClass({ id: uniqCls(c.id), name: c.name, sort: c.sort }, ORG, stamp));
  const classIds = {};
  (old.classes || []).forEach((c, i) => { classIds[c.id] = classes[i].id; });

  // v10：课程 id 可能被去重器重排，绑定要跟着映射后的 id 走，所以边建边记关系
  const courses = [];
  const courseLinks = [];
  (old.courses || []).forEach(c => {
    const id = uniqCrs(c.id);
    const cid = classIds[c.clsId] !== undefined ? classIds[c.clsId] : c.clsId;
    courses.push(schema.normalizeCourse({ id, name: c.name }, ORG, stamp));
    if (cid) courseLinks.push({ id, clsId: cid });
  });

  const students = (old.students || []).map(s =>
    schema.normalizeStudent({
      id: uniqStu(s.id), name: s.name,
      clsIds: (s.clsIds || []).map(id => (classIds[id] !== undefined ? classIds[id] : id)),
      parent: s.parent, wechat: s.wechat, photo: s.photo, profile: s.profile, demo: s.demo
    }, ORG, stamp));

  const records = (old.records || []).map(r =>
    schema.normalizeRecord({
      id: uniqRec(r.id), sid: r.sid, cid: classIds[r.cid] !== undefined ? classIds[r.cid] : r.cid,
      course: r.course, date: r.date, score: r.score, tag: r.tag, note: r.note,
      photos: r.photos, videos: r.videos, audio: r.audio, sent: r.sent, demo: r.demo,
      createdAt: r.createdAt, updatedAt: r.updatedAt
    }, ORG, stamp));

  const rawUsers = (old.users || []).map(u => Object.assign({}, u, {
    clsIds: (u.clsIds || []).map(id => (classIds[id] !== undefined ? classIds[id] : id))
  }));
  const users = rawUsers.map(u =>
    schema.normalizeUser({ id: u.id || ('u' + stamp + Math.floor(Math.random() * 1000)), name: u.name, role: u.role }, ORG, stamp));
  if (!users.length) users.push(schema.normalizeUser({ id: 't1', name: '测试老师', role: 'owner' }, ORG, stamp));

  // 权限从 user 搬到 member：第一个老师升为负责人，其余按原角色；
  // 旧版"没分配班级 = 全可见"在这里显式展开成"分配全部班级"
  const allClsIds = classes.filter(c => !c.removed).map(c => c.id);
  let mseq = 0;
  const members = rawUsers.length
    ? rawUsers.map((u, i) => {
      const uid = users[i].id;
      const oldRole = u.role === 'admin' ? 'admin' : u.role === 'parent' ? 'parent' : 'teacher';
      const role = (oldRole === 'teacher' && i === 0) ? 'owner' : oldRole;
      const staff = role !== 'parent';
      const clsIds = schema.numList(u.clsIds);
      mseq += 1;
      return schema.normalizeMember({
        id: stamp + mseq, orgId: ORG, userId: uid, role, name: u.name,
        clsIds: staff ? (clsIds.length ? clsIds : allClsIds) : [],
        courseIds: staff ? schema.numList(u.courseIds) : [],
        studentIds: role === 'parent' ? schema.numList(u.studentIds) : [],
        status: (role === 'parent' && !schema.numList(u.studentIds).length) ? 'invited' : 'active'
      }, ORG, stamp);
    })
    : [schema.normalizeMember({ id: stamp + 1, orgId: ORG, userId: users[0].id, role: 'owner', name: users[0].name }, ORG, stamp)];

  const orgs = [schema.normalizeOrg({
    id: ORG, name: '我的机构', ownerId: (members.find(m => m.role === 'owner') || members[0] || {}).userId || '', status: 'active'
  }, stamp)];

  const me = users.some(u => u.id === old.me) ? old.me : users[0].id;

  // v5：内置「长期班」学期 + 收编全部班级
  const terms = [];
  ensureBuiltinTerm(terms, classes, ORG, stamp);

  // v7：老记录按「同班同一天 = 同一课」补算课次号
  schema.assignRecordSessions(classes, records);

  // v9：学科种子 + 课程归类 + 知识点空表
  const subjects = ensureSubjects([], ORG, stamp);
  ensureCourseSubjects(courses, subjects, stamp);
  // v10：老课程的班级关系 → 绑定表；同名课程收拢（老版本一个班一条课）
  const classCourses = ensureClassCourses(courseLinks, [], {}, ORG, stamp);
  mergeSameNameCourses(courses, classCourses, records, members, stamp);

  return {
    meta: {
      version: schema.VERSION, orgId: ORG, orgName: '我的机构',
      teacher: old.teacher || '测试老师',
      me,
      createdAt: stamp, updatedAt: stamp,
      migratedFrom: 'v2'
    },
    orgs, members,
    terms, classes, courses, class_courses: classCourses, subjects,
    knowledge_points: [],
    students: schema.assignStudentNos(students), enrollments: [], records, users,
    templates: buildTemplates(legacy.tpls, stamp)
  };
}

module.exports = { build, buildFresh, upgrade, buildTemplates, ensureBuiltinTerm, ensureSubjects, ensureCourseSubjects, mergeSameNameCourses };
