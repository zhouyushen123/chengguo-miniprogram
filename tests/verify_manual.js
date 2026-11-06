// tests/verify_manual.js —— 手册与测试用例的「功能点存在性」守卫
//
// 为什么需要它：docs/user-manual.md 与 docs/user-test-cases.md 是发给机构用户照着点的，
// 里面每写一个按钮（「开始录入」「保存修改」「一键备份」…），界面上就必须真有那东西。
// 文档靠人记性对齐代码，第一次忘改就会让用户在界面上找一个不存在的按钮。
// 这里把手册里出现的**入口级功能点**逐条落到源码（页面文件 + 事件方法 + 界面文案），
// 少一处就红，改文案时同步逼着改文档。
//
// 判定口径：一条入口 = 页面 wxml 上有这个事件绑定（bindtap/bindinput/bindchange/bindblur 都算）
//          + 页面 js 上有同名方法（含 async）+ 界面上有这段中文文案。
// 文案先查 wxml，再查 js（页签/入口列表是数据驱动渲染的，"全部""邀请成员"这些字在 js 的数组里）；
// 纯图标的操作（模板选项的改/删）不写文案，只校验事件。
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const P = p => path.join(ROOT, p);

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

function wxml(page) { return fs.readFileSync(P('pages/' + page + '/' + page + '.wxml'), 'utf8'); }
function pageJs(page) { return fs.readFileSync(P('pages/' + page + '/' + page + '.js'), 'utf8'); }

