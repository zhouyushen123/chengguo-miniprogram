// tests/verify_onboard.js —— 新手引导：全新库 → 开通向导四步 → 首页不再是空的
//
// 这一套刻意从一个「空库」起步（其它套件都铺了种子数据），因为要验的正是
// "第一次打开时什么都不存在"这条最容易被忽略、也最影响第一印象的路径。
//
// 守三件事：
//   1. 空库时首页不再摆三块 0，而是 empty=true（wxml 据此摆开通卡）
//   2. 向导四步能真正建出 机构名 / 学期 / 班级 / 学生，且学生自动拿到学号
//   3. 每一步的校验拦得住（手机号乱填、学期日期倒挂），且失败时停在原地不消费数据
const path = require('path');
const fs = require('fs');
const assert = require('assert');

/* ---------------- 模拟小程序运行环境（空库起步） ---------------- */
const mem = {};
const toasts = [];
const navs = [];
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; },
  showToast: o => { toasts.push(o && o.title); },
  showModal: o => { if (o && o.success) o.success({ confirm: true }); },
  navigateTo: o => { navs.push(o && o.url); if (o && o.success) o.success({}); },
  switchTab: o => { navs.push(o && o.url); },
  navigateBack: () => {},
  setNavigationBarTitle: () => {},
  setClipboardData: o => { o && o.success && o.success(); }
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

const lastToast = () => toasts[toasts.length - 1];

const db = require('../utils/db');
db.init();

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

console.log('\n【空库】');
ok('全新安装：没有班级、没有学生（不再塞"书法班/素描班"这种示例班），负责人已就位', () => {
  assert.deepStrictEqual(db.classes.list().map(c => c.name), [], '真实新库不该自带示例班级');
  assert.strictEqual(db.students.list().length, 0);
  assert.ok(db.auth.isOwner(), '第一位用户应当是机构负责人，否则建不了学期/班级');
  // 内置「长期班」是历史数据兜底用的，留着；有它不影响开通
  assert.ok(db.terms.list().filter(t => t.builtIn).length === 1, '应保留内置长期班');
});
ok('全新安装：不留下任何"测试"痕迹（没有测试老师、没有家长演示、不预生成演示包）', () => {
  const u = db.users.current() || {};
  assert.strictEqual(u.name, '', '出厂姓名留空，等用户在向导里填');
  assert.strictEqual(db.members.list().length, 1, '只有负责人一个人，不该有"家长演示"这种假成员');
  assert.strictEqual(db.members.list().filter(m => m.role === 'parent').length, 0);
  assert.strictEqual(db.demo.available(), false, '演示包点了才建，不随安装写入');
  assert.strictEqual(db.settings().sandbox, false, '首次打开是真实机构，不是样板间');
});

console.log('\n【首页空态】');
const index = loadPage('pages/index/index.js');
ok('空库首页：empty=true，并自动打开一次"老师还是家长"的选择页', () => {
  navs.length = 0;
  index.onShow();
  assert.strictEqual(index.data.empty, true);
  assert.strictEqual(index.data.clsCount, 0);
  // 首次进入先问身份：家长不该被要求给机构起名字
  assert.ok(navs.some(u => u.indexOf('/pages/join/join') > -1), '首次进入应自动跳身份选择，实际：' + navs.join(','));
});
ok('再次进入首页：标记已写，不再自动跳（改由首页卡片引导）', () => {
  navs.length = 0;
  index.onShow();
  assert.strictEqual(navs.length, 0, '第二次不该再自动跳，实际：' + navs.join(','));
  assert.strictEqual(index.data.empty, true, '卡片仍然要在');
});

console.log('\n【向导 · 第 1 步 机构】');
const setup = loadPage('pages/setup/setup.js');
setup.onLoad();
ok('进入向导时预填：学期名按当前月份推、日期默认今天起半年', () => {
  assert.ok(setup.data.term.name.length > 0, '学期名应有默认值');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(setup.data.term.startDate));
  assert.ok(setup.data.term.endDate > setup.data.term.startDate);
  assert.strictEqual(setup.data.step, 1);
});
ok('机构名太短：拦下并停在第一步', () => {
  setup.setData({ org: { name: '橙', type: '培训机构', contact: '周老师', phone: '13800001111' } });
  setup.next();
  assert.strictEqual(setup.data.step, 1);
  assert.ok(/机构名称/.test(lastToast()), '应提示机构名称问题，实际：' + lastToast());
});
ok('手机号不合法：拦下并停在第一步', () => {
  setup.setData({ org: { name: '墨白书法工作室', type: '培训机构', contact: '周老师', phone: '1380000' } });
  setup.next();
  assert.strictEqual(setup.data.step, 1);
  assert.ok(/手机号/.test(lastToast()), '应提示手机号，实际：' + lastToast());
});
ok('填全后进入第二步，机构名与申请单都落库', () => {
  setup.setData({ org: { name: '墨白书法工作室', type: '培训机构', contact: '周老师', phone: '13800001111' } });
  setup.next();
  assert.strictEqual(setup.data.step, 2);
  assert.strictEqual(db.settings().orgName, '墨白书法工作室');
  const apply = require('../utils/apply').get();
  assert.ok(apply && apply.name === '墨白书法工作室', '机构资料页要能看到这张单');
});

