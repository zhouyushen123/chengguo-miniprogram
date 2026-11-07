// tests/verify_student_form.js —— F 组两条真机失败项的回归守卫
//   F-04「添加学生时没有手机号输入框」：表单、字段、回显、校验、家长归并
//   F-08「学生列表页没有改成照片」：库里存了照片，页面映射却漏字段，头像永远是首字色块
// 另有 F-05/F-06 的同类断链：studentCreate 曾漏传 gender / enrollYear。
process.env.CG_CLOUD = '1';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------------- 模拟小程序运行环境 ---------------- */
const mem = {};
const toasts = [];
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; },
  showToast: o => { toasts.push(o && o.title); },
  showModal: o => { if (o && o.success) o.success({ confirm: true, content: '' }); },
  showActionSheet: o => { if (o && o.success) o.success({ tapIndex: 0 }); },
  chooseMedia: o => { if (o && o.success) o.success({ tempFiles: [] }); },
  getSystemInfoSync: () => ({}),
  setNavigationBarColor: () => {}, setNavigationBarTitle: () => {},
  navigateTo: () => {}, switchTab: () => {}, navigateBack: () => {},
  setClipboardData: o => { o && o.success && o.success(); },
  showLoading: () => {}, hideLoading: () => {},
  previewImage: () => {}, stopPullDownRefresh: () => {},
  env: { USER_DATA_PATH: '/tmp' },
  getFileSystemManager: () => ({ copyFileSync() {}, accessSync() {}, mkdirSync() {} })
};
global.getApp = () => ({ globalData: { pick: null } });
global.App = () => {};
let captured = null;
global.Page = cfg => { captured = cfg; };
function loadPage(rel) {
  captured = null;
  const full = path.join(ROOT, rel);
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

const seed = require('./fixture').richSeed();
Object.keys(seed).forEach(k => { mem[k] = seed[k]; });
const db = require('../utils/db');
db.init();
const stu = require('../utils/db/students');
const tel = require('../utils/phone');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ok - ' + name); pass++; }
  catch (e) { console.log('  FAIL - ' + name + '\n    ' + e.message); fail++; }
}

/* ---------- 1. F-08：照片与学号贯通到两个列表 ---------- */
const cid = db.classes.list()[0].id;
const made = db.students.create({
  name: '照片测试生', clsIds: [cid], photo: '/store/stu-a.jpg',
  parentPhone: '13800001111', parent: '张妈妈', wechat: 'zhangmama',
  gender: '女', enrollYear: 2026
}).item;
const mgr = loadPage('pages/mgr/mgr.js');
mgr.onShow();

ok('F-08 学生列表带出 photo，不再只显示首字色块', () => {
  const row = mgr.data.students.find(x => x.id === made.id);
  assert.ok(row, '新学生应出现在列表');
  assert.strictEqual(row.photo, '/store/stu-a.jpg', '列表映射漏了 photo，<ava> 会拿到空值');
  assert.ok(read('pages/mgr/mgr.wxml').indexOf('<ava src="{{item.photo}}"') > -1, '列表要用统一头像组件');
});

ok('F-03 学生列表同时带出学号；F-04 手机号显示成 3-4-4', () => {
  const row = mgr.data.students.find(x => x.id === made.id);
  assert.strictEqual(row.no, made.no, '列表映射漏了 no，学号栏会空白');
  assert.strictEqual(row.parentPhone, tel.fmt('13800001111'));
});

ok('F-08 班级展开名单也带出 photo', () => {
  mgr.onClsTap({ currentTarget: { dataset: { id: cid } } });
  const row = mgr.data.clsStus.find(x => x.id === made.id);
  assert.ok(row, '学生应出现在展开的班级名单');
  assert.strictEqual(row.photo, '/store/stu-a.jpg');
  mgr.onClsTap({ currentTarget: { dataset: { id: cid } } });
});

ok('源码守卫：两处列表映射都显式带 photo，不许再被漏掉', () => {
  const js = read('pages/mgr/mgr.js');
  assert.strictEqual((js.match(/photo: st\.photo \|\| ''/g) || []).length, 2);
  assert.ok(/no: st\.no \|\| ''/.test(js));
});

