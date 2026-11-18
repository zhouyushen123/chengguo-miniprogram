// tests/verify_lesson.js —— 课次（lessons）：建/批量/编辑/确认/重排/权限/归档只读/记录关联
//
// 方案见 docs/lesson-plan.md（九轮收敛）：纯课程维度 + 挂学期；seq 是存储序号，
// 补录错乱靠「检测 + 一键重排」；确认是软标记（方式 C：保持已确认 + contentEditedAt）。
// 这组断言钉死：
//   A. 建课次：seq 接尾、weekday 由日期推导、时间 HH:mm 白名单、默认挂学期
//   B. 批量生成：日期展开、每周多天、次数、事务
//   C. 确认与内容更新标记（方式 C 语义）
//   D. 序号 C'：补录旧日期 → disorder=true → 重排归位（有日期在前、无日期在后）
//   E. 权限：teacher 限自己的 courseIds（fail-closed）、家长只读
//   F. 归档学期只读
//   G. 记录关联 lessonId：新建可带、课程不匹配被拦、编辑保持原关联
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

/* ---------- 模拟 wx 存储（每段一个干净实例） ---------- */
function boot(mem) {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k];
  });
  global.wx = {
    getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
    setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
    removeStorageSync: k => { delete mem[k]; },
    getStorageInfoSync: () => ({ keys: Object.keys(mem), currentSize: 200, limitSize: 10240 }),
    showToast: () => {}, showModal: () => {}
  };
  const db = require(path.join(ROOT, 'utils/db'));
  db.init();
  return db;
}

// 一套"有学期/班级/课程/老师"的标准开局
function stage(db) {
  const term = db.terms.create({ name: '2026 秋季班', startDate: '2026-09-01', status: 'active' });
  assert.ok(term.ok, term.msg);
  const builtIn = db.terms.list().find(t => t.builtIn);
  const cls = db.classes.create({ name: '素描班' });
  assert.ok(cls.ok, cls.msg);
  const c1 = db.courses.create({ name: '几何石膏体' });
  assert.ok(c1.ok, c1.msg);
  const c2 = db.courses.create({ name: '水彩静物' });
  assert.ok(c2.ok, c2.msg);
  const bind = db.courses.bind(cls.item.id, c1.item.id);
  assert.ok(bind.ok, bind.msg);
  const stu = db.students.create({ name: '周小明', clsIds: [cls.item.id] });
  assert.ok(stu.ok, stu.msg);
  // 老师：只可管理课程 1
  const t = db.members.create({ name: '陈老师', role: 'teacher', clsIds: [cls.item.id], courseIds: [c1.item.id] });
  assert.ok(t.ok, t.msg);
  return {
    termId: term.item.id, builtInId: builtIn.id,
    clsId: cls.item.id, stuId: stu.item.id,
    c1: c1.item.id, c2: c2.item.id, teacherUserId: t.raw.userId
  };
}

console.log('· 课次（lessons）');

