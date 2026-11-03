# 项目工程档案：橙果 · 课后成果记录（微信小程序）

> 本档案是项目的记忆载体。每次架构决策、评审结论、风险变更都登记在此。
> **ADR 只增不删**；推翻旧决策时新增一条并注明"替代 ADR-xxx"，保留追溯链。

## 1. 项目概况

- **一句话目标**：艺术培训机构老师课后用手机记录每位学生的课堂成果（照片/视频/语音/评语），一键发送给家长。
- **当前阶段**：④ 评审与重构（工程周期地图）。已完成 MVP 功能闭环，本次为架构体检，尚未进入重构实施。
- **最后更新时间**：2026-11-01 19:00
- **代码位置**：`E:\新建文件夹\chengguo-miniprogram`（GitHub 私有仓库 `zhouyushen123/chengguo-miniprogram`）
- **规模**：约 6700 行（含 demo-data 2367 行），8 个页面，主包 719KB。

## 2. 技术栈与版本

| 项 | 值 | 来源 |
|---|---|---|
| 平台 | 微信小程序原生（WXML/WXSS/JS） | project.config.json |
| 基础库 | 3.0.0 | project.config.json `libVersion` |
| AppID | wxd1c22bef24e8dff2 | project.config.json |
| 云函数根 | `cloudfunctions/`（已配置，未部署） | project.config.json |
| 云开发 | **未开通**（需微信认证；`utils/api.js` `CLOUD_ENABLED=false`） | 代码确认 |
| CI 工具 | miniprogram-ci ^2.1.9（路径问题已修 CR-003/004；**测试门禁仍未加**，备案下来后补） | package.json |
| 数据持久化 | `wx.setStorageSync`，前缀 `chengguo_v3_`；`records` 按 320 条/片分片（P0-1） | utils/db/storage.js |
| 本地存储限额 | 单 key 1MB / 总量 10MB（已按官方文档核实，分片即为绕开单 key 限制） | 微信官方文档 |
| 运行时依赖 | **零第三方依赖**（图标为预渲染 PNG，拼音为内置表） | 代码确认 |

## 3. 架构决策记录（ADR）

### ADR-001 采用模块化单体，不上微服务
- **场景**：单人/小团队开发，机构数量与用户量均为个位数到几十量级，日增记录数百条。
- **决策**：保持单一小程序 + 单一本地存储，按业务能力划分模块边界，不做服务拆分。
- **理由**：微服务采用门槛为"团队≥10人 + 边界稳定 + 运维到位"三条同时满足，本项目一条不满足。过早拆分只会让运维复杂度压垮单人开发。
- **代价**：模块边界靠自律维持，需通过目录结构与依赖方向约束防止腐化。
- **状态**：已接受

### ADR-002 数据读写单点收口到 `utils/db`
- **场景**：早期页面直接操作一个大 JSON（`chengguo_v2`），改字段不落盘、越权无拦截、无法上云。
- **决策**：全站唯一数据出口 `utils/db/index.js`；只有 `utils/db/storage.js` 允许接触 `wx.*Storage`。
- **理由**：换云端时只需替换 storage 适配器，页面与仓储代码零改动。
- **代价**：仓储层成为热点文件（当前 952 行），需继续拆分。
- **状态**：已接受（拆分计划见 §7 P1）

### ADR-003 权限属于「人 × 机构」，不属于人
- **场景**：老师可在多机构兼职、家长可在多机构有孩子，单人单角色的模型表达不了。
- **决策**：拆 `users`（账号本身）与 `members`（某人在某机构的角色与数据范围），新增 `orgs`。
- **理由**：`member` 上云后即服务端授权表，结构与云端一致。
- **代价**：身份判定需 join 两张表；页面需用 `userCurrent()` 拿合成身份。
- **状态**：已接受

### ADR-004 权限判定 fail-closed
- **场景**：旧逻辑"老师没分班 = 看到全部"，配漏一个参数即等于全开。
- **决策**：未显式授权一律拒绝；升级时把"隐式全放行"展开为"显式分配全部班级"，行为不变但规则变白名单。
- **代价**：新建老师必须先分班才能看到数据（已在表单强校验）。
- **状态**：已接受

