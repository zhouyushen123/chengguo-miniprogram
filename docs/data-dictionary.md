# 数据字典（自动生成，请勿手改）

> 由 `npm run docs:schema` 从 `utils/db/entities.js` + `utils/db/schema.js` 生成。
> 门禁：`npm run check` 会跑 `node tools/schema-doc.js --check`，代码与本文不一致即失败。
> 改字段的正确顺序：改 `schema.js` 的 normalize/validate → 改 `entities.js` 登记 → 重新生成本文。

共 **23** 张集合：本机库 **13** 张（其中参与同步的 **12** 张）+ 云端专用 **10** 张。

> 注意 `users` 同名不同物：本机那张是"演示身份"，云端那张是"这个微信绑过哪些机构"，见第 2 节末尾。

## 1. 总览

| 集合 | 名称 | 位置 | 域 | id | 同步 | 写入方 | 保留期 |
|---|---|---|---|---|---|---|---|
| `orgs` | 机构 | 本机 + 云端 | 组织域 | string | ✅ | 客户端（负责人） | 随机构存在；机构删除后归档 90 天 |
| `members` | 成员关系 | 本机 + 云端 | 组织域 | int（登记时刻） | ✅ | 客户端 + 云函数（认领/邀请） | 随机构存在 |
| `terms` | 学期 | 本机 + 云端 | 教学域 | int 自增 | ✅ | 客户端（负责人/管理员） | 长期保留（历史成绩单依赖它） |
| `classes` | 班级 | 本机 + 云端 | 教学域 | int 自增 | ✅ | 客户端（负责人/管理员/班主任） | 长期保留 |
| `courses` | 课程 | 本机 + 云端 | 内容域 | int 自增 | ✅ | 客户端（负责人/管理员/老师） | 长期保留（班级删除不影响课程本身） |
| `class_courses` | 班级课程绑定 | 本机 + 云端 | 教学域 | int 自增 | ✅ | 客户端（负责人/管理员/老师） | 随班级存在；解绑即软删 |
| `subjects` | 学科 | 本机 + 云端 | 内容域 | int 自增 | ✅ | 客户端（首次使用种子化 + 负责人可改名） | 随机构存在 |
| `knowledge_points` | 知识点 | 本机 + 云端 | 内容域 | int 自增 | ✅ | 阶段一：脚本/后台；阶段二：题库后台 | 长期保留；被题目引用时禁止物理删除 |
| `students` | 学生 | 本机 + 云端 | 教学域 | int 自增 | ✅ | 客户端（负责人/管理员/老师） | 长期保留（离班后仍保留档案与历史记录） |
| `enrollments` | 报名（课时账本） | 本机 + 云端 | 教学域 | int 自增 | ✅ | 客户端（报名/结转/退费） | 长期保留（账本不可删，只能作废） |
| `records` | 课堂记录 | 本机 + 云端 | 活动域 | int 自增 | ✅ | 客户端（老师） | 长期保留；媒体文件按 3 年冷归档（阶段二定策略） |
| `users` | 人员（账号） | 本机 + 云端 | 组织域 | string | — | 客户端（仅本机账号，不上传） | 随机构存在 |
| `templates` | 评价模板 | 本机 + 云端 | 内容域 | int 自增 | ✅ | 客户端（负责人/管理员） | 随机构存在 |
| `users` | 微信绑定（云端） | **仅云端** | — | 自动 | — | 云函数 `syncv2`（hello / finishJoin） | 随账号存在 |
| `invites` | 机构码（邀请码） | **仅云端** | — | string（6 位码，作 _id） | — | 云函数 `syncv2`（inviteGet / parentCode） | 30 天过期；作废即 `closed=true` |
| `invite_cards` | 家长邀请卡（一人一张） | **仅云端** | — | string（12 位 token，作 _id） | — | 云函数 `syncv2`（cardCreate / cardClaim / cardRevoke） | 7 天过期；作废保留记录 |
| `history` | 版本历史 | **仅云端** | — | 自动 | — | 云函数 `syncv2`（push 前留旧值） | 每个资产保留最近 10 份 |
| `openid_map` | 订阅授权额度 | **仅云端** | — | 自动 | — | 云函数 `family`（bind / familyNotify） | 长期；授权用完 `grants=0` |
| `record_views` | 家长已读回执 | **仅云端** | — | string（`orgId:rid:openid`） | — | 云函数 `family`（fbView） | 长期 |
| `parent_notes` | 家长留言 | **仅云端** | — | 自动 | — | 云函数 `family`（fbNote / fbHandle） | 长期 |
| `admin_accounts` | 电脑端后台账号 | **仅云端** | — | string（6 位账号，作 _id） | — | 云函数 `admin`（adminAccount / resetPin） | 随机构存在 |
| `admin_sessions` | 后台登录会话 | **仅云端** | — | string（token，作 _id） | — | 云函数 `admin`（login / resetPin 清空） | 过期即失效（`exp`） |
| `backups` | 备份清单 | **仅云端** | — | string（`orgId+日期+tag`） | — | 云函数 `backup`（runOrg / prune） | 保留近 N 天 + 至少 2 份 |

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

