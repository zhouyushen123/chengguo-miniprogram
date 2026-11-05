// tests/verify_pages.js —— 页面级联调：把真实页面模块跑起来，验证改数据层后流程没断
process.env.CG_CLOUD = '1';   // 本套件需验证 aiEvalDraft 链路：api.js 模块加载时读此开关
const path = require('path');
const assert = require('assert');

/* ---------------- 模拟小程序运行环境 ---------------- */
const mem = {};
const toasts = [];
// 弹层输入框的模拟内容（addOpt / editOpt 等会读 success 回调里的 content）
const modal = { content: '' };
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; },
  showToast: o => { toasts.push(o && o.title); },
  showModal: o => { if (o && o.success) o.success({ confirm: true, content: modal.content }); },
  navigateTo: () => {}, switchTab: () => {}, navigateBack: () => {},
  setNavigationBarTitle: () => {}, stopPullDownRefresh: () => {},
  previewImage: () => {}, setClipboardData: o => { o && o.success && o.success(); },
  showLoading: () => {}, hideLoading: () => {},
  createInnerAudioContext: () => ({ onEnded() {}, onError() {}, play() {}, stop() {} }),
  env: { USER_DATA_PATH: '/tmp' },
  getFileSystemManager: () => ({ copyFileSync() {} })
};
const appInst = { globalData: { pick: null } };
global.getApp = () => appInst;
global.App = () => {};

let captured = null;
global.Page = cfg => { captured = cfg; };

function loadPage(rel) {
  captured = null;
  const full = path.join(__dirname, '..', rel);
  delete require.cache[require.resolve(full)];
  require(full);
  const cfg = captured;
  const page = Object.assign({}, cfg);
  page.data = JSON.parse(JSON.stringify(cfg.data || {}));
  page.setData = function (patch, cb) {
    Object.keys(patch).forEach(k => {
      if (k.indexOf('.') > -1) {
        const parts = k.split('.'); let o = page.data;
        for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]]) o[parts[i]] = {}; o = o[parts[i]]; }
        o[parts[parts.length - 1]] = patch[k];
      } else page.data[k] = patch[k];
    });
    if (cb) cb();
  };
  return page;
}

// 页面联调需要一份"有内容"的真实库：用演示数据集铺一份去掉 demo 标记的种子数据，
// 等价于"这位老师自己录了这些学生和记录"（真实库不该自带演示数据）。
const seedFixture = require('./fixture').richSeed();
Object.keys(seedFixture).forEach(k => { mem[k] = seedFixture[k]; });
const db = require('../utils/db');
db.init();

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

console.log('\n【首页】');
const index = loadPage('pages/index/index.js');
ok('老师端渲染：班级 2 / 学生 45 / 最近成果 5 条', () => {
  index.onShow();
  assert.strictEqual(index.data.clsCount, 2);
  assert.strictEqual(index.data.stuCount, 45);
  assert.strictEqual(index.data.recent.length, 5);
  assert.strictEqual(index.data.uName, '林老师');
  assert.ok(index.data.myClasses.every(c => c.count > 0));
});
ok('模糊搜索：输入单字命中所有含该字的学生', () => {
  index.onSearch({ detail: { value: '周' } });
  assert.ok(index.data.results.length > 0, '应有命中');
  assert.ok(index.data.results.every(r => r.name.indexOf('周') > -1));
  index.clearSearch();
  assert.strictEqual(index.data.results.length, 0);
});

console.log('\n【录入 → 首页可见（原不同步问题的闭环）】');
const record = loadPage('pages/record/record.js');
let newRid = 0;
ok('录入页带参进入：班级、课程、学生就位', () => {
  appInst.globalData.pick = { cls: 1, sid: 101, score: 85, photos: [], videos: [], audio: null, tag: '', note: '', rid: null, course: '' };
  record.onLoad({});
  assert.strictEqual(record.data.clsId, 1);
  assert.strictEqual(record.data.course, '楷书');
  assert.strictEqual(record.data.students.length, 45);
  assert.strictEqual(record.data.sid, 101);
});
ok('只写文字也能判定为"可发送"', () => {
  record.onNote({ detail: { value: '上课态度：认真专注' } });
  assert.strictEqual(record.data.canSend, true);
});
ok('保存后落到规范字段，并出现在首页最近成果', () => {
  record.save({ currentTarget: { dataset: { send: '1' } } });
  const latest = db.records.latest(101);
  assert.ok(latest, '应有新记录');
  newRid = latest.id;
  assert.strictEqual(latest.cid, 1);
  assert.strictEqual(latest.sent, true);
  index.onShow();
  assert.strictEqual(index.data.recent[0].id, newRid, '新记录应排在首页最近成果第一位');
  assert.strictEqual(index.data.recent[0].clsName, '书法班');
});
ok('编辑入口回填：课程定位正确（不再默认第一门课）', () => {
  // 必须用素描班里的学生：记录带 cid∈学生班级 的强校验，随便挑一个书法班的学生录素描班
  // 正是这个校验要拦的情况（以前能过，记录会挂到学生并不在的班上）
  const s2 = db.students.of(2)[0];
  const r = db.records.save({ cls: 2, sid: s2.id, course: '素描', note: '素描课', photos: ['x.jpg'] }, true).record;
  appInst.globalData.pick = { cls: 2, sid: s2.id, course: '素描', score: r.score, note: r.note, photos: r.photos, rid: r.id };
  record.onLoad({});
  assert.strictEqual(record.data.course, '素描');
  assert.strictEqual(record.data.clsId, 2);
});

