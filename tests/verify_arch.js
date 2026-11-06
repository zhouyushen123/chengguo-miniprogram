// tests/verify_arch.js —— 架构守卫
//
// 把「数据层怎么组织」的约定变成可执行断言，防止后续改动悄悄退化。
// 这一套不测业务行为，只测「结构有没有走形」，所以改动业务逻辑时它不应该红；
// 一旦它红了，通常意味着有人破坏了分层或绕过了数据层，值得停下来看一眼。
//
// 守住五件事：
//   1. utils/db 内部 require 无环（有环在小程序里会拿到半成品模块，表现为随机 undefined）
//   2. 依赖严格下行（见 LAYER 表）：只允许依赖层级更小的模块
//   3. 页面不绕过数据层直接读写本地存储（数据层是唯一出口）
//   4. 数据层不直接调 wx.*（只允许经 storage.js，将来换云端才不用改业务代码）
//   5. 对外 API 面完整 + 单文件规模上限（防止门面再膨胀回千行大文件）
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'utils', 'db');

/* ---------- 工具：剥掉注释，避免注释里的示例代码被误判 ---------- */
function stripComments(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { out += src[i]; i++; }
        out += src[i]; i++;
      }
      if (i < n) { out += src[i]; i++; }
    } else {
      out += c; i++;
    }
  }
  return out;
}

const readCode = f => stripComments(fs.readFileSync(f, 'utf8'));
const dbFiles = fs.readdirSync(DB_DIR).filter(f => f.endsWith('.js'));
const nameOf = f => f.replace(/\.js$/, '');

/* ---------- 1 & 2. 依赖图：无环 + 严格下行 ---------- */
// 层级表就是这套架构的文档。新增领域模块时在这里登记它的位置；
// 如果发现必须「向上」或「同层」引用，说明边界划错了——先调整边界，不要加 require 环。
//
// 基础组（BASIC）是数据层的底座：schema 定义、storage 读写、core 内存集合、permissions 规则、migrate 迁移。
// 它们天生互相依赖（core 要用 storage 和 schema），所以组内允许互相引用；
// 业务领域之间的依赖则必须严格下行。
const BASIC = ['subject-seeds', 'schema-base', 'schema', 'entities', 'storage', 'core', 'permissions', 'migrate'];
const LAYER = {
  'subject-seeds': 0, 'schema-base': 0, schema: 0, entities: 0, storage: 0, core: 0, permissions: 0, migrate: 0,  // 基础组
  ctx: 1,                                   // 底座：now/org/oc/actor/deny，只依赖基础组
  org: 2, terms: 2, courses: 2, students: 2, templates: 2, content: 2,  // content: 学科与知识点（只依赖基础组 + ctx）
  classes: 3,                               // → terms（新建班级默认挂进行中学期）
  enrollments: 4,                           // → classes, students
  identity: 4,                              // → org, classes, students（成员视图要班级/学生名）
  records: 5,                               // → students, enrollments（结转班消课）
  settle: 6,                                // 结转向导落地：→ terms, classes, courses, students, enrollments
  maintenance: 6,                           // 库级维护，只用 ctx + 基础组 + integrity
  integrity: 5,                             // 引用完整性体检/自愈：只用 core + ctx，不碰领域模块
  sync: 6,                                  // 同步的数据层半边：→ core + 外部纯函数 syncmerge（不碰领域模块）
  factory: 6,                               // 回到出厂（坏档自救）：只用基础组，不碰领域模块
  audit: 5,                                 // 核心资产体检：只用 core + ctx，不碰领域模块
  trash: 6,                                 // 回收站：列删除 + 分派到各领域的 restore（→ students/classes/records/identity）
  index: 7                                  // 门面，只用各领域
};

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

console.log('\n【A. 依赖方向】');

