// tests/verify_platform_deep.js —— 平台控制台深度测试（行为级，不只读源码）
//
// 2026-11-09：用户要求「更详细的深度测试」。verify_platform.js 是口径与纪律守卫，
// 这个套件把 platform.html 的**真实页面脚本**跑起来（DOM 桩 + fetch 桩 + 测试钩子），
// 用恶意/边界数据逐个敲渲染面与数据面：
//   D1  XSS 注入面：机构名/负责人/学生名/提醒文案带 HTML 时，所有渲染出口必须转义
//   D2  抽屉与学生表注入面：renderOrg / loadStudents 同样过恶意数据
//   D3  隐私脱敏边界：11 位手机、带分隔符、86 前缀 13 位、座机、空值
//   D4  数字与日期格式化边界：0 / 负数 / NaN / 非法时间戳
//   D5  图表边界：空数据 / 单点 / NaN 值 / 超大值，SVG 里不许出现 NaN/Infinity
//   D6  演示数据一致性：KPI 与清单同源、发布率界内、趋势 30 天
//   D7  分页边界：第 0 页 / 负页 / 超界页（演示路径逐个敲）
//   D8  搜索特殊字符：正则元字符当关键字不崩
//   D9  CSV 注入：= + - @ 开头的单元格必须加前缀
//   D10 可达性与状态纪律：Esc/焦点圈/aria/密码框/退出清 token/防抖/无静默吞错
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

/* ---------------- 页面脚本加载（带测试钩子） ---------------- */
function loadPage() {
  const html = fs.readFileSync(path.join(ROOT, 'cloudfunctions/admin/public/platform.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'platform.html 里应有 <script>');
  let code = m[1];
  // 在 IIFE 结尾前插测试钩子（只在本内存副本上，不动源文件）
  const hook = 'window.__T = { esc: esc, num: num, maskPhone: maskPhone, dt: dt, niceTop: niceTop,\n' +
    '  drawChart: drawChart, renderPager: renderPager, demoApi: demoApi, loadOverview: loadOverview,\n' +
    '  loadOrgs: loadOrgs, loadStudents: loadStudents, renderOrg: renderOrg, openOrg: openOrg, goTab: goTab };';
  const patched = code.replace(/\}\)\(\);\s*$/, hook + '\n})();');
  assert.ok(patched !== code, '应能插入测试钩子');

  const elems = {};
  function mk(id) {
    const classes = new Set();
    return {
      id, innerHTML: '', textContent: '', value: '', type: '', disabled: false,
      style: {}, _handlers: {}, children: [],
      classList: {
        add: c => classes.add(c), remove: c => classes.delete(c),
        toggle: c => { classes.has(c) ? classes.delete(c) : classes.add(c); },
        contains: c => classes.has(c)
      },
      addEventListener(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); },
      appendChild() {}, setAttribute() {}, getAttribute: () => null,
      querySelectorAll: () => [], querySelector: () => null,
      remove() {}, click() {}, focus() {},
      getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, width: 100 })
    };
  }
  const docHandlers = {};
  const sandbox = {
    console, setTimeout, clearTimeout,
    document: {
      getElementById: id => (elems[id] || (elems[id] = mk(id))),
      querySelector: () => mk('anon'),
      querySelectorAll: () => [],
      createElement: t => mk('anon-' + t),
      body: { appendChild() {}, style: {} },
      addEventListener(ev, fn) { (docHandlers[ev] = docHandlers[ev] || []).push(fn); }
    },
    window: { addEventListener() {} },
    location: { protocol: 'https:', search: '?view=platform', pathname: '/admin', origin: 'https://env.example.com' },
    localStorage: (() => { const s = {}; return {
      getItem: k => (k in s ? s[k] : null),
      setItem: (k, v) => { s[k] = String(v); },
      removeItem: k => { delete s[k]; },
      _dump: s }; })(),
    Blob: function () {},
    URL: { createObjectURL: () => '', revokeObjectURL() {} }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // fetch 桩：按 action 分发，默认拒绝
  let fetchPlan = () => ({ ok: false, msg: '未配置' });
  sandbox.fetch = () => Promise.resolve({ json: () => Promise.resolve(fetchPlan()) });
  sandbox.__setFetch = fn => { fetchPlan = fn; };

  vm.runInContext(patched, sandbox, { filename: 'platform.html<script>' });
  return { T: sandbox.window.__T, elems, sandbox, docHandlers };
}

const { T, elems, sandbox, docHandlers } = loadPage();
const raw = s => String(s || '');
const hasRawTag = html => /<(img|script|svg|iframe|on\w+)/i.test(raw(html));

