// tests/verify_course.js —— 课程：一次开给多个班 + 详细介绍字段 + 扩展槽
//
// 真机 2026-11-07（管理页课程页签）：用户问「语文能不能同时开给一班到六班」
// 「课程要不要加详细介绍、以后还能不能加更多字段」。
// 数据层 V10 本来就支持多班（courses 内容单元 + class_courses 多对多），卡在界面：
// 建课表单是单选 picker，「＋ 开设到…」用 ActionSheet 一次只能挑一个班且 slice(0,6)。
// 这组断言同时钉死：① 一次可绑任意多个班；② intro/meta 真的落库、同名复用不丢；
// ③ 界面不许退回一次一个班 / 6 个班上限；④ 新输入框仍配全站统一麦克风。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

/* ---------- 模拟 wx 存储 ---------- */
const mem = {};
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; }
};

const schema = require('../utils/db/schema');
const db = require('../utils/db');
db.init();

/* ================= A. 课程字段 ================= */
console.log('\n【A. 详细介绍与扩展槽】');
ok('normalizeCourse 收下 intro，并只保留 meta 里可序列化的标量', () => {
  const c = schema.normalizeCourse({
    name: '语文', intro: '  识字与阅读  ',
    meta: { age: '6-8岁', hours: 32, trial: true, bad: { x: 1 }, fn: () => {} }
  }, 'org1', 1000);
  assert.strictEqual(c.intro, '识字与阅读');
  assert.deepStrictEqual(c.meta, { age: '6-8岁', hours: 32, trial: true });
});
ok('脏 meta（数组/字符串/null）不会炸，统一成空对象', () => {
  [[], 'x', null, 3].forEach(v => {
    assert.deepStrictEqual(schema.normalizeCourse({ name: '课', meta: v }, 'org1', 1).meta, {});
  });
});
ok('介绍超过 500 字在 validate 层被拦住', () => {
  const c = schema.normalizeCourse({ name: '语文', intro: '字'.repeat(501) }, 'org1', 1);
  assert.match(schema.validate('course', c), /课程介绍过长/);
  assert.strictEqual(schema.validate('course', Object.assign({}, c, { intro: '字'.repeat(500) })), null);
});
ok('实体注册表与数据字典都登记了新字段（改字段忘登记/忘生成会红）', () => {
  const ent = require('../utils/db/entities').byColl('courses');
  ['intro', 'meta'].forEach(k => assert.ok(ent.fields.some(f => f.k === k), '注册表缺 ' + k));
  const dict = read('docs/data-dictionary.md');
  assert.ok(/\| `intro` \| string \|/.test(dict));
  assert.ok(/\| `meta` \| object \|/.test(dict));
});

/* ================= B. 一次开给多个班 ================= */
console.log('\n【B. 一门课同时开给 1~N 个班】');
const clsIds = [];
for (let i = 1; i <= 7; i++) clsIds.push(db.classes.create({ name: i + '班' }).item.id);
const made = db.courses.create({
  name: '语文', intro: '识字、阅读与表达',
  clsIds: clsIds.slice(0, 6), meta: { age: '6-8岁' }
});
ok('建课时一次勾 6 个班：课程只存一条，介绍与 meta 都落库', () => {
  assert.ok(made.ok, made.msg);
  const c = db.courses.get(made.item.id);
  assert.strictEqual(c.intro, '识字、阅读与表达');
  assert.deepStrictEqual(c.meta, { age: '6-8岁' });
  assert.deepStrictEqual(c.classIds.slice().sort((a, b) => a - b), clsIds.slice(0, 6).sort((a, b) => a - b));
  assert.strictEqual(db.courses.list().filter(c => c.name === '语文').length, 1, '不能每班复制一条课');
});
ok('setClasses 能补到第 7 个班（界面旧版只显示前 6 个）', () => {
  const r = db.courses.setClasses(made.item.id, clsIds);
  assert.ok(r.ok, r.msg);
  assert.strictEqual(db.courses.classIdsOf(made.item.id).length, 7);
});
ok('setClasses 写的是结果状态：没勾的班一次撤下，课程本身仍在', () => {
  const r = db.courses.setClasses(made.item.id, clsIds.slice(0, 2));
  assert.ok(r.ok, r.msg);
  assert.strictEqual(r.removed, 5);
  assert.strictEqual(db.courses.classIdsOf(made.item.id).length, 2);
  assert.ok(db.courses.get(made.item.id), '撤班不能把课程删掉');
});

