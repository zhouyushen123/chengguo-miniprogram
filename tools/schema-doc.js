// tools/schema-doc.js —— 从实体注册表生成数据字典（npm run docs:schema）
//
// 【为什么必须自动生成】上一版数据字典是手写的，两天后就跟代码对不上了（字段名改了、
// 表加了两张、口径换了，文档还是旧的），然后没人再信它。这里把"文档"变成代码的投影：
//   - 字段来源：utils/db/entities.js（注册表）
//   - 枚举与校验来源：utils/db/schema.js
//   - tests/verify_datamodel.js 再断言注册表字段 == normalize() 实际输出，
//     所以"改了字段没登记"会在 CI 红，而不是等人某天发现文档过期。
//
// 用法：
//   node tools/schema-doc.js          重新生成 docs/data-dictionary.md
//   node tools/schema-doc.js --check  只比对，不一致退出 1（挂进 npm run check / CI）
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'data-dictionary.md');
const entities = require(path.join(ROOT, 'utils', 'db', 'entities'));
const schema = require(path.join(ROOT, 'utils', 'db', 'schema'));

const idLabel = e => (e.idType === 'str' ? 'string' : (e.idGen === 'stamp' ? 'int（登记时刻）' : 'int 自增'));

/* ---------------- 云端专用表 ----------------
 * 这些表只在云数据库里，不进本地库、也不参与 pull/push（凭据、回执、留言、备份清单都属于
 * "本机不需要持有全量"的东西）。它们没法从 entities.js 生成，所以在这里登记。
 * 【纪律】改任何一个云函数的字段，必须同时改这里，否则这份字典就变成"看起来全、其实漏"。
 * 每张表的字段都标了出处函数，改代码时按图索骥。
 */
