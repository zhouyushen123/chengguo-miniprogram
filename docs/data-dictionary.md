# 数据字典（自动生成，请勿手改）

> 由 `npm run docs:schema` 从 `utils/db/entities.js` + `utils/db/schema.js` 生成。
> 门禁：`npm run check` 会跑 `node tools/schema-doc.js --check`，代码与本文不一致即失败。
> 改字段的正确顺序：改 `schema.js` 的 normalize/validate → 改 `entities.js` 登记 → 重新生成本文。

共 **13** 张表；参与同步的 **12** 张。

## 1. 总览

| 集合 | 名称 | 域 | id | 同步 | 写入方 | 保留期 |
|---|---|---|---|---|---|---|
| `orgs` | 机构 | 组织域 | string | ✅ | 客户端（负责人） | 随机构存在；机构删除后归档 90 天 |
| `members` | 成员关系 | 组织域 | int（登记时刻） | ✅ | 客户端 + 云函数（认领/邀请） | 随机构存在 |
| `terms` | 学期 | 教学域 | int 自增 | ✅ | 客户端（负责人/管理员） | 长期保留（历史成绩单依赖它） |
| `classes` | 班级 | 教学域 | int 自增 | ✅ | 客户端（负责人/管理员/班主任） | 长期保留 |
| `courses` | 课程 | 内容域 | int 自增 | ✅ | 客户端（负责人/管理员/老师） | 长期保留（班级删除不影响课程本身） |
| `class_courses` | 班级课程绑定 | 教学域 | int 自增 | ✅ | 客户端（负责人/管理员/老师） | 随班级存在；解绑即软删 |
| `subjects` | 学科 | 内容域 | int 自增 | ✅ | 客户端（首次使用种子化 + 负责人可改名） | 随机构存在 |
| `knowledge_points` | 知识点 | 内容域 | int 自增 | ✅ | 阶段一：脚本/后台；阶段二：题库后台 | 长期保留；被题目引用时禁止物理删除 |
| `students` | 学生 | 教学域 | int 自增 | ✅ | 客户端（负责人/管理员/老师） | 长期保留（离班后仍保留档案与历史记录） |
| `enrollments` | 报名（课时账本） | 教学域 | int 自增 | ✅ | 客户端（报名/结转/退费） | 长期保留（账本不可删，只能作废） |
| `records` | 课堂记录 | 活动域 | int 自增 | ✅ | 客户端（老师） | 长期保留；媒体文件按 3 年冷归档（阶段二定策略） |
| `users` | 人员（账号） | 组织域 | string | — | 客户端（仅本机账号，不上传） | 随机构存在 |
| `templates` | 评价模板 | 内容域 | int 自增 | ✅ | 客户端（负责人/管理员） | 随机构存在 |

## 2. 表结构

### `orgs` 机构

- 域：组织域　id：string　同步：是
- 写入方：客户端（负责人）
- 保留期：随机构存在；机构删除后归档 90 天
- 索引：`id`（主键）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 机构号 org_xxx（服务端发放，非自增） |
| `name` | string | 机构名称 |
| `ownerId` | string | 负责人 user.id |
| `status` | string | active / suspended |
| `orgId` | string | 归属机构。orgs 集合里等于 id |
| `createdAt` | int(ms) | 创建时间 |
| `updatedAt` | int(ms) | 更新时间，同步 LWW 的依据 |
| `removed` | bool | 软删除标记（删除必须能被同步，不能硬删） |
| `removedAt` | int(ms) | 哪一次删除：同一批次共用，回收站按它整批还原 |
| `removedBy` | int | 操作人 member.id，0 = 系统 |

### `members` 成员关系