### ADR-005 存储前缀固定，版本号只存在 meta
- **场景**：每次升版本若换 storage key，老师手机上的历史数据直接读不到。
- **决策**：前缀恒为 `chengguo_v3_`，`meta.version` 负责版本判断，升级走 `migrate.upgrade()` 就地加字段。
- **代价**：`v3` 前缀名与当前 `VERSION=4` 不一致，属历史命名遗留，不可再改（改了即数据丢失）。
- **状态**：已接受

### ADR-006 软删除 + 审计字段全覆盖
- **场景**：多端同步时硬删除会被其它端的历史数据"复活"。
- **决策**：所有实体强制携带 `orgId / createdAt / updatedAt / removed`。
- **状态**：已接受（⚠️ 但当前同步协议未使用墓碑，见 CR-011）

### ADR-007 迁移只做加法
- **场景**：`migrate.build()` 曾有"版本不符即 buildFresh"的分支，升版本会清空全部学生与记录。
- **决策**：有 `meta` 即走 `upgrade()`，只加字段不重建集合。
- **状态**：已接受（已修复并在 `verify_perm.js` 中固化回归）

### ADR-008 权限规则做成纯函数，前后端共用
- **场景**：只靠客户端过滤等于没有权限；但认证未下来前无法部署服务端。
- **决策**：`utils/db/permissions.js` 零 IO 依赖、纯函数，上云后原样搬进云函数。
- **状态**：已接受（⚠️ 上云时必须执行，见 §7 P2）

### ADR-009（已落地）记录实体升级为业务活动，预留 type 字段但不实现多类型
- **场景**：未来要加考勤、作业、课时消耗、缴费等业务，若每类建一套表，schema 与权限会指数膨胀。
- **决策**：`record` 保持现有字段不变，仅增加保留字段 `type`（默认 `'achievement'`）；暂不实现多类型分发逻辑。
- **理由**：当前只有一种业务，此时做 payload 抽象属过度设计（A1）；但表结构一旦定型后再加 `type` 需要全量数据迁移，成本更高。折中：留字段不留逻辑。
- **落地（2026-11-01）**：`schema.js` 增加 `RECORD_TYPES = ['achievement']` 与 `normalizeRecord().type`；非法值归一到 `achievement`；`db.TYPES` 对外暴露清单。**编辑记录不会冲掉 `type`**（不传则沿用原值）。
- **代价**：等二种业务真正落地时，仍需一次 `domain/activities` 注册表改造。
- **状态**：已接受（P0 已实施；多类型分发逻辑留到 P1）

## 4. 模块清单与进度

| 模块 | 文件 | 状态 | 说明 |
|---|---|---|---|
| 存储适配 | `utils/db/storage.js` | 已完成 | 唯一接触 wx.storage；云端适配器未做 |
| 实体与校验 | `utils/db/schema.js` | 已完成 | 8 类实体白名单规范化 + 校验 |
| 内存态与落盘 | `utils/db/core.js` | 已完成 | 全集合水合；全量覆盖写（见 CR-006） |
| 版本迁移 | `utils/db/migrate.js` | 已完成 | v2→v4 两条路径，只做加法 |
| 权限 | `utils/db/permissions.js` | 已完成 | 角色×范围×动作，纯函数 |
| 仓储 API | `utils/db/index.js` | 进行中 | 952 行，需按实体拆分为 repo（P1） |
| 首页工作台 | `pages/index` | 已完成 | 统计、模糊搜索、最近成果 |
| 成果录入 | `pages/record` | 已完成 | 媒体采集、模板、五档评分 |
| 成果列表 | `pages/records` | 已完成 | 三段级联筛选、双按钮 |
| 学生主页 | `pages/student` | 已完成 | 最近详情 + 历史行内展开 |
| 班级详情 | `pages/cls` | 已完成 | 三状态色块、一键发送 |
| 班级/课程/学生管理 | `pages/mgr` | 已完成但过载 | 265 行，5 个分区挤一页（CR-012） |
| 模板管理 | `pages/tpls` | 已完成 | 机构统一维护，老师只读 |
| 家长端 | — | 未开始 | 目前复用老师端页面 + 权限降级 |
| 媒体持久化 | `utils/media.js` | **已完成（P0）** | 临时路径统一转存 USER_DATA_PATH；启动自愈存量记录 |
| 云端同步 | `utils/api.js` + `cloudfunctions/sync` | 半成品 | 旧 openid 模型，与新架构冲突（CR-005） |
| 自动化测试 | `tests/verify_*.js` | **已完成（P0，已入库）** | 236 项断言，8 个套件，`npm test` 一键跑完；`npm run lint` 另守约定 |