const CLOUD_TABLES = [
  {
    coll: 'users', label: '微信绑定（云端）', id: '自动',
    writer: '云函数 `syncv2`（hello / finishJoin）',
    retention: '随账号存在',
    indexes: [['_openid', '唯一查（一个微信一条）']],
    note: '**与本地 `users` 同名但语义不同**：本地那张是"本机演示身份"，这张是"这个微信绑过哪些机构"。',
    fields: [
      { k: '_openid', t: 'string', d: '微信 openid（系统字段）' },
      { k: 'orgId', t: 'string', d: '主机构（第一家加入的）' },
      { k: 'orgIds', t: 'array', d: '我能进的机构清单（一张工牌一个）；老数据没有这个字段时按 `orgId` 算' },
      { k: 'createdAt', t: 'serverDate', d: '首次绑定时间' }
    ]
  },
  {
    coll: 'invites', label: '机构码（邀请码）', id: 'string（6 位码，作 _id）',
    writer: '云函数 `syncv2`（inviteGet / parentCode）',
    retention: '30 天过期；作废即 `closed=true`',
    indexes: [['orgId+role+closed', '找本机构可用码']],
    fields: [
      { k: '_id', t: 'string', d: '邀请码本身（字母表去掉 0/O/1/I/2/Z，避免看错）' },
      { k: 'orgId', t: 'string', d: '码属于哪个机构' },
      { k: 'role', t: 'string', d: '`parent` / `teacher` / `admin`，一种身份一个码' },
      { k: 'closed', t: 'bool', d: '是否停用' },
      { k: 'uses', t: 'number', d: '已使用次数' },
      { k: 'by', t: 'string', d: '生成者 openid' },
      { k: 'createdAt', t: 'number', d: '生成时间（毫秒）' },
      { k: 'expiresAt', t: 'number', d: '过期时间（默认 30 天）' }
    ]
  },
  {
    coll: 'invite_cards', label: '家长邀请卡（一人一张）', id: 'string（12 位 token，作 _id）',
    writer: '云函数 `syncv2`（cardCreate / cardClaim / cardRevoke）',
    retention: '7 天过期；作废保留记录',
    indexes: [['orgId+sid', '按学生查卡'], ['status', '清理解析']],
    note: 'token 就是 `_id`；`data` 里绝不能带 `_id`（云数据库会报 -501007）。卡面名字在创建时固化，家长点开不必回查业务表。',
    fields: [
      { k: '_id', t: 'string', d: '一次性令牌（小写无歧义字符，12 位）' },
      { k: 'orgId', t: 'string', d: '机构' },
      { k: 'clsId', t: 'number', d: '学生所在班（发卡时取第一个班）' },
      { k: 'sid', t: 'number', d: '学生 id' },
      { k: 'code', t: 'string', d: '机构码（**只在服务端用**，从不下发给家长）' },
      { k: 'role', t: 'string', d: '固定 `parent`' },
      { k: 'stuNo', t: 'string', d: '学号（卡面不回显，仅服务端匹配用）' },
      { k: 'orgName', t: 'string', d: '卡面：机构名' },
      { k: 'clsName', t: 'string', d: '卡面：班级名' },
      { k: 'stuName', t: 'string', d: '卡面：孩子姓名' },
      { k: 'status', t: 'string', d: '`unused` / `claimed` / `approved` / `revoked`' },
      { k: 'expiresAt', t: 'number', d: '过期时间（7 天）' },
      { k: 'usedAt', t: 'number', d: '被点开的时间' },
      { k: 'usedBy', t: 'string', d: '认领者 openid' },
      { k: 'claimName', t: 'string', d: '认领时填的姓名' },
      { k: 'claimPhone', t: 'string', d: '预留：认领手机号（阶段 2）' },
      { k: 'pid', t: 'string', d: '归并后的平台身份（同一个孩子跨机构共用）' },
      { k: 'approvedAt', t: 'number', d: '确认加入完成时间' },
      { k: 'by', t: 'string', d: '发卡老师 openid' },
      { k: 'createdAt', t: 'number', d: '创建时间' }
    ]
  },
  {
    coll: 'history', label: '版本历史', id: '自动',
    writer: '云函数 `syncv2`（push 前留旧值）',
    retention: '每个资产保留最近 10 份',
    indexes: [['orgId+c+id+at', '按资产倒序取历史']],
    note: '只给核心四类（`orgs` / `members` / `students` / `classes`）留历史；记录量大，留历史会把库撑爆。',
    fields: [
      { k: 'orgId', t: 'string', d: '机构' },
      { k: 'c', t: 'string', d: '集合名' },
      { k: 'id', t: 'number|string', d: '资产 id' },
      { k: 'at', t: 'number', d: '留档时间（毫秒）' },
      { k: 'by', t: 'string', d: '操作者 openid' },
      { k: 'doc', t: 'object', d: '旧值快照（去掉 `_id` / `_openid` / `srvAt`）' }
    ]
  },
  {
    coll: 'openid_map', label: '订阅授权额度', id: '自动',
    writer: '云函数 `family`（bind / familyNotify）',
    retention: '长期；授权用完 `grants=0`',
    indexes: [['_openid', '按家长查'], ['sids', '按孩子找家长']],
    fields: [
      { k: '_openid', t: 'string', d: '家长 openid（系统字段）' },
      { k: 'sids', t: 'array', d: '这个家长订阅了哪些孩子（学生 id）' },
      { k: 'name', t: 'string', d: '家长备注名' },
      { k: 'grants', t: 'number', d: '剩余可推送条数（一次性订阅按条计，收到一条减一）' },
      { k: 'updatedAt', t: 'serverDate', d: '最后更新时间' }
    ]
  },
  {
    coll: 'record_views', label: '家长已读回执', id: 'string（`orgId:rid:openid`）',
    writer: '云函数 `family`（fbView）',
    retention: '长期',
    indexes: [['orgId+rid', '按记录统计已读'], ['orgId+sid', '按学生统计']],
    note: '`_id` 用三元组拼出来，重复上报是幂等的（`set` 覆盖），不会因为反复打开而多算。',
    fields: [
      { k: '_id', t: 'string', d: '`orgId:rid:openid`' },
      { k: 'orgId', t: 'string', d: '机构' },
      { k: 'rid', t: 'number', d: '成果（记录）id' },
      { k: 'sid', t: 'number', d: '学生 id' },
      { k: 'openid', t: 'string', d: '看的那个家长' },
      { k: 'viewedAt', t: 'number', d: '看到的时间（首次与再次都会刷新，只用于"看过没有"）' }
    ]
  },
  {
    coll: 'parent_notes', label: '家长留言', id: '自动',
    writer: '云函数 `family`（fbNote / fbHandle）',
    retention: '长期',
    indexes: [['orgId+rid', '按记录看留言'], ['orgId+openid', '家长看自己写的']],
    note: '限流：一条成果最多 3 条、60 秒内最多 2 条；正文 ≤200 字，先过 `secCheck`（只拦明确违规 87014）。',
    fields: [
      { k: 'orgId', t: 'string', d: '机构' },
      { k: 'rid', t: 'number', d: '针对哪条成果' },
      { k: 'sid', t: 'number', d: '学生 id' },
      { k: 'openid', t: 'string', d: '留言的家长' },
      { k: 'text', t: 'string', d: '正文（≤200 字）' },
      { k: 'createdAt', t: 'number', d: '留言时间' },
      { k: 'handled', t: 'number', d: '0 未处理 / 1 已处理' },
      { k: 'handledBy', t: 'string', d: '处理人 openid' },
      { k: 'handledAt', t: 'number', d: '处理时间' }
    ]
  },
  {
    coll: 'admin_accounts', label: '电脑端后台账号', id: 'string（6 位账号，作 _id）',
    writer: '云函数 `admin`（adminAccount / resetPin）',
    retention: '随机构存在',
    indexes: [['orgId', '一机构一账号']],
    fields: [
      { k: '_id', t: 'string', d: '后台账号（6 位）' },
      { k: 'account', t: 'string', d: '同 `_id`，便于直接读' },
      { k: 'orgId', t: 'string', d: '属于哪个机构' },
      { k: 'pin', t: 'string', d: '6 位口令（重置即换）' },
      { k: 'fail', t: 'number', d: '连续试错次数' },
      { k: 'lockUntil', t: 'number', d: '锁定到期时间（试错太多后锁定 10 分钟）' },
      { k: 'createdAt', t: 'number', d: '创建时间' },
      { k: 'by', t: 'string', d: '创建者 openid' }
    ]
  },
  {
    coll: 'admin_sessions', label: '后台登录会话', id: 'string（token，作 _id）',
    writer: '云函数 `admin`（login / resetPin 清空）',
    retention: '过期即失效（`exp`）',
    indexes: [['account', '按账号清会话']],
    fields: [
      { k: '_id', t: 'string', d: '会话 token' },
      { k: 'account', t: 'string', d: '哪个后台账号' },
      { k: 'orgId', t: 'string', d: '机构' },
      { k: 'exp', t: 'number', d: '过期时间' },
      { k: 'at', t: 'number', d: '签发时间' }
    ]
  },
  {
    coll: 'backups', label: '备份清单', id: 'string（`orgId+日期+tag`）',
    writer: '云函数 `backup`（runOrg / prune）',
    retention: '保留近 N 天 + 至少 2 份',
    indexes: [['orgId+date', '按机构按日取清单']],
    note: '只存"清单"，正文在云存储（`fileID`）。清单先落地再删旧分片——反过来会让清单指向已删除的文件。',
    fields: [
      { k: '_id', t: 'string', d: '清单 id（机构+日期+tag）' },
      { k: 'orgId', t: 'string', d: '机构' },
      { k: 'date', t: 'string', d: '备份日期 `YYYYMMDD`' },
      { k: 'tag', t: 'string', d: '日常备份为空；恢复前快照用唯一 tag' },
      { k: 'at', t: 'number', d: '生成时间' },
      { k: 'counts', t: 'object', d: '`{集合: 条数}`' },
      { k: 'total', t: 'number', d: '总条数' },
      { k: 'bytes', t: 'number', d: '总字节数' },
      { k: 'files', t: 'array', d: '`[{c, part, count, bytes, fileID}]` 分片清单' },
      { k: 'status', t: 'string', d: '`ok` / `partial` / `failed`' },
      { k: 'stoppedAt', t: 'string', d: '因超时停在哪个集合（空=跑完）' },
      { k: 'failed', t: 'array', d: '读失败的集合（**不是空集合**）' },
      { k: 'missing', t: 'array', d: '本次没跑的集合' },
      { k: 'truncated', t: 'bool', d: '有集合撞到单次上限，可能不全' },
      { k: 'safety', t: 'bool', d: '是否为恢复前的安全快照（不参与清理）' }
    ]
  }
];