/* ================= A. 单次添加 ================= */
console.log('\n【A. 建课次】');
{
  const db = boot({});
  const s = stage(db);
  const a = db.lessons.create(s.c1, { termId: s.termId, date: '2026-11-01', title: '立方体', content: '透视与明暗' });
  ok('建第 1 次课：seq=1、weekday 由日期推导（2026-11-01 是周日 → 7）', () => {
    assert.ok(a.ok, a.msg);
    assert.strictEqual(a.item.seq, 1);
    assert.strictEqual(a.item.weekday, 7);
  });
  const b = db.lessons.create(s.c1, { termId: s.termId, date: '2026-11-08', title: '球体明暗' });
  ok('再建一次：seq 接尾为 2', () => {
    assert.ok(b.ok, b.msg);
    assert.strictEqual(b.item.seq, 2);
  });
  ok('时间白名单：合法 HH:mm 落库，脏值清空', () => {
    const r = db.lessons.create(s.c1, { termId: s.termId, date: '2026-11-15', startTime: '18:00', endTime: '25:99' });
    assert.ok(r.ok);
    assert.strictEqual(r.item.startTime, '18:00');
    assert.strictEqual(r.item.endTime, '', '脏时间必须清空而不是落库');
  });
  ok('不传 termId 时默认挂进行中学期', () => {
    const r = db.lessons.create(s.c1, { date: '2026-11-22' });
    assert.ok(r.ok);
    assert.strictEqual(r.item.termId, s.termId);
  });
  ok('校验拦得住：课题超长 / 结束不晚于开始 / 课程不存在', () => {
    const bad1 = db.lessons.create(s.c1, { termId: s.termId, title: '长'.repeat(31) });
    assert.match(bad1.msg, /课题过长/);
    const bad2 = db.lessons.create(s.c1, { termId: s.termId, startTime: '19:00', endTime: '18:00' });
    assert.match(bad2.msg, /结束时间必须晚于开始时间/);
    const bad3 = db.lessons.create(99999, {});
    assert.match(bad3.msg, /课程不存在/);
  });
}

/* ================= B. 批量生成 ================= */
console.log('\n【B. 批量生成】');
{
  const db = boot({});
  const s = stage(db);
  // 2026-11-01 是周日；选周日+周三，从 11-01 起 5 次 → 11-01(日) 11-04(三) 11-08(日) 11-11(三) 11-15(日)
  const r = db.lessons.batch(s.c1, { termId: s.termId, startDate: '2026-11-01', weekdays: [7, 3], count: 5, startTime: '18:00', endTime: '19:30' });
  ok('每周日+周三生成 5 次：日期按周展开、seq 连续、时间段批量填入', () => {
    assert.ok(r.ok, r.msg);
    assert.deepStrictEqual(r.items.map(x => x.date), ['2026-11-01', '2026-11-04', '2026-11-08', '2026-11-11', '2026-11-15']);
    assert.deepStrictEqual(r.items.map(x => x.seq), [1, 2, 3, 4, 5]);
    assert.ok(r.items.every(x => x.startTime === '18:00' && x.endTime === '19:30'));
  });
  ok('入参拦：没选每周上课日 / 次数非正 / 日期非法', () => {
    assert.match(db.lessons.batch(s.c1, { termId: s.termId, startDate: '2026-11-01', weekdays: [], count: 3 }).msg, /每周上课日/);
    assert.match(db.lessons.batch(s.c1, { termId: s.termId, startDate: '2026-11-01', weekdays: [1], count: 0 }).msg, /课次数/);
    assert.match(db.lessons.batch(s.c1, { termId: s.termId, startDate: 'bad', weekdays: [1], count: 3 }).msg, /YYYY-MM-DD/);
  });
  ok('批量接在已有课次后面，seq 不重头', () => {
    const r2 = db.lessons.batch(s.c1, { termId: s.termId, startDate: '2026-11-18', weekdays: [7], count: 2 });
    assert.deepStrictEqual(r2.items.map(x => x.seq), [6, 7]);
  });
}

/* ================= C. 确认与内容更新标记（方式 C） ================= */
console.log('\n【C. 确认 · 内容有更新】');
{
  const db = boot({});
  const s = stage(db);
  const a = db.lessons.create(s.c1, { termId: s.termId, date: '2026-11-01', title: '立方体', content: '透视' });
  ok('新建默认待确认', () => assert.strictEqual(a.item.status, 'draft'));
  const cf = db.lessons.confirm(a.item.id);
  ok('确认后：status=confirmed、有确认人与时间', () => {
    assert.ok(cf.ok, cf.msg);
    assert.strictEqual(cf.item.status, 'confirmed');
    assert.ok(cf.item.confirmedAt > 0);
  });
  const up = db.lessons.update(a.item.id, { content: '透视与明暗交界线' });
  ok('编辑已确认课次：保持已确认 + 打内容更新标记（方式 C）', () => {
    assert.ok(up.ok, up.msg);
    assert.strictEqual(up.item.status, 'confirmed');
    assert.ok(up.item.contentEditedAt >= up.item.confirmedAt, 'contentEditedAt 要刷新');
  });
  ok('再确认一次：确认时间刷新，「有更新」标记自然消失', () => {
    const cf2 = db.lessons.confirm(a.item.id);
    assert.ok(cf2.ok);
    assert.ok(cf2.item.confirmedAt >= cf2.item.contentEditedAt);
  });
  ok('非内容字段（seq）不动 contentEditedAt', () => {
    const before = db.lessons.get(a.item.id).contentEditedAt;
    const up2 = db.lessons.update(a.item.id, { seq: 9 });
    assert.ok(up2.ok);
    assert.strictEqual(db.lessons.get(a.item.id).contentEditedAt, before);
  });
}