// [页面, 事件, 文案(数组，空表示不校验), 说明]
// 第 3 项只放**界面上真实出现的字**：数据驱动的文案会在 wxml 或 js 的数组里找到。
const JS_ONLY = new Set(['onPullDownRefresh', 'refreshRaw']);   // 生命周期/内部刷新，不在 wxml 上绑
const ENTRIES = [
  // ---- 首页 ----
  ['index', 'goRecord', ['开始录入'], '首页大卡：开始录入'],
  ['index', 'goRecords', ['全部记录'], '首页第二卡：全部记录'],
  ['index', 'goTab', ['班级 ›', '学生 ›'], '首页统计卡直达班级/学生'],
  ['index', 'goCls', [], '首页我的班级卡进班级详情'],
  ['index', 'openRec', ['最近成果'], '最近成果条目'],
  ['index', 'goSetup', ['开始开通'], '空库开通入口'],
  ['index', 'viewDemo', ['先看看示例数据'], '演示数据入口'],
  ['index', 'startReal', ['开始使用'], '退出演示'],
  ['index', 'explainConflict', ['这台手机的数据没和云端同步'], '同步冲突横幅'],
  ['index', 'onSearch', [], '首页搜索'],
  ['index', 'clearSearch', [], '清空搜索'],
  ['index', 'goStudent', [], '搜索结果进学生档案'],
  ['index', 'onSubscribe', ['开启成绩通知'], '家长订阅成绩通知'],
  ['index', 'onPullDownRefresh', [], '下拉刷新'],

  // ---- 开通向导 ----
  ['setup', 'next', [], '向导下一步'],
  ['setup', 'back', ['上一步'], '向导上一步'],
  ['setup', 'later', ['稍后再说，先进去看看'], '向导中途退出'],
  ['setup', 'goJoin', ['我有邀请码，用邀请码加入机构 ›'], '向导里的邀请码入口'],
  ['setup', 'pickType', ['机构类型'], '机构类型选择'],
  ['setup', 'pickMode', ['上课方式'], '学期制/课时结转'],
  ['setup', 'addStudent', ['添加'], '向导加学生'],
  ['setup', 'goRecord', ['录入第一条成果'], '完成页：录入第一条'],
  ['setup', 'goHome', ['先去首页看看'], '完成页：回首页'],
  ['setup', 'goMgr', ['去「管理」补全信息'], '完成页：去管理'],
  ['setup', 'onPhoneBlur', ['手机号'], '手机号失焦格式化'],

  // ---- 加入机构 ----
  ['join', 'goCode', ['我有邀请码'], '加入页：我有邀请码'],
  ['join', 'goSetup', ['我是老师，创建机构'], '加入页：创建机构'],
  ['join', 'doJoin', [], '确认加入'],
  ['join', 'check', [], '校验邀请码'],

  // ---- 管理页 ----
  ['mgr', 'pickTab', ['机构', '班级', '课程', '学生', '人员'], '管理页五个页签'],
  ['mgr', 'saveOrgFull', ['保存机构资料'], '保存机构资料'],
  ['mgr', 'openClsForm', ['＋ 添加班级'], '添加班级'],
  ['mgr', 'addClass', [], '班级表单提交'],
  ['mgr', 'onClsMode', ['学期制', '课时结转'], '班级模式'],
  ['mgr', 'addClsStudent', ['＋ 添加学生到本班'], '添加学生到本班'],
  ['mgr', 'delClass', ['删除'], '删除班级'],
  ['mgr', 'openCourseForm', ['＋ 添加课程'], '添加课程'],
  ['mgr', 'addCourse', [], '课程提交'],
  ['mgr', 'delCourse', [], '删除课程'],
  ['mgr', 'addStudent', ['＋ 添加学生'], '添加学生'],
  ['mgr', 'stuSave', ['保存'], '学生表单保存'],
  ['mgr', 'onStuGenderSet', ['性别'], '学生性别'],
  ['mgr', 'onStuEnrollYear', ['入学年份'], '入学年份'],
  ['mgr', 'stuClsTgl', ['加入班级（可多选）'], '学生加班级'],
  ['mgr', 'stuCancel', ['取消'], '表单取消'],
  ['mgr', 'editStudent', ['编辑'], '编辑学生'],
  ['mgr', 'delStudent', [], '删除学生'],
  ['mgr', 'goImport', ['批量导入'], '批量导入入口'],
  ['mgr', 'pickMemTab', ['老师', '家长'], '人员分类'],
  ['mgr', 'addUserTeacher', ['＋ 添加老师'], '添加老师'],
  ['mgr', 'addUserParent', ['＋ 添加家长'], '添加家长'],
  ['mgr', 'bindByNo', ['按学号绑定'], '家长按学号绑孩子'],
  ['mgr', 'switchMe', ['切换'], '切换成员视角'],
  ['mgr', 'delUser', ['移除'], '移除成员'],
  ['mgr', 'saveOrgFull', ['机构名称', '联系人', '手机号'], '机构表单字段'],
  ['mgr', 'onStuQ', [], '学生搜索'],
  ['mgr', 'onStuGender', [], '学生性别筛选'],

  // ---- 录入页 ----
  ['record', 'pickStu', ['选择学生'], '选学生'],
  ['record', 'pickTag', ['课堂评分'], '档位点选'],
  ['record', 'onCourse', ['课程'], '选课程'],
  ['record', 'addMedia', ['拍摄', '相册'], '拍照/相册'],
  ['record', 'previewPhoto', [], '预览照片'],
  ['record', 'rmPhoto', [], '删除照片'],
  ['record', 'rmVideo', [], '删除视频'],
  ['record', 'onMic', ['课堂成果'], '语音录入区'],
  ['record', 'playAudio', ['播放'], '播放语音'],
  ['record', 'rmAudio', ['删除'], '删除语音'],
  ['record', 'toggleTpl', ['模板'], '评价模板'],
  ['record', 'aiDraft', ['AI 评'], 'AI 评价草稿'],
  ['record', 'clearNote', ['清空'], '清空评价'],
  ['record', 'preview', ['预览效果'], '预览效果'],
  ['record', 'save', ['存草稿', '发布到家长端', '保存修改'], '底部三个按钮'],
  ['record', 'tplAdd', ['＋ 新增选项'], '模板新增选项'],
  ['record', 'tplApply', ['插入所选'], '插入所选'],
  ['record', 'tplClear', ['清空选择'], '清空选择'],
  ['record', 'toggleRec', ['发布'], '发布开关'],

  // ---- 记录列表 ----
  ['records', 'pickTab', ['全部'], '班级 chip'],
  ['records', 'onTerm', ['共 '], '学期筛选与计数'],
  ['records', 'onDate', [], '日期筛选'],
  ['records', 'onTag', [], '等级筛选'],
  ['records', 'openRec', [], '打开记录'],
  ['records', 'editRec', ['修改'], '修改按钮'],
  ['records', 'sendRec', ['发布到家长端', '已发布'], '列表发布按钮'],

  // ---- 学生档案 ----
  ['student', 'editRec', ['修改这条记录', '修改这条'], '档案页修改入口'],
  ['student', 'goRecord', ['记录本节成果'], '档案页录新记录'],
  ['student', 'toggleExpand', ['历史课程'], '历史展开'],
  ['student', 'pickCls', [], '班级筛选'],
  ['student', 'pickFilter', [], '状态筛选'],
  ['student', 'goProfile', ['资料'], '学生资料入口（未填完显示「资料 · 待填写」）'],
  ['student', 'toggleAudio', [], '语音播放'],
  ['student', 'previewPhoto', [], '照片预览'],

  // ---- 班级详情 ----
  ['cls', 'goRecord', [], '班级页录成果'],
  ['cls', 'goBatch', ['成绩单批量录入本次课'], '批量录入入口'],
  ['cls', 'sendAll', [], '一键发布'],
  ['cls', 'pickFilt', ['已录入', '已发布', '未录入'], '班级筛选'],
  ['cls', 'openRec', [], '班级记录'],

  // ---- 批量 / 导入 ----
  ['batch', 'onTopic', ['本课主题'], '批量页主题'],
  ['batch', 'aiAll', [], '批量 AI 评语'],
  ['batch', 'pickTag', ['请假'], '请假'],
  ['batch', 'save', ['保存'], '批量保存'],
  ['import', 'onCls', ['导入到哪个班'], '导入选班'],
  ['import', 'pickFile', ['表格'], '表格导入'],
  ['import', 'pickPhoto', ['拍照'], '拍照导入'],
  ['import', 'commit', [], '确认导入'],
  ['import', 'done', ['完成'], '导入完成'],

  // ---- 学期 ----
  ['terms', 'startWizard', ['结束本学期'], '结束本学期'],
  ['terms', 'openCreate', ['＋ 新建学期'], '新建学期'],
  ['terms', 'wzDecision', ['随期结束', '延续下期'], '逐班决定去向'],
  ['terms', 'wzCourse', ['带哪些课程去新学期'], '带课程'],
  ['terms', 'wzTeacher', ['新学期主讲老师'], '新学期老师'],
  ['terms', 'wzBatch', ['全部续报', '全部流失'], '批量续报/流失'],
  ['terms', 'wzAct', ['续报', '流失'], '单个续报/流失'],
  ['terms', 'wzGenerate', ['确认生成并归档'], '确认生成'],
  ['terms', 'wzStep', ['上一步', '下一步'], '向导步骤切换'],
  ['terms', 'saveTerm', [], '创建学期'],

  // ---- 模板页 ----
  ['tpls', 'copyPreview', ['一键复制，发给家长'], '一键复制通知'],
  ['tpls', 'pvPlayAudio', ['播放'], '试听语音'],
  ['tpls', 'addOpt', ['新增'], '新增模板选项'],
  ['tpls', 'editOpt', [], '编辑选项（铅笔图标）'],
  ['tpls', 'delOpt', [], '删除选项（叉号图标）'],
  ['tpls', 'confirmSel', ['插入所选'], '插入所选'],
  ['tpls', 'clearSel', ['清空选择'], '清空选择'],

  // ---- 存储 ----
  ['storage', 'doSync', ['云同步'], '云同步卡'],
  ['storage', 'doBackup', ['立即备份'], '本地备份'],
  ['storage', 'doRestore', ['从备份恢复'], '从备份恢复'],
  ['storage', 'doCloudBackup', ['云端备份'], '云端备份'],
  ['storage', 'fixData', ['修复可自动处理的问题'], '数据体检'],
  ['storage', 'doReset', ['重置本机数据'], '重置本机数据'],
  ['storage', 'goTrash', ['查看最近删除'], '回收站入口'],
  ['storage', 'clean', ['清理'], '清理空间'],
  ['storage', 'clearRejects', ['知道了，隐藏'], '隐藏失败条目'],
  ['storage', 'refreshRaw', ['本机数据'], '本机数据计数'],

  // ---- 回收站 ----
  ['trash', 'onKind', ['全部', '学生', '班级', '记录', '成员'], '回收站分类'],
  ['trash', 'onRestore', ['恢复'], '回收站恢复'],

  // ---- 我的 ----
  ['mine', 'tapEntry', [], '我的入口跳转'],
  ['mine', 'pickTheme', ['换肤'], '换肤'],
  ['mine', 'tapStat', [], '统计格跳转'],
  ['mine', 'tapEntry', ['邀请成员'], '我的页入口：邀请成员（k=invite）'],
  ['mine', 'tapEntry', ['电脑端后台'], '我的页入口：电脑端后台（k=web）'],
  ['mine', 'tapEntry', ['切换身份'], '我的页入口：切换身份（k=switch）'],
  ['mine', 'backHome', ['切回我自己'], '切回自己'],
  ['mine', 'tapEntry', ['关于橙果'], '我的页入口：关于（k=about）'],
  ['mine', 'tapEntry', ['看演示数据'], '我的页入口：演示数据（k=demo）'],

  // ---- 机构资料 / 加入申请 ----
  ['apply', 'submit', ['开通机构空间'], '机构入驻提交'],
  ['apply', 'toggleCourse', ['课程方向'], '课程方向多选'],
  ['apply', 'onScale', ['学员规模'], '学员规模'],
  ['profile', 'submit', ['保存并提交'], '学生资料保存'],

  // ---- 老师详情 ----
  ['teacher', 'callPhone', ['拨打'], '拨打老师电话'],
  ['teacher', 'copyWechat', ['复制'], '复制老师微信']
];

