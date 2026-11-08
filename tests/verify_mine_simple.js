// tests/verify_mine_simple.js —— 「我的」页简化（20 块 → 5 块）回归守卫
//
// 这次改动不是"少显示几个按钮"，而是把三类东西分开：
//   身份/机构（我是谁、在几家）| 日常工作（今天要处理什么）| 配置（一年点几次）
// 一旦有人图省事把"存储空间""学期管理"塞回首屏，这一屏又会变回一张清单，
// 每天要点的「家长反馈」会重新被挤到下面去。所以用断言把结构钉住：
//
//   1. 首屏只有 5 块，且没有配置项文案
//   2. 低频项必须落在「机构与身份」/「设置」两个二级页里（一次能点到，不许三级）
//   3. 家长端只留：身份卡 / 我的孩子 / 设置
//   4. 空库才出现「开通引导」「输入邀请码」——数据建完还摆着就是噪音
//   5. 邀请码与未读数各只有一份实现（两处各写一遍，数字迟早对不上）
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✘ ' + name + '\n      ' + ((e && e.message) || e).split('\n')[0]); }
};

/* ---------------- 假小程序环境 ---------------- */
const mem = {};
const toasts = [];
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; },
  showToast: o => { toasts.push(o && o.title); },
  showModal: o => { if (o && o.success) o.success({ confirm: false }); },
  showActionSheet: o => { if (o && o.success) o.success({ tapIndex: 0 }); },
  navigateTo: o => { toasts.push('NAV:' + (o && o.url)); },
  reLaunch: o => { toasts.push('REL:' + (o && o.url)); },
  navigateBack: () => {},
  setNavigationBarTitle: () => {}, stopPullDownRefresh: () => {},
  showLoading: () => {}, hideLoading: () => {},
  setClipboardData: o => { o && o.success && o.success(); },
  env: { USER_DATA_PATH: '/tmp' }
};
let captured = null;
global.Page = cfg => { captured = cfg; };
global.getApp = () => ({ globalData: {} });

// 每次取页面都重新加载模块：本套件会在"空库"和"有数据"两种状态下各看一遍首屏
function loadPage(rel) {
  captured = null;
  const full = path.join(ROOT, rel);
  delete require.cache[require.resolve(full)];
  require(full);
  const cfg = captured;
  const page = Object.assign({}, cfg);
  page.data = JSON.parse(JSON.stringify(cfg.data || {}));
  page.setData = function (patch, cb) {
    Object.keys(patch).forEach(k => { page.data[k] = patch[k]; });
    if (cb) cb();
  };
  return page;
}
// 重置数据层：清缓存 + 清存储，换一份干净的库
function freshDb() {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k];
  });
  Object.keys(mem).forEach(k => delete mem[k]);
  const d = require('../utils/db');
  d.init();
  return d;
}

