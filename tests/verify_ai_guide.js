// tests/verify_ai_guide.js —— AI 评价「老师引导」的守卫
//
// 守的是这件产品能力本身：AI 写出来的是「这孩子这周具体做到了什么」，
// 还是「孩子们表现非常棒」这种谁都能用的话。前者靠提示词里那几项上下文，
// 后者会在改代码时悄悄回来（少传一个字段，评价立刻退回套话，界面上看不出来）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const P = require('../cloudfunctions/aiEval/prompt.js');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✘ ' + name + '\n      ' + ((e && e.message) || e)); fail++; }
}

console.log('\n【提示词：老师引导层】');

ok('五个视角齐全，每条都是可执行的指令而不是标签', () => {
  const keys = Object.keys(P.VIEWS);
  assert.deepStrictEqual(keys, ['skill', 'compose', 'habit', 'progress', 'mood']);
  keys.forEach(k => {
    const v = P.VIEWS[k];
    assert.ok(v.length > 20, k + ' 的指令太短，等于没要求：' + v);
    assert.ok(v.indexOf('：') > -1, k + ' 应该是「角度：具体要求」的形式');
  });
});

ok('客户端的 AI_VIEWS 与云端 VIEWS 键完全一致（改一边忘另一边，勾了也不生效）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'pages/record/record.js'), 'utf8');
  const seg = src.slice(src.indexOf('const AI_VIEWS'), src.indexOf('];', src.indexOf('const AI_VIEWS')));
  const clientKeys = (seg.match(/k:\s*'([a-zA-Z]+)'/g) || []).map(x => x.replace(/[^a-zA-Z_]/g, '').replace('k', ''));
  assert.deepStrictEqual(clientKeys, Object.keys(P.VIEWS),
    '客户端视角 [' + clientKeys + '] 与云端 [' + Object.keys(P.VIEWS) + '] 不一致');
});

ok('学科词表覆盖内置 7 个 gid，且每个学科的词各说各的', () => {
  assert.strictEqual(Object.keys(P.GID_DIM).length, 7);
  const seen = {};
  Object.keys(P.GID_DIM).forEach(gid => {
    const dims = P.dimOf(gid, '');
    assert.ok(dims && dims.length > 10, gid + ' 没有对应词表');
    assert.ok(!seen[dims], gid + ' 与其他学科共用了同一套词表（' + dims + '）');
    seen[dims] = gid;
  });
});

ok('美术说构图与明暗，书法说间架与笔锋（不是一套词套所有课）', () => {
  assert.ok(P.dimOf('sub_art', '').indexOf('构图与主次') > -1);
  assert.ok(P.dimOf('sub_art', '').indexOf('明暗层次') > -1);
  assert.ok(P.dimOf('sub_calligraphy', '').indexOf('间架结构') > -1);
  assert.ok(P.dimOf('sub_math', '').indexOf('算理表述') > -1);
});

ok('客户端没传学科时按课程名猜（老版本客户端 / 老师没选课程）', () => {
  assert.ok(P.dimOf('', '素描').indexOf('构图') > -1);
  assert.ok(P.dimOf('', '硬笔书法').indexOf('间架') > -1);
  assert.ok(P.dimOf('', '钢琴陪练').indexOf('过程方法') > -1, '猜不出要走通用词表，不能空');
});

console.log('\n【提示词：默认路径（老师什么都没勾也要能用）】');

const base = { kid: '张小明', course: '素描', subjectGid: 'sub_art' };
const p0 = P.buildPrompt(base);

ok('默认路径带上孩子姓名，并明确「只写他一个人」', () => {
  assert.ok(p0.indexOf('【学生】张小明') > -1);
  assert.ok(p0.indexOf('只写给张小明一个人的家长') > -1);
});

ok('默认路径就禁掉群发腔（这是截图里「亲爱的家长朋友们」的病根）', () => {
  assert.ok(p0.indexOf('不许出现"孩子们""大家""亲爱的家长朋友们"') > -1);
  assert.ok(p0.indexOf('群发口吻') > -1);
});

ok('要求落具体细节，并说清「只有形容词等于没写」', () => {
  assert.ok(p0.indexOf('必须落一两处只属于这次的具体细节') > -1);
  assert.ok(p0.indexOf('只有形容词没有细节，等于没写') > -1);
});

