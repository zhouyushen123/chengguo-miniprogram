// utils/db/maintenance.js —— 启动、自愈与云端合并
//
// 这里放的是「整个库级别」的操作：加载/迁移、规范化、引用修复、媒体自愈、演示数据、云端合并。
// 它们必须直接操作 core.coll（全量集合），不能用 oc()——否则 setColl 这类覆盖写会把
// 其他机构的数据一起抹掉。依赖：ctx（底座），不依赖具体领域的读写函数。
const storage = require('./storage');
const schema = require('./schema');
const core = require('./core');
const migrate = require('./migrate');
const integrity = require('./integrity');
const media = require('../media');
const demo = require('../demo-data');
const { now, org, oc } = require('./ctx');

/* =====================================================================
 * 启动：加载 → 迁移 → 规范化 → 演示包 → 引用修复 → 关系自愈 → 媒体自愈 → 定模式
 * ===================================================================*/
let inited = false;
let bootError = '';
// 这次启动是否从本地快照恢复过（页面要明确告诉用户"数据回到几点的样子"，不能悄悄替换）
let snapRestored = null;   // { id, at, bad }
// 每日备份的日期戳：同一天只打一次，避免每次冷启动都写一份把配额吃光
function dayKey(t) {
  const d = new Date(t);
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function init() {
  if (inited) return;
  try {
    let loaded = storage.load();

    /* ---------------- 读盘校验 ----------------
     * storage.load 会把"读异常"记进 _damage。这时候内存里是残缺的（缺一片 = 少几百条记录），
     * 只要走完启动流程，后面任何一次落盘都会把这份残缺数据写回磁盘，等于永久丢失。
     * 所以：有损坏 → 先找本地快照；快照也没有 → 只读降级，宁可让用户看到"读取异常"，
     * 也不能让程序自己把数据抹掉。 */
    if (loaded._damage && loaded._damage.length) {
      const bad = loaded._damage.join('、');
      const snap = storage.latestSnapshot();
      if (snap && snap.data) {
        const fixed = { meta: Object.assign({}, snap.meta || {}, { version: schema.VERSION }) };
        storage.COLLECTIONS.forEach(n => { fixed[n] = Array.isArray(snap.data[n]) ? snap.data[n].slice() : []; });
        loaded = fixed;
        snapRestored = { id: snap.id, at: snap.at, bad };
        console.warn('[db] 本地数据读取异常，已从备份恢复', bad, snap.at);
      } else {
        throw new Error('本地数据读取异常（' + bad + '），且没有可用备份。为保护原有数据，已切换为只读');
      }
    }

    // 升级前先留一份：迁移代码出错时，至少能回到升级前的样子（这是最贵的一次写操作）
    if (loaded.meta && loaded.meta.version && loaded.meta.version !== schema.VERSION) {
      storage.saveSnapshot('升级前 v' + loaded.meta.version, loaded);
    }

    // 迁移/维护期"新增的行"（学科种子、内置学期、补出来的记录）走的是 flushAll 快路径，
    // 那条路径不过写钩子 —— 不标脏就永远推不上云端，表现是"本机 7 条、云端 0 条"。
    // 记下迁移前的条数，维护结束后按差异补标脏。
    const beforeCount = {};
    storage.COLLECTIONS.forEach(n => { beforeCount[n] = Array.isArray(loaded[n]) ? loaded[n].length : 0; });

    const data = (loaded.meta && loaded.meta.version === schema.VERSION)
      ? loaded
      : migrate.build(loaded);
    core.hydrate(data);

    // 全量规范化很贵：每条实体都要 JSON.stringify 两遍比对，记录上千条时是启动耗时大头。
    // 只在"规范化口径变了"时跑全量——靠 meta.normStamp 记住口径版本，改 normalizeXxx 时递增它。
    const changed = normalizeAll(core.meta().normStamp !== NORM_STAMP);
    const purged = purgeSeed();          // 老版本混在真实库里的演示数据 → 请出去（演示包里另有一份）
    // 演示包改成「点了才建」：新用户手机里不该先躺着一整套用不到的示例学生与记录
    // （十几个 key、几百 KB），真实第一屏就该是空的。
    // 例外两种：①磁盘上已经有包（含老版本），要跟着版本重建；②这次升级会把人送进演示
    // （老版本把演示数据混在真实库里，清掉后不能让他面对空白），必须先备好包再切模式。
    const hadDemo = !!storage.demo.load().meta;
    if (hadDemo || purged) ensureDemo();
    const repaired = repairRefs();
    const linked = integrity.repairLinks();   // 关系表与三处外键的悬空行：启动即修
    const mediaFixed = repairMedia();
    // 一次性补标：学科/知识点是 v9 新加的表。升级到 v9 那次启动写种子会被 markRegrown 抓到，
    // 但"已经升到 v9、种子只在本地、云端一条没有"的设备（本修复之前升级的）条数不会再变，
    // 只能靠这个戳补推一次 —— 否则它永远停在"本机有、云端没有"。
    if (core.realMeta().subjStamp !== schema.VERSION) {
      core.updateRealMeta({ subjStamp: schema.VERSION });
      core.persist('subjects');
    }
    const regrew = markRegrown(beforeCount);   // 迁移新增的行为什么必须标脏，见 markRegrown
    resolveMode(purged);                 // 该进演示还是回真实机构
    const linkedFixed = (linked.bindings + linked.dupBind + linked.records + linked.members + linked.students) > 0;
    if (changed || purged || repaired || mediaFixed || regrew || linkedFixed) core.flushAll();

    if (snapRestored) {
      // 恢复出来的数据必须立刻落盘，否则磁盘上还是那份缺了片的旧数据，
      // 下次启动又掉进同一个坑里。
      core.flushAll();
      // 游标归零 + 全量标脏：快照只留了最近 300 条记录，更早的从云端补回来；
      // 本地这份也要回推一次，保证云端与本机一致（合并是 LWW，不会重复建）。
      const s = core.realMeta().sync || {};
      core.updateRealMeta({ sync: Object.assign({}, s, { cursor: 0, dirty: storage.COLLECTIONS.slice() }) });
    }

    // 每日首启留一份滚动备份（3 份 ≈ 三天）；空库不备份，既没东西可救又白占配额
    const rd = core.realData();
    const hasAsset = (rd.students && rd.students.length) || (rd.members && rd.members.length);
    if (hasAsset && core.realMeta().lastSnap !== dayKey(Date.now())) {
      const r = storage.saveSnapshot('每日备份', rd);
      if (r.ok) core.updateRealMeta({ lastSnap: dayKey(Date.now()) });
    }
  } catch (e) {
    // 启动失败不能让整页白屏，也不能把坏状态写回磁盘 → 降级成"内存空库 + 只读"，磁盘原样保留
    bootError = (e && e.message) || '数据加载失败';
    core.setReadOnly(true);
    core.setMode('real');
    if (!core.isReady()) {
      try { core.hydrate(migrate.buildFresh(Date.now())); } catch (e2) { /* 连兜底都失败就只能空着 */ }
    }
    console.error('[db] 初始化失败，已降级为只读', e);
  }
  inited = true;
}

// 启动状态：页面可据此提示"数据读取异常，当前为只读"
function status() {
  return {
    ready: inited, degraded: !!bootError, error: bootError,
    readOnly: core.isReadOnly(),
    restored: snapRestored
  };
}

// 规范化口径版本：改了 schema.normalizeXxx 的字段/默认值就 +1，老库下次启动会重跑一次全量
const NORM_STAMP = schema.VERSION + '/2';

/* =====================================================================
 * 从本地快照恢复
 * ---------------------------------------------------------------------
 * 【为什么恢复前又备份一次】用户可能是"点错了"，或者想回到更早的那一份。
 * 恢复本身也是一次覆盖写，不给自己留退路就成了新的丢数据途径。
 *
 * 【恢复后做什么】立刻落盘 → 游标归零 + 全量标脏：
 * 快照只留最近 300 条记录，更早的要靠云端补；本地这份也要回推一次。
 * 合并是 LWW + 按 id 去重，重复推不会产生重复数据。
 * ===================================================================*/
function restoreSnapshot(id) {
  if (!id) return { ok: false, msg: '缺少备份标识' };
  if (core.isReadOnly()) return { ok: false, msg: '当前是只读模式，请重启小程序后再恢复' };
  const snap = storage.readSnapshot(id);
  if (!snap || !snap.data) return { ok: false, msg: '这份备份已不可用（可能被系统清理过）' };

  storage.saveSnapshot('恢复前', core.realData());

  const data = { meta: Object.assign({}, snap.meta || {}, { version: schema.VERSION }) };
  storage.COLLECTIONS.forEach(n => { data[n] = Array.isArray(snap.data[n]) ? snap.data[n] : []; });
  core.hydrate(data);
  // 快照可能是旧版本生成的：按当前 schema 重过一遍（老快照没有 class_courses，顺手补关系）
  normalizeAll(true); repairRefs(); integrity.repairLinks();
  const ok = core.flushAll();
  if (!ok) return { ok: false, msg: core.SAVE_FAIL };
  const s = core.realMeta().sync || {};
  core.updateRealMeta({ sync: Object.assign({}, s, { cursor: 0, dirty: storage.COLLECTIONS.slice() }) });
  return { ok: true, at: snap.at, tag: snap.tag || '' };
}

// 迁移/维护期"新增的行"必须过一遍 core.persist：persist 会调写钩子，把集合名记进
// meta.sync.dirty，下一次同步才会推上云端。core.flushAll 是"落盘但不算改动"的快路径，
// 它不碰写钩子 —— 学科种子第一次就是从这里漏掉的：本机 7 条、云端 0 条，重启也不会好，
// 因为重启时条数没再变化，谁也不会再想起这几行还没上云。
function markRegrown(before) {
  if (core.isReadOnly()) return false;
  let grew = false;
  storage.COLLECTIONS.forEach(n => {
    const list = core.coll(n) || [];
    if (list.length !== before[n]) { core.persist(n); grew = true; }
  });
  return grew;
}

// 把库里所有实体按当前 schema 过一遍（补默认字段、修正日期格式、丢弃未知字段）
// full=false 时跳过昂贵的逐条比对，只做下面几件"每次都必须做"的结构性兜底
function normalizeAll(full) {
  let changed = false;
  if (full) {
    const each = (name, fn) => {
      const list = core.coll(name);
      let dirty = false;
      for (let i = 0; i < list.length; i++) {
        const next = fn(list[i], org(), now());
        if (JSON.stringify(next) !== JSON.stringify(list[i])) { list[i] = next; dirty = true; }
      }
      // 规范化改的是字段值、条数不变，markRegrown 看不见 —— 这里单独标脏
      if (dirty) { changed = true; core.persist(name); }
    };
    each('orgs', x => schema.normalizeOrg(x, now()));
    each('members', schema.normalizeMember);
    each('terms', schema.normalizeTerm);
    each('classes', schema.normalizeClass);
    each('courses', schema.normalizeCourse);
    each('subjects', schema.normalizeSubject);
    each('knowledge_points', schema.normalizeKnowledgePoint);
    each('students', schema.normalizeStudent);
    each('enrollments', schema.normalizeEnrollment);
    each('records', schema.normalizeRecord);
    each('users', schema.normalizeUser);
    each('templates', schema.normalizeTemplate);
  }
  const m = core.meta();
  if (m.normStamp !== NORM_STAMP) {
    core.updateMeta({ normStamp: NORM_STAMP });
    changed = true;
  }
  if (!m.version) {
    core.updateMeta({
      version: schema.VERSION, orgId: m.orgId || schema.DEFAULT_ORG,
      orgName: m.orgName || '我的机构', createdAt: now(), updatedAt: now()
    });
    changed = true;
  }
  // 兜底：机构表为空时补一个，避免权限判定无处可取
  if (!oc('orgs').length) {
    const first = oc('users').find(u => u.role !== 'parent') || oc('users')[0];
    core.coll('orgs').push(schema.normalizeOrg({
      id: org(), name: m.orgName || '我的机构',
      ownerId: (first && first.id) || '', status: 'active'
    }, now()));
    core.persist('orgs');
    changed = true;
  }
  // 兜底：内置「长期班」不存在或班级没挂靠学期时补齐（版本刚升级/异常数据）
  const termFix = migrate.ensureBuiltinTerm(core.coll('terms'), core.coll('classes'), org(), now());
  if (termFix.changed) { core.persist('terms'); core.persist('classes'); changed = true; }
  // 兜底：学科种子缺失时补齐（升级路径会补，这里防"版本已是 v9 但学科被清空"的异常数据）
  const subs = core.coll('subjects');
  const before = subs.length;
  migrate.ensureSubjects(subs, org(), now());
  if (subs.length !== before) { core.persist('subjects'); changed = true; }
  return changed;
}

// 引用完整性自愈：老记录缺班级/缺课程/缺录入老师时按学生与班级回填
function repairRefs() {
  let changed = 0;
  const students = core.coll('students');
  const courses = core.coll('courses');
  const classes = core.coll('classes');
  // 在职教职工（不含家长、不含已停用），用于上面 tid 的可信回填
  const staff = core.coll('members')
    .filter(m => m.role !== 'parent' && m.status === 'active' && m.userId);
  core.coll('records').forEach(r => {
    if (r.removed) return;
    if (!r.cid) {
      const s = students.find(x => x.id === r.sid);
      if (s && s.clsIds.length) { r.cid = s.clsIds[0]; changed++; }
    }
    // V10 起同名即同一门课（课程不再挂班级），不再按 clsId 找
    const cm = (r.courseId || !r.course) ? null : courses.find(x => x.name === r.course && !x.removed);
    if (cm) { r.courseId = cm.id; changed++; }
    // tid 必须有值：为空会让"只能改自己录的"这条规则失效。
    // 但绝不能拿"当前登录人"回填——启动时可能恰好是家长身份，
    // 那样历史记录会被记成家长录入，而 own 规则下老师从此改不了这条记录。
    // 可信来源按优先级：① 该班主讲老师（teacherId 是 member.id，tid 存的是 user.id，要换）
    // ② 机构里唯一的在职教职工（单人工作室就是这种情况，归属没有歧义）
    // ③ 都不满足就留空：宁可让负责人/管理员来改，也不伪造一个归属。
    if (!r.tid) {
      const c = classes.find(x => x.id === r.cid);
      const owner = c && c.teacherId ? staff.find(m => m.id === c.teacherId) : null;
      const solo = staff.length === 1 ? staff[0] : null;
      const from = (owner && owner.userId) || (solo && solo.userId) || '';
      if (from) { r.tid = from; changed++; }
    }
  });
  if (changed > 0) { core.persist('records'); core.persist('courses'); }
  return changed > 0;
}

// 媒体自愈：历史记录里的 photos / videos / audio 可能还是临时路径（系统随时会清理），
// 启动时尝试把它们转存成持久文件。源文件已经不在了就无法恢复——此时保留原路径不动，
// 而不是清空引用：清空等于主动删掉用户照片，留着至少还有一丝恢复可能。
function repairMedia() {
  let n = 0;
  const fix = (p, kind) => {
    const s = schema.str(p);
    if (!s || media.isPersist(s)) return s;
    if (!media.exists(s)) return s;
    const next = media.persist(s, kind);
    if (next && next !== s) { n++; return next; }
    return s;
  };
  oc('records').forEach(r => {
    const photos = (r.photos || []).map(p => fix(p, 'photo'));
    const videos = (r.videos || []).map(p => fix(p, 'video'));
    const audio = r.audio ? fix(r.audio, 'audio') : r.audio;
    if (photos.join('|') !== (r.photos || []).join('|')) r.photos = photos;
    if (videos.join('|') !== (r.videos || []).join('|')) r.videos = videos;
    if (audio !== r.audio) r.audio = audio;
  });
  oc('students').forEach(s => {
    if (s.photo) {
      const np = fix(s.photo, 'photo');
      if (np !== s.photo) s.photo = np;
    }
  });
  if (n > 0) { core.persist('records'); core.persist('students'); }
  return n > 0;
}

// 真实库引用着的媒体文件集合（跨机构、含已软删的记录）。
// 「存储空间」页拿它和磁盘目录比对，差集就是可以清理的垃圾文件。
// 已删除的记录也算"引用"：宁可留着，也不要因为一条被误删的记录把照片真删了——
// 用户的照片删掉就找不回来了，多占几百 KB 是可以接受的代价。
function mediaRefs() {
  const st = core.realData();
  const out = {};
  const add = v => { const s = schema.str(v); if (s) out[s] = 1; };
  (st.students || []).forEach(s => add(s.photo));
  (st.records || []).forEach(r => {
    (r.photos || []).forEach(add);
    (r.videos || []).forEach(add);
    add(r.audio);
  });
  return out;
}

/* =====================================================================
 * 演示数据
 *
 * 【设计】演示数据不是"真实库里打了标记的行"，而是磁盘上另一套 key（storage.demo）里的
 * 完整一套数据：机构、学期、班级、课程、成员、学生、记录全都有。当前看哪一套由
 * core.setMode('real' | 'demo') 决定，切换只换指针，不搬数据。
 *
 * 好处：
 *   1. 重播/清空/改造演示数据，物理上碰不到真实数据 —— 不再依赖 demoVersion 这个开关
 *   2. 不需要每一处查询都记得过滤 demo 标记，也就不会漏
 *   3. 演示模式下写操作被 ctx.deny 拦下（样板间能看不许改），误操作不会留在真实数据里
 * ===================================================================*/
const DEMO_ORG_NAME = '演示机构';

// 用 buildFresh 的默认骨架 + demo-data 的学生与记录拼出整套演示数据：
// 骨架里已经带了书法班/素描班、楷书/素描、负责人与家长账号、默认评价模板，
// 演示学生正好挂在这两个班上，一份数据就能把 App 每个页面填满。
function buildDemoData() {
  const stamp = now();
  const d = migrate.buildFresh(stamp, { demoParent: true });
  const o = schema.DEFAULT_ORG;
  d.meta = Object.assign({}, d.meta, {
    orgName: DEMO_ORG_NAME, demoVersion: demo.DEMO_VERSION,
    // 演示包自己的 meta 永远是"真实库"，它不会嵌套切模式
    sandbox: false, createdAt: stamp, updatedAt: stamp
  });
  d.orgs = d.orgs.map(x => Object.assign({}, x, { name: DEMO_ORG_NAME }));
  // 演示机构得有个像样的老师名：真实库出厂留空（等用户填），样板间留空就成了无主数据
  d.meta.teacher = demo.DEMO_TEACHER;
  d.users = d.users.map(u => (u.role === 'owner' ? Object.assign({}, u, { name: demo.DEMO_TEACHER }) : u));
  d.members = d.members.map(m => (m.role !== 'parent' ? Object.assign({}, m, { name: demo.DEMO_TEACHER }) : m));

  d.students = schema.assignStudentNos(demo.DEMO_STUDENTS.map(s => schema.normalizeStudent(Object.assign({}, s, {
    clsIds: s.clsIds.slice(),
    // 入学年份按 id 确定性铺开（2022–2025），让「按年份筛选」在演示数据上立即可见
    enrollYear: 2022 + (s.id % 4)
  }), o, stamp)));
  d.records = demo.DEMO_RECORDS.map(r =>
    schema.normalizeRecord(Object.assign({ tid: d.meta.me }, r), o, stamp));
  // v7：演示记录同样盖课次号（同班同一天 = 同一课），班级页「第 N 次课」才有意义
  schema.assignRecordSessions(d.classes, d.records);

  // 家长演示账号绑第一个孩子：权限在 member 上，不在 user 上
  const p = d.members.find(m => m.role === 'parent');
  if (p) {
    p.studentIds = [demo.DEMO_STUDENTS[0].id];
    if (p.status === 'invited') p.status = 'active';
    p.updatedAt = stamp;
  }
  // 演示老师拿到全部班级：fail-closed 下不分配就什么都看不到
  const t = d.members.find(m => m.role !== 'parent');
  if (t) {
    t.clsIds = d.classes.map(c => c.id);
    t.updatedAt = stamp;
  }
  return d;
}

function writeDemoPackage(d) {
  storage.demo.removeAll();   // 先清干净：删掉已经不存在的实体，避免旧 key 残留
  storage.COLLECTIONS.forEach(n => storage.demo.saveCollection(n, d[n]));
  storage.demo.saveMeta(d.meta);
}

// 演示包就绪：磁盘上有且版本一致就直接用，否则按当前 demo-data 重建
function ensureDemo() {
  const saved = storage.demo.load();
  const usable = saved.meta
    && saved.meta.demoVersion === demo.DEMO_VERSION
    && (saved.students.length || saved.records.length);
  if (usable) { core.hydrateDemo(saved); return false; }
  const built = buildDemoData();
  writeDemoPackage(built);
  core.hydrateDemo(built);
  return true;
}

// 老版本把演示数据直接灌进了真实库（靠 demoVersion 区分）。现在它们已经有独立的家，
// 真实库里那些带 demo 标记的学生与记录要一次性清出去 —— 不清就变成"看起来像真实数据"
// 的幽灵行：统计、导出、家长绑定都会把它算进去。
function purgeSeed() {
  const stu = core.coll('students');
  const rec = core.coll('records');
  const seeded = stu.filter(s => s.demo);
  if (!seeded.length && !rec.some(r => r.demo)) return false;
  const ids = {};
  seeded.forEach(s => { ids[s.id] = 1; });
  // 挂在演示学生上的记录一并清掉：没有学生，留着就是一条无主记录
  const keepRec = rec.filter(r => !r.demo && !ids[r.sid]);
  core.setColl('students', stu.filter(s => !s.demo));
  core.setColl('records', keepRec);
  core.coll('members').forEach(m => {
    const next = (m.studentIds || []).filter(sid => !ids[sid]);
    if (next.length !== (m.studentIds || []).length) { m.studentIds = next; m.updatedAt = now(); }
  });
  core.persist('members');
  return true;
}

// 决定启动后看哪一套。
// 优先级：用户显式选择（meta.sandbox）> 本次启动刚清掉演示数据（那就还给他演示视图）> 真实机构。
// 为什么不在"库是空的"时候自动进演示：空库不等于"想看样板间"——老师刚清空学生准备
// 重新录入时被弹回演示模式，会以为自己的库坏了。模式由用户点，不由猜测。
function resolveMode(justPurged) {
  const m = core.realMeta();
  let sandbox = m.sandbox;
  if (typeof sandbox !== 'boolean') {
    sandbox = !!justPurged;
    core.updateRealMeta({ sandbox });
  }
  core.setMode(sandbox ? 'demo' : 'real');
  return core.isSandbox();
}

/* ---------------- 演示模式的对外开关 ---------------- */
const demoApi = {
  active: () => core.isSandbox(),
  available: () => core.isDemoReady(),
  // 进演示：只切指针 + 记住选择，真实数据一个字节都不动
  enter() {
    // 演示包是懒建的：用户第一次点「看演示数据」时才在磁盘上生成（并落盘存档）
    if (!core.isDemoReady()) ensureDemo();
    if (!core.isDemoReady()) return { ok: false, msg: '演示数据准备失败，请重启小程序' };
    core.setMode('demo');
    core.updateRealMeta({ sandbox: true });
    return { ok: true };
  },
  // 回真实机构。哪怕真实库是空的也留在真实模式：用户既然点了"开始使用"，
  // 就不该下次打开又被塞回演示样板间。
  exit() {
    core.setMode('real');
    core.updateRealMeta({ sandbox: false });
    return { ok: true };
  },
  // 重置：把演示包按当前 demo-data 重建（演示时乱点的痕迹一并消失），真实数据不受影响
  reset() {
    const built = buildDemoData();
    writeDemoPackage(built);
    core.hydrateDemo(built);
    if (core.isSandbox()) core.setMode('demo');
    return { ok: true, item: { students: built.students.length, records: built.records.length } };
  }
};

// 云端拉取结果合并（按 updatedAt 取新，只处理记录与学生资料）
// 【机构归属】外部数据一律强制打上当前机构：normalize 时 audit 优先用 raw.orgId，
// 若云端带回来的是别的 orgId，记录会入库却永远读不出来（幽灵数据）。
// 【演示模式】合并只写真实库：demo 态的落盘本来就是关掉的，这里显式跳过免得白跑。
function merge(remote) {
  if (!remote || core.isSandbox()) return false;
  const o = org();
  let changed = false;
  const own = raw => !(raw && raw.orgId && raw.orgId !== o);
  (remote.records || []).forEach(raw => {
    if (!own(raw)) return;
    const inc = schema.normalizeRecord(Object.assign({}, raw, { orgId: o }), o, now());
    if (!inc.id) return;
    const cur = core.coll('records').find(r => r.id === inc.id);
    if (!cur) { core.coll('records').push(inc); changed = true; }
    else if ((inc.updatedAt || 0) > (cur.updatedAt || 0)) { Object.assign(cur, inc); changed = true; }
  });
  (remote.profiles || []).forEach(p => {
    if (!own(p)) return;
    const s = core.coll('students').find(x => x.id === Number(p.sid));
    if (s && p.profile) { s.profile = p.profile; s.updatedAt = now(); changed = true; }
  });
  if (changed) { core.persist('records'); core.persist('students'); }
  return changed;
}

module.exports = {
  mediaRefs,
  init, status, normalizeAll, repairRefs, repairMedia, restoreSnapshot,
  integrity: integrity.integrity, repairLinks: integrity.repairLinks, integrityGroups: integrity.integrityGroups,
  buildDemoData, ensureDemo, purgeSeed, resolveMode, demo: demoApi, merge
};
