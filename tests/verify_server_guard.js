// tests/verify_server_guard.js —— 服务端权限闸门守卫（2026-11-09 第二轮审查收口）
//
// 根因：权限模型只活在客户端。utils/db/permissions.js 顶部承诺「服务端用同样的
// 文件做判定」，但 syncv2 从未引用过它 —— pull 全量下发、push 只拦 members，
// 家长工牌能拿到全机构孩子信息、改全班评语（报告 C-1 / C-2）。
//
// 本套件钉住修复不回退，并且把「前后端一套规则」从承诺变成断言：
// 从 syncv2 源码抽出写权限白名单，与 permissions.js 的 ACTIONS 规则逐条比对，
// 前端改了规则、云端忘了跟（或反过来），这里立刻红。
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { ACTIONS } = require('../utils/db/permissions');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✘ ' + name + '\n      ' + ((e && e.message) || e).split('\n')[0]); }
}

const idx = read('cloudfunctions/syncv2/index.js');
const pull = idx.slice(idx.indexOf("action === 'pull'"));
const push = idx.slice(idx.indexOf("action === 'push'"), idx.indexOf("action === 'pull'"));

function collsOf(name) {
  const m = idx.match(new RegExp('const ' + name + ' = \\[([^\\]]+)\\]'));
  assert.ok(m, name + ' 白名单不存在');
  return m[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
}

console.log('\n【push：写权限白名单（C-2）】');

ok('两类白名单都存在，且互不重叠（一个集合只能归一类）', () => {
  const mgr = collsOf('COLL_MGR_ONLY');
  const tea = collsOf('COLL_TEACHER');
  assert.ok(mgr.length && tea.length, '白名单是空的等于全开');
  mgr.forEach(c => assert.ok(tea.indexOf(c) < 0, c + ' 同时出现在两类白名单里'));
});

ok('COLLS 里除 members 外每个集合都已归档（新增集合默认谁都不能写）', () => {
  const all = collsOf('COLLS');
  const filed = collsOf('COLL_MGR_ONLY').concat(collsOf('COLL_TEACHER'));
  const missed = all.filter(c => c !== 'members' && filed.indexOf(c) < 0);
  assert.deepStrictEqual(missed, [], '这些集合没登记写权限，等于全开：' + missed);
});

ok('家长与无效身份在 members 分支之前就被挡住', () => {
  const gate = push.indexOf('COLL_MGR_ONLY.indexOf(c) > -1');
  const memberGate = push.indexOf("c === 'members' && !isMgr");
  assert.ok(gate > -1, '缺写权限白名单判定');
  assert.ok(memberGate > -1 && gate < memberGate, '白名单必须先于 members 分支生效');
});

ok('老师的写入受班级范围限制，没分班 = 什么都写不了（fail-closed）', () => {
  assert.ok(/async function inTeacherScope/.test(idx), '缺 inTeacherScope');
  const seg = idx.slice(idx.indexOf('async function inTeacherScope'));
  assert.ok(/cls\.length\) return false/.test(seg), '没分配班级必须拒绝，不能默认放行');
});