### 云端专用表（不进本机库、不参与 pull/push）

#### `users` 微信绑定（云端）

- id：自动
- 写入方：云函数 `syncv2`（hello / finishJoin）
- 保留期：随账号存在
- 索引：`_openid`（唯一查（一个微信一条））
- 说明：**与本地 `users` 同名但语义不同**：本地那张是"本机演示身份"，这张是"这个微信绑过哪些机构"。

| 字段 | 类型 | 说明 |
|---|---|---|
| `_openid` | string | 微信 openid（系统字段） |
| `orgId` | string | 主机构（第一家加入的） |
| `orgIds` | array | 我能进的机构清单（一张工牌一个）；老数据没有这个字段时按 `orgId` 算 |
| `createdAt` | serverDate | 首次绑定时间 |

#### `invites` 机构码（邀请码）

- id：string（6 位码，作 _id）
- 写入方：云函数 `syncv2`（inviteGet / parentCode）
- 保留期：30 天过期；作废即 `closed=true`
- 索引：`orgId+role+closed`（找本机构可用码）

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 邀请码本身（字母表去掉 0/O/1/I/2/Z，避免看错） |
| `orgId` | string | 码属于哪个机构 |
| `role` | string | `parent` / `teacher` / `admin`，一种身份一个码 |
| `closed` | bool | 是否停用 |
| `uses` | number | 已使用次数 |
| `by` | string | 生成者 openid |
| `createdAt` | number | 生成时间（毫秒） |
| `expiresAt` | number | 过期时间（默认 30 天） |

#### `invite_cards` 家长邀请卡（一人一张）

- id：string（12 位 token，作 _id）
- 写入方：云函数 `syncv2`（cardCreate / cardClaim / cardRevoke）
- 保留期：7 天过期；作废保留记录
- 索引：`orgId+sid`（按学生查卡）；`status`（清理解析）
- 说明：token 就是 `_id`；`data` 里绝不能带 `_id`（云数据库会报 -501007）。卡面名字在创建时固化，家长点开不必回查业务表。

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 一次性令牌（小写无歧义字符，12 位） |
| `orgId` | string | 机构 |
| `clsId` | number | 学生所在班（发卡时取第一个班） |
| `sid` | number | 学生 id |
| `code` | string | 机构码（**只在服务端用**，从不下发给家长） |
| `role` | string | 固定 `parent` |
| `stuNo` | string | 学号（卡面不回显，仅服务端匹配用） |
| `orgName` | string | 卡面：机构名 |
| `clsName` | string | 卡面：班级名 |
| `stuName` | string | 卡面：孩子姓名 |
| `status` | string | `unused` / `claimed` / `approved` / `revoked` |
| `expiresAt` | number | 过期时间（7 天） |
| `usedAt` | number | 被点开的时间 |
| `usedBy` | string | 认领者 openid |
| `claimName` | string | 认领时填的姓名 |
| `claimPhone` | string | 预留：认领手机号（阶段 2） |
| `pid` | string | 归并后的平台身份（同一个孩子跨机构共用） |
| `approvedAt` | number | 确认加入完成时间 |
| `by` | string | 发卡老师 openid |
| `createdAt` | number | 创建时间 |