## 5. 接口约定

### 5.1 仓储 API（页面唯一允许的数据入口）

```js
const db = require('../../utils/db');
// 读：已按当前身份过滤，页面不要二次判断角色
db.classes.list() / .get(id) / .name(id)
db.classes.mode(id) / .countOfTerm(termId)     // 只回结论（是不是结转制 / 有几个班），不回实体
db.courses.list() / .of(clsId) / .get(id)
db.students.list() / .of(clsId) / .get(id) / .search(q) / .name(id)
db.records.list() / .ofStudent(sid) / .ofClass(cid) / .get(id) / .latest(sid)
db.enrollments.list() / .ofStudent(sid) / .ofClass(cid) / .of(clsId, sid)
db.members.list() / .get(id) / .current()
db.terms.list() / .activeList() / .planSettle(...) / .settle(payload)   // settle 是事务
db.orgs.current() / .list() / .get(id) / .checkName(name)               // 校验与写入同一份规则
// 写：返回 {ok, msg?, item?, rid?}，msg 可直接 toast；写失败不会谎报成功（SAVE_FAIL）
db.records.save(pick, send) / .markSent(ids) / .remove(id)
db.students.create/update/updateProfile/remove
// 健康度与常量
db.health()            // → { usage: {currentSize, limitSize, keys}, lastFail, readOnly, mode, counts }
db.mediaRefs()         // 媒体引用集合（清理孤儿文件用）
db.LIMITS / db.TAGS / db.TYPES
// 权限
db.auth.role() / .isParent() / .can(action, target) / .canSeeRecord(r)
```

**契约纪律**：页面禁止 `require('utils/db/core')`；禁止 `db.raw()` / `db.coll()` / `db.classes._all()`（三者都为测试与设备级维护保留，lint 已禁 `pages/` 出现）；页面也不许直接 `wx.setStorageSync`（lint 拦）。

### 5.2 存储适配器接口（云端化时实现同名方法即可）

```js
load()                          // → { meta, orgs, members, classes, courses, students, records, users, templates }
saveCollection(name, list)      // → boolean（分片集合会写成多片，任一片失败即 false）
saveMeta(meta)                  // → boolean
removeCollection(name)          // → boolean
kvUsage()                       // → 本地 key 用量（云端实现返回服务端配额）
```

### 5.3 权限动作表（`permissions.ACTIONS`）

| 动作 | 角色 | scoped | own |
|---|---|---|---|
| org.manage / member.manage | owner, admin | — | — |
| class.write / course.write / template.write | owner, admin | — | — |
| student.write | owner, admin, teacher | ✓ | — |
| record.create | owner, admin, teacher | ✓ | — |
| record.update / record.delete | owner, admin, teacher | ✓ | ✓ |
| record.send | owner, admin, teacher | ✓ | — |
| profile.write | 全部角色 | ✓ | — |

**扩展纪律**：新增动作必须同时登记 `roles`，`can()` 对未登记动作返回 `false`（fail-closed）。

## 6. 已知风险（架构体检结论，2026-11-01）

> 分级：🔴 阻塞（会导致数据丢失/错误/安全问题，必须优先修）／🟠 重要（设计缺陷或随规模恶化）／🟡 建议。
> 编号规则：CR-xxx，评审轮次核销制。

### 🔴 阻塞级

> **P0 已于 2026-11-01 全部修复**，修复方式见每行末尾「✅」。回归见 `tests/verify_p0.js`。

