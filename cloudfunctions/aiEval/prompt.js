// cloudfunctions/aiEval/prompt.js —— 评价提示词的唯一出处
//
// 【为什么单独成文件】这一段决定了 AI 写出来是「有骨头」还是「放之四海皆准」，
// 是产品能力本身，不是胶水代码。放在 index.js 里只能靠正则去测，抽出来就能直接
// require 做行为断言（tests/verify_ai_guide.js）。云函数按目录上传，子文件会被带上，
// 与 cloudfunctions/backup/lib.js 是同一个套路。
//
// 【一句话原理】AI 写得空，不是模型笨，是它只拿到一张没上下文的照片。
// 这孩子学什么、上一次写到哪、老师今天想让他被夸什么——一条都没传进去，
// 它只能写「孩子们表现非常棒」。下面两张表就是把老师脑子里的东西结构化喂进去。

// 五个视角。客户端展示文案可随界面改，k 与这里的键一一对应、不能加减
// （pages/record/record.js 的 AI_VIEWS 与本表由测试比对，改一边忘另一边会红）。
const VIEWS = {
  skill:    '专业技法：说清这次用了什么手法/动作、做到什么程度，再点出一处还不到位的',
  compose:  '画面与结构：谈布局、主次、比例、层次、节奏这类整体关系，不要只说"画得好"',
  habit:    '课堂状态：专注程度、是否独立完成、遇到卡点怎么处理、收拾与协作',
  progress: '和上次比：用"比上次……"的对照说清进步具体落在哪一点上',
  mood:     '情绪与状态：投入程度、遇到困难时的反应、做完之后的成就感'
};

// 学科维度词表：让「专业」落到这个学科真正被评价的东西上。
// 美术老师说线条与明暗、数学老师说思路与算理——不能共用一套词。
const SUBJECT_DIMS = {
  art:         '线条与笔触、造型准确度、构图与主次、明暗层次、色彩关系、虚实与透视、细节刻画',
  calligraphy: '间架结构、笔画起收、运笔力度、章法布局、临帖相似度、行气连贯',
  math:        '解题思路、算理表述、步骤规范、举一反三、错题订正',
  chinese:     '语言表达、篇章结构、用词准确、书写规范、阅读理解',
  english:     '语音语调、词汇运用、句型完整、听说反应、书写规范',
  science:     '观察记录、实验操作、推理过程、结论表述',
  coding:      '逻辑拆解、调试方法、命名与结构、独立查错',
  general:     '过程方法、完成度、专注与坚持、独立解决问题'
};

// 学科 gid → 词表键。gid 是跨机构固定的那 7 条（utils/db/subject-seeds.js）
const GID_DIM = {
  sub_art: 'art', sub_calligraphy: 'calligraphy', sub_math: 'math',
  sub_chinese: 'chinese', sub_english: 'english', sub_science: 'science', sub_coding: 'coding'
};

// 客户端传了 gid 就用它；没传（老版本客户端）或没选课程时按课程名猜，猜不中走通用。
function dimOf(gid, course) {
  const key = GID_DIM[String(gid || '')];
  if (key) return SUBJECT_DIMS[key];
  const n = String(course || '');
  const hit = [
    [/素描|水彩|油画|国画|绘画|美术|漫画|手工|陶艺/, 'art'],
    [/书法|硬笔|软笔|写字|毛笔/, 'calligraphy'],
    [/数学|思维|奥数/, 'math'],
    [/语文|作文|阅读|拼音/, 'chinese'],
    [/英语|口语|绘本/, 'english'],
    [/科学|物理|化学|生物|实验/, 'science'],
    [/编程|机器人|乐高|代码|信息/, 'coding']
  ].find(([re]) => re.test(n));
  return hit ? SUBJECT_DIMS[hit[1]] : SUBJECT_DIMS.general;
}