- 域：组织域　id：int（登记时刻）　同步：是
- 写入方：客户端 + 云函数（认领/邀请）
- 保留期：随机构存在
- 索引：`orgId + userId`（唯一）；`orgId + openid`（唯一（认领后））

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 成员 id |
| `userId` | string | 人员 user.id |
| `role` | string | owner / admin / teacher / parent |
| `name` | string | 冗余姓名，列表不必再查 users |
| `clsIds` | array | 可管理的班级 |
| `courseIds` | array | 可管理的课程 |
| `studentIds` | array | 家长绑定的孩子 |
| `status` | string | active / invited / disabled |
| `phone` | string | 手机号（选填） |
| `wechat` | string | 微信号（选填） |
| `photo` | string | 头像 |
| `openid` | string | 云端账号标识（认领后写入） |
| `orgId` | string | 归属机构。orgs 集合里等于 id |
| `createdAt` | int(ms) | 创建时间 |
| `updatedAt` | int(ms) | 更新时间，同步 LWW 的依据 |
| `removed` | bool | 软删除标记（删除必须能被同步，不能硬删） |
| `removedAt` | int(ms) | 哪一次删除：同一批次共用，回收站按它整批还原 |
| `removedBy` | int | 操作人 member.id，0 = 系统 |

### `terms` 学期

- 域：教学域　id：int 自增　同步：是
- 写入方：客户端（负责人/管理员）
- 保留期：长期保留（历史成绩单依赖它）
- 索引：`orgId + status`（复合）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 学期 id |
| `name` | string | 2026春季班 / 暑假班 / 长期班 |
| `startDate` | string | 开始日期 YYYY-MM-DD |
| `endDate` | string | 结束日期 YYYY-MM-DD |
| `status` | string | upcoming / active / archived |
| `builtIn` | bool | 内置长期班，老数据升级时收编历史班级 |
| `orgId` | string | 归属机构。orgs 集合里等于 id |
| `createdAt` | int(ms) | 创建时间 |
| `updatedAt` | int(ms) | 更新时间，同步 LWW 的依据 |
| `removed` | bool | 软删除标记（删除必须能被同步，不能硬删） |
| `removedAt` | int(ms) | 哪一次删除：同一批次共用，回收站按它整批还原 |
| `removedBy` | int | 操作人 member.id，0 = 系统 |

### `classes` 班级

- 域：教学域　id：int 自增　同步：是
- 写入方：客户端（负责人/管理员/班主任）
- 保留期：长期保留
- 索引：`orgId + termId`（复合）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 班级 id |
| `name` | string | 班级名称 |
| `sort` | int | 排序 |
| `termId` | int | 归属学期 |
| `mode` | string | term 学期制 / carry 课时包结转 |
| `teacherId` | int | 主讲老师 member.id，0 = 未指派 |
| `session` | int | 当前课次号，从 1 起，结清时 +1 |
| `detached` | object | 删除班级时摘掉的关联 {students[], members[]}，还原用 |
| `orgId` | string | 归属机构。orgs 集合里等于 id |
| `createdAt` | int(ms) | 创建时间 |
| `updatedAt` | int(ms) | 更新时间，同步 LWW 的依据 |
| `removed` | bool | 软删除标记（删除必须能被同步，不能硬删） |
| `removedAt` | int(ms) | 哪一次删除：同一批次共用，回收站按它整批还原 |
| `removedBy` | int | 操作人 member.id，0 = 系统 |

### `courses` 课程

- 域：内容域　id：int 自增　同步：是
- 写入方：客户端（负责人/管理员/老师）
- 保留期：长期保留（班级删除不影响课程本身）
- 索引：`orgId + subjectId`（复合（按学科筛课 / 阶段二选题））

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 课程 id |
| `subjectId` | int | 学科 subjects.id，0 = 未指定（V9 新增） |
| `name` | string | 课程名，如 楷书 / 素描 / 数学思维。V10 起不再绑定班级 |
| `intro` | string | 课程详细介绍（面向家长/新老师的课程说明，多行文本，可空，≤500 字） |
| `meta` | object | 课程扩展槽：以后加适合年龄/课时/教材/教学目标/封面等字段直接写这里，不改表结构、不迁移、不动云函数 |
| `mergedInto` | int | 同名课程合并到哪门课（0 = 未合并；非 0 的行是墓碑，不进回收站） |
| `orgId` | string | 归属机构。orgs 集合里等于 id |
| `createdAt` | int(ms) | 创建时间 |
| `updatedAt` | int(ms) | 更新时间，同步 LWW 的依据 |
| `removed` | bool | 软删除标记（删除必须能被同步，不能硬删） |
| `removedAt` | int(ms) | 哪一次删除：同一批次共用，回收站按它整批还原 |
| `removedBy` | int | 操作人 member.id，0 = 系统 |