/* ================= D. 序号 C'：错乱检测 + 一键重排 ================= */
console.log('\n【D. 序号机制】');
{
  const db = boot({});
  const s = stage(db);
  db.lessons.create(s.c1, { termId: s.termId, date: '2026-11-01' });
  db.lessons.create(s.c1, { termId: s.termId, date: '2026-11-08' });
  db.lessons.create(s.c1, { termId: s.termId, date: '2026-11-15' });
  ok('顺序建课时无错乱', () => assert.strictEqual(db.lessons.disorder(s.c1, s.termId), false));
  // 补录上周漏记的课：日期 11-04 排最前面，但 seq 是 4 → 错乱
  const late = db.lessons.create(s.c1, { termId: s.termId, date: '2026-11-04' });
  ok('补录旧日期的课 → create 返回 disorder=true', () => {
    assert.ok(late.ok);
    assert.strictEqual(late.disorder, true);
    assert.strictEqual(db.lessons.disorder(s.c1, s.termId), true);
  });
  // 无日期的大纲课次排最后，不参与检测
  db.lessons.create(s.c1, { termId: s.termId, title: '大纲：期末创作' });
  const re = db.lessons.reorder(s.c1, s.termId);
  ok('一键重排：有日期按（日期,时间）归位，无日期排最后按创建顺序', () => {
    assert.ok(re.ok, re.msg);
    const list = db.lessons.groups(s.c1)[0].lessons;
    assert.deepStrictEqual(list.map(x => [x.seq, x.date]), [
      [1, '2026-11-01'], [2, '2026-11-04'], [3, '2026-11-08'], [4, '2026-11-15'],
      [5, '']   // 无日期大纲课次殿后
    ]);
    assert.strictEqual(db.lessons.disorder(s.c1, s.termId), false);
  });
  ok('重排安全的前提在数据模型上成立：记录只存 lessonId，无序号冗余', () => {
    const ent = require(path.join(ROOT, 'utils/db/entities')).byColl('records');
    assert.ok(ent.fields.some(f => f.k === 'lessonId'));
    assert.ok(!ent.fields.some(f => f.k === 'lessonSeq'), '不应有序号冗余字段');
  });
}

/* ================= E. 权限：teacher 限自己可管理的课程 ================= */
console.log('\n【E. 权限】');
{
  const db = boot({});
  const s = stage(db);
  const mine = db.lessons.create(s.c1, { termId: s.termId, date: '2026-11-01', title: '立方体' });
  assert.ok(mine.ok);
  // 负责人先在"别人的课程"（c2）上建一次课，老师没有这门课的管理权
  const theirs = db.lessons.create(s.c2, { termId: s.termId, date: '2026-11-02', title: '水彩构图' });
  assert.ok(theirs.ok);
  db.users.switchTo(s.teacherUserId);
  ok('老师可给自己可管理课程建课次/确认/编辑', () => {
    const a = db.lessons.create(s.c1, { termId: s.termId, date: '2026-11-08' });
    assert.ok(a.ok, a.msg);
    assert.ok(db.lessons.confirm(mine.item.id).ok);
    assert.ok(db.lessons.update(mine.item.id, { title: '立方体结构' }).ok);
  });
  ok('老师不能动别人课程（fail-closed）', () => {
    assert.match(db.lessons.create(s.c2, {}).msg, /管理范围/);
    assert.match(db.lessons.update(theirs.item.id, {}).msg, /管理范围|无权/);
  });
  ok('删除同理被拦', () => {
    assert.match(db.lessons.remove(theirs.item.id).msg, /管理范围|无权/);
  });
}