// 单条评价（识图）。ev 里每一项都是老师那边真实有的上下文，缺哪项就少一块证据。
function buildPrompt(ev) {
  const e = ev || {};
  const kid = String(e.kid || '').trim().slice(0, 20);
  const course = String(e.course || e.hint || '').trim().slice(0, 40);
  const tag = String(e.tag || '').trim().slice(0, 10);
  const say = String(e.say || '').trim().slice(0, 120);
  const prev = String(e.prev || '').trim().slice(0, 200);
  const views = (Array.isArray(e.views) ? e.views : [])
    .map(k => VIEWS[String(k)])
    .filter(Boolean)
    .slice(0, 4);
  const dims = dimOf(e.subjectGid, course);

  const head = course
    ? '你是「' + course + '」课的授课老师，正在给一位学生的家长写这节课的评价。'
    : '你是一位课外培训机构的授课老师，正在给一位学生的家长写这节课的评价。';

  return [
    head,
    '',
    kid ? '【学生】' + kid : null,
    '【课程】' + (course || '本机构课程') +
      (e.session ? ' · 第 ' + (Number(e.session) || 1) + ' 次课' : '') +
      (tag ? ' · 本次等第：' + tag : ''),
    '【这个学科的评价维度】' + dims,
    prev ? '【上一次给他的评语】（可对照进步，但不要重复用词）\n' + prev : null,
    '',
    views.length ? '【老师要求重点看】\n' + views.map((v, i) => (i + 1) + '. ' + v).join('\n') : null,
    say ? '【老师特别交代】' + say : null,
    '',
    '写法要求：',
    kid
      ? '1. 只写给' + kid + '一个人的家长，用"他/她"称呼；不许出现"孩子们""大家""亲爱的家长朋友们"这类群发口吻'
      : '1. 只写这一个孩子的家长，用"他/她"称呼；不许出现"孩子们""大家""亲爱的家长朋友们"这类群发口吻',
    '2. 先看照片再写：照片里看不见的一律不写，不要编造场景、对话和成果',
    '3. 只挑这次最突出的一两点说，不要把所有评价维度逐条罗列（罗列出来的就是废话）；老师指定了重点就按老师的来',
    '4. 必须落一两处只属于这次的具体细节（例："桌腿的透视比上次收得准"）。只有形容词没有细节，等于没写',
    '5. 可以用专业术语，但每个术语后面用一句家长听得懂的话说明效果（例："明暗层次拉开了（桌子和人物的前后关系更清楚）"）',
    '6. 80~150 字：先讲这次做到的具体之处，再点一处还能更好的地方，结尾给孩子一句和这次表现有关的期待',
    '7. 不要这些空话："很棒""很认真""继续努力""相信你一定能取得更好的成绩"',
    '8. 不要出现"照片""图片"这类字眼，直接以课堂口吻描述；不要任何标题、引号或解释',
    '9. 直接输出评价正文'
  ].filter(l => l !== null).join('\n');
}

// 批量评价（纯文本，不看图）。一人一条，所以「只写这一个孩子」这条在批量里更要紧——
// 一条评语里出现"孩子们""大家"，家长一眼就看出来是套话。
function buildBatchPrompt(students, opts) {
  const o = opts || {};
  const topic = String(o.topic || '').slice(0, 100);
  const course = String(o.course || '').slice(0, 40);
  const dims = dimOf(o.subjectGid, course);
  const roster = (students || []).map((s, k) =>
    (k + 1) + '. 姓名：' + s.name + '；本次等第：' + (s.tag || '未评') +
    (s.prev ? '；上次评价：' + s.prev : '')).join('\n');

  return [
    course
      ? '你是一位「' + course + '」课的授课老师。根据下面的学生名单和本次课程信息，给每位学生写一条发给家长的课后评价。'
      : '你是一位课外培训机构的授课老师。根据下面的学生名单和本次课程信息，给每位学生写一条发给家长的课后评价。',
    '【这个学科的评价维度】' + dims,
    '要求：',
    '- 每条 60~120 字，一位老师和一位家长说话的口吻',
    '- 每一条只写给名单里那一个孩子的家长，用"他/她"称呼；' +
      '不许出现"孩子们""大家""亲爱的家长朋友们"这类群发口吻（一条评语同时说好几个人，家长一眼就看出来是套话）',
    '- 必须落一处具体细节（作品/动作/表现上的），只有形容词没有细节等于没写',
    '- 可以用专业术语，但术语后面跟一句家长听得懂的话说明效果',
    '- 结合等第高低调子不同：优秀多讲具体做到了什么，待提高提期望但不批评',
    '- 不要这些空话："很棒""很认真""继续努力""相信你一定能取得更好的成绩"',
    '- 同一批人的评语不许雷同，各人侧重点不同',
    topic ? '- 本次课程重点：' + topic : '',
    '- 输出严格的 JSON 数组，不要任何其它文字：[{"name":"学生姓名","note":"评价正文"}]，姓名必须与名单完全一致',
    '',
    '学生名单：',
    roster
  ].filter(l => l !== '').join('\n');
}

module.exports = { VIEWS, SUBJECT_DIMS, GID_DIM, dimOf, buildPrompt, buildBatchPrompt };