#### `history` 版本历史

- id：自动
- 写入方：云函数 `syncv2`（push 前留旧值）
- 保留期：每个资产保留最近 10 份
- 索引：`orgId+c+id+at`（按资产倒序取历史）
- 说明：只给核心四类（`orgs` / `members` / `students` / `classes`）留历史；记录量大，留历史会把库撑爆。

| 字段 | 类型 | 说明 |
|---|---|---|
| `orgId` | string | 机构 |
| `c` | string | 集合名 |
| `id` | number|string | 资产 id |
| `at` | number | 留档时间（毫秒） |
| `by` | string | 操作者 openid |
| `doc` | object | 旧值快照（去掉 `_id` / `_openid` / `srvAt`） |

#### `openid_map` 订阅授权额度

- id：自动
- 写入方：云函数 `family`（bind / familyNotify）
- 保留期：长期；授权用完 `grants=0`
- 索引：`_openid`（按家长查）；`sids`（按孩子找家长）

| 字段 | 类型 | 说明 |
|---|---|---|
| `_openid` | string | 家长 openid（系统字段） |
| `sids` | array | 这个家长订阅了哪些孩子（学生 id） |
| `name` | string | 家长备注名 |
| `grants` | number | 剩余可推送条数（一次性订阅按条计，收到一条减一） |
| `updatedAt` | serverDate | 最后更新时间 |

#### `record_views` 家长已读回执

- id：string（`orgId:rid:openid`）
- 写入方：云函数 `family`（fbView）
- 保留期：长期
- 索引：`orgId+rid`（按记录统计已读）；`orgId+sid`（按学生统计）
- 说明：`_id` 用三元组拼出来，重复上报是幂等的（`set` 覆盖），不会因为反复打开而多算。

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | `orgId:rid:openid` |
| `orgId` | string | 机构 |
| `rid` | number | 成果（记录）id |
| `sid` | number | 学生 id |
| `openid` | string | 看的那个家长 |
| `viewedAt` | number | 看到的时间（首次与再次都会刷新，只用于"看过没有"） |

#### `parent_notes` 家长留言

- id：自动
- 写入方：云函数 `family`（fbNote / fbHandle）
- 保留期：长期
- 索引：`orgId+rid`（按记录看留言）；`orgId+openid`（家长看自己写的）
- 说明：限流：一条成果最多 3 条、60 秒内最多 2 条；正文 ≤200 字，先过 `secCheck`（只拦明确违规 87014）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `orgId` | string | 机构 |
| `rid` | number | 针对哪条成果 |
| `sid` | number | 学生 id |
| `openid` | string | 留言的家长 |
| `text` | string | 正文（≤200 字） |
| `createdAt` | number | 留言时间 |
| `handled` | number | 0 未处理 / 1 已处理 |
| `handledBy` | string | 处理人 openid |
| `handledAt` | number | 处理时间 |

#### `admin_accounts` 电脑端后台账号

- id：string（6 位账号，作 _id）
- 写入方：云函数 `admin`（adminAccount / resetPin）
- 保留期：随机构存在
- 索引：`orgId`（一机构一账号）

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 后台账号（6 位） |
| `account` | string | 同 `_id`，便于直接读 |
| `orgId` | string | 属于哪个机构 |
| `pin` | string | 6 位口令（重置即换） |
| `fail` | number | 连续试错次数 |
| `lockUntil` | number | 锁定到期时间（试错太多后锁定 10 分钟） |
| `createdAt` | number | 创建时间 |
| `by` | string | 创建者 openid |

#### `admin_sessions` 后台登录会话