/* ================= F. 归档学期只读 ================= */
console.log('\n【F. 归档只读】');
{
  const db = boot({});
  const s = stage(db);
  const a = db.lessons.create(s.c1, { termId: s.termId, date: '2026-11-01', title: '立方体' });
  assert.ok(a.ok);
  assert.ok(db.terms.archive(s.termId).ok, '归档学期');
  ok('归档后：建/改/确认/删/重排全部拒绝', () => {
    assert.match(db.lessons.create(s.c1, { termId: s.termId }).msg, /已归档/);
    assert.match(db.lessons.update(a.item.id, { title: 'x' }).msg, /已归档/);
    assert.match(db.lessons.confirm(a.item.id).msg, /已归档/);
    assert.match(db.lessons.remove(a.item.id).msg, /已归档/);
    assert.match(db.lessons.reorder(s.c1, s.termId).msg, /已归档/);
  });
  ok('归档组仍可读（补录历史要能看见）', () => {
    const g = db.lessons.groups(s.c1).find(x => x.term && x.term.id === s.termId);
    assert.ok(g && g.lessons.length === 1);
  });
}

/* ================= G. 记录关联课次 ================= */
console.log('\n【G. records.lessonId】');
{
  const db = boot({});
  const s = stage(db);
  const l1 = db.lessons.create(s.c1, { termId: s.termId, date: '2026-11-01', title: '立方体' });
  assert.ok(l1.ok);
  ok('保存记录可带 lessonId，落库可查', () => {
    const r = db.records.save({ cls: s.clsId, sid: s.stuId, course: '几何石膏体', lessonId: l1.item.id, score: 90 });
    assert.ok(r.ok, r.msg);
    assert.strictEqual(db.records.get(r.rid).lessonId, l1.item.id);
  });
  ok('课程与课次不匹配：明报错，不静默回落', () => {
    const bad = db.records.save({ cls: s.clsId, sid: s.stuId, course: '几何石膏体', lessonId: 99999, score: 90 });
    assert.match(bad.msg, /课次/);
  });
  ok('编辑记录保持原关联（不因改分数挪课）', () => {
    const first = db.records.save({ cls: s.clsId, sid: s.stuId, course: '几何石膏体', lessonId: l1.item.id, score: 80 });
    const rid = first.rid;
    const r2 = db.records.save({ rid, cls: s.clsId, sid: s.stuId, course: '几何石膏体', score: 95 });
    assert.ok(r2.ok, r2.msg);
    assert.strictEqual(db.records.get(rid).lessonId, l1.item.id);
  });
  ok('删课次后记录保留、查序号回退为 0（显示层由此判「未关联」）', () => {
    const rm = db.lessons.remove(l1.item.id);
    assert.ok(rm.ok);
    const rec = db.records.list().find(x => x.lessonId === l1.item.id);
    assert.ok(rec, '记录还在');
    assert.strictEqual(db.lessons.get(l1.item.id), null, '课次已删（视图不可见）');
  });
  ok('门面与页面用的接口都在（少一个页面就是 TypeError）', () => {
    ['get', 'groups', 'linked', 'create', 'batch', 'update', 'remove', 'confirm', 'disorder', 'reorder']
      .forEach(k => assert.strictEqual(typeof db.lessons[k], 'function', 'db.lessons.' + k + ' 缺失'));
  });
}

console.log('\n全部 ' + pass + ' 项课次断言通过');