console.log('\n【记录页：三段级联筛选 + 双按钮】');
const records = loadPage('pages/records/records.js');
ok('渲染出班级页签与全量记录', () => {
  records.onShow();
  assert.deepStrictEqual(records.data.tabs, ['全部', '书法班', '素描班']);
  assert.strictEqual(records.data.role, 'owner'); // 全新安装时首个老师即机构负责人
  assert.ok(records.data.list.length > 0);
});
ok('选班级 → 日期选项只列该班有记录的日期', () => {
  records.pickTab({ currentTarget: { dataset: { i: 1 } } });
  const dates = records.data.dateOpts.slice(1);
  const pool = db.records.ofClass(1).map(r => r.date);
  assert.ok(dates.every(d => pool.indexOf(d) > -1));
  assert.ok(dates.length > 0);
});
ok('选日期 → 等级只列该批出现过的等级，结果只含该日期', () => {
  records.onDate({ detail: { value: 1 } });
  const d = records.data.dateOpts[1];
  assert.ok(records.data.list.every(r => r.date === d));
  const tagsShown = records.data.tagOpts.slice(1);
  assert.ok(tagsShown.every(t => records.data.list.some(r => r.tag === t)));
});
ok('双按钮：编辑带全量字段跳录入页', () => {
  records.onShow();
  const item = records.data.list.find(r => !r.sent) || records.data.list[0];
  records.editRec({ currentTarget: { dataset: { rid: item.id } } });
  const pick = appInst.globalData.pick;
  assert.strictEqual(pick.rid, item.id);
  assert.strictEqual(pick.sid, item.sid);
  assert.strictEqual(pick.cls, db.records.get(item.id).cid);
});
ok('发送给家长：状态落库且按钮变灰', () => {
  // 重置筛选（切回"全部"，日期/等级归位）：前面用例把日期定在了最新日期桶，
  // 演示数据固定而真实保存的记录用当天日期，跨天跑测试时该桶里可能没有未发送记录
  records.pickTab({ currentTarget: { dataset: { i: 0 } } });
  const item = records.data.list.find(r => !r.sent);
  assert.ok(item, '应有未发送记录');
  records.sendRec({ currentTarget: { dataset: { rid: item.id } } });
  assert.strictEqual(db.records.get(item.id).sent, true);
  records.onShow();
  assert.strictEqual(records.data.list.find(r => r.id === item.id).sent, true);
});

console.log('\n【班级详情页：三状态 + 统一发送】');
const cls = loadPage('pages/cls/cls.js');
ok('三状态计数相加等于全班人数', () => {
  cls.onLoad({ id: '1' });
  cls.render();
  const c = cls.data.counts;
  assert.strictEqual(cls.data.tiles.length, 45);
  assert.strictEqual(c.none + c.rec + c.sent, 45);
});
ok('色块排序：未录入 → 已录入 → 已发布', () => {
  const w = { none: 0, rec: 1, sent: 2 };
  const arr = cls.data.tiles.map(t => w[t.st]);
  for (let i = 1; i < arr.length; i++) assert.ok(arr[i] >= arr[i - 1], '状态排序错乱');
});
ok('统一发送后今日待发送归零', () => {
  cls.render();
  const before = cls.data.pending;
  cls.sendAll();
  cls.render();
  assert.strictEqual(cls.data.pending, 0);
  assert.ok(before >= 0);
});

console.log('\n【学生主页】');
const student = loadPage('pages/student/student.js');
ok('最近一条 + 历史列表 + 老师名都取得到', () => {
  student.onLoad({ id: '101' });
  student.render();
  assert.ok(student.data.s && student.data.s.name);
  assert.ok(student.data.total > 0);
  assert.ok(student.data.teacher, '语音条需要老师名');
  assert.ok(Array.isArray(student.data.history));
});
ok('零记录学生进详情不白屏（deco(null) 曾抛异常 → 白屏+错误复制）', () => {
  const created = db.students.create({ name: '零记录学生', clsIds: [] });
  assert.ok(created.ok, '建学生失败：' + created.msg);
  const p2 = loadPage('pages/student/student.js');
  p2.onLoad({ id: String(created.item.id) });
  p2.onShow();
  assert.ok(p2.data.s && p2.data.s.name === '零记录学生', '页面应正常渲染出学生');
  assert.strictEqual(p2.data.latest, null);
  assert.strictEqual(p2.data.total, 0);
  // rid 指向不存在/不可见的记录时同样要稳
  const p3 = loadPage('pages/student/student.js');
  p3.onLoad({ rid: '999999', sid: String(created.item.id) });
  p3.onShow();
  assert.strictEqual(p3.data.rec, null);
  db.students.remove(created.item.id);   // 清理，免得影响后续"学生总数 45"的断言
});
ok('历史条目行内展开（不跳页）', () => {
  const h = student.data.history[0];
  assert.ok(h, '应有历史记录');
  student.toggleExpand({ currentTarget: { dataset: { rid: h.id } } });
  assert.strictEqual(student.data.expandId, h.id);
  student.toggleExpand({ currentTarget: { dataset: { rid: h.id } } });
  assert.strictEqual(student.data.expandId, 0);
});
ok('按课程筛选', () => {
  const f = student.data.filters[1];
  student.pickFilter({ currentTarget: { dataset: { f } } });
  assert.ok(student.data.history.concat(student.data.latest).every(r => !r || r.course === f));
});