### `class_courses` 班级课程绑定

- 域：教学域　id：int 自增　同步：是
- 写入方：客户端（负责人/管理员/老师）
- 保留期：随班级存在；解绑即软删
- 索引：`orgId + clsId`（复合（排课表））；`orgId + courseId`（复合（这门课在哪些班））

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 绑定 id |
| `clsId` | int | 班级 classes.id |
| `courseId` | int | 课程 courses.id，同一门课可绑多个班 |
| `teacherId` | int | 该班这门课的任课老师 member.id，0 = 跟随班级主讲（预留） |
| `sort` | int | 同班内的教学顺序，上课选课按它排 |
| `orgId` | string | 归属机构。orgs 集合里等于 id |
| `createdAt` | int(ms) | 创建时间 |
| `updatedAt` | int(ms) | 更新时间，同步 LWW 的依据 |
| `removed` | bool | 软删除标记（删除必须能被同步，不能硬删） |
| `removedAt` | int(ms) | 哪一次删除：同一批次共用，回收站按它整批还原 |
| `removedBy` | int | 操作人 member.id，0 = 系统 |

### `subjects` 学科

- 域：内容域　id：int 自增　同步：是
- 写入方：客户端（首次使用种子化 + 负责人可改名）
- 保留期：随机构存在
- 索引：`orgId + gid`（唯一）；`orgId + sort`（复合）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 机构内自增 id |
| `gid` | string | 全局 ID（sub_math…），内置学科跨机构一致，永不复用 |
| `name` | string | 语文 / 数学 / 书法 / 美术… |
| `kind` | string | academic 学科类 / art 艺术类 / skill 技能类 |
| `sort` | int | 排序 |
| `orgId` | string | 归属机构。orgs 集合里等于 id |
| `createdAt` | int(ms) | 创建时间 |
| `updatedAt` | int(ms) | 更新时间，同步 LWW 的依据 |
| `removed` | bool | 软删除标记（删除必须能被同步，不能硬删） |
| `removedAt` | int(ms) | 哪一次删除：同一批次共用，回收站按它整批还原 |
| `removedBy` | int | 操作人 member.id，0 = 系统 |

### `knowledge_points` 知识点

- 域：内容域　id：int 自增　同步：是
- 写入方：阶段一：脚本/后台；阶段二：题库后台
- 保留期：长期保留；被题目引用时禁止物理删除
- 索引：`orgId + gid`（唯一）；`orgId + subjectId + parentId`（复合）；`orgId + path`（复合（子树前缀查询））

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 机构内自增 id |
| `gid` | string | 全局 ID（kp_xxx），题目永久引用，永不复用 |
| `subjectId` | int | 所属学科 |
| `parentId` | int | 父节点，0 = 根 |
| `path` | string | 物化路径 数学/小学/数与代数/分数（云开发无递归查询，靠它查子树） |
| `depth` | int | 层级深度，根为 0 |
| `name` | string | 知识点名 |
| `grade` | string | 适用年级，空 = 全年级 |
| `code` | string | 外部映射码（对齐课标/教材），做数据交换用 |
| `sort` | int | 同层排序 |
| `source` | string | platform 平台公共 / org 机构私有 |
| `orgId` | string | 归属机构。orgs 集合里等于 id |
| `createdAt` | int(ms) | 创建时间 |
| `updatedAt` | int(ms) | 更新时间，同步 LWW 的依据 |
| `removed` | bool | 软删除标记（删除必须能被同步，不能硬删） |
| `removedAt` | int(ms) | 哪一次删除：同一批次共用，回收站按它整批还原 |
| `removedBy` | int | 操作人 member.id，0 = 系统 |

### `students` 学生