console.log('\n【向导 · 第 2 步 学期】');
ok('日期倒挂：拦下并停在第二步', () => {
  setup.setData({ 'term.startDate': '2026-09-01', 'term.endDate': '2026-07-01' });
  setup.next();
  assert.strictEqual(setup.data.step, 2);
  assert.ok(/结束日期/.test(lastToast()), '实际：' + lastToast());
  assert.strictEqual(db.terms.list().filter(t => !t.builtIn).length, 0, '校验失败不该落库');
});
ok('正常提交：学期建立且直接是进行中（第一个学期不能是"未开始"）', () => {
  setup.setData({ 'term.name': '2026 秋季学期', 'term.startDate': '2026-09-01', 'term.endDate': '2027-01-31' });
  setup.next();
  assert.strictEqual(setup.data.step, 3);
  const created = db.terms.list().filter(t => t.name === '2026 秋季学期');
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].status, 'active');
});

console.log('\n【向导 · 第 3 步 班级】');
ok('课程默认跟班级同名预填；提交后课程随班级一起建（录入页才有的选）', () => {
  assert.ok(setup.data.cls.name.length > 0, '应预填班级名');
  assert.ok(setup.data.cls.course.length > 0, '应预填课程名（否则录入页空选框卡人）');
  assert.strictEqual(setup.data.cls.course, setup.data.cls.name, '预填值默认同名，用户可改');
  setup.setData({ 'cls.name': '书法提高班', 'cls.course': '软笔书法', 'cls.mode': 'carry' });
  setup.next();
  assert.strictEqual(setup.data.step, 4);
  const cs = db.classes.list();
  assert.strictEqual(cs.length, 1);
  assert.strictEqual(cs[0].name, '书法提高班');
  assert.strictEqual(cs[0].mode, 'carry');
  assert.strictEqual(cs[0].termId, setup._termId, '班级要挂进向导刚建的学期，而不是内置长期班');
  const crs = db.courses.list();
  assert.strictEqual(crs.length, 1, '课程应随班级一起建');
  assert.strictEqual(crs[0].name, '软笔书法');
  assert.deepStrictEqual(crs[0].classIds, [cs[0].id], '课程要开在刚建的班上（V10 走绑定表）');
});

console.log('\n【向导 · 第 4 步 学生】');
ok('空姓名：拦下不建人', () => {
  setup.setData({ stuName: '' });
  setup.addStudent();
  assert.strictEqual(db.students.list().length, 0);
  assert.ok(/学生姓名/.test(lastToast()), '实际：' + lastToast());
});
ok('添加学生：自动分学号 1001，并挂进刚建的班', () => {
  setup.setData({ stuName: '李思远' });
  setup.addStudent();
  const ss = db.students.list();
  assert.strictEqual(ss.length, 1);
  assert.strictEqual(ss[0].name, '李思远');
  assert.strictEqual(ss[0].no, '1001');
  assert.deepStrictEqual(ss[0].clsIds, [db.classes.list()[0].id]);
  assert.strictEqual(setup.data.stuName, '', '添加后输入框应清空，方便连着加');
  assert.strictEqual(setup.data.added.length, 1);
});
ok('完成开通：进完成页，摘要里四个数都对得上', () => {
  setup.setData({ stuName: '王梓萱' });   // 输入框里还留着一个，完成时应一并加上
  setup.next();
  assert.strictEqual(setup.data.done, true);
  assert.strictEqual(db.students.list().length, 2);
  const s = setup.data.summary;
  assert.strictEqual(s.org, '墨白书法工作室');
  assert.strictEqual(s.term, '2026 秋季学期');
  assert.strictEqual(s.cls, '书法提高班');
  assert.strictEqual(s.stu, 2);
});
ok('完成页「录入第一条成果」把班级与学生带进录入页', () => {
  setup.goRecord();
  const pick = appInst.globalData.pick;
  assert.ok(pick && pick.cls, '应带班级');
  assert.ok(pick.sid, '应带第一位学生');
});

console.log('\n【回到首页】');
ok('有了班级和学生之后：首页不再摆开通卡', () => {
  navs.length = 0;
  index.onShow();
  assert.strictEqual(index.data.empty, false);
  assert.strictEqual(index.data.clsCount, 1);
  assert.strictEqual(index.data.stuCount, 2);
  assert.strictEqual(navs.length, 0, '不该再自动跳向导');
});

console.log('\n【跳过路径】');
ok('「稍后再说」：直接进完成页，不建任何东西也不报错', () => {
  const p2 = loadPage('pages/setup/setup.js');
  p2.onLoad();
  p2.later();
  assert.strictEqual(p2.data.done, true);
  assert.ok(p2.data.summary.org, '摘要至少要能显示当前机构名');
});

console.log('\n【入口兜底】');
ok('「我的」里有开通引导入口：数据不空也能重走一遍', () => {
  const mine = loadPage('pages/mine/mine.js');
  mine.onShow();
  const keys = mine.data.entries.map(e => e.k);
  assert.ok(keys.indexOf('setup') > -1, '管理员应看到开通引导入口');
});
ok('首次跳转的标记：跳成功才记，避免一次失败就永久不再引导', () => {
  const firstrun = require('../utils/firstrun');
  assert.strictEqual(typeof firstrun.markAutoShown, 'function');
  // autoSetup 里 navigateTo 带 success 回调才算数（结构断言，防止回退成"先记账再跳"）
  const src = fs.readFileSync(require.resolve('../pages/index/index.js'), 'utf8');
  const body = src.slice(src.indexOf('autoSetup()'), src.indexOf('goSetup()'));
  assert.ok(/success\s*:/.test(body), 'navigateTo 应带 success 回调');
  assert.ok(body.indexOf('success') < body.indexOf('markAutoShown'), '记账应在跳转成功之后');
});

console.log('\n全部 ' + pass + ' 项新手引导断言通过');