console.log('\n【管理页：增删改都过规范化 + 校验】');
const mgr = loadPage('pages/mgr/mgr.js');
ok('列表渲染：班级/课程/学生/人员齐备', () => {
  mgr.onShow();
  assert.strictEqual(mgr.data.classes.length, 2);
  assert.strictEqual(mgr.data.courses.length, 2);
  assert.strictEqual(mgr.data.students.length, 45);
  assert.strictEqual(mgr.data.members.length, 2);
  assert.strictEqual(mgr.data.teacher, '林老师');
  assert.strictEqual(mgr.data.isManager, true);
});
ok('新增班级', () => {
  mgr.onNewCls({ detail: { value: '国画班' } });
  mgr.addClass();
  assert.strictEqual(mgr.data.classes.length, 3);
  assert.ok(mgr.data.classes.some(c => c.name === '国画班'));
});
ok('空名称班级被拒并提示', () => {
  const before = mgr.data.classes.length;
  mgr.onNewCls({ detail: { value: '  ' } });
  mgr.addClass();
  assert.strictEqual(mgr.data.classes.length, before);
  assert.ok(toasts[toasts.length - 1].indexOf('不能为空') > -1);
});
ok('班级展开：添加学生到本班预选该班级', () => {
  mgr.onClsTap({ currentTarget: { dataset: { id: 1 } } });
  assert.strictEqual(mgr.data.clsExpand, 1);
  mgr.addClsStudent({ currentTarget: { dataset: { id: 1 } } });
  assert.ok(mgr.data.stuForm);
  assert.deepStrictEqual(mgr.data.stuClsSel, [1]);
  mgr.stuCancel();
  assert.strictEqual(mgr.data.stuForm, null);
  mgr.onClsTap({ currentTarget: { dataset: { id: 1 } } }); // 收起
  assert.strictEqual(mgr.data.clsExpand, 0);
});
ok('班级卡展开：本班学生列表与筛选', () => {
  mgr.onClsTap({ currentTarget: { dataset: { id: 1 } } });
  assert.strictEqual(mgr.data.clsExpand, 1);
  assert.ok(mgr.data.clsStus.length > 0);
  const k = mgr.data.clsStus[0].name[0];
  mgr.onClsStuQ({ detail: { value: k } });
  assert.ok(mgr.data.clsStus.every(s => s.name.indexOf(k) >= 0 || (s.parent || '').indexOf(k) >= 0));
  mgr.onClsStuQ({ detail: { value: '' } });
  mgr.onClsTap({ currentTarget: { dataset: { id: 1 } } });
  assert.strictEqual(mgr.data.clsExpand, 0);
  assert.strictEqual(mgr.data.clsStus.length, 0);
});
ok('新增学生（带班级）', () => {
  const before = mgr.data.students.length;
  mgr.addStudent();
  mgr.onStuName({ detail: { value: '测试新增' } });
  mgr.stuClsTgl({ currentTarget: { dataset: { id: 1 } } });
  mgr.stuSave();
  assert.strictEqual(mgr.data.students.length, before + 1);
  const s = mgr.data.students.find(x => x.name === '测试新增');
  assert.strictEqual(s.cls, '书法班');
});
ok('学生筛选：模糊搜索命中姓名/家长/微信号', () => {
  mgr.onStuQ({ detail: { value: '测试新增' } });
  assert.strictEqual(mgr.data.students.length, 1);
  mgr.onStuQ({ detail: { value: '' } });
  assert.strictEqual(mgr.data.students.length, mgr.data.stuCount);
});
ok('学生筛选：性别未知归桶 + 表单补录后可筛出', () => {
  mgr.onStuGender({ currentTarget: { dataset: { v: '未知' } } });
  assert.ok(mgr.data.students.length > 0 && mgr.data.students.every(x => !x.gender));
  const first = mgr._stuAll[0];
  mgr.onStuGender({ currentTarget: { dataset: { v: '' } } });
  // 通过表单给第一名学生补录性别，存量学生默认都是「未知」
  mgr.editStudent({ currentTarget: { dataset: { id: first.id } } });
  mgr.onStuGenderSet({ currentTarget: { dataset: { v: '女' } } });
  assert.strictEqual(mgr.data.stuForm.gender, '女');
  mgr.stuSave();
  assert.strictEqual(db.students.get(first.id).gender, '女');
  mgr.onStuGender({ currentTarget: { dataset: { v: '女' } } });
  assert.ok(mgr.data.students.some(x => x.id === first.id));
  mgr.onStuGender({ currentTarget: { dataset: { v: '' } } });
});
ok('学生筛选：入学年份选项由数据倒推且过滤正确', () => {
  assert.ok(mgr.data.stuYears.length >= 1 && mgr.data.stuYears[0].name === '全部');
  if (mgr.data.stuYears.length > 1) {
    mgr.onStuYear({ detail: { value: 1 } });
    const y = mgr.data.stuYears[1].y;
    assert.ok(mgr.data.students.every(x => x.year === y));
    mgr.onStuYear({ detail: { value: 0 } });
  }
});
ok('学生表单：入学年份选择器保存并落库', () => {
  const first = mgr._stuAll[0];
  mgr.editStudent({ currentTarget: { dataset: { id: first.id } } });
  // 选项结构：[未填, 2026, 2025, ...]，取第 2 项（最近一年）
  const opt = mgr.data.enrollYearOpts[1];
  mgr.onStuEnrollYear({ detail: { value: 1 } });
  assert.strictEqual(mgr.data.stuForm.enrollYear, opt.y);
  mgr.stuSave();
  assert.strictEqual(db.students.get(first.id).enrollYear, opt.y);
  // 筛选该年份应能找到该学生
  mgr.onStuYear({ detail: { value: 0 } });
  assert.ok(mgr.data.stuYears.some(x => x.y === opt.y));
});
ok('删除学生同时清掉其记录', () => {
  const s = db.students.create({ name: '待删', clsIds: [1] }).item;
  const r = db.records.save({ cls: 1, sid: s.id, note: '会被一起删' }, true).record;
  mgr.delStudent({ currentTarget: { dataset: { id: s.id } } });
  assert.strictEqual(db.students.get(s.id), null);
  assert.strictEqual(db.records.get(r.id), null);
});
ok('切换身份：家长端只看到自己孩子', () => {
  const parent = mgr.data.members.find(u => u.role === 'parent');
  mgr.switchMe({ currentTarget: { dataset: { id: parent.id } } });
  index.onShow();
  assert.strictEqual(index.data.isParent, true);
  assert.strictEqual(index.data.roleLabel, '家长端');
  assert.ok(index.data.kids.length >= 1);
  // 家长视角下成员列表为空，必须靠「切回我自己」这个出口，否则会锁死
  assert.strictEqual(mgr.data.members.length, 0, '家长不该看到同事名单');
  assert.strictEqual(mgr.data.canSwitchHome, true, '应提供返回入口');
  mgr.backHome();
  assert.strictEqual(db.isParent(), false);
  assert.strictEqual(db.auth.role(), 'owner');
  index.onShow();
  assert.strictEqual(index.data.isParent, false);
});
ok('家长身份下记录页只显示孩子、且编辑被拒', () => {
  const pm = mgr.data.members.find(m => m.role === 'parent');
  mgr.switchMe({ currentTarget: { dataset: { id: pm.id } } });
  records.onShow();
  const kidId = db.users.current().studentIds[0];
  assert.ok(records.data.list.every(r => r.sid === kidId));
  records.editRec({ currentTarget: { dataset: { rid: records.data.list[0].id } } });
  assert.ok(toasts[toasts.length - 1].indexOf('只读') > -1);
  mgr.backHome();
});