ok('禁止把评价维度逐条罗列（罗列出来就是废话）', () => {
  assert.ok(p0.indexOf('不要把所有评价维度逐条罗列') > -1);
});

ok('专业术语后面必须跟一句家长听得懂的话', () => {
  assert.ok(p0.indexOf('每个术语后面用一句家长听得懂的话') > -1);
});

ok('禁空话清单在（很棒 / 很认真 / 继续努力 / 相信你一定能取得更好的成绩）', () => {
  ['很棒', '很认真', '继续努力', '相信你一定能取得更好的成绩'].forEach(w => {
    assert.ok(p0.indexOf(w) > -1, '缺禁词：' + w);
  });
});

ok('照片里看不见的不许编造；不许提「照片/图片」', () => {
  assert.ok(p0.indexOf('照片里看不见的一律不写') > -1);
  assert.ok(p0.indexOf('不要出现"照片""图片"这类字眼') > -1);
});

console.log('\n【提示词：老师勾了之后的增强】');

ok('勾了两个视角，两条指令都进 prompt', () => {
  const t = P.buildPrompt(Object.assign({}, base, { views: ['skill', 'compose'] }));
  assert.ok(t.indexOf('【老师要求重点看】') > -1);
  assert.ok(t.indexOf(P.VIEWS.skill) > -1);
  assert.ok(t.indexOf(P.VIEWS.compose) > -1);
  assert.ok(t.indexOf(P.VIEWS.habit) < 0, '没勾的不该出现');
});

ok('老师那句话原样进 prompt（这是老师唯一的直接指令入口）', () => {
  const t = P.buildPrompt(Object.assign({}, base, { say: '重点夸构图，他这学期线条进步很大' }));
  assert.ok(t.indexOf('【老师特别交代】重点夸构图，他这学期线条进步很大') > -1);
});

ok('上一次评语带进去，并要求对照进步但别重复用词', () => {
  const t = P.buildPrompt(Object.assign({}, base, { prev: '上次画了教室一角，透视基本对了。' }));
  assert.ok(t.indexOf('【上一次给他的评语】') > -1);
  assert.ok(t.indexOf('上次画了教室一角') > -1);
  assert.ok(t.indexOf('不要重复用词') > -1);
});

ok('课次与等第进课程行（第 1 次课和第 20 次课的写法不该一样）', () => {
  const t = P.buildPrompt(Object.assign({}, base, { session: 6, tag: '优秀' }));
  assert.ok(t.indexOf('第 6 次课') > -1);
  assert.ok(t.indexOf('本次等第：优秀') > -1);
});

ok('不认识的视角值被忽略，不会把 undefined 写进 prompt', () => {
  const t = P.buildPrompt(Object.assign({}, base, { views: ['nope', 'skill'] }));
  assert.ok(t.indexOf('undefined') < 0);
  assert.ok(t.indexOf(P.VIEWS.skill) > -1);
});

ok('超长输入被截断（孩子姓名 20 / 老师原话 120 / 上次评语 200）', () => {
  const t = P.buildPrompt({
    kid: '张'.repeat(50), course: '素描',
    say: '重'.repeat(500), prev: '旧'.repeat(1000)
  });
  assert.ok(t.indexOf('张'.repeat(21)) < 0, '姓名没截断');
  assert.ok(t.indexOf('重'.repeat(121)) < 0, '老师原话没截断');
  assert.ok(t.indexOf('旧'.repeat(201)) < 0, '上次评语没截断');
});

ok('完全空的入参不崩，仍然产出可用的写作要求', () => {
  const t = P.buildPrompt({});
  assert.ok(t.indexOf('写法要求：') > -1);
  assert.ok(t.indexOf('群发口吻') > -1);
});

console.log('\n【提示词：班级批量（一人一条，最容易写成群发腔）】');

const roster = [
  { name: '张小明', tag: '优秀', prev: '上次画了教室一角。' },
  { name: '李小红', tag: '加油' }
];
const pb = P.buildBatchPrompt(roster, { course: '素描', subjectGid: 'sub_art', topic: '静物写生' });