/* ================= C. 同名复用与详情编辑 ================= */
console.log('\n【C. 同名复用 / 详情编辑】');
ok('同名课程复用时把新填的介绍补上，不新建第二条', () => {
  const old = db.courses.create({ name: '美学通识' }).item;
  assert.strictEqual(db.courses.get(old.id).intro, '');
  const again = db.courses.create({ name: '美学通识', intro: '色彩与构图', clsIds: [clsIds[0]] });
  assert.ok(again.ok, again.msg);
  assert.strictEqual(again.reused, true);
  assert.strictEqual(again.item.id, old.id);
  assert.strictEqual(db.courses.get(old.id).intro, '色彩与构图');
  assert.ok(db.courses.classIdsOf(old.id).indexOf(clsIds[0]) > -1);
});
ok('再建同名课时不覆盖别人写好的介绍', () => {
  db.courses.create({ name: '美学通识', intro: '别的内容' });
  const c = db.courses.list().find(x => x.name === '美学通识');
  assert.strictEqual(c.intro, '色彩与构图');
});
ok('update 只改介绍：名称、学科、班级绑定都不动', () => {
  const before = db.courses.classIdsOf(made.item.id).slice();
  const c0 = db.courses.get(made.item.id);
  const r = db.courses.update(c0.id, { intro: '改过的介绍' });
  assert.ok(r.ok, r.msg);
  const c = db.courses.get(c0.id);
  assert.strictEqual(c.intro, '改过的介绍');
  assert.strictEqual(c.name, c0.name);
  assert.strictEqual(c.subjectId, c0.subjectId);
  assert.deepStrictEqual(c.classIds.slice().sort(), before.sort());
});

/* ================= D. 界面：不许退回一次一个班 ================= */
console.log('\n【D. 管理页交互】');
const js = read('pages/mgr/mgr.js');
const wxml = read('pages/mgr/mgr.wxml');
ok('建课表单改成班级多选，并把 clsIds / intro 一起交给数据层', () => {
  assert.ok(/courseClsChips/.test(wxml) && /toggleCourseCls/.test(wxml), '建课表单没有班级多选');
  assert.ok(/create\(\{ name: n, intro: this\.data\.newIntro \|\| '', clsIds: picked \}\)/.test(js));
});
ok('「＋ 开设到…」改成全量班级弹层，一次保存走 setClasses', () => {
  assert.ok(!/showActionSheet/.test(js), '不许再用一次只能选一个班的 ActionSheet');
  assert.ok(!/slice\(0, ?6\)/.test(js), '不许再把班级截到前 6 个');
  assert.ok(/crsBindTgl/.test(wxml) && /crsBindAll/.test(wxml) && /saveCrsBind/.test(wxml));
  assert.ok(/db\.courses\.setClasses\(b\.id, b\.sel\)/.test(js));
});
ok('课程卡片有详情入口，两个介绍输入框都接了统一麦克风', () => {
  assert.ok(/openCrsDetail/.test(wxml) && /saveCrsDetail/.test(wxml));
  assert.ok(/crsintro/.test(wxml), '列表要露一行介绍摘要');
  const areas = (wxml.match(/<textarea[^>]*class="crstext vin-in"[^>]*\/>/g) || []);
  assert.strictEqual(areas.length, 2, '建课表单 + 详情弹层各一个介绍框');
  // verify_voice.js 全站数量守卫视每个自由输入框都有麦克风，这里再钉死新增的两处
  ['newIntro', 'crsDetail.intro'].forEach(k => {
    assert.ok(new RegExp('data-k="' + k.replace('.', '\\.') + '"').test(wxml));
    assert.ok(new RegExp("src=\"\\{\\{micKey==='" + k.replace('.', '\\.') + "'\\?icoWhite:icoMic\\}\\}\"").test(wxml));
  });
});
ok('离开管理页会停掉麦克风', () => {
  assert.ok(/onHide\(\)[\s\S]{0,80}voice\.stop\(this\)/.test(js));
  assert.ok(/onUnload\(\)[\s\S]{0,80}voice\.stop\(this\)/.test(js));
});

console.log('\n全部 ' + pass + ' 项课程断言通过');
if (process.env.EXIT_STRICT) process.exit(0);