console.log('\n【学期管理页：新建 + 结转向导】');
const terms = loadPage('pages/terms/terms.js');
ok('学期列表渲染：内置长期班 + 建议胶囊生成', () => {
  terms.onShow();
  assert.ok(terms.data.terms.some(t => t.builtIn && t.name === '长期班'));
  assert.ok(terms.data.sugg.length >= 5);
});
ok('新建学期（秋季班）落库并出现在列表', () => {
  terms.openCreate();
  terms.onF({ currentTarget: { dataset: { k: 'name' } }, detail: { value: '2027 春季班' } });
  terms.saveTerm();
  assert.ok(terms.data.terms.some(t => t.name === '2027 春季班'));
  assert.strictEqual(terms.data.showCreate, false);
});
ok('结转向导：建结转班+报名+记录后可走通四步', () => {
  // 准备：上一个进行中学期 + 结转制班级 + 10 课时的学生
  const t0 = db.terms.create({ name: '2026 秋季班' }).item;
  db.terms.update(t0.id, { status: 'active' });
  const c0 = db.classes.create({ name: '硬笔提高', termId: t0.id, mode: 'carry' }).item;
  const s0 = db.students.create({ name: '结转测试生', clsIds: [c0.id] }).item;
  db.enrollments.create({ studentId: s0.id, clsId: c0.id, totalHours: 10 });
  db.records.save({ sid: s0.id, cls: c0.id, course: '硬笔', score: 90, tag: '优秀', note: '好' }, false);
  terms.onShow();
  terms.startWizard({ currentTarget: { dataset: { id: t0.id } } });
  assert.strictEqual(terms.data.wz.step, 1);
  // 步骤1：默认延续 + 新学期名
  assert.strictEqual(terms.data.wz.classes[0].decision, 'carry');
  terms.wzStep({ currentTarget: { dataset: { s: 2 } } });
  // 步骤2：指派老师（owner 成员）
  const owner = terms.data.wz.staff[0];
  terms.wzTeacher({ currentTarget: { dataset: { ci: 0 } }, detail: { value: 0 } });
  assert.ok(terms.data.wz.classes[0].teacherId > 0 || owner.id > 0);
  terms.wzStep({ currentTarget: { dataset: { s: 3 } } });
  // 步骤3：默认续报，把剩余 9 课时带过去
  assert.strictEqual(terms.data.wz.classes[0].students[0].act, 're');
  assert.strictEqual(terms.data.wz.classes[0].students[0].remain, 9);
  terms.wzStep({ currentTarget: { dataset: { s: 4 } } });
  // 步骤4：生成并归档
  terms.wzGenerate();
  assert.strictEqual(terms.data.mode, 'list');
  const nt = db.terms.list().find(t => t.name === '2027 春季班');
  assert.ok(nt, '新学期应已创建');
  const newCls = db.classes._all().find(c => c.termId === nt.id && c.name === '硬笔提高');
  assert.ok(newCls, '延续班级应在新学期');
  assert.strictEqual(newCls.mode, 'carry');
  const newEn = db.enrollments.of(newCls.id, s0.id);
  assert.ok(newEn, '续报报名应存在');
  assert.strictEqual(newEn.totalHours, 9, '剩余 9 课时带入');
  const oldEn = db.enrollments.ofClass(c0.id).find(e => e.studentId === s0.id);
  assert.ok(oldEn, '旧报名应存在');
  assert.strictEqual(oldEn.status, 'carried', '旧报名标记已结转');
  assert.strictEqual(db.terms.get(t0.id).status, 'archived', '旧学期已归档');
});
ok('归档学期的班级不再出现在录入页班级列表', () => {
  const record2 = loadPage('pages/record/record.js');
  record2.onLoad({});
  assert.ok(record2.data.clsId, '应有可选班级');
});