ok('名单每人都进提示词，带上等第与上次评价', () => {
  assert.ok(pb.indexOf('张小明') > -1);
  assert.ok(pb.indexOf('李小红') > -1);
  assert.ok(pb.indexOf('本次等第：优秀') > -1);
  assert.ok(pb.indexOf('上次评价：上次画了教室一角。') > -1);
});

ok('批量也注入学科词表与「只写这一个孩子」', () => {
  assert.ok(pb.indexOf('【这个学科的评价维度】') > -1);
  assert.ok(pb.indexOf('构图与主次') > -1);
  assert.ok(pb.indexOf('只写给名单里那一个孩子的家长') > -1);
  assert.ok(pb.indexOf('孩子们""大家') > -1, '批量必须显式禁掉群发腔');
});

ok('批量要求指定 JSON 格式并按姓名对号（前端靠 name 匹配）', () => {
  assert.ok(pb.indexOf('"name":"学生姓名","note":"评价正文"') > -1);
  assert.ok(pb.indexOf('姓名必须与名单完全一致') > -1);
});

ok('课程重点有就带、没有就不出现（不占位、不留空标题）', () => {
  assert.ok(pb.indexOf('本次课程重点：静物写生') > -1);
  const noTopic = P.buildBatchPrompt(roster, { course: '素描' });
  assert.ok(noTopic.indexOf('本次课程重点') < 0);
});

console.log('\n【客户端：上下文真的传出去了】');

const recSrc = fs.readFileSync(path.join(ROOT, 'pages/record/record.js'), 'utf8');

ok('AI 评先开引导层，生成走 aiGo（不能一点就打网络）', () => {
  assert.ok(/aiDraft\(\)[\s\S]{0,600}_openAi\(\)/.test(recSrc), 'aiDraft 应打开引导层');
  assert.ok(/aiGo\(\)/.test(recSrc));
  assert.ok(/return this\._aiRun\(views, say\)/.test(recSrc), 'aiGo 要返回 promise，否则测试和调用方都在猜什么时候结束');
});

ok('payload 带齐七项上下文（缺一项，AI 就退回说套话）', () => {
  const seg = recSrc.slice(recSrc.indexOf('const payload = {'), recSrc.indexOf('};', recSrc.indexOf('const payload = {')));
  ['kid', 'course', 'subjectGid', 'tag', 'session', 'views', 'say', 'prev'].forEach(k => {
    assert.ok(new RegExp('\\b' + k + ':').test(seg), 'payload 缺 ' + k);
  });
});

ok('课程名 → 学科 gid 走数据层，不在页面里写死关键词表', () => {
  assert.ok(/db\.subjects\.guessFor\(/.test(recSrc));
  assert.ok(!/素描\|水彩\|油画/.test(recSrc), '页面里不该出现学科关键词表');
});

ok('上次评语取「已发布 + 排除当前这条」（否则会拿自己跟自己比）', () => {
  const seg = recSrc.slice(recSrc.indexOf('_prevNote('), recSrc.indexOf('_subjectGid('));
  assert.ok(/r\.sent/.test(seg), '只看已发布的');
  assert.ok(/r\.id !== rid/.test(seg), '要排除当前正在改的这条');
});

console.log('\n【偏好记忆：同一门课的重点不该每节课重选】');

// 最小 wx 存储桩：aipref 只依赖 getStorageSync / setStorageSync
const mem = {};
global.wx = {
  getStorageSync: k => (k in mem ? mem[k] : ''),
  setStorageSync: (k, v) => { mem[k] = v; }
};
const aipref = require('../utils/aipref');

ok('存过什么就读回什么', () => {
  aipref.save(['skill', 'progress']);
  assert.deepStrictEqual(aipref.views(), ['skill', 'progress']);
});

ok('本地存了脏值也不让录入页崩掉（手改、旧版本结构）', () => {
  mem.ai_views_v1 = { bad: true };
  assert.deepStrictEqual(aipref.views(), []);
  mem.ai_views_v1 = ['skill', 42, null, 'mood'];
  assert.deepStrictEqual(aipref.views(), ['skill', 'mood'], '非字符串项要被过滤');
});

console.log('\nverify_ai_guide: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