const CHAPTERS = [
  '0. 先看这一页', '1. 第一次打开：开通机构（4 步）', '2. 首页', '3. 管理页',
  '4. 录入一条成果（核心功能）', '5. 查看与修改记录', '6. 学生档案页',
  '7. 学期管理与结课结转', '8. 评价模板', '9. 批量录入与批量导入',
  '10. 回收站', '11. 我的', '12. 存储与数据安全', '13. 家长端',
  '14. 老师端', '15. 常见问题'
];

console.log('· 手册与用例的功能点存在性');

/* ---------------- 1. 页面文件齐不齐 ---------------- */
ok('app.json 里 18 个页面都有 wxml/js/json/wxss 四件套', () => {
  const app = JSON.parse(fs.readFileSync(P('app.json'), 'utf8'));
  assert.ok(app.pages.length >= 18, '页面数异常：' + app.pages.length);
  app.pages.forEach(p => {
    ['wxml', 'js', 'json', 'wxss'].forEach(ext => {
      assert.ok(fs.existsSync(P(p + '.' + ext)), '缺文件：' + p + '.' + ext);
    });
  });
});

/* ---------------- 2. 每个入口：事件 + 方法 + 文案 ---------------- */
ok('手册里每个按钮都在界面上真实存在（事件 + 方法 + 文案）', () => {
  const miss = [];
  ENTRIES.forEach(([page, ev, texts, desc]) => {
    let w, j;
    try { w = wxml(page); j = pageJs(page); }
    catch (e) { miss.push(desc + '：页面不存在 ' + page); return; }
    const bound = new RegExp('(bind|catch)[a-zA-Z]*="' + ev + '"').test(w);
    if (!bound && !JS_ONLY.has(ev)) miss.push(desc + '：' + page + '.wxml 没有绑定 ' + ev);
    const defined = new RegExp('(^|\\n)\\s*(async\\s+)?' + ev + '\\s*\\(').test(j) || new RegExp('\\b' + ev + '\\s*:\\s*function').test(j);
    if (!defined) miss.push(desc + '：' + page + '.js 没有定义 ' + ev);
    (texts || []).forEach(t => {
      if (w.indexOf(t) < 0 && j.indexOf(t) < 0) miss.push(desc + '：' + page + ' 的界面和数据里都找不到「' + t + '」');
    });
  });
  assert.ok(miss.length === 0, '共 ' + miss.length + ' 处对不上：\n      - ' + miss.join('\n      - '));
});