/* 本地存储布局（不是"表"，但排障时必须知道数据落在哪个键） */
const STORAGE_KEYS = [
  ['`chengguo_v3_<集合>`', '该集合的全部文档（13 个集合各一个键）'],
  ['`chengguo_v3_records` / `_2` … `_n`', '`records` 按 320 条分片（上课记录线性增长，单片会撞 1MB）'],
  ['`chengguo_v3_meta`', '机构号、我的身份、同步游标（一家一个）、脏集合、被退回条目'],
  ['`chengguo_v3_chunks`', '各集合分片数索引（只用于清理旧分片）'],
  ['`chengguo_demo_<集合>`', '演示数据命名空间，与真实数据完全隔离，不上云'],
  ['`chengguo_snap_<id>` / `chengguo_snaps`', '启动自愈用的快照与索引'],
  ['`chengguo_v2` / `chengguo_tpls`', '老版本单对象（迁移源，保留作兜底）'],
  ['`chengguo_theme`', '皮肤选择'],
  ['`chengguo_firstrun_v1`', '首次引导是否已自动弹过'],
  ['`cg_last_error`', '最近一次未捕获异常（「关于」里可看）']
];


function render() {
  const L = [];
  L.push('# 数据字典（自动生成，请勿手改）');
  L.push('');
  L.push('> 由 `npm run docs:schema` 从 `utils/db/entities.js` + `utils/db/schema.js` 生成。');
  L.push('> 门禁：`npm run check` 会跑 `node tools/schema-doc.js --check`，代码与本文不一致即失败。');
  L.push('> 改字段的正确顺序：改 `schema.js` 的 normalize/validate → 改 `entities.js` 登记 → 重新生成本文。');
  L.push('');
  L.push('共 **' + (entities.ENTITIES.length + CLOUD_TABLES.length) + '** 张集合：本机库 **' +
    entities.ENTITIES.length + '** 张（其中参与同步的 **' + entities.SYNC_COLLS.length +
    '** 张）+ 云端专用 **' + CLOUD_TABLES.length + '** 张。');
  L.push('');
  L.push('> 注意 `users` 同名不同物：本机那张是"演示身份"，云端那张是"这个微信绑过哪些机构"，见第 2 节末尾。');
  L.push('');
  L.push('## 1. 总览');
  L.push('');
  L.push('| 集合 | 名称 | 位置 | 域 | id | 同步 | 写入方 | 保留期 |');
  L.push('|---|---|---|---|---|---|---|---|');
  entities.ENTITIES.forEach(e => {
    L.push('| `' + e.coll + '` | ' + e.label + ' | 本机 + 云端 | ' + e.domain + ' | ' + idLabel(e) +
      ' | ' + (e.sync ? '✅' : '—') + ' | ' + e.writer + ' | ' + e.retention + ' |');
  });
  CLOUD_TABLES.forEach(t => {
    L.push('| `' + t.coll + '` | ' + t.label + ' | **仅云端** | — | ' + t.id +
      ' | — | ' + t.writer + ' | ' + t.retention + ' |');
  });
  L.push('');

  L.push('## 2. 表结构');
  entities.ENTITIES.forEach(e => {
    L.push('');
    L.push('### `' + e.coll + '` ' + e.label);
    L.push('');
    L.push('- 域：' + e.domain + '　id：' + idLabel(e) + '　同步：' + (e.sync ? '是' : '否（仅本机）'));
    L.push('- 写入方：' + e.writer);
    L.push('- 保留期：' + e.retention);
    L.push('- 索引：' + (e.indexes || []).map(x => '`' + x[0] + '`（' + x[1] + '）').join('；'));
    L.push('');
    L.push('| 字段 | 类型 | 说明 |');
    L.push('|---|---|---|');
    e.fields.forEach(f => { L.push('| `' + f.k + '` | ' + f.t + ' | ' + f.d + ' |'); });
  });

  L.push('');
  L.push('### 云端专用表（不进本机库、不参与 pull/push）');
  CLOUD_TABLES.forEach(t => {
    L.push('');
    L.push('#### `' + t.coll + '` ' + t.label);
    L.push('');
    L.push('- id：' + t.id);
    L.push('- 写入方：' + t.writer);
    L.push('- 保留期：' + t.retention);
    L.push('- 索引：' + (t.indexes || []).map(x => '`' + x[0] + '`（' + x[1] + '）').join('；'));
    if (t.note) L.push('- 说明：' + t.note);
    L.push('');
    L.push('| 字段 | 类型 | 说明 |');
    L.push('|---|---|---|');
    t.fields.forEach(f => { L.push('| `' + f.k + '` | ' + f.t + ' | ' + f.d + ' |'); });
  });

  L.push('');
  L.push('> **历史遗留，不算数据表**：`cloudfunctions/sync`（旧同步函数）里用过 `profiles` 集合，');
  L.push('> 该函数已废弃、未部署、客户端零引用（`npm run cloud:ls` 会显示"本地有目录但没被引用"），');
  L.push('> 云环境里不存在这张表。留着代码只为追溯，不要照它设计新东西。');
  L.push('');

  L.push('## 3. 枚举与常量');
  L.push('');
  L.push('| 名称 | 取值 | 出处 |');
  L.push('|---|---|---|');
  const enums = [
    ['评分五档 TAGS', schema.TAGS],
    ['记录类型 RECORD_TYPES', schema.RECORD_TYPES],
    ['角色 ROLES', schema.ROLES],
    ['成员状态 MEMBER_STATUS', schema.MEMBER_STATUS],
    ['机构状态 ORG_STATUS', schema.ORG_STATUS],
    ['学期状态 TERM_STATUS', schema.TERM_STATUS],
    ['班级模式 CLASS_MODES', schema.CLASS_MODES],
    ['报名状态 ENROLL_STATUS', schema.ENROLL_STATUS],
    ['学科类别 SUBJECT_KINDS', schema.SUBJECT_KINDS],
    ['知识点来源 KP_SOURCES', schema.KP_SOURCES],
    ['媒体上限 LIMITS', ['photos=' + schema.LIMITS.photos, 'videos=' + schema.LIMITS.videos]]
  ];
  enums.forEach(x => {
    L.push('| ' + x[0] + ' | ' + x[1].map(v => '`' + v + '`').join(' / ') + ' | `utils/db/schema.js` |');
  });
  L.push('');
  L.push('## 4. 内置学科（gid 永不变）');
  L.push('');
  L.push('| gid | 名称 | 类别 | 排序 |');
  L.push('|---|---|---|---|');
  schema.SUBJECT_SEEDS.forEach(s => {
    L.push('| `' + s.gid + '` | ' + s.name + ' | ' + s.kind + ' | ' + s.sort + ' |');
  });
  L.push('');
  L.push('> `gid` 是不可逆决策：阶段二题目按它永久引用，机构可改学科名，但 gid 绝不改、不复用。');
  L.push('');

  L.push('## 5. 本机存储布局（排障用）');
  L.push('');
  L.push('全项目只有 `utils/db/storage.js` 碰本地存储；键名规则如下。');
  L.push('');
  L.push('| 键 | 内容 |');
  L.push('|---|---|');
  STORAGE_KEYS.forEach(x => L.push('| ' + x[0] + ' | ' + x[1] + ' |'));
  L.push('');

  L.push('## 6. 表间关系（一句话版）');
  L.push('');
  L.push('- `orgs` 1—n `members` / `terms` / `classes` / `students` / `records`；所有表都带 `orgId`，云函数按它做**物理隔离**。');
  L.push('- `classes` n—n `courses` 经 `class_courses`；`class_courses` 记这门课由谁带、每周几节。');
  L.push('- `students` n—n `classes` 用 `students.clsIds`（学生可在多个班）；`records` 同时挂 `sid` 与 `cid`。');
  L.push('- `records` 1—n `enrollments`（上课扣课时）；`enrollments` 归属 `sid + courseId`。');
  L.push('- 跨机构身份：`students.pid` 相同 = 同一个孩子（家长端据此把两家成果并到一页）。');
  L.push('- `invite_cards.sid` → `students.id`；`invite_cards.pid` 是确认后写回的平台身份。');
  L.push('- `record_views.rid` / `parent_notes.rid` → `records.id`；两者都只按 `orgId` 内可见。');
  L.push('- `history` 按 `(orgId, c, id)` 指向任一核心表的某个资产。');
  L.push('');
  return L.join('\n');
}