ok('被移除/停用的成员当作没有身份（push 与 pull 都要看生死）', () => {
  assert.ok(/function aliveMember/.test(idx), '缺 aliveMember');
  const seg = idx.slice(idx.indexOf('function aliveMember'), idx.indexOf('function newCode'));
  assert.ok(/removed !== true/.test(seg) && /'disabled'/.test(seg), 'removed/disabled 至少要各挡一个');
  assert.ok(/aliveMember\(await memberOf|aliveMember\(raw\)/.test(push), 'push 没用 aliveMember');
  assert.ok(/aliveMember\(await memberOf|aliveMember\(rawMe\)|aliveMember\(raw\)/.test(pull), 'pull 没用 aliveMember');
});

console.log('\n【前后端一套规则：白名单 = permissions.js 的 ACTIONS】');

ok('老师可写的集合，与前端 student.write / record.create / lesson.write 的角色完全一致', () => {
  const tea = collsOf('COLL_TEACHER');
  ['students', 'records', 'lessons'].forEach(c => assert.ok(tea.indexOf(c) > -1, c + ' 不在老师可写集合里'));
  ['student.write', 'record.create', 'record.update', 'lesson.write'].forEach(a => {
    const roles = ACTIONS[a].roles;
    assert.ok(roles.indexOf('teacher') > -1, a + ' 前端没放开给老师，云端白名单却开了');
    assert.ok(roles.indexOf('parent') < 0, a + ' 前端放开给了家长，请立刻检查云端白名单');
  });
});

ok('只有管理角色能写的集合，前端对应动作也没放开给老师/家长', () => {
  const mgr = collsOf('COLL_MGR_ONLY');
  const map = { orgs: 'org.manage', terms: 'term.manage', classes: 'class.write',
    courses: 'course.write', templates: 'template.write' };
  Object.keys(map).forEach(c => {
    assert.ok(mgr.indexOf(c) > -1, c + ' 应在管理白名单里');
    const roles = ACTIONS[map[c]].roles;
    assert.ok(roles.indexOf('teacher') < 0, map[c] + ' 前端放开了老师，云端白名单没跟');
  });
  ['records', 'students', 'lessons'].forEach(c => assert.ok(mgr.indexOf(c) < 0, c + ' 是教学内容，不该锁成管理专用'));
});

console.log('\n【pull：按自家孩子收窄（C-1）】');

ok('家长只拉自家孩子：students/records/enrollments 按 sid 过滤', () => {
  assert.ok(/isParent/.test(pull), '缺家长分支');
  assert.ok(/where\.id = _\.in\(kidIds\)/.test(pull), 'students/enrollments 没按孩子过滤');
  assert.ok(/where\.sid = _\.in\(kidIds\)/.test(pull), 'records 没按孩子过滤');
});

ok('家长拿不到草稿（sent 过滤）和别人家的成员（只要自己那条）', () => {
  assert.ok(/where\.sent = true/.test(pull), '未发布草稿也下发给了家长');
  assert.ok(/where\.openid = OPENID/.test(pull), '家长能拉到其他老师的成员信息');
});

ok('没身份的（成员表没有/被移除）什么都不拉（fail-closed，不退化成全量）', () => {
  assert.ok(/NO_MEMBER/.test(pull), '缺无身份短路');
  const ret = pull.indexOf('NO_MEMBER');
  const loop = pull.indexOf('for (const c of COLLS)');
  assert.ok(ret > -1 && loop > -1 && ret < loop, '短路必须在遍历集合之前');
});

ok('截断保护的 count 用同一个 where（否则家长拉满一页会游标原地踏步）', () => {
  assert.ok(/Object\.assign\(\{\}, where, \{ srvAt: maxAt \}\)/.test(pull),
    'count 没带家长过滤条件，同一 srvAt 全机构计数会被误判为组不完整');
});

console.log('\n【aiEval 与客户端配套】');

ok('aiEval 只让老师及以上生成（登录校验之后、限流之前）', () => {
  const src = read('cloudfunctions/aiEval/index.js');
  const role = src.indexOf("WRITERS = ['owner', 'admin', 'teacher']");
  const login = src.indexOf('未登录，拒绝调用');
  const limit = src.indexOf('RATE_LIMIT');
  assert.ok(role > -1, '缺角色闸门');
  assert.ok(login < role && role < limit, '角色校验要在登录之后、限流之前');
  assert.ok(/FORBIDDEN/.test(src), '拒绝要带业务码，前端好给人话');
});

ok('家长确认第二张卡时重置该机构游标（新孩子要拉回历史）', () => {
  const src = read('utils/sync.js');
  const i = src.indexOf("db.sync.setCursor(0, target)");
  assert.ok(i > -1, 'joinByCard 加机构分支缺游标重置');
  const seg = src.slice(src.indexOf('joinByCard'), src.indexOf('function orgList'));
  assert.ok(/setCursor\(0, target\)/.test(seg), '游标重置必须发生在「再加一家」分支里');
});

console.log('\n【架构体检收口（2026-11-09 A1/A3）】');

ok('aiEval 的 HTTP 传输层只有一份（callGLM 去重后不许再复制粘贴）', () => {
  const src = read('cloudfunctions/aiEval/index.js');
  const n = (src.match(/https\.request\(/g) || []).length;
  assert.strictEqual(n, 1, 'https.request 出现 ' + n + ' 次，只允许 callGLMApi 一处');
  assert.ok(/function callGLMApi/.test(src), '公共传输层必须叫 callGLMApi（可被守卫引用）');
  ['callGLMText', 'callGLM'].forEach(fn => {
    const i = src.indexOf('function ' + fn);
    const seg = src.slice(i, src.indexOf('function', i + 1) > -1 ? src.indexOf('function', i + 1) : i + 600);
    assert.ok(/callGLMApi\(/.test(seg), fn + ' 必须复用公共传输层');
  });
});

ok('老师 pull 按班级订阅：四个集合都带班级过滤，没分班直接跳过', () => {
  const src = read('cloudfunctions/syncv2/index.js');
  const i = src.indexOf('老师：按班级订阅');
  assert.ok(i > -1, '缺老师订阅段');
  const seg = src.slice(i, i + 700);
  ['students', 'classes', 'enrollments', 'records'].forEach(c => {
    assert.ok(new RegExp("c === '" + c + "'").test(seg), c + ' 要在按班收窄清单里');
  });
  assert.ok(/myCls\.length\) continue/.test(seg), '没分班（fail-closed）要直接跳过');
});

ok('工牌范围变化 → 游标重拉链路齐备（applyRemote 检测 + pullNow 消费）', () => {
  const dbSrc = read('utils/db/sync.js');
  assert.ok(/addRescoped\(/.test(dbSrc), '数据层要能记「范围变了」的机构');
  const sSrc = read('utils/sync.js');
  const seg = sSrc.slice(sSrc.indexOf('function pullNow'), sSrc.indexOf('function flush'));
  assert.ok(/rescoped\(\)/.test(seg), 'pullNow 要消费 rescoped');
  assert.ok(/setCursor\(0, useOrg\)/.test(seg), '消费后要把该机构游标归零重拉');
});

console.log('');
console.log((fail ? '有 ' + fail + ' 项失败' : '全部 ' + pass + ' 项服务端权限断言通过'));
console.log('verify_server_guard: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