| 编号 | 位置 | 问题 | 影响 | 状态 |
|---|---|---|---|---|
| CR-001 | `pages/record/record.js:119,120,167` | 照片/视频/语音保存的是 `tempFilePath` 临时路径，未持久化 | 小程序退出后系统清理临时文件，历史记录媒体全部失效——这是本产品的核心资产 | ✅ 新增 `utils/media.js`，采集即转存 `USER_DATA_PATH/media/`；启动时 `repairMedia()` 自愈存量记录（源文件已丢失则保留原路径不清空） |
| CR-002 | `utils/db/index.js` 全部 `list()` + `schema.js:61 audit()` | 查询不过滤 `orgId`；`audit(raw, orgId, stamp)` 的 `orgId` 入参是死参数（实际用 `raw.orgId`）。**已实测：org2 的班级与学生出现在 org1 列表** | 机构模型形同虚设，多机构/上云共享库时数据直接串号 | ✅ `core.orgColl(name)` 作为读路径唯一入口（`orgs` 按 id、其余按 `orgId`）；写路径保持全量避免误删他机构数据；`orgs` 集合的 `orgId` 也改为真实归属 |
| CR-003 | `.github/workflows/deploy.yml` | `paths: ['橙果-小程序/**']` 与 `working-directory: 橙果-小程序` 指向不存在的目录（仓库根即小程序根） | 该流水线从未被触发过，自动上传是假象 | ✅ 改为 `paths-ignore`（排除 md/tests/.github）+ 删除全部 `working-directory` |
| CR-004 | `deploy.js:9` | `PROJECT_PATH = path.join(__dirname, '..')` 指向仓库上级目录 | 手动执行会把整个 `E:\新建文件夹` 打包上传 | ✅ 改为 `__dirname`；`ignores` 补 `tests/`、`.workbuddy/`、工程档案 |

### 🟠 重要

| 编号 | 位置 | 问题 | 影响 |
|---|---|---|---|
| CR-005 | `utils/api.js` + `cloudfunctions/sync/index.js` | 云端是「按 openid 隔离」旧模型，与本地「机构内共享 + member 授权」新模型冲突；`merge()` 只同步 records/profiles | 一旦开云，换设备后学生/班级/课程为空，记录变成指向不存在学生的孤儿数据 |
| CR-006 | `utils/db/storage.js` | 每次写操作序列化整个集合（全量覆盖写） | 单条录入写全部 records；数据到数千条时明显卡顿并可能触及 1MB key 限额 | ✅ `records` 按 320 条/片分片：老单 key 数据天然当第一片（无需迁移），每片最坏 243KB，离 1MB 有 4 倍余量；写失败会回滚并返回 `SAVE_FAIL`，见 6.7 |
| CR-007 | `utils/db/permissions.js:132-135` | `if (tid && tid !== actor.userId) return false` —— `tid` 为空时**放行** | 记录缺录入人时"只能改自己录的"规则失效（fail-open） | ✅ 改为 fail-closed：有目标且 `tid` 为空即拒绝；`abilities()` 用空 target 预判时不误伤 |
| CR-008 | `utils/db/records.js` | `cid` 取自入参且未校验是否属于该学生班级，`validate` 只查非 0 | 记录可挂在学生并不在的班级，污染班级统计与家长可见性 | ✅ 新建与编辑双向校验 `cid ∈ stu.clsIds`；编辑路径另补 `canSeeStudent` / `canSeeClass`（P1-1）；`enrollments` 消课改用 `enrollmentRawOf`，避免"看不到→又补一条 0 课时报名" |
| CR-009 | `utils/db/maintenance.js` | `init()` 无条件播种，`DEMO_VERSION` 升版即向真实数据追加 45 名演示学生 | 演示数据污染生产库，老师会看到不属于自己的学生 | ✅ 演示数据搬进独立存储命名空间（`chengguo_demo_*`），与真实库物理分离；启动时把老版本混进来的演示行请出去，见 6.6 |
| CR-010 | `.gitignore` 忽略 `.workbuddy/` | 103 项断言测试不在版本控制内 | 换机/协作即丢失质量网，CI 无法执行 | ✅ 迁到 `tests/` 入库，`npm test` 跑全部 236 项；图标脚本迁到 `tools/` |
| CR-011 | `utils/db/index.js:857 merge()` | 按 `updatedAt` 取新，无墓碑、无冲突记录、无幂等键 | 多端同时编辑必然静默丢数据 | 未修（P2） |
| CR-012 | `pages/mgr/mgr.js` | 单页 265 行承载机构/班级/课程/学生/成员 5 个分区 | 任何新业务（课表/考勤/收费）都会撑爆此页 | 未修（P1） |
| CR-013 | `app.js:onLaunch` | `db.init()` 无 try/catch | 迁移或水合抛错即整站白屏，且无恢复入口 | ✅ `init()` 内部兜底：失败降级为**只读 + 空库**，磁盘数据原样保留；`app.js` 弹窗告知，`db.status()` 可查 |
| CR-014 | `utils/db/schema.js:104 normalizeRecord` | 实体为固定字段，无业务类型扩展位 | 加考勤/作业/缴费需改表结构 + 权限 + 全部页面（ADR-009 提出预留 `type`） | ✅ 已加 `type`（默认 `achievement`），见 ADR-009 |

