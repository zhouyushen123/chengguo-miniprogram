// utils/db/entities.js —— 实体注册表（集合清单与数据字典的唯一来源）
//
// 【为什么要有这个文件】
// 这份清单以前在 6 个地方各抄了一遍：core.COLLS、storage.COLLECTIONS、sync.COLLS、
// syncv2.COLLS、backup.COLLS、admin 的两份。加一张新表要改 6 处，漏一处不会报错——
// 数据在本地看着正常，只是永远同步不上云、也不进备份。这种漏是静默的，
// 而"新表漏备份"意味着灾难恢复那天才发现少了一半数据。
// 现在只有这一份：其它地方全部从这里派生；云函数不能跨目录 require，
// 所以由 tests/verify_datamodel.js 断言它们的清单包含注册表里的每一个同步集合。
//
// 【字段清单也是注册表的一部分】
// 字段名不是文档，而是被测试比对的：normalize() 输出的键集合必须与这里登记的完全一致。
// 改了 schema 忘了登记 → 测试红；登记了却不存在 → 测试红。这样数据字典不可能过期。
//
// 每条登记：集合名 / 实体名 / 域 / id 类型 / 是否同步 / 谁能写 / 保留期 / 索引 / 字段
// 字段：k 字段名、t 类型、d 说明。

// 公共审计字段（所有实体强制携带，见 schema.audit）
const AUDIT = [
  { k: 'orgId', t: 'string', d: '归属机构。orgs 集合里等于 id' },
  { k: 'createdAt', t: 'int(ms)', d: '创建时间' },
  { k: 'updatedAt', t: 'int(ms)', d: '更新时间，同步 LWW 的依据' },
  { k: 'removed', t: 'bool', d: '软删除标记（删除必须能被同步，不能硬删）' },
  { k: 'removedAt', t: 'int(ms)', d: '哪一次删除：同一批次共用，回收站按它整批还原' },
  { k: 'removedBy', t: 'int', d: '操作人 member.id，0 = 系统' }
];

const INT = 'int';
const STR = 'string';
const BOOL = 'bool';
const ARR = 'array';
const OBJ = 'object';