/* ---------------- 3. 发布前置条件与手册口径一致 ---------------- */
ok('手册写的发布条件（学生 + 任一内容）与 db.canSend 实现一致', () => {
  const src = fs.readFileSync(P('utils/db/records.js'), 'utf8');
  assert.ok(/p\.photos.*p\.videos.*p\.audio/.test(src), 'canSend 里应同时认照片/视频/语音');
  assert.ok(/p\.note && String\(p\.note\)\.trim\(\)/.test(src), 'canSend 应把文字评价也算内容');
  assert.ok(/return !!\(p\.sid && hasContent\)/.test(src), 'canSend 应要求先选学生');
  const w = wxml('record');
  assert.ok(w.indexOf('补齐 照片/语音 与 课堂评价 后，即可发布到家长端') > -1, '界面缺少发布前置文案');
});

/* ---------------- 4. 评分档位与手册表格一致 ---------------- */
ok('五档评分锚点与手册表格一致（60/75/85/92/98）', () => {
  const src = pageJs('record');
  [['待提高', 60], ['加油', 75], ['良好', 85], ['优秀', 92], ['最佳', 98]].forEach(([t, n]) => {
    assert.ok(new RegExp("t: '" + t + "', anchor: " + n).test(src), t + ' 的锚点应为 ' + n);
  });
});