/* ---------- 2. F-04：家长手机号字段与表单 ---------- */
ok('建学生不再静默丢掉性别和入学年份（F-05/F-06 同类断链）', () => {
  assert.strictEqual(made.gender, '女');
  assert.strictEqual(made.enrollYear, 2026);
});

ok('手机号落库只存 11 位裸数字，展示串/空格/超长都被清洗', () => {
  const r = db.students.create({ name: '清洗测试生', parentPhone: '138-0000 99998888' }).item;
  assert.strictEqual(r.parentPhone, '13800009999');
  assert.strictEqual(db.students.get(r.id).parentPhone, '13800009999');
});

ok('表单有手机号输入框，且是格式化字段（不配麦克风）', () => {
  const wxml = read('pages/mgr/mgr.wxml');
  const tag = (wxml.match(/<input[^>]*onStuPhone[\s\S]*?\/>/) || [])[0] || '';
  assert.ok(tag, '缺家长手机号输入框');
  assert.ok(/type="number"/.test(tag), '手机号要数字键盘');
  assert.ok(/bindblur="onStuPhoneBlur"/.test(tag), '失焦才分段');
  assert.ok(!/vmic|smic/.test(tag), '格式化字段不该配麦克风');
});

ok('表单输入 11 位 → 失焦 3-4-4 → 保存落库 → 编辑回填，三个字段都在', () => {
  mgr.addStudent();
  mgr.onStuName({ detail: { value: '手机测试生' } });
  mgr.onStuPhone({ detail: { value: '138 0000 2222' } });
  mgr.onStuPhoneBlur();
  assert.strictEqual(mgr.data.stuForm.parentPhone, '138-0000-2222');
  mgr.onStuParent({ detail: { value: '李妈妈' } });
  mgr.onStuWechat({ detail: { value: 'limama' } });
  mgr.stuSave();
  const saved = db.students.list().find(x => x.name === '手机测试生');
  assert.ok(saved, '应保存成功');
  assert.strictEqual(saved.parentPhone, '13800002222', '落库要是裸数字');
  assert.strictEqual(saved.parent, '李妈妈');
  assert.strictEqual(saved.wechat, 'limama');
  mgr.editStudent({ currentTarget: { dataset: { id: saved.id } } });
  assert.strictEqual(mgr.data.stuForm.parentPhone, '138-0000-2222', '编辑回显要带出来');
  assert.strictEqual(mgr.data.stuForm.parent, '李妈妈');
  assert.strictEqual(mgr.data.stuForm.wechat, 'limama');
  mgr.stuCancel();
});

ok('手机号非法时被拦下，不静默保存', () => {
  mgr.addStudent();
  mgr.onStuName({ detail: { value: '不该保存' } });
  mgr.onStuPhone({ detail: { value: '12345' } });
  mgr.stuSave();
  assert.ok(!db.students.list().some(x => x.name === '不该保存'));
  assert.ok(toasts.some(t => /11 位/.test(String(t || ''))), '要给明确提示');
  mgr.stuCancel();
});

/* ---------- 3. 家长归并：手机号与微信号双键，兼容历史数据 ---------- */
ok('G-07 不回归：同微信号的老数据仍是兄弟姐妹', () => {
  const a = db.students.create({ name: '归并甲', wechat: 'same_family' }).item;
  const b = db.students.create({ name: '归并乙', wechat: 'same_family' }).item;
  assert.ok(stu.studentSiblings(b).some(x => x.id === a.id));
});

ok('新表单填手机号、老数据把号码写在微信栏，仍能归并', () => {
  const old = db.students.create({ name: '历史孩子', wechat: '13800003333' }).item;
  const nowKid = db.students.create({ name: '新孩子', parentPhone: '13800003333' }).item;
  assert.ok(stu.studentSiblings(nowKid).some(x => x.id === old.id));
  assert.deepStrictEqual(stu.parentKeys(nowKid), ['13800003333']);
  assert.strictEqual(stu.parentKeys({}).length, 0, '两个都没填不能被当成一家人');
});

ok('数据字典已登记 parentPhone（字段改动固定走生成命令）', () => {
  assert.ok(/parentPhone/.test(read('docs/data-dictionary.md')));
  assert.ok(/parentPhone/.test(read('utils/db/entities.js')));
});

console.log('\n全部 ' + pass + ' 项学生表单断言通过');
if (fail) { console.log(fail + ' 项失败'); process.exit(1); }