- 域：教学域　id：int 自增　同步：是
- 写入方：客户端（负责人/管理员/老师）
- 保留期：长期保留（离班后仍保留档案与历史记录）
- 索引：`orgId + no`（唯一（学号））；`orgId + name`（复合（搜索））

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 学生 id |
| `pid` | string | 平台身份（p_xxx）：同一个孩子在多家机构的档案共用它，家长端据此把两家的成果摆在一页；空=尚未归并 |
| `name` | string | 姓名 |
| `no` | string | 学号，机构内唯一，从 1001 起，一经生成不变 |
| `gender` | string | 男 / 女 / 空 |
| `enrollYear` | int | 入学年份，0 = 未填 |
| `clsIds` | array | 所在班级 |
| `parent` | string | 家长姓名 |
| `parentPhone` | string | 家长手机号，11 位裸数字（展示时 3-4-4）；与微信号同为家长归并键 |
| `wechat` | string | 家长微信号 |
| `photo` | string | 照片 |
| `profile` | object | 扩展档案（年级、学校等自由字段） |
| `demo` | bool | 演示数据标记 |
| `orgId` | string | 归属机构。orgs 集合里等于 id |
| `createdAt` | int(ms) | 创建时间 |
| `updatedAt` | int(ms) | 更新时间，同步 LWW 的依据 |
| `removed` | bool | 软删除标记（删除必须能被同步，不能硬删） |
| `removedAt` | int(ms) | 哪一次删除：同一批次共用，回收站按它整批还原 |
| `removedBy` | int | 操作人 member.id，0 = 系统 |

### `enrollments` 报名（课时账本）

- 域：教学域　id：int 自增　同步：是
- 写入方：客户端（报名/结转/退费）
- 保留期：长期保留（账本不可删，只能作废）
- 索引：`orgId + studentId + clsId`（复合）；`orgId + termId`（复合）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 报名 id |
| `studentId` | int | 学生 |
| `clsId` | int | 班级 |
| `termId` | int | 学期 |
| `totalHours` | int | 购买课时 |
| `usedHours` | int | 已用课时 |
| `status` | string | active / carried / churned / refunded |
| `carriedFrom` | int | 上一期报名 id，续报溯源 |
| `orgId` | string | 归属机构。orgs 集合里等于 id |
| `createdAt` | int(ms) | 创建时间 |
| `updatedAt` | int(ms) | 更新时间，同步 LWW 的依据 |
| `removed` | bool | 软删除标记（删除必须能被同步，不能硬删） |
| `removedAt` | int(ms) | 哪一次删除：同一批次共用，回收站按它整批还原 |
| `removedBy` | int | 操作人 member.id，0 = 系统 |

### `records` 课堂记录

- 域：活动域　id：int 自增　同步：是
- 写入方：客户端（老师）
- 保留期：长期保留；媒体文件按 3 年冷归档（阶段二定策略）
- 索引：`orgId + cid + session`（复合（本次录入））；`orgId + sid + date`（复合（学生时间线））

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 记录 id |
| `type` | string | 业务活动类型，现在只有 achievement（留字段不留逻辑） |
| `sid` | int | 学生 |
| `cid` | int | 班级 |
| `courseId` | int | 课程 |
| `course` | string | 课程名冗余（改名不改历史） |
| `date` | string | 日期 YYYY-MM-DD（本地日，避免 UTC 偏一天） |
| `score` | int | 分数，口径见 scoreScale |
| `scoreScale` | int | 满分口径，默认 100（V9 新增） |
| `tag` | string | 五档：待提高/加油/良好/优秀/最佳 |
| `note` | string | 评语 |
| `photos` | array | 照片（最多 9 张，可含云存储 fileID） |
| `videos` | array | 视频（最多 3 个） |
| `audio` | string | 语音 fileID 或本地路径 |
| `sent` | bool | 是否已发布到家长端 |
| `session` | int | 课次号 |
| `kpIds` | array | 关联知识点（阶段二填，V9 新增） |
| `tid` | string | 录入老师 user.id |
| `demo` | bool | 演示数据标记 |
| `orgId` | string | 归属机构。orgs 集合里等于 id |
| `createdAt` | int(ms) | 创建时间 |
| `updatedAt` | int(ms) | 更新时间，同步 LWW 的依据 |
| `removed` | bool | 软删除标记（删除必须能被同步，不能硬删） |
| `removedAt` | int(ms) | 哪一次删除：同一批次共用，回收站按它整批还原 |
| `removedBy` | int | 操作人 member.id，0 = 系统 |