### 🟡 建议

| 编号 | 位置 | 问题 | 影响 | 处理 |
|---|---|---|---|---|
| CR-015 | `utils/demo-data.js` | 2367 行（占全项目 35%）打包进主包，演示数据与产品代码混居 | 主包清洁度；体积只 48KB，不是体积问题 | 未修（P1，建议分包或按需构建） |
| CR-016 | `server/server.js` | 45 行 Express 单租户原型：整个 db.json 对任何请求方开放、`/api/login` 直接发随机 id | 放在仓库根目录会被当成"已有后端"，上云即数据裸奔 | ✅ 重写：Bearer 鉴权、按 openid 分文件、原子写（tmp+rename）、`jscode2session`（未配 APPID/SECRET 返回 503 而非伪造登录）、上传限扩展名与 50MB |
| CR-017 | `utils/db/index.js` | 曾向页面暴露 `raw()` / `coll()`，是绕过权限的后门接口 | 页面能拿走未经权限过滤的实体 | 部分修：页面现已不再使用（lint 禁 `pages/` 出现 `db.raw(` / `db.coll(` / `._all(`），但两个方法仍留在门面上给 `tests/` 与设备级维护用——真要摘掉需要先给测试一条独立的测试入口 |
| CR-018 | `utils/db/records.js` | `recordOfStudent` 在 `recordList()` 已过滤后再次过滤，冗余 | —— | 保留：第二个闸门是刻意的 defense-in-depth，成本可忽略（fail-closed 优于"省一次 filter"） |

### 做得好的地方（重构时必须保住）

1. 数据层单点收口，页面零 `wx.*Storage` 调用 —— 这是能上云的前提。
2. 权限为纯函数、单点定义、fail-closed —— 可原样搬到服务端，前后端一套规则。
3. 权限从 `user` 拆到 `member` —— 模型层次正确，无需返工。
4. 软删除 + 审计字段全覆盖。
5. `schema` 白名单规范化，脏数据不抛错（`str/num/list` 容错）。
6. 迁移"只做加法"铁律，已修复清空数据地雷并有回归固化。
7. 236 项断言覆盖到页面级真实模块加载，不是只测数据层（`npm test`，已入库）；另有 `npm run lint` 守住"页面绕开数据层"这类约定漂移。

## 6.5 P0 修复记录（2026-11-01）

| 项 | 改动文件 | 关键决定 |
|---|---|---|
| 媒体持久化 | `utils/media.js`（新增）、`pages/record`、`pages/mgr`、`pages/record/record.js` | 采集瞬间就转存，不等到保存——用户可能中途杀掉小程序；转存失败保留原路径，不让整条记录保存失败 |
| 存量媒体自愈 | `utils/db/index.js repairMedia()` | 源文件已丢失时**保留原路径而非清空**，清空等于主动删用户照片 |
| 多机构隔离 | `utils/db/core.js orgColl()`、`utils/db/index.js` | 读走机构视图、写走全量：如果写也走视图，`setColl` 会把他机构数据一起抹掉 |
| tid fail-closed | `utils/db/permissions.js` | 用 `hasOwnProperty('tid')` 区分"无目标预判"与"有目标且 tid 为空"，前者不拦，后者拒绝 |
| 降级只读 | `utils/db/core.js setReadOnly()`、`app.js` | 启动失败时内存放空库但**禁止任何落盘**，否则一次读失败就永久覆盖真实数据 |
| CI | `.github/workflows/deploy.yml`、`deploy.js` | 用 `paths-ignore` 替代 `paths`，避免再写错目录前缀 |
| 测试入库 | `tests/`（新增）、`tools/gen_icons.py` | 测试与图标脚本都属于资产，`.workbuddy/` 只留临时产物 |
| record.type | `utils/db/schema.js` | 白名单归一，非法值不报错只归位（避免旧数据被拒） |

## 6.6 演示数据隔离（2026-11-03）