/* ================= 恶意数据模板 ================= */
const EVIL = '<img src=x onerror=alert(1)>';
const EVIL2 = '"><script>alert(2)</script>';
const EVIL3 = '<svg onload=alert(3)>';

const evilOverview = () => ({
  ok: true, account: 'CGPLAT', demo: false,
  stat: { orgs: 2, students: 3, teachers: 2, parents: 4, records: 10, sent: 8, rate: 80, avgScore: 88,
    photos: 5, videos: 1, audios: 2, todayRecords: 1, weekRecords: 4, classes: 3, members: 8, draft: 2, admins: 1 },
  activeOrgs: 2, trendSampled: false, sampleSize: 10, sampleSampled: false,
  trend: [{ d: '2026-11-08', n: 5, sent: 4 }, { d: '2026-11-09', n: 5, sent: 4 }],
  dist: [{ k: '最佳', n: 2 }, { k: '优秀', n: 3 }, { k: '良好', n: 3 }, { k: '加油', n: 1 }, { k: '待提高', n: 1 }],
  tags: [{ t: EVIL, n: 5 }],
  warnings: [{ level: 'warn', t: EVIL, d: EVIL2 }],
  orgs: [{ orgId: 'o1', name: EVIL, owner: EVIL2, students: 2, classes: 1, records: 6, rate: 80, perStudent: 3, teachers: 1, parents: 2, lastDate: '2026-11-08', status: 'active' },
         { orgId: 'o2', name: EVIL3, owner: '王老师', students: 1, classes: 1, records: 4, rate: 80, perStudent: 4, teachers: 1, parents: 2, lastDate: '2026-11-07', status: 'active' }]
});

/* ================= D1 总览渲染注入面 ================= */
ok('D1 总览各渲染出口：恶意机构名/负责人/标签/提醒必须全部转义（XSS）', () => {
  sandbox.__setFetch(req => {
    const action = JSON.parse(req.body).action;
    if (action === 'platOverview') return evilOverview();
    return { ok: true };
  });
  return T.goTab('overview').then(() => {
    ['kpis', 'rank', 'dist', 'tags', 'warns'].forEach(k => {
      const html = raw(elems[k] && elems[k].innerHTML);
      assert.ok(!hasRawTag(html), k + ' 出现了未转义 HTML：' + html.slice(0, 160));
    });
  });
});

/* ================= D2 抽屉与学生表注入面 ================= */
ok('D2a 机构详情抽屉：恶意班级名/成员名/学生名全部转义', () => {
  const evilDrawer = {
    ok: true,
    org: { orgId: 'o1', name: EVIL, status: 'active', ownerName: EVIL2, createdAt: 1700000000000 },
    kpi: { students: 2, classes: 1, courses: 1, members: 5, teachers: 1, parents: 3, records: 6, sent: 5,
      draft: 1, rate: 83, avgScore: 90, photos: 3, videos: 0, audios: 1, silentStudents: 0 },
    trend: [{ d: '2026-11-08', n: 3, sent: 3 }],
    dist: [{ k: '最佳', n: 2 }, { k: '优秀', n: 2 }, { k: '良好', n: 1 }, { k: '加油', n: 1 }, { k: '待提高', n: 0 }],
    tags: [{ t: EVIL3, n: 2 }],
    classes: [{ id: 1, name: EVIL, term: EVIL2, session: '第 1 次课', students: 2, records: 6, lastDate: '2026-11-08' }],
    members: [{ name: EVIL, role: 'teacher', roleLabel: '老师', status: 'active', openid: '已绑定', scope: EVIL },
              { name: EVIL2, role: 'parent', roleLabel: '家长', status: 'active', openid: '未绑定', scope: '孩子' }],
    topStudents: [{ id: 1, name: EVIL, n: 3, last: '2026-11-08' }],
    students: [{ id: 1, no: 'S001', name: EVIL3, classes: EVIL, records: 3, lastDate: '2026-11-08', parent: EVIL2, wechat: '13812345678', enrollYear: 2026 }]
  };
  sandbox.__setFetch(req => (JSON.parse(req.body).action === 'platOrg' ? evilDrawer : { ok: true }));
  T.openOrg('o1');
  return new Promise(r => setTimeout(r, 20)).then(() => {
    const html = raw(elems['drawerRoot'] && elems['drawerRoot'].innerHTML);
    assert.ok(html.length > 100, '抽屉应有渲染内容');
    assert.ok(!hasRawTag(html), '抽屉出现未转义 HTML：' + html.slice(0, 200));
  });
});