const ENTITIES = [
  {
    coll: 'orgs', entity: 'org', label: '机构', domain: '组织域',
    idType: 'str', sync: true, writer: '客户端（负责人）',
    retention: '随机构存在；机构删除后归档 90 天',
    indexes: [['id', '主键']],
    fields: [
      { k: 'id', t: STR, d: '机构号 org_xxx（服务端发放，非自增）' },
      { k: 'name', t: STR, d: '机构名称' },
      { k: 'ownerId', t: STR, d: '负责人 user.id' },
      { k: 'status', t: STR, d: 'active / suspended' }
    ]
  },
  {
    coll: 'members', entity: 'member', label: '成员关系', domain: '组织域',
    idType: 'num', idGen: 'stamp', sync: true, writer: '客户端 + 云函数（认领/邀请）',
    retention: '随机构存在',
    indexes: [['orgId + userId', '唯一'], ['orgId + openid', '唯一（认领后）']],
    fields: [
      { k: 'id', t: INT, d: '成员 id' },
      { k: 'userId', t: STR, d: '人员 user.id' },
      { k: 'role', t: STR, d: 'owner / admin / teacher / parent' },
      { k: 'name', t: STR, d: '冗余姓名，列表不必再查 users' },
      { k: 'clsIds', t: ARR, d: '可管理的班级' },
      { k: 'courseIds', t: ARR, d: '可管理的课程' },
      { k: 'studentIds', t: ARR, d: '家长绑定的孩子' },
      { k: 'status', t: STR, d: 'active / invited / disabled' },
      { k: 'phone', t: STR, d: '手机号（选填）' },
      { k: 'wechat', t: STR, d: '微信号（选填）' },
      { k: 'photo', t: STR, d: '头像' },
      { k: 'openid', t: STR, d: '云端账号标识（认领后写入）' }
    ]
  },
  {
    coll: 'terms', entity: 'term', label: '学期', domain: '教学域',
    idType: 'num', sync: true, writer: '客户端（负责人/管理员）',
    retention: '长期保留（历史成绩单依赖它）',
    indexes: [['orgId + status', '复合']],
    fields: [
      { k: 'id', t: INT, d: '学期 id' },
      { k: 'name', t: STR, d: '2026春季班 / 暑假班 / 长期班' },
      { k: 'startDate', t: STR, d: '开始日期 YYYY-MM-DD' },
      { k: 'endDate', t: STR, d: '结束日期 YYYY-MM-DD' },
      { k: 'status', t: STR, d: 'upcoming / active / archived' },
      { k: 'builtIn', t: BOOL, d: '内置长期班，老数据升级时收编历史班级' }
    ]
  },
  {
    coll: 'classes', entity: 'class', label: '班级', domain: '教学域',
    idType: 'num', sync: true, writer: '客户端（负责人/管理员/班主任）',
    retention: '长期保留',
    indexes: [['orgId + termId', '复合']],
    fields: [
      { k: 'id', t: INT, d: '班级 id' },
      { k: 'name', t: STR, d: '班级名称' },
      { k: 'sort', t: INT, d: '排序' },
      { k: 'termId', t: INT, d: '归属学期' },
      { k: 'mode', t: STR, d: 'term 学期制 / carry 课时包结转' },
      { k: 'teacherId', t: INT, d: '主讲老师 member.id，0 = 未指派' },
      { k: 'session', t: INT, d: '当前课次号，从 1 起，结清时 +1' },
      { k: 'detached', t: OBJ, d: '删除班级时摘掉的关联 {students[], members[]}，还原用' }
    ]
  },
  {
    coll: 'courses', entity: 'course', label: '课程', domain: '教学域',
    idType: 'num', sync: true, writer: '客户端（负责人/管理员/老师）',
    retention: '长期保留',
    indexes: [['orgId + clsId', '复合'], ['orgId + subjectId', '复合（阶段二选题用）']],
    fields: [
      { k: 'id', t: INT, d: '课程 id' },
      { k: 'clsId', t: INT, d: '所属班级' },
      { k: 'subjectId', t: INT, d: '学科 subjects.id，0 = 未指定（V9 新增）' },
      { k: 'name', t: STR, d: '课程名，如 楷书 / 素描 / 数学思维' }
    ]
  },
  {
    coll: 'subjects', entity: 'subject', label: '学科', domain: '内容域',
    idType: 'num', sync: true, writer: '客户端（首次使用种子化 + 负责人可改名）',
    retention: '随机构存在',
    indexes: [['orgId + gid', '唯一'], ['orgId + sort', '复合']],
    fields: [
      { k: 'id', t: INT, d: '机构内自增 id' },
      { k: 'gid', t: STR, d: '全局 ID（sub_math…），内置学科跨机构一致，永不复用' },
      { k: 'name', t: STR, d: '语文 / 数学 / 书法 / 美术…' },
      { k: 'kind', t: STR, d: 'academic 学科类 / art 艺术类 / skill 技能类' },
      { k: 'sort', t: INT, d: '排序' }
    ]
  },
  {
    coll: 'knowledge_points', entity: 'knowledgePoint', label: '知识点', domain: '内容域',
    idType: 'num', sync: true, writer: '阶段一：脚本/后台；阶段二：题库后台',
    retention: '长期保留；被题目引用时禁止物理删除',
    indexes: [['orgId + gid', '唯一'], ['orgId + subjectId + parentId', '复合'], ['orgId + path', '复合（子树前缀查询）']],
    fields: [
      { k: 'id', t: INT, d: '机构内自增 id' },
      { k: 'gid', t: STR, d: '全局 ID（kp_xxx），题目永久引用，永不复用' },
      { k: 'subjectId', t: INT, d: '所属学科' },
      { k: 'parentId', t: INT, d: '父节点，0 = 根' },
      { k: 'path', t: STR, d: '物化路径 数学/小学/数与代数/分数（云开发无递归查询，靠它查子树）' },
      { k: 'depth', t: INT, d: '层级深度，根为 0' },
      { k: 'name', t: STR, d: '知识点名' },
      { k: 'grade', t: STR, d: '适用年级，空 = 全年级' },
      { k: 'code', t: STR, d: '外部映射码（对齐课标/教材），做数据交换用' },
      { k: 'sort', t: INT, d: '同层排序' },
      { k: 'source', t: STR, d: 'platform 平台公共 / org 机构私有' }
    ]
  },
  {
    coll: 'students', entity: 'student', label: '学生', domain: '教学域',
    idType: 'num', sync: true, writer: '客户端（负责人/管理员/老师）',
    retention: '长期保留（离班后仍保留档案与历史记录）',
    indexes: [['orgId + no', '唯一（学号）'], ['orgId + name', '复合（搜索）']],
    fields: [
      { k: 'id', t: INT, d: '学生 id' },
      { k: 'name', t: STR, d: '姓名' },
      { k: 'no', t: STR, d: '学号，机构内唯一，从 1001 起，一经生成不变' },
      { k: 'gender', t: STR, d: '男 / 女 / 空' },
      { k: 'enrollYear', t: INT, d: '入学年份，0 = 未填' },
      { k: 'clsIds', t: ARR, d: '所在班级' },
      { k: 'parent', t: STR, d: '家长姓名' },
      { k: 'wechat', t: STR, d: '家长微信号' },
      { k: 'photo', t: STR, d: '照片' },
      { k: 'profile', t: OBJ, d: '扩展档案（年级、学校等自由字段）' },
      { k: 'demo', t: BOOL, d: '演示数据标记' }
    ]
  },
  {
    coll: 'enrollments', entity: 'enrollment', label: '报名（课时账本）', domain: '教学域',
    idType: 'num', sync: true, writer: '客户端（报名/结转/退费）',
    retention: '长期保留（账本不可删，只能作废）',
    indexes: [['orgId + studentId + clsId', '复合'], ['orgId + termId', '复合']],
    fields: [
      { k: 'id', t: INT, d: '报名 id' },
      { k: 'studentId', t: INT, d: '学生' },
      { k: 'clsId', t: INT, d: '班级' },
      { k: 'termId', t: INT, d: '学期' },
      { k: 'totalHours', t: INT, d: '购买课时' },
      { k: 'usedHours', t: INT, d: '已用课时' },
      { k: 'status', t: STR, d: 'active / carried / churned / refunded' },
      { k: 'carriedFrom', t: INT, d: '上一期报名 id，续报溯源' }
    ]
  },
  {
    coll: 'records', entity: 'record', label: '课堂记录', domain: '活动域',
    idType: 'num', sync: true, writer: '客户端（老师）',
    retention: '长期保留；媒体文件按 3 年冷归档（阶段二定策略）',
    indexes: [['orgId + cid + session', '复合（本次录入）'], ['orgId + sid + date', '复合（学生时间线）']],
    fields: [
      { k: 'id', t: INT, d: '记录 id' },
      { k: 'type', t: STR, d: '业务活动类型，现在只有 achievement（留字段不留逻辑）' },
      { k: 'sid', t: INT, d: '学生' },
      { k: 'cid', t: INT, d: '班级' },
      { k: 'courseId', t: INT, d: '课程' },
      { k: 'course', t: STR, d: '课程名冗余（改名不改历史）' },
      { k: 'date', t: STR, d: '日期 YYYY-MM-DD（本地日，避免 UTC 偏一天）' },
      { k: 'score', t: INT, d: '分数，口径见 scoreScale' },
      { k: 'scoreScale', t: INT, d: '满分口径，默认 100（V9 新增）' },
      { k: 'tag', t: STR, d: '五档：待提高/加油/良好/优秀/最佳' },
      { k: 'note', t: STR, d: '评语' },
      { k: 'photos', t: ARR, d: '照片（最多 9 张，可含云存储 fileID）' },
      { k: 'videos', t: ARR, d: '视频（最多 3 个）' },
      { k: 'audio', t: STR, d: '语音 fileID 或本地路径' },
      { k: 'sent', t: BOOL, d: '是否已发布到家长端' },
      { k: 'session', t: INT, d: '课次号' },
      { k: 'kpIds', t: ARR, d: '关联知识点（阶段二填，V9 新增）' },
      { k: 'tid', t: STR, d: '录入老师 user.id' },
      { k: 'demo', t: BOOL, d: '演示数据标记' }
    ]
  },
  {
    coll: 'users', entity: 'user', label: '人员（账号）', domain: '组织域',
    idType: 'str', sync: false, writer: '客户端（仅本机账号，不上传）',
    retention: '随机构存在',
    indexes: [['id', '主键']],
    fields: [
      { k: 'id', t: STR, d: '本机人员 id' },
      { k: 'name', t: STR, d: '姓名' },
      { k: 'photo', t: STR, d: '头像' },
      { k: 'role', t: STR, d: '默认角色参考，不参与权限判定' }
    ]
  },
  {
    coll: 'templates', entity: 'template', label: '评价模板', domain: '内容域',
    idType: 'num', sync: true, writer: '客户端（负责人/管理员）',
    retention: '随机构存在',
    indexes: [['orgId + sort', '复合']],
    fields: [
      { k: 'id', t: INT, d: '模板 id' },
      { k: 'name', t: STR, d: '维度名，如 上课态度' },
      { k: 'options', t: ARR, d: '常用评语选项' },
      { k: 'sort', t: INT, d: '排序' }
    ]
  }
];

// 公共审计字段统一补在每条实体后面（不手抄，避免漏一个字段）
ENTITIES.forEach(e => { e.fields = e.fields.concat(AUDIT); });

const ALL_COLLS = ENTITIES.map(e => e.coll);
const SYNC_COLLS = ENTITIES.filter(e => e.sync).map(e => e.coll);
// 由 core.nextId 分配 id 的集合：启动时用现有最大值给分配器垫底，避免时间回拨撞号。
// members 的 id 是"登记时刻 + 序号"，不参与垫底（纳入也不会错，但语义上不该混进来）。
const NUM_ID_COLLS = ENTITIES.filter(e => e.idType === 'num' && e.idGen !== 'stamp').map(e => e.coll);
const byColl = coll => ENTITIES.find(e => e.coll === coll) || null;
const byEntity = entity => ENTITIES.find(e => e.entity === entity) || null;

module.exports = { ENTITIES, ALL_COLLS, SYNC_COLLS, NUM_ID_COLLS, AUDIT, byColl, byEntity };