(async () => {
  /* ================= 一、结构守卫（源码） ================= */
  console.log('\n【首屏结构】');

  await ok('S01 我的页首屏正好 5 块（身份卡 / 三个数字 / 我的孩子 / 常用入口 / 设置）', async () => {
    const w = read('pages/mine/mine.wxml');
    const cards = (w.match(/class="card /g) || []).length;
    assert.strictEqual(cards, 5, '首屏卡片数从 5 变了（现在 ' + cards + ' 张）：加东西前先问一句"这是每天都要点的吗"');
  });

  await ok('S02 配置类文案不再出现在我的页（搬进二级页，不是删掉）', async () => {
    const j = read('pages/mine/mine.js');
    ['电脑端后台', '学期管理', '存储空间', '关于橙果', '换肤', '切换身份', '看演示数据', '机构入驻']
      .forEach(t => assert.ok(j.indexOf(t) < 0, '「' + t + '」还在首屏，应搬进「机构与身份」或「设置」'));
  });

  await ok('S03 身份卡进「机构与身份」、底部进「设置」，两个入口都真的绑上了', async () => {
    const w = read('pages/mine/mine.wxml');
    const j = read('pages/mine/mine.js');
    assert.ok(/bindtap="goOrgId"/.test(w) && /goOrgId\s*\(/.test(j), '身份卡应可点进机构与身份');
    assert.ok(/bindtap="goSetting"/.test(w) && /goSetting\s*\(/.test(j), '底部应有设置入口');
    assert.ok(/pages\/orgid\/orgid/.test(j) && /pages\/setting\/setting/.test(j));
  });

  await ok('S04 二级页 A 承载：切换机构 / 再加一家 / 机构资料 / 电脑端后台 / 邀请成员', async () => {
    const j = read('pages/orgid/orgid.js');
    ['addorg', 'apply', 'web', 'invite'].forEach(k => assert.ok(j.indexOf("k: '" + k + "'") > -1, '缺少入口 ' + k));
    assert.ok(/switchOrg\(/.test(j), '切换机构要走 sync.switchOrg');
    assert.ok(/pickOrg\s*\(/.test(j));
  });

  await ok('S05 二级页 B 承载：学期 / 开通引导 / 存储 / 演示 / 切换身份 / 关于 / 外观', async () => {
    const j = read('pages/setting/setting.js');
    ['term', 'setup', 'storage', 'demo', 'switch', 'about'].forEach(k => assert.ok(j.indexOf("k: '" + k + "'") > -1, '缺少入口 ' + k));
    assert.ok(/pickTheme\s*\(/.test(j) && /外观/.test(read('pages/setting/setting.wxml')), '换肤应在设置页的「外观」里');
  });

  await ok('S06 两页都注册进 app.json（否则 navigateTo 直接失败）', async () => {
    const app = JSON.parse(read('app.json'));
    ['pages/orgid/orgid', 'pages/setting/setting'].forEach(p => {
      assert.ok(app.pages.indexOf(p) > -1, p + ' 未注册');
      ['js', 'wxml', 'wxss', 'json'].forEach(ext => assert.ok(fs.existsSync(path.join(ROOT, p + '.' + ext)), '缺文件 ' + p + '.' + ext));
    });
  });

  console.log('\n【一份实现，两处入口】');

  await ok('S07 邀请码只有一份实现：我的首屏与机构页都调同一个弹层', async () => {
    const sheet = read('utils/invitesheet.js');
    assert.ok(/inviteGet\(role/.test(sheet), '取码应集中在 invitesheet');
    ['pages/mine/mine.js', 'pages/orgid/orgid.js'].forEach(f => {
      const s = read(f);
      assert.ok(/utils\/invitesheet/.test(s), f + ' 应复用 invitesheet');
      assert.ok(!/inviteGet\(/.test(s), f + ' 不该自己再实现一遍取码');
    });
  });

  await ok('S08 家长反馈未读数只有一份口径：首页与我的都走 utils/fbunread', async () => {
    assert.ok(/fbList\('teacher'\)/.test(read('utils/fbunread.js')));
    ['pages/index/index.js', 'pages/mine/mine.js'].forEach(f => {
      const s = read(f);
      assert.ok(/utils\/fbunread/.test(s), f + ' 应复用 fbunread');
      assert.ok(!/fbList\(/.test(s), f + ' 不该自己算一遍未读数');
    });
  });

  /* ================= 二、行为（真跑页面） ================= */
  console.log('\n【负责人首屏】');

  await ok('S09 三个数字：学生 / 班级 / 课程（家长数、老师数、学期数已移走）', async () => {
    const db = freshDb();
    db.students.create({ name: '张小明' });
    const mine = loadPage('pages/mine/mine.js');
    mine.onShow();
    assert.deepStrictEqual(mine.data.stats.map(x => x.k), ['stu', 'cls', 'crs']);
    assert.strictEqual(mine.data.stats.find(x => x.k === 'stu').n, db.students.list().length);
  });

  await ok('S10 有数据时不出现「开通引导」「输入邀请码」（首页已有开通卡）', async () => {
    const db = freshDb();
    const mine0 = loadPage('pages/mine/mine.js');
    mine0.onShow();
    const keys0 = mine0.data.entries.map(e => e.k);
    assert.ok(keys0.indexOf('setup') > -1, '空库时应给一条明路');

    db.students.create({ name: '张小明' });
    const mine1 = loadPage('pages/mine/mine.js');
    mine1.onShow();
    const keys1 = mine1.data.entries.map(e => e.k);
    assert.ok(keys1.indexOf('setup') < 0, '有学生后不该再摆开通引导');
    assert.ok(keys1.indexOf('feedback') > -1, '每天要点的家长反馈必须留着');
  });

  await ok('S11 首屏入口只剩「家长反馈 / 邀请成员」这一档，其余全在二级页', async () => {
    freshDb();
    const mine = loadPage('pages/mine/mine.js');
    mine.onShow();
    const keys = mine.data.entries.map(e => e.k);
    ['storage', 'demo', 'term', 'switch', 'about', 'web', 'apply', 'addorg']
      .forEach(k => assert.ok(keys.indexOf(k) < 0, k + ' 不该在首屏'));
    assert.deepStrictEqual(keys.filter(k => ['feedback', 'invite'].indexOf(k) > -1), ['feedback', 'invite']);
  });

  await ok('S12 家长端：身份卡 + 我的孩子 + 设置，没有机构管理入口', async () => {
    const db = freshDb();
    const s = db.students.create({ name: '张小明' });
    const m = db.members.create({ role: 'parent', name: '张妈妈', studentIds: [s.item.id] });
    db.users.switchTo(m.raw.userId);
    const mine = loadPage('pages/mine/mine.js');
    mine.onShow();
    assert.strictEqual(mine.data.isParent, true);
    assert.deepStrictEqual(mine.data.stats, [], '家长不该看到学生/班级/课程三个数字');
    assert.deepStrictEqual(mine.data.entries, [], '家长首屏不摆机构入口');
    assert.strictEqual(mine.data.kids.length, 1);
    assert.strictEqual(mine.data.kids[0].name, '张小明');
    // 家长点孩子 → 看成果
    mine.goKid({ currentTarget: { dataset: { id: mine.data.kids[0].id } } });
    assert.ok(toasts.some(t => t === 'NAV:/pages/student/student?id=' + mine.data.kids[0].id));
  });

  await ok('S13 家长在设置页只有「存储空间 / 关于」——不出现学期、演示、切换身份', async () => {
    const db = freshDb();
    const s = db.students.create({ name: '张小明' });
    const m = db.members.create({ role: 'parent', name: '张妈妈', studentIds: [s.item.id] });
    db.users.switchTo(m.raw.userId);
    const set = loadPage('pages/setting/setting.js');
    set.onShow();
    const keys = set.data.entries.map(e => e.k);
    assert.deepStrictEqual(keys, ['storage', 'about']);
  });

  await ok('S14 负责人设置页：学期 / 开通引导 / 存储 / 演示 / 切换身份 / 关于都在', async () => {
    freshDb();
    const set = loadPage('pages/setting/setting.js');
    set.onShow();
    const keys = set.data.entries.map(e => e.k);
    ['term', 'setup', 'storage', 'demo', 'switch', 'about'].forEach(k => assert.ok(keys.indexOf(k) > -1, '缺 ' + k));
  });

  await ok('S15 云没通时未读数一律为 0（宁可不显示，也不摆一个猜出来的数字）', async () => {
    freshDb();
    const mine = loadPage('pages/mine/mine.js');
    mine.onShow();
    await new Promise(r => setTimeout(r, 0));
    assert.strictEqual(mine.data.fbUnread, 0);
    assert.ok(isNaN(mine.data.fbUnread) === false, '未读数必须是数字');
  });

  await ok('S16 机构与身份页只在一家机构时不摆「切换机构」，但「再加一家」常驻', async () => {
    freshDb();
    const org = loadPage('pages/orgid/orgid.js');
    org.onShow();
    assert.deepStrictEqual(org.data.orgs, [], '只有一家时不该出现切换入口');
    assert.ok(org.data.entries.some(e => e.k === 'addorg'), '再加一家必须常驻（否则只有一家的老师没地方输第二家机构码）');
  });

  console.log('\nverify_mine_simple: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