/* ---------------- 5. 五个页签与手册一致 ---------------- */
ok('管理页负责人五个页签顺序与手册一致', () => {
  const src = pageJs('mgr');
  assert.ok(src.indexOf("['机构', '班级', '课程', '学生', '人员']") > -1, '负责人页签应为 机构/班级/课程/学生/人员');
  assert.ok(src.indexOf("['班级', '课程', '学生']") > -1, '老师页签应为 班级/课程/学生');
});

/* ---------------- 6. 手册文件结构完整 ---------------- */
ok('操作手册存在且 16 个章节齐全', () => {
  const md = fs.readFileSync(P('docs/user-manual.md'), 'utf8');
  CHAPTERS.forEach(c => assert.ok(md.indexOf(c) > -1, '手册缺章节：' + c));
  assert.ok(md.indexOf('怎么点') > -1 || md.indexOf('操作手册') > -1, '手册应说明怎么操作');
});

/* ---------------- 7. 用例编号唯一且汇总数对得上 ---------------- */
ok('测试用例编号唯一、分组齐全', () => {
  const md = fs.readFileSync(P('docs/user-test-cases.md'), 'utf8');
  const ids = (md.match(/^\| (P0-\d+|[A-R]-\d+) \|/gm) || []).map(s => s.replace(/[| ]/g, ''));
  assert.ok(ids.length >= 150, '用例条数偏少：' + ids.length);
  assert.strictEqual(new Set(ids).size, ids.length, '存在重复用例编号');
  ['P0-1', 'A-01', 'H-20', 'P-13', 'Q-11', 'R-07'].forEach(k => {
    assert.ok(ids.indexOf(k) > -1, '缺关键用例：' + k);
  });
});

/* ---------------- 8. 关键能力有代码支撑（防止手册写未来功能） ---------------- */
ok('手册承诺的能力都有实现支撑', () => {
  const has = (file, re, msg) => {
    const s = fs.readFileSync(P(file), 'utf8');
    assert.ok(re.test(s), msg);
  };
  has('utils/db/records.js', /canSend/, '发布前置判定');
  has('utils/sync.js', /onDirty/, '保存后自动同步');
  has('utils/dailybackup.js', /cg_bk_day/, '每日云端备份兜底');
  has('utils/db/factory.js', /repairIdentity/, '身份自愈');
  has('utils/phone.js', /fmt|digits/, '手机号格式化');
  has('pages/trash/trash.js', /restore/, '回收站恢复');
  has('pages/terms/terms.js', /wzGenerate/, '学期结转向导');
  has('pages/import/import.js', /pickFile/, '表格导入');
});

console.log('\n全部 ' + pass + ' 项手册/用例守卫通过');