const text = render();

// 附带一份 CSV（字段级平铺，Excel/Numbers 直接打开）：给人审阅用，
// 刻意不带任何格式，只保证"一张表一个字段一行，不漏"。
function renderCsv() {
  const cell = v => {
    const s = String(v === undefined || v === null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [['集合', '中文名', '位置', '字段', '类型', '说明', '参与同步']];
  entities.ENTITIES.forEach(e => (e.fields || []).forEach(f => {
    rows.push([e.coll, e.label, '本机 + 云端', f.k, f.t, f.d, e.sync ? '是' : '否']);
  }));
  CLOUD_TABLES.forEach(t => (t.fields || []).forEach(f => {
    rows.push([t.coll, t.label, '仅云端', f.k, f.t, f.d, '否']);
  }));
  // BOM：不加的话 Excel 打开中文全是乱码
  return '\ufeff' + rows.map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

if (process.argv.indexOf('--check') > -1) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (cur !== text) {
    console.error('✘ 数据字典与代码不一致：docs/data-dictionary.md');
    console.error('  请运行 npm run docs:schema 重新生成后再提交（不要手改这份文件）。');
    process.exit(1);
  }
  console.log('✔ 数据字典与代码一致（本机 ' + entities.ENTITIES.length + ' + 云端专用 ' + CLOUD_TABLES.length + '）');
} else {
  fs.writeFileSync(OUT, text, 'utf8');
  fs.writeFileSync(path.join(ROOT, 'docs', 'data-tables.csv'), renderCsv(), 'utf8');
  console.log('✔ 已生成 docs/data-dictionary.md + docs/data-tables.csv（本机 ' + entities.ENTITIES.length +
    ' 张 + 云端专用 ' + CLOUD_TABLES.length + ' 张）');
}