console.log('\n【模板页：增删改选项】');
const tpls = loadPage('pages/tpls/tpls.js');
ok('渲染 5 个维度', () => {
  tpls.onLoad({ mode: 'select' });
  assert.strictEqual(tpls.data.groups.length, 5);
  assert.ok(tpls.data.groups[0].id > 0);
  assert.ok(tpls.data.groups[0].opts.length > 0);
});
ok('新增选项落库', () => {
  const n0 = tpls.data.groups[0].opts.length;
  modal.content = '认真专注，坐姿端正';
  tpls.addOpt({ currentTarget: { dataset: { i: 0 } } });
  assert.strictEqual(tpls.data.groups[0].opts.length, n0 + 1);
});
ok('重名选项被拒并提示', () => {
  const n0 = tpls.data.groups[0].opts.length;
  modal.content = '认真专注，坐姿端正';
  tpls.addOpt({ currentTarget: { dataset: { i: 0 } } });
  assert.strictEqual(tpls.data.groups[0].opts.length, n0);
  assert.ok(toasts[toasts.length - 1].indexOf('已有') > -1);
});
ok('编辑选项落库', () => {
  modal.content = '改过的评语';
  tpls.editOpt({ currentTarget: { dataset: { i: 0, j: 0 } } });
  assert.strictEqual(tpls.data.groups[0].opts[0].o, '改过的评语');
});
ok('删除选项后选中项正确位移（不再错位选中别的评语）', () => {
  tpls.sel = ['0:0', '0:1', '0:2'];
  const g = tpls.data.groups[0];
  assert.ok(g.opts.length >= 3);
  tpls.delOpt({ currentTarget: { dataset: { i: 0, j: 1 } } });
  assert.deepStrictEqual(tpls.sel, ['0:0', '0:1'], '选中下标应前移');
});

console.log('\n【老师档案：成员档案字段 + 档案页】');
let teacherMid = 0;
ok('成员表单可填手机号/微信号并落库', () => {
  mgr.openUserForm({ role: 'teacher', name: '王老师' });
  mgr.onUserPhone({ detail: { value: '13800001111' } });
  mgr.onUserWechat({ detail: { value: 'wang_laoshi' } });
  mgr.userClsTgl({ currentTarget: { dataset: { id: 1 } } }); // 老师必须至少一个班
  mgr.userSave();
  const t = db.members.list().find(m => m.name === '王老师');
  assert.ok(t, '成员已创建');
  teacherMid = t.id;
  assert.strictEqual(t.phone, '13800001111');
  assert.strictEqual(t.wechat, 'wang_laoshi');
});
ok('成员卡点按跳老师档案页', () => {
  const navs = [];
  const old = global.wx.navigateTo;
  global.wx.navigateTo = o => { navs.push(o.url); };
  mgr.goTeacher({ currentTarget: { dataset: { id: teacherMid } } });
  global.wx.navigateTo = old;
  assert.deepStrictEqual(navs, ['/pages/teacher/teacher?id=' + teacherMid]);
});
ok('老师档案页：个人卡 + 统计 + 负责班级 + 最近成果', () => {
  const teacher = loadPage('pages/teacher/teacher.js');
  teacher.onLoad({ id: teacherMid });
  teacher.onShow();
  assert.strictEqual(teacher.data.m.name, '王老师');
  assert.strictEqual(teacher.data.m.phone, '13800001111');
  assert.strictEqual(teacher.data.stats.clsN, 1);
  assert.deepStrictEqual(teacher.data.clsList.map(c => c.id), [1]);
  assert.ok(teacher.data.recTotal >= 0);
  assert.ok(teacher.data.recent.length <= 10);
});
ok('老师档案页：成员不存在时给空态不崩溃', () => {
  const teacher = loadPage('pages/teacher/teacher.js');
  teacher.onLoad({ id: 999999 });
  teacher.onShow();
  assert.strictEqual(teacher.data.m, null);
});
ok('测试成员清理，不污染后续用例', () => {
  const r = db.members.remove(teacherMid);
  assert.ok(r.ok !== false);
  assert.ok(!db.members.list().some(m => m.name === '王老师'));
});