| 项 | 改动文件 | 关键决定 |
|---|---|---|
| 物理分离 | `utils/db/storage.js` | 新增第二套命名空间 `chengguo_demo_*`（与真实库 `chengguo_v3_*` 同构）。**不用"同表加 demo 标记"**：标记法的隔离靠每处查询都记得 `!demo`，新增统计/筛选/导出一漏就混；换一套 key 是结构性的，演示数据怎么重播都碰不到真实数据 |
| 两套内存态 | `utils/db/core.js` | `realState` / `demoState` 各自持有独立数组，`setMode()` 只换指针不搬数据；`persist()` 在演示态直接返回（演示改动只留在内存，重启即复原） |
| 演示包自足 | `utils/db/maintenance.js buildDemoData()` | 用 `migrate.buildFresh()` 的骨架 + `demo-data.js` 的学生/记录拼出**完整的一套世界**（机构/学期/班级/课程/成员/模板都有），否则权限层看不到东西 |
| 模式由用户点 | `resolveMode()` | 优先级：`meta.sandbox` 显式选择 > 本次启动刚清掉演示数据 > 真实机构。**不按"库是空的"猜**——老师刚清空学生准备重录时被弹回样板间会以为库坏了 |
| 演示态只读 | `utils/db/ctx.js deny()` | 闸门最前面一条：演示模式下所有写返回"演示数据只读，点「开始使用」后再录入"。顺带暴露了 `recordSave` 绕过闸门直接 `perms.can` 的历史写法，已一并收口 |
| 老数据清理 | `purgeSeed()` | 老版本把演示行混在真实库里（靠 `demo` 标记区分），启动时一次性清出；挂在演示学生上的记录一并清（学生都没了，留着就是无主记录） |
| 公开 API | `db.demo.{active,available,enter,exit,reset}` | 页面只管开关与显示，不知道底层是两套 key。`reset()` 重建演示包，真实数据一字不动 |
| 回归 | `tests/verify_demo.js`（新增 18 项） | 磁盘级验证：真实 key 里零演示行、演示态零落盘、重启/重置/升版后真实数据一字不差 |

## 6.7 代码审查整改（2026-11-03）

审查报告见 `docs/code-review-report-2026-11-03.md`（含逐条状态与验证方式）。**除 P0-3 由项目方决定暂缓外全部落地**。

| 项 | 结论 | 落点 |
|---|---|---|
| P0-1 记录触顶 1MB 静默丢数据 | ✅ | `storage.js` 分片 + `core.persist` 返回值检查 + `ctx.pushSaved/applyEdit` 写后即落盘即回滚 + `SAVE_FAIL` 文案 |
| P0-2 媒体裂图且无清理 | ✅ | `media.persist` 失败返回空串 + `lostCount()`；`scan/prune`（2 小时豁免）+ `db.mediaRefs()` + 「我的 · 存储空间」页 |
| P0-3 CI 无测试门禁 | ⏸ 暂缓 | 备案未下来只发体验版；**提审前必须补**（`npm test` 步骤 + concurrency + 体积检查） |
| P1-1/P1-2 写闸门与 cid 归属 | ✅ | 编辑路径补 `canSeeStudent/canSeeClass`；`cid ∈ stu.clsIds` 双向校验 |
| P1-3 报名读路径 | ✅ | `canSeeEnrollment` + `enrollmentRaw/rawOf` 内部版本 |
| P1-4 页面用 `_all()` | ✅ | 数据层给 `classes.mode/countOfTerm`；lint 禁 `pages/` 出现 `._all(` |
| P1-5 结转非原子 | ✅ | 新增 `utils/db/settle.js`（L6），15 处写进 `core.tx` |
| P1-6 保存零防重 | ✅ | `_saving` 同步锁 + `saving` 态 + 按钮 busy |
| P1-7 服务端/云函数鉴权 | ✅ | server 重写（token/分文件/原子写/jscode2session/上传白名单）；云函数确定性 `_id` + `doc().set()` + 分页 + 字段白名单 |
| P1-8 主包体积 | ✅ 缓解 | `packOptions.ignore` 排除测试/文档/服务端/工具；实测 **0.85MB / 2MB** |
| P1-9 合规 | ◐ 部分 | 隐私弹窗补「监护人同意」段落；`msgSecCheck` 待云环境与审核类目确定 |
| P2-1 ~ P2-9 | ✅ | 音频上下文复用、自愈不伪造 `tid`（三级降级）、规范化按 `meta.normStamp` 触发、筛选按 id、申请页共用 `orgs.checkName`、正式版不覆盖剪贴板、资料限长（字段级 + 整包 2KB）、自建 lint、失败路径断言 |
| P3-1 ~ P3-5 | ✅ | 注释指向 `COLLECTIONS`、删 `fileToText`、`memberNameOf`、`LIMITS` 单份、AppID 走 `MP_APPID` |