- id：string（token，作 _id）
- 写入方：云函数 `admin`（login / resetPin 清空）
- 保留期：过期即失效（`exp`）
- 索引：`account`（按账号清会话）

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 会话 token |
| `account` | string | 哪个后台账号 |
| `orgId` | string | 机构 |
| `exp` | number | 过期时间 |
| `at` | number | 签发时间 |

#### `backups` 备份清单

- id：string（`orgId+日期+tag`）
- 写入方：云函数 `backup`（runOrg / prune）
- 保留期：保留近 N 天 + 至少 2 份
- 索引：`orgId+date`（按机构按日取清单）
- 说明：只存"清单"，正文在云存储（`fileID`）。清单先落地再删旧分片——反过来会让清单指向已删除的文件。

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 清单 id（机构+日期+tag） |
| `orgId` | string | 机构 |
| `date` | string | 备份日期 `YYYYMMDD` |
| `tag` | string | 日常备份为空；恢复前快照用唯一 tag |
| `at` | number | 生成时间 |
| `counts` | object | `{集合: 条数}` |
| `total` | number | 总条数 |
| `bytes` | number | 总字节数 |
| `files` | array | `[{c, part, count, bytes, fileID}]` 分片清单 |
| `status` | string | `ok` / `partial` / `failed` |
| `stoppedAt` | string | 因超时停在哪个集合（空=跑完） |
| `failed` | array | 读失败的集合（**不是空集合**） |
| `missing` | array | 本次没跑的集合 |
| `truncated` | bool | 有集合撞到单次上限，可能不全 |
| `safety` | bool | 是否为恢复前的安全快照（不参与清理） |

> **历史遗留，不算数据表**：`cloudfunctions/sync`（旧同步函数）里用过 `profiles` 集合，
> 该函数已废弃、未部署、客户端零引用（`npm run cloud:ls` 会显示"本地有目录但没被引用"），
> 云环境里不存在这张表。留着代码只为追溯，不要照它设计新东西。

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

## 5. 本机存储布局（排障用）

全项目只有 `utils/db/storage.js` 碰本地存储；键名规则如下。

| 键 | 内容 |
|---|---|
| `chengguo_v3_<集合>` | 该集合的全部文档（13 个集合各一个键） |
| `chengguo_v3_records` / `_2` … `_n` | `records` 按 320 条分片（上课记录线性增长，单片会撞 1MB） |
| `chengguo_v3_meta` | 机构号、我的身份、同步游标（一家一个）、脏集合、被退回条目 |
| `chengguo_v3_chunks` | 各集合分片数索引（只用于清理旧分片） |
| `chengguo_demo_<集合>` | 演示数据命名空间，与真实数据完全隔离，不上云 |
| `chengguo_snap_<id>` / `chengguo_snaps` | 启动自愈用的快照与索引 |
| `chengguo_v2` / `chengguo_tpls` | 老版本单对象（迁移源，保留作兜底） |
| `chengguo_theme` | 皮肤选择 |
| `chengguo_firstrun_v1` | 首次引导是否已自动弹过 |
| `cg_last_error` | 最近一次未捕获异常（「关于」里可看） |

## 6. 表间关系（一句话版）

- `orgs` 1—n `members` / `terms` / `classes` / `students` / `records`；所有表都带 `orgId`，云函数按它做**物理隔离**。
- `classes` n—n `courses` 经 `class_courses`；`class_courses` 记这门课由谁带、每周几节。
- `students` n—n `classes` 用 `students.clsIds`（学生可在多个班）；`records` 同时挂 `sid` 与 `cid`。
- `records` 1—n `enrollments`（上课扣课时）；`enrollments` 归属 `sid + courseId`。
- 跨机构身份：`students.pid` 相同 = 同一个孩子（家长端据此把两家成果并到一页）。
- `invite_cards.sid` → `students.id`；`invite_cards.pid` 是确认后写回的平台身份。
- `record_views.rid` / `parent_notes.rid` → `records.id`；两者都只按 `orgId` 内可见。
- `history` 按 `(orgId, c, id)` 指向任一核心表的某个资产。