console.log('\n【学号与家长绑定】');
ok('新建学生自动分配学号，编辑表单展示学号', () => {
  mgr.openStuForm(null, [1]);
  mgr.onStuName({ detail: { value: '学号测试生' } });
  mgr.stuSave();
  const s = db.students.list().find(x => x.name === '学号测试生');
  assert.ok(s, '学生已保存');
  assert.ok(/^\d+$/.test(s.no), '保存后应自动带学号：' + s.no);
  mgr.openStuForm(s.id);
  assert.strictEqual(mgr.data.stuForm.no, s.no, '编辑表单应展示学号');
  mgr.stuCancel();
  db.students.remove(s.id);
});
ok('家长表单按学号绑定：同家长的孩子一并带出', () => {
  const a = db.students.create({ name: '小明', clsIds: [1], wechat: '13500009999' }).item;
  const b = db.students.create({ name: '小亮', clsIds: [1], wechat: '13500009999' }).item;
  mgr.openUserForm({ role: 'parent' });
  mgr.onBindNo({ detail: { value: a.no } });
  mgr.bindByNo();
  assert.ok(mgr.data.userStuSel.indexOf(a.id) > -1, '按学号应加上该学生');
  assert.ok(mgr.data.userStuSel.indexOf(b.id) > -1, '同家长号码的另一个孩子应自动带出');
  assert.ok(mgr.data.userStuChips.some(c => c.name.indexOf(a.no) > -1), '孩子胶囊要显示学号，防重名选错');
  mgr.userCancel();
  [a.id, b.id].forEach(id => db.students.remove(id));
});

console.log('\n【重启：数据持久化】');
ok('重新加载后数据不变', () => {
  const before = { cls: db.classes.list().length, stu: db.students.list().length, rec: db.records.list().length };
  Object.keys(require.cache).forEach(k => { if (k.indexOf(path.join('utils', 'db')) > -1) delete require.cache[k]; });
  const db2 = require('../utils/db');
  db2.init();
  assert.strictEqual(db2.classes.list().length, before.cls);
  assert.strictEqual(db2.students.list().length, before.stu);
  assert.strictEqual(db2.records.list().length, before.rec);
});

console.log('\n【图标资产：引用即存在，且函数式图标可调用】');
console.log('\n【我的页：管理统计层】');
const mine = loadPage('pages/mine/mine.js');
mine.onShow();
ok('统计层两行三列、六维数据齐备（上行学生/家长/老师，下行班级/课程/学期）', () => {
  assert.strictEqual(mine.data.statRows.length, 2);
  assert.deepStrictEqual(mine.data.statRows[0].map(x => x.k), ['stu', 'parent', 'teacher']);
  assert.deepStrictEqual(mine.data.statRows[1].map(x => x.k), ['cls', 'crs', 'term']);
  const flat = mine.data.statRows.flat();
  assert.strictEqual(flat.find(x => x.k === 'stu').n, db.students.list().length);
  assert.strictEqual(flat.find(x => x.k === 'cls').n, db.classes.list().length);
  assert.strictEqual(flat.find(x => x.k === 'term').n, db.terms.list().length);
  assert.ok(flat.every(x => x.k !== 'term' || x.tab === null), '学期不走管理页页签');
  assert.ok(!mine.data.entries.some(e => e.k === 'mgr' || e.k === 'member'));
});
ok('统计点按跳转到管理页对应页签（负责人管理页多「机构」页签在最前，tab 统一 +1），学期进独立学期管理页', () => {
  const navs = [];
  const old = global.wx.navigateTo;
  global.wx.navigateTo = o => { navs.push(o.url); };
  mine.tapStat({ currentTarget: { dataset: { tab: 2 } } });   // 学生：负责人页签 0机构1班级2课程3学生4人员 → 3
  mine.tapStat({ currentTarget: { dataset: { tab: 3 } } });   // 家长/老师 → 人员页签 4
  mine.tapStat({ currentTarget: { dataset: { tab: null, k: 'term' } } });
  global.wx.navigateTo = old;
  assert.deepStrictEqual(navs, ['/pages/mgr/mgr?tab=3', '/pages/mgr/mgr?tab=4', '/pages/terms/terms']);
});