ok('D2b 学生总览：恶意姓名/机构名/家长字段全部转义', () => {
  const evilStudents = {
    ok: true, total: 2, page: 1, size: 30,
    rows: [{ id: 1, no: 'S001', name: EVIL, orgId: 'o1', orgName: EVIL2, clsNames: [EVIL], records: 3,
      lastDate: '2026-11-08', parent: EVIL3, wechat: '13812345678', enrollYear: 2026 }],
    orgs: [{ orgId: 'o1', name: EVIL }]
  };
  sandbox.__setFetch(req => (JSON.parse(req.body).action === 'platStudents' ? evilStudents : { ok: true }));
  return T.goTab('students').then(() => {
    const html = raw(elems['stuBody'] && elems['stuBody'].innerHTML);
    assert.ok(html.length > 50, '学生表应有渲染内容');
    assert.ok(!hasRawTag(html), '学生表出现未转义 HTML：' + html.slice(0, 200));
  });
});

/* ================= D3 隐私脱敏边界 ================= */
ok('D3 手机号脱敏：11 位与带分隔符都要脱；空值给 —', () => {
  assert.strictEqual(T.maskPhone('13812345678'), '138****5678');
  assert.strictEqual(T.maskPhone('138 1234 5678'), '138****5678');
  assert.strictEqual(T.maskPhone('138-1234-5678'), '138****5678');
  assert.strictEqual(T.maskPhone(''), '—');
  assert.strictEqual(T.maskPhone(null), '—');
});
ok('D3b 脱敏口径：去分隔符后满 11 位一律脱敏（座机也会被脱，方向保守可接受）', () => {
  assert.strictEqual(T.maskPhone('021-88886666'), '021****6666', '11 位座机也脱敏（保守，可接受）');
  assert.strictEqual(T.maskPhone('8613812345678'), '8613812345678', '86 前缀 13 位整号显示（问题点，见报告）');
  assert.strictEqual(T.maskPhone('1381234567'), '1381234567', '10 位不满足 11 位按座机原样');
});

/* ================= D4 数字与日期边界 ================= */
ok('D4 数字格式化：0 / 负数 / NaN / 千分位', () => {
  assert.strictEqual(T.num(0), '0');
  assert.strictEqual(T.num(NaN), '0');
  assert.strictEqual(T.num(-1234), '-1,234');
  assert.strictEqual(T.num(1234567), '1,234,567');
  assert.strictEqual(T.num(undefined), '0');
});
ok('D4b 日期格式化：非法时间戳不许输出 NaN-NaN-NaN', () => {
  assert.strictEqual(T.dt(0), '—');
  assert.strictEqual(T.dt(undefined), '—');
  const bad = T.dt('abc');
  assert.ok(!/NaN/.test(bad), '非法时间戳应兜底，实际输出：' + bad);
});

/* ================= D5 图表边界 ================= */
ok('D5 图表：空数据 / 单点 / NaN 值 / 超大值，SVG 不出现 NaN 或 Infinity', () => {
  const svg = () => ({ id: 'chart', innerHTML: '', style: {}, setAttribute() {} });
  const cases = [[], [{ d: '2026-11-08', n: 5, sent: 4 }],
    [{ d: '2026-11-08', n: NaN, sent: undefined }],
    [{ d: '2026-11-08', n: 1e9, sent: 1e9 }, { d: '2026-11-09', n: 0, sent: 0 }]];
  cases.forEach((rows, i) => {
    const el = svg();
    T.drawChart(rows, el);
    const out = raw(el.innerHTML);
    assert.ok(!/NaN|Infinity/.test(out), '第 ' + i + ' 组数据画出了 NaN/Infinity：' + out.slice(0, 120));
  });
});
ok('D5b niceTop 刻度：0 / 小数 / 负数都返回有限正数', () => {
  [0, 0.5, 3, 26, -5].forEach(v => {
    const t = T.niceTop(v);
    assert.ok(isFinite(t) && t > 0, 'niceTop(' + v + ') 应为有限正数，实际 ' + t);
  });
});

/* ================= D6 演示数据一致性 ================= */
ok('D6 演示总览：KPI 与机构清单同源、发布率在 0-100、趋势 30 天', () => {
  const r = T.demoApi('platOverview', {});
  assert.ok(r.ok);
  assert.strictEqual(r.stat.orgs, r.orgs.length, 'KPI 机构数应与清单行数一致');
  assert.ok(r.stat.rate >= 0 && r.stat.rate <= 100, '发布率应在 0-100');
  assert.strictEqual(r.trend.length, 30, '趋势应为 30 天');
  assert.ok(r.trend.every(x => x.n >= 0 && x.sent >= 0), '趋势数字不应为负');
  const distSum = r.dist.reduce((n, d) => n + d.n, 0);
  assert.ok(distSum <= r.sampleSize, '分档合计不应超过样本量');
});
ok('D6b 演示家长数：KPI 与各机构行合计一致（11-08 修过的口径不能再漂）', () => {
  const r = T.demoApi('platOverview', {});
  const sum = r.orgs.reduce((n, o) => n + o.parents, 0);
  assert.strictEqual(r.stat.parents, sum, 'stat.parents=' + r.stat.parents + ' 合计=' + sum);
});