const graph = {};
for (const f of dbFiles) {
  const code = readCode(path.join(DB_DIR, f));
  const deps = [];
  const re = /require\(\s*['"]\.\/([\w-]+)(?:\.js)?['"]\s*\)/g;
  let m;
  while ((m = re.exec(code))) deps.push(m[1]);
  graph[nameOf(f)] = deps;
}

ok('utils/db 内部不存在 require 环', () => {
  const color = {};      // 1=访问中 2=完成
  const stack = [];
  const cycles = [];
  const dfs = n => {
    color[n] = 1; stack.push(n);
    for (const d of (graph[n] || [])) {
      if (!(d in graph)) continue;
      if (color[d] === 1) cycles.push(stack.slice(stack.indexOf(d)).concat(d).join(' → '));
      else if (!color[d]) dfs(d);
    }
    stack.pop(); color[n] = 2;
  };
  Object.keys(graph).forEach(n => { if (!color[n]) dfs(n); });
  assert.deepStrictEqual(cycles, [], '发现循环依赖：\n    ' + cycles.join('\n    '));
});

ok('依赖严格下行（业务领域只能 require 层级更小的模块）', () => {
  const unregistered = Object.keys(graph).filter(n => !(n in LAYER));
  assert.deepStrictEqual(unregistered, [],
    '这些模块没在 LAYER 表登记层级：' + unregistered.join(', ') + '（请先想清它在架构中的位置）');
  const bad = [];
  Object.keys(graph).forEach(n => {
    (graph[n] || []).forEach(d => {
      if (!(d in LAYER)) return;
      // 基础组内部互相依赖是设计使然（core 要用 storage/schema），不算违规
      if (BASIC.indexOf(n) > -1 && BASIC.indexOf(d) > -1) return;
      if (LAYER[d] >= LAYER[n]) bad.push(`${n}(L${LAYER[n]}) → ${d}(L${LAYER[d]})`);
    });
  });
  assert.deepStrictEqual(bad, [], '出现上行或同层依赖：\n    ' + bad.join('\n    '));
});

ok('ctx 只依赖基础组，不依赖任何业务领域（这是无环的根本保证）', () => {
  const off = (graph.ctx || []).filter(d => BASIC.indexOf(d) < 0);
  assert.deepStrictEqual(off, [], 'ctx 不应依赖业务模块：' + off.join(', '));
});

/* ---------- 3. 页面不绕过数据层 ---------- */
console.log('\n【B. 数据层是唯一出口】');

function walkJs(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

ok('页面与组件不直接读写本地存储（必须走 utils/db）', () => {
  const files = walkJs(path.join(ROOT, 'pages')).concat(walkJs(path.join(ROOT, 'components')));
  const hits = [];
  files.forEach(f => {
    const code = readCode(f);
    if (/wx\s*\.\s*(get|set|remove)StorageSync/.test(code)) hits.push(path.relative(ROOT, f));
  });
  assert.deepStrictEqual(hits, [], '这些页面绕过了数据层：\n    ' + hits.join('\n    '));
});

ok('数据层只有 storage.js 碰 wx（换云端时只需替换它）', () => {
  const hits = [];
  dbFiles.forEach(f => {
    if (f === 'storage.js') return;   // 存储实现本身就是隔离层，唯一允许直连 wx 的地方
    const code = readCode(path.join(DB_DIR, f));
    if (/\bwx\s*\./.test(code)) hits.push('utils/db/' + f);
  });
  assert.deepStrictEqual(hits, [], '这些文件绕过了存储隔离层直接碰 wx：\n    ' + hits.join('\n    '));
});

/* ---------- 4. 对外 API 面完整 ---------- */
console.log('\n【C. 对外 API 面】');

// 模拟存储后再加载数据层（只读断言，不 init，不污染任何真实数据）
const mem = {};
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; }
};
const db = require('../utils/db');

ok('顶层导出与关键分组齐全', () => {
  ['init', 'status', 'settings', 'today', 'canSend', 'merge', 'me', 'isParent', 'org', 'nextId']
    .forEach(k => assert.strictEqual(typeof db[k], 'function', '缺少 db.' + k));
  ['auth', 'orgs', 'members', 'terms', 'enrollments', 'classes', 'courses', 'students', 'records', 'users', 'templates', 'demo']
    .forEach(k => assert.ok(db[k] && typeof db[k] === 'object', '缺少分组 db.' + k));
  assert.ok(db.TAGS && db.TYPES, '缺少常量 TAGS / TYPES');
});

ok('各分组的方法都在且可调用（拆文件时漏搬会在这里暴露）', () => {
  const EXPECT = {
    auth: ['actor', 'member', 'can', 'abilities', 'canSeeClass', 'canSeeStudent', 'canSeeRecord',
      'denyReason', 'role', 'roleLabel', 'isOwner', 'isAdmin', 'isTeacher', 'isParent'],
    orgs: ['current', 'update', 'checkName', 'get', 'list'],
    members: ['list', 'view', 'get', 'ofUser', 'current', 'create', 'update', 'remove'],
    terms: ['list', 'get', 'activeList', 'create', 'update', 'archive', 'planSettle', 'settle'],
    enrollments: ['list', 'get', 'ofStudent', 'ofClass', 'of', 'create', 'update', 'remove'],
    classes: ['list', 'get', 'name', 'mode', 'countOfTerm', 'create', 'update', 'remove', '_all'],
    courses: ['list', 'of', 'get', 'create', 'update', 'remove'],
    students: ['list', 'of', 'get', 'search', 'name', 'create', 'update', 'updateProfile', 'remove'],
    records: ['list', 'ofStudent', 'ofClass', 'get', 'latest', 'save', 'markSent', 'remove'],
    users: ['list', 'get', 'name', 'current', 'switchTo', 'switchHome', 'create', 'update', 'remove'],
    demo: ['active', 'available', 'enter', 'exit', 'reset'],
    templates: ['list', 'get', 'create', 'update', 'remove', 'addOption', 'updateOption', 'removeOption', 'replaceAll']
  };
  const missing = [];
  Object.keys(EXPECT).forEach(g => {
    EXPECT[g].forEach(k => {
      if (typeof (db[g] || {})[k] !== 'function') missing.push(`db.${g}.${k}`);
    });
  });
  assert.deepStrictEqual(missing, [], '这些方法不见了：' + missing.join(', '));
});

/* ---------- 5. 文件规模 ---------- */
console.log('\n【D. 文件规模】');

ok('门面 index.js 保持精简（≤ 260 行），实现都在领域模块里', () => {
  const n = fs.readFileSync(path.join(DB_DIR, 'index.js'), 'utf8').split('\n').length;
  assert.ok(n <= 260, `index.js 已 ${n} 行，超过 260 行门槛——新逻辑请加到对应领域模块，不要堆回门面`);
});

ok('单个领域模块不超过 500 行（超了就该再拆一层）', () => {
  const big = dbFiles
    .map(f => ({ f, n: fs.readFileSync(path.join(DB_DIR, f), 'utf8').split('\n').length }))
    .filter(x => x.n > 500);
  assert.deepStrictEqual(big.map(x => `${x.f}(${x.n}行)`), [], '这些模块过大：');
});

/* ---------- 5. 送达文案 ---------- */
console.log('\n【E. 送达文案】');

// 全仓零 subscribeMessage / 客服消息 / 短信：点「发送」并不会真的推到家长手机上。
// 所以界面只能承诺「发布」（家长打开小程序能看到），不能写「已发送」——
// 那会让老师以为家长收到了通知，是最容易招投诉的一处误导。
// 等订阅消息真正接通（见 docs/handoff.md B-1），再改回「已发送」并把这条断言反转。
const BANNED_COPY = ['已发送', '待发送', '发送给家长'];

function walkAll(dir, exts, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkAll(p, exts, out);
    else if (exts.some(x => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

ok('界面文案统一说「发布」，不出现「已发送 / 待发送 / 发送给家长」', () => {
  const files = walkAll(path.join(ROOT, 'pages'), ['.js', '.wxml'])
    .concat(walkAll(path.join(ROOT, 'components'), ['.js', '.wxml']));
  const hits = [];
  files.forEach(f => {
    const raw = fs.readFileSync(f, 'utf8');
    // js 剥注释（注释里讨论"发送"是允许的），wxml 直接扫
    const code = f.endsWith('.js') ? stripComments(raw) : raw;
    BANNED_COPY.forEach(w => {
      if (code.indexOf(w) > -1) hits.push(path.relative(ROOT, f) + ' → ' + w);
    });
  });
  assert.deepStrictEqual(hits, [], '这些地方还在承诺「送达」：\n    ' + hits.join('\n    '));
});

console.log('\n全部 ' + pass + ' 项架构断言通过');