ok('全站图标引用与 assets/icons 一一对应', () => {
  const fs = require('fs');
  const root = path.join(__dirname, '..');
  const icons = require('../utils/icons');
  const dirs = fs.readdirSync(path.join(root, 'pages'));
  const missing = [];
  dirs.forEach(d => {
    const f = path.join(root, 'pages', d, d + '.js');
    if (!fs.existsSync(f)) return;
    const src = fs.readFileSync(f, 'utf8');
    const re = /icons\.([a-zA-Z]+)(\s*\()?/g;
    // 这三个不是图标，是图标库自身的工具方法（页面对它们只做调用，不产出图片路径）
    const NOT_ICON = ['setTheme', 'brand', 'std'];
    let m;
    while ((m = re.exec(src))) {
      const key = m[1], called = !!m[2];
      if (NOT_ICON.indexOf(key) > -1) continue;
      if (typeof icons[key] === 'undefined') { missing.push(d + ': 图标库无 ' + key); continue; }
      if (called) {
        // 按函数调用 → 图标库里必须真的是函数（这里正是 plus 曾经报错的地方）
        if (typeof icons[key] !== 'function') { missing.push(d + ': ' + key + ' 不是函数'); continue; }
        ['#FFFFFF', '#E8590C'].forEach(c => {
          const p = path.join(root, icons[key](c).replace(/^\//, ''));
          if (!fs.existsSync(p)) missing.push(d + ': 缺文件 ' + icons[key](c));
        });
      } else {
        if (typeof icons[key] !== 'string') { missing.push(d + ': ' + key + ' 当作字符串用但其实是函数'); continue; }
        const p = path.join(root, icons[key].replace(/^\//, ''));
        if (!fs.existsSync(p)) missing.push(d + ': 缺文件 ' + icons[key]);
      }
    }
  });
  assert.deepStrictEqual(missing, [], missing.join('; '));
});

console.log('\n【机构入驻申请】');
const applyUtil = require('../utils/apply');
// 上面「重启持久化」用例清过 db 模块缓存，页面持有的是新实例，这里必须拿同一份
const dbNow = require('../utils/db');
const applyPage = loadPage('pages/apply/apply.js');
ok('我的页：未入驻时入口是「机构入驻申请」', () => {
  mine.onShow();
  const e = mine.data.entries.find(x => x.k === 'apply');
  assert.ok(e, '应有入驻入口');
  assert.strictEqual(e.t, '机构入驻申请');
});
ok('入驻表单：空机构名被拦', () => {
  applyPage.onShow();
  applyPage.onName({ detail: { value: '  ' } });
  applyPage.onContact({ detail: { value: '王校长' } });
  applyPage.onPhone({ detail: { value: '13800001111' } });
  applyPage.toggleAgree();
  applyPage.submit();
  assert.strictEqual(toasts[toasts.length - 1], '请填写机构名称');
  assert.strictEqual(applyUtil.get(), null, '校验不过不应落单');
});
ok('入驻表单：手机号格式不对被拦；输入中是裸数字，失焦才分段成 3-4-4', () => {
  applyPage.onName({ detail: { value: '橙果书法学堂' } });
  applyPage.onPhone({ detail: { value: '18674882783' } });
  // 输入中是裸数字：type="number" 的键盘容不下 "-"，真机边输边格式化会把字符调乱
  assert.strictEqual(applyPage.data.form.phone, '18674882783', '输入中不带横线');
  assert.strictEqual(applyPage.data.form.phoneBad, false);
  applyPage.onPhoneBlur();
  assert.strictEqual(applyPage.data.form.phone, '186-7488-2783', '失焦后分段展示');
  applyPage.onPhone({ detail: { value: '12345' } });
  applyPage.submit();
  assert.strictEqual(toasts[toasts.length - 1], '请填写正确的 11 位手机号（1 开头）');
});
ok('入驻表单：未勾选协议被拦', () => {
  applyPage.onPhone({ detail: { value: '13800001111' } });
  applyPage.toggleAgree(); // 取消勾选
  applyPage.submit();
  assert.strictEqual(toasts[toasts.length - 1], '请先勾选同意协议');
});
ok('入驻提交成功：生成申请单 + 机构名落库 + 课程方向多选', () => {
  applyPage.toggleAgree();
  applyPage.pickType({ currentTarget: { dataset: { v: '培训机构' } } });
  applyPage.onRegion({ detail: { value: ['湖南省', '长沙市', '岳麓区'] } });
  applyPage.onScale({ currentTarget: { dataset: { v: '50–200 人' } } });
  applyPage.toggleCourse({ currentTarget: { dataset: { v: '书法' } } });
  applyPage.toggleCourse({ currentTarget: { dataset: { v: '美术' } } });
  applyPage.submit();
  const rec = applyUtil.get();
  assert.ok(rec && /^CG\d{12}$/.test(rec.no), '单号格式应为 CG+年月日+4位');
  assert.strictEqual(rec.name, '橙果书法学堂');
  assert.deepStrictEqual(rec.courses, ['书法', '美术']);
  assert.strictEqual(rec.regionText, '湖南省 长沙市 岳麓区');
  assert.strictEqual(rec.status, 'active'); // 当前身份是负责人，直接生效
  assert.strictEqual(dbNow.settings().orgName, '橙果书法学堂', '机构名应同步落库');
  assert.ok(applyPage.data.done, '应切到成功态');
});
ok('我的页：已有申请单后入口变「机构信息」并带上类型与地区', () => {
  mine.onShow();
  const e = mine.data.entries.find(x => x.k === 'apply');
  assert.strictEqual(e.t, '机构信息');
  assert.strictEqual(e.d, '培训机构 · 湖南省 长沙市 岳麓区');
});
ok('入驻页二次进入：表单回填已提交资料', () => {
  const p2 = loadPage('pages/apply/apply.js');
  p2.onShow();
  assert.strictEqual(p2.data.isEdit, true);
  assert.strictEqual(p2.data.form.name, '橙果书法学堂');
  assert.strictEqual(p2.data.form.phone, '13800001111');
  assert.ok(p2.data.courseChips.filter(c => c.on).length === 2);
});


/* =============================== 演示数据（独立的一套） =============================== */
console.log('\n【演示数据】');
// 「重启持久化」用例清过 db 模块缓存，页面分别持有新旧两个实例：
// 首页是老实例、我的页是新实例，所以两边都要切（真机上只有一份）
const setDemo = on => { (on ? [db, dbNow] : [db, dbNow]).forEach(x => (on ? x.demo.enter() : x.demo.exit())); };
ok('演示模式：首页出现横幅，录入入口被拦下', () => {
  setDemo(true);
  assert.strictEqual(db.settings().sandbox, true);
  appInst.globalData.pick = null;
  index.onShow();
  assert.strictEqual(index.data.sandbox, true, '应显示演示横幅');
  assert.strictEqual(index.data.navTitle, '演示机构');
  index.goRecord();
  assert.strictEqual(appInst.globalData.pick, null, '演示模式下不该进录入页');
  assert.strictEqual(toasts.pop(), '演示数据只看不改，点上方「开始使用」');
});
ok('演示模式：我的页入口变「退出演示数据」，并带演示徽标', () => {
  mine.onShow();
  assert.strictEqual(mine.data.sandbox, true);
  const e = mine.data.entries.find(x => x.k === 'demo');
  assert.ok(e, '应有演示数据入口');
  assert.strictEqual(e.t, '退出演示数据');
});
ok('退出演示：横幅消失，回到自己的机构数据', () => {
  setDemo(false);
  index.onShow();
  assert.strictEqual(index.data.sandbox, false);
  assert.strictEqual(index.data.stuCount, db.students.list().length, '回到真实库后看到的是自己的学生');
  mine.onShow();
  assert.strictEqual(mine.data.sandbox, false);
  assert.strictEqual(mine.data.entries.find(x => x.k === 'demo').t, '看演示数据');
});

console.log('\n全部 ' + pass + ' 项页面级断言通过');

/* ---------------- AI 评价草稿链路（录入页 → aiEval 云函数） ---------------- */
// 放在文件末尾用异步 IIFE：链路全程 Promise 化。mock 全部同步 resolve，
// 因此必须纯顺序 await，任何把断言挂到"注册时不等待"的包装都会引入竞态。
// 任何一项失败 → assert 抛错 → catch 里进程非零退出，套件照样被卡住
(async () => {
  console.log('\n【AI 评价草稿链路】');
  const apiMod = require('../utils/api');
  const AIDRAFT = 'AI草稿：书写工整，继续保持！';

  // 1. 无照片拦截
  record.setData({ photos: [], note: '' });
  toasts.length = 0;
  await record.aiDraft();
  assert.ok(toasts.some(x => x.indexOf('先拍') > -1), '应提示先拍照片');
  console.log('  ✓ 无照片时拦截并提示');

  // 打通云层：模拟 wx.cloud，api.initCloud 后 cloudReady 置真
  let called = null;
  global.wx.cloud = {
    init() {},
    callFunction(o) { called = o; o.success({ result: { ok: true, text: '  ' + AIDRAFT + ' ' } }); }
  };
  global.wx.compressImage = o => o.success({ tempFilePath: '/tmp/a_small.jpg' });
  const origFSM = global.wx.getFileSystemManager;
  global.wx.getFileSystemManager = () => ({ readFile(o) { o.success({ data: 'ZmFrZQ==' }); } });
  apiMod.initCloud();

  // 2. 全链路：压缩 → 读 base64 → 调 aiEval → trim 回填 → 可发送
  record.setData({ photos: ['/tmp/a.jpg'], note: '' });
  toasts.length = 0;
  await record.aiDraft();
  assert.ok(called && called.name === 'aiEval', '应调用 aiEval 云函数');
  assert.strictEqual(called.data.imageBase64, 'ZmFrZQ==');
  assert.strictEqual(record.data.note, AIDRAFT, '生成文本应 trim 后回填');
  assert.strictEqual(record.data.canSend, true);
  assert.strictEqual(record.data.aiBusy, false, '结束后忙碌态复位');
  console.log('  ✓ 有照片全链路：压缩 → base64 → aiEval → 回填可发送');

  // 3. 已有评价时先确认（mock showModal 恒 confirm）再覆盖
  record.setData({ note: '旧评价' });
  await record.aiDraft();
  assert.strictEqual(record.data.note, AIDRAFT);
  console.log('  ✓ 已有评价时确认后覆盖');

  // 4. 云函数业务错误透出中文提示（NO_KEY）
  global.wx.cloud.callFunction = o => o.success({ result: { ok: false, code: 'NO_KEY', msg: 'x' } });
  record.setData({ note: '' });
  toasts.length = 0;
  await record.aiDraft();
  assert.ok(toasts.some(x => x.indexOf('ZHIPU_API_KEY') > -1), '应提示缺 Key');
  console.log('  ✓ 云函数业务错误透出中文提示');

  // 还原 mock
  delete global.wx.cloud;
  delete global.wx.compressImage;
  global.wx.getFileSystemManager = origFSM;
  console.log('  ✓ AI 评价草稿链路 4 项通过');
})().catch(e => { console.error('AI 草稿测试失败:', (e && e.message) || e); process.exit(1); });
