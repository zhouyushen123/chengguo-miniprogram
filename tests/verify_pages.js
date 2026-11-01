// .workbuddy/verify_pages.js —— 页面级联调：把真实页面模块跑起来，验证改数据层后流程没断
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
  assert.strictEqual(index.data.uName, '测试老师');
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
  const r = db.records.save({ cls: 2, sid: 110, course: '素描', note: '素描课', photos: ['x.jpg'] }, true).record;
  appInst.globalData.pick = { cls: 2, sid: 110, course: '素描', score: r.score, note: r.note, photos: r.photos, rid: r.id };
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
  records.onShow();
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
  assert.strictEqual(mgr.data.teacher, '测试老师');
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
    let m;
    while ((m = re.exec(src))) {
      const key = m[1], called = !!m[2];
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

console.log('\n全部 ' + pass + ' 项页面级断言通过');