新增文件：`utils/db/settle.js`、`pages/storage/storage.*`、`tools/lint.js`、`.editorconfig`、`tests/verify_hardening.js`。
断言：209 → **236**（新增加固套件 27 项）；`npm run lint` 82 文件 0 提醒；`npm run check` = lint + test。

**同步修改的工程约束**（`tests/verify_arch.js`）：`classes` 的方法表加 `mode` / `countOfTerm`，`orgs` 加 `checkName`，`terms` 加 `settle`。

---

## 7. 待办

### P0 止血（不动架构，先让数据不丢）—— **2026-11-01 完成**
- [x] CR-001 媒体持久化：新增 `utils/media.js`，采集即转存 `USER_DATA_PATH/media/`；启动 `repairMedia()` 自愈存量
- [x] CR-002 全实体列表加 `orgId` 过滤：新增 `core.orgColl()`，读路径全收口（写路径保持全量，避免误删他机构数据）
- [x] CR-003 / CR-004 修正 CI 路径与 `PROJECT_PATH`
- [x] CR-007 修 `tid` fail-open
- [x] CR-010 测试迁入 `tests/`，`npm test` 跑 236 项
- [x] CR-013 启动包兜底 + 降级为只读（**绝不落盘覆盖**，避免读失败变成永久丢失）
- [x] ADR-009 `record.type` 预留（默认 `achievement`）
- [x] CR-008 校验 `cid ∈ student.clsIds`（2026-11-03 完成，编辑路径另补 sid/cid 二次过闸门）
- [x] CR-009 演示数据隔离：独立存储命名空间 + `db.demo` 开关 + 演示态只读（2026-11-03，见 6.6）
- [x] CR-006 记录分片 + 落盘失败可见（2026-11-03，见 6.7）

### P1 划边界（改结构不改功能）
- [x] 拆 `utils/db/index.js`（已成门面 ≤260 行，实现按领域拆到同目录 `classes/courses/students/records/…`，`verify_arch` 的 LAYER 表守着依赖方向）
- [ ] 引入 `domain/` 应用层，页面只调用例，不直接调 repo
- [ ] 拆 `pages/mgr` 为「我的」+「管理」两个页面
- [ ] 演示数据移出主包（`demo-data.js` 2367 行仍在主包内，考虑分包/在线拉取）
- [ ] `domain/activities` 注册表骨架（接住 `record.type`）
- [x] CR-008 / CR-009（2026-11-03）

### 上线前必办（微信备案下来之后，顺序即优先级）
- [ ] **P0-3 CI 测试门禁**：`deploy.yml` 在「安装依赖」后加 `run: npm test`，加 `concurrency: { group: deploy, cancel-in-progress: true }`，加主包体积检查
- [ ] **P1-9 内容安全**：接 `msgSecCheck` / `imgSecCheck`（记录文字与照片会发给家长，属 UGC）
- [ ] 隐私保护指引在公众平台发布（弹窗已按指引授权流程实现，缺的是"指引本身已发布"）
- [ ] 主包体积在开发者工具里复核一次（本仓库按字节实测 0.85MB，工具显示的可能是未压缩值）

### P2 上云（微信认证后）
- [ ] 实现 `infra/storage/cloud.js`，保持 `load/saveCollection/saveMeta` 接口
- [ ] 媒体上云 → 存 fileID
- [ ] 同步协议：幂等键 + 墓碑 + 冲突记录 + 重试队列
- [ ] 服务端复用 `permissions.js` 做二次校验（**只靠客户端过滤等于没有权限**）
- [ ] 云函数按 `orgId` + `memberId` 收敛数据边界，废弃 openid 隔离模型

### 明确「现在不要做」
- ❌ 微服务拆分（团队规模不满足）
- ❌ 分库分表（数据量级远未到）
- ❌ 引入 MQ / Redis（无异步与缓存诉求）
- ❌ 多机构 SaaS 后台（先把单机构跑通）
- ❌ `record.payload` 通用化抽象（只有一种业务时属过度设计）