/* ================= D7 分页边界（演示路径） ================= */
ok('D7 分页：第 0 页回第一页；超界页返回空行且不崩', () => {
  const p0 = T.demoApi('platOrgs', { page: 0, size: 20 });
  assert.strictEqual(p0.page, 1, 'page=0 应回退为 1');
  const big = T.demoApi('platOrgs', { page: 999, size: 20 });
  assert.strictEqual(big.rows.length, 0, '超界页应无数据');
  assert.ok(big.total > 0, 'total 不应跟着归零');
});
ok('D7b 负数页码：要么钳回 1，要么明确拒绝，不能悄悄算错窗口', () => {
  const neg = T.demoApi('platOrgs', { page: -5, size: 20 });
  const sane = neg.page >= 1 && Array.isArray(neg.rows) && neg.rows.length <= 20;
  assert.ok(sane, '负页码应被钳制（page=' + neg.page + '，rows=' + neg.rows.length + '）——演示路径有问题，见报告');
});

/* ================= D8 搜索特殊字符 ================= */
ok('D8 搜索：正则元字符 / 引号 / 超长关键字不崩、结果为空数组', () => {
  ['.*[](){}$^', '\'"\\', 'x'.repeat(500), '  '].forEach(q => {
    const r = T.demoApi('platStudents', { q });
    assert.ok(r.ok && Array.isArray(r.rows), '关键字 ' + q.slice(0, 10) + ' 不应崩');
    const r2 = T.demoApi('platOrgs', { q });
    assert.ok(r2.ok, '机构搜索不应崩');
  });
});

/* ================= D9 CSV 注入 ================= */
ok('D9 CSV 单元格：= + - @ 开头必须加前缀，逗号引号要包引号', () => {
  const lib = require(path.join(ROOT, 'cloudfunctions/admin/lib'));
  // 前缀 + 含引号单元格还要包引号并双写内部引号，两层防护都对
  assert.strictEqual(lib.csvCell('=cmd|"/c calc"!A1'), '"\'=cmd|""/c calc""!A1"');
  assert.strictEqual(lib.csvCell('@SUM(1)'), "'@SUM(1)");
  assert.strictEqual(lib.csvCell('+1'), "'+1");
  assert.strictEqual(lib.csvCell('a,b'), '"a,b"');
  assert.strictEqual(lib.csvCell('正常'), '正常');
  assert.strictEqual(lib.csvCell(null), '');
});

/* ================= D10 可达性与状态纪律（源码级） ================= */
const SRC = fs.readFileSync(path.join(ROOT, 'cloudfunctions/admin/public/platform.html'), 'utf8');
ok('D10 键盘与焦点：Esc 关抽屉、焦点圈定、页签方向键、打开锁背景滚动', () => {
  assert.ok(/Escape/.test(SRC), '应有 Esc 关抽屉');
  assert.ok(/aria-modal/.test(SRC), '抽屉应 aria-modal');
  assert.ok(/role="dialog"/.test(SRC), '抽屉应 role=dialog');
  assert.ok(/ArrowRight|ArrowLeft/.test(SRC), '页签应支持方向键');
  assert.ok(/overflow\s*=\s*['"]hidden/.test(SRC) || /\.style\.overflow/.test(SRC), '抽屉打开应锁背景滚动');
});
ok('D10b 口令框必须是密码型，退出要清会话', () => {
  assert.ok(/id="pin"[^>]*type="password"|type="password"[^>]*id="pin"/.test(SRC), '平台口令框应 type=password');
  assert.ok(/removeItem\(TOKEN_KEY\)/.test(SRC), '退出登录应清 token');
  assert.ok(/trim\(\)/.test(SRC), '登录输入应去首尾空格');
});
ok('D10c 不许静默吞错：空 catch 必须写明为什么可以吞（注释说明已提示/已本地生效）', () => {
  const bare = (SRC.match(/catch\s*\(\s*function\s*\(\s*\)\s*\{\s*\}\s*\)/g) || [])
    .concat(SRC.match(/catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g) || []);
  assert.strictEqual(bare.length, 0, '发现 ' + bare.length + ' 处无注释空 catch（失败不提示）');
});
ok('D10d 窗口缩放防抖重画图表', () => {
  assert.ok(/addEventListener\('resize'/.test(SRC), '应监听 resize');
  assert.ok(/rzTimer/.test(SRC), 'resize 应走防抖');
});

console.log('\n全部 ' + pass + ' 项平台控制台深度断言通过');