### `users` 人员（账号）

- 域：组织域　id：string　同步：否（仅本机）
- 写入方：客户端（仅本机账号，不上传）
- 保留期：随机构存在
- 索引：`id`（主键）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 本机人员 id |
| `name` | string | 姓名 |
| `photo` | string | 头像 |
| `role` | string | 默认角色参考，不参与权限判定 |
| `orgId` | string | 归属机构。orgs 集合里等于 id |
| `createdAt` | int(ms) | 创建时间 |
| `updatedAt` | int(ms) | 更新时间，同步 LWW 的依据 |
| `removed` | bool | 软删除标记（删除必须能被同步，不能硬删） |
| `removedAt` | int(ms) | 哪一次删除：同一批次共用，回收站按它整批还原 |
| `removedBy` | int | 操作人 member.id，0 = 系统 |

### `templates` 评价模板

- 域：内容域　id：int 自增　同步：是
- 写入方：客户端（负责人/管理员）
- 保留期：随机构存在
- 索引：`orgId + sort`（复合）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | 模板 id |
| `name` | string | 维度名，如 上课态度 |
| `options` | array | 常用评语选项 |
| `sort` | int | 排序 |
| `orgId` | string | 归属机构。orgs 集合里等于 id |
| `createdAt` | int(ms) | 创建时间 |
| `updatedAt` | int(ms) | 更新时间，同步 LWW 的依据 |
| `removed` | bool | 软删除标记（删除必须能被同步，不能硬删） |
| `removedAt` | int(ms) | 哪一次删除：同一批次共用，回收站按它整批还原 |
| `removedBy` | int | 操作人 member.id，0 = 系统 |

## 3. 枚举与常量

| 名称 | 取值 | 出处 |
|---|---|---|
| 评分五档 TAGS | `待提高` / `加油` / `良好` / `优秀` / `最佳` | `utils/db/schema.js` |
| 记录类型 RECORD_TYPES | `achievement` | `utils/db/schema.js` |
| 角色 ROLES | `owner` / `admin` / `teacher` / `parent` | `utils/db/schema.js` |
| 成员状态 MEMBER_STATUS | `active` / `invited` / `disabled` | `utils/db/schema.js` |
| 机构状态 ORG_STATUS | `active` / `suspended` | `utils/db/schema.js` |
| 学期状态 TERM_STATUS | `upcoming` / `active` / `archived` | `utils/db/schema.js` |
| 班级模式 CLASS_MODES | `term` / `carry` | `utils/db/schema.js` |
| 报名状态 ENROLL_STATUS | `active` / `carried` / `churned` / `refunded` | `utils/db/schema.js` |
| 学科类别 SUBJECT_KINDS | `academic` / `art` / `skill` | `utils/db/schema.js` |
| 知识点来源 KP_SOURCES | `platform` / `org` | `utils/db/schema.js` |
| 媒体上限 LIMITS | `photos=9` / `videos=3` | `utils/db/schema.js` |

## 4. 内置学科（gid 永不变）

| gid | 名称 | 类别 | 排序 |
|---|---|---|---|
| `sub_chinese` | 语文 | academic | 1 |
| `sub_math` | 数学 | academic | 2 |
| `sub_english` | 英语 | academic | 3 |
| `sub_science` | 科学 | academic | 4 |
| `sub_calligraphy` | 书法 | art | 5 |
| `sub_art` | 美术 | art | 6 |
| `sub_coding` | 编程 | skill | 7 |

> `gid` 是不可逆决策：阶段二题目按它永久引用，机构可改学科名，但 gid 绝不改、不复用。
