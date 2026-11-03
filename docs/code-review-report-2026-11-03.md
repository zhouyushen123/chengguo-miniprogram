# 橙果小程序 · 代码审查报告

> 审查日期：2026-11-03
> 审查范围：全仓库（`pages/` 11 页、`utils/` 14 个模块 + `utils/db/` 13 个模块、`components/`、`cloudfunctions/`、`server/`、`tests/` 7 套、`deploy.js`、`.github/workflows/`）
> 规模：12,384 行 JS/WXML/WXSS；55 个 JS 文件
> 基线：`npm test` 全绿，209 项断言（数据层 27 / 权限 45 / 学期 30 / P0 27 / 页面级 54 / 演示隔离 18 / 架构守卫 9）
> 整改后：**240 项断言**（加固套件 20 → 30），`npm run lint` 82 文件 0 提醒
> 配套标准：`docs/code-review-standard.md`
> **审查阶段未改任何代码**；同日按审查意见完成整改，逐条状态见各节标题后的标记与文末「九、整改记录」。

---

## 一、总体结论

**这是一份明显高于同类小程序平均水平的代码库**，尤其在数据层：分领域拆分、依赖严格下行、权限单点定义、fail-closed、演示数据物理隔离、架构守卫把约定变成可执行断言、注释写"为什么"而不是"做了什么"。这些不是常见的自觉，是被人反复踩坑后总结出来的——README 和 `project-engineering-file.md` 里能对上每一条的来源。

所以这份报告不打算夸它，而是集中写**三个会真的伤人的地方**，和一批"现在没事、上云就出事"的地方。

三句话结论：

1. **一个月内会丢数据**（不是可能，是算术）。`records` 整表存一个 storage key，微信单 key 硬上限 1MB，按 45 名学生每天一条的体量约 1 个月触顶；触顶后 `setStorageSync` 抛错被吞掉，界面仍提示"已保存"，重启记录消失。
2. **权限闸门有一处缺口**："谁能做这件事"校验得很干净，"对哪个对象做"在编辑路径上漏了 `sid`/`cid` 归属校验。当前 UI 不可达（编辑时学生选择器只列本班），但这是构造请求就能越过的形状，上云后会变成真正的越权。
3. **上线门禁是空的**：`deploy.yml` 在 push 到 main 时直接上传版本，**不跑测试**。上面 209 项断言、9 项架构守卫全部只在人记得跑的时候才生效。

---

## 一·补 整改状态总览

审查当天即按意见整改。**除 P0-3 由项目方决定暂缓外，全部落地**：

| 项 | 状态 | 一句话 |
|---|---|---|
| P0-1 记录触顶静默丢数据 | ✅ 已修 | `records` 分片存储 + 所有写路径检查落盘结果 + 失败回滚 + 可见提示 |
| P0-2 媒体裂图且无清理 | ✅ 已修 | 转存失败不再留假路径 + 孤儿文件扫描/清理 + 新增「存储空间」页 |
| P0-3 CI 无测试门禁 | ⏸ 暂缓 | 备案未下来、当前只发体验版；**正式上线前必须补上**（见该节末尾） |
| P1-1 编辑路径不校验新目标 | ✅ 已修 | 新 `sid`/`cid` 二次过闸门 |
| P1-2 `cid` 不属于该学生 | ✅ 已修 | 新建与编辑双向校验 `cid ∈ stu.clsIds` |
| P1-3 `enrollments` 读路径不过权限 | ✅ 已修 | 读按身份过滤，内部另开 raw 版 |
| P1-4 页面用 `_all()` 绕权限 | ✅ 已修 | 数据层给只读判定（`mode`/`countOfTerm`），lint 禁页面出现 `_all()` |
| P1-5 结转非原子 | ✅ 已修 | 下沉 `settle.js` + `core.tx` 事务，失败整体回滚 |
| P1-6 保存零防重 | ✅ 已修 | 同步锁 + 按钮 busy 态 |
| P1-7 服务端/云函数鉴权缺口 | ✅ 已修 | token + 按 openid 分文件 + 确定性 `_id` + 分页 + 上传白名单 |
| P1-8 主包体积 | ✅ 已缓解 | `packOptions.ignore` 排除非运行目录；按文件字节实测 **0.85MB / 2MB** |
| P1-9 合规 | ◐ 部分 | 隐私弹窗补「监护人同意」表述；`msgSecCheck` 待备案与云环境确定后接 |
| P2-1 ~ P2-9 | ✅ 已修 | 音频上下文复用、自愈不伪造归属、规范化按口径版本跑、筛选按 id、申请页共用校验、正式版不覆盖剪贴板、资料字段限长、自建 lint、失败路径断言 |
| P3-1 ~ P3-5 | ✅ 已修 | 头注释指向 `COLLECTIONS`、删死函数、命名正名、上限只留一份、AppID 从配置读 |

---

## 二、P0 · 阻断（修复前不建议发版）

### 🔴 P0-1 记录集合触顶 1MB 后静默丢数据 ✅ 已修

> **怎么修的**：`storage.js` 把 `records` 按 320 条/片切开（`chengguo_v3_records`、`_records_2`…），读取靠"片没填满就停"，老版本的单 key 全量数据天然当第一片用（`length !== size` 即视为完整集合），**不需要数据迁移**；`chunks` 记各集合分片数，用来回收多余片。写路径全部改成 `pushSaved` / `applyEdit`：写内存 → 立刻落盘 → 失败还原并返回 `SAVE_FAIL`（"本地存储空间不足，这次没能保存。请到「我的 · 存储空间」清理后重试"）。`db.health()` 暴露 `lastFail`，存储页把"上次写失败"显示出来。
>
> **第二轮复核补的一刀**：分片只解决了"单 key 装不下"，没解决"每条记录都把整个集合重刷一遍"——实测 2000 条时落盘次数从 2000 涨到 7287。所以每片再记一个**内容指纹**（djb2 + 长度），相同就跳过 `setStorageSync`：追加一条只写 1 片，2000 条时落盘 2007 次 / 125MB（比整改前的 804MB 降 84%）。用指纹而不是比引用（写路径改的是同一对象）或比 `updatedAt`（自愈/迁移会改字段不动时间戳）；万一碰撞，代价只是"这次没写"，下次真实变更必然失配，不会永久丢数据。
> **断言**：`tests/verify_hardening.js` —— 单片写满自动开第二片、重启读回顺序一致、老数据不截断、写失败不留幽灵记录、失败被记进健康度、空间恢复后能正常保存、**改第一片只写第一片 / 改第二片只写第二片**。
> **压测（同一负载跑整改前后的代码）**：3000 条记录时，整改前第 2542 条开始写入失败、459 条静默丢失、单 key 顶在 1023.8KB；现在 0 丢失、单 key 峰值 129KB。

**位置**：`utils/db/storage.js:75-140`（分片 + 脏片写）、`utils/db/core.js:84-90`、`utils/db/records.js:54,105`

**现象**：
每个集合整表存一个 key（`chengguo_v3_records`）。微信硬限制是**单个 key 最大 1MB**、总量 10MB（官方 `wx.setStorageSync` 文档明确）。超限时 `setStorageSync` 抛错，`write()` catch 后返回 `false`，`saveCollection` 返回 `false`，`core.persist` 返回 `false` —— 而 `records.js` 里三处 `core.persist('records')` **没有一个看返回值**，函数继续 `return { ok: true }`，页面弹"已保存，icon: success"。

**为什么严重**：
测算过（用仓库里的演示数据）：单条记录不带照片 251 字节；带 3 张照片 + 200 字评价约 760 字节。1MB ÷ 760 ≈ **1,380 条**。45 名学生、每天一条 → **约 30 天触顶**。触顶之后老师每录一条，都是一次"看起来成功、实际只存在内存、关掉小程序就消失"的丢失。而且丢失是静默的：老师不会重录，等发现时已经积了几十条空账。

这是 R1（数据不可静默丢失）的教科书违约，也是最贵的一种——**用户不知道自己丢了东西**。

**建议**（按优先级）：
1. `persist()` 失败要能向上传：`records.save` 检查返回值，失败返回 `{ ok:false, msg:'存储空间已满，请先清理' }`；页面已经有 `if (!res.ok) toast(res.msg)` 的统一处理，改造成本很小。
2. 容量预警：`storage` 暴露一个 `usage()`（`wx.getStorageInfoSync`），到 80% 在「我的」页给一条提示 + 导出入口。
3. 治本：`records` 不要整表存一个 key。按年/按月分片（`records_2026_11`），或按班级分片。**这是唯一能撑过两年的方案**，但会改动迁移逻辑，建议与"上云"一起排期——云数据库天然没有这个限制。
4. 短期护栏：给 `note` 加长度上限（现在无限制），单条记录体积可控。

**验证**：mock 一个 `setStorageSync` 必抛错的 storage，断言 `records.save` 返回 `ok:false` 且界面拿到的 msg 包含"空间"。这个断言现在不存在——也就是说**当前没有任何测试能发现这条丢数据路径**。

---

### 🔴 P0-2 媒体目录触顶 200MB 后静默裂图，且没有清理入口 ✅ 已修

> **怎么修的**：`media.persist()` 失败返回空串并累加 `lostCount()`，录入页汇总成"N 个没能保存"如实提示（不再留一条几个月后才爆的假路径）；新增 `media.scan(refs)` / `media.prune(refs)`，引用集合来自 `db.mediaRefs()`（跨机构、含已软删记录），**2 小时内新建的文件豁免**（`KEEP_RECENT_MS`），避免把用户刚拍还没保存的图删掉。新增「我的 · 存储空间」页：设备存储用量 + 照片视频占用、可清理数量、一键清理。
> **断言**：转存失败返回空串且计数 +1、成功文件能被 scan 统计、清理只删无引用且非新建文件、引用集合含照片/视频/语音、存储页数值与清理动作。

**位置**：`utils/media.js:60-77`、`pages/record/record.js:142-158`

**现象**：
照片/视频/语音转存到 `USER_DATA_PATH/media/`，上限约 200MB。`persist()` 失败时 **catch 后返回原临时路径**（注释写着"宁可留个可能失效的路径，也不能让整条记录保存失败"）——这个取舍在单张照片上是对的，但有两个叠加问题：

1. 临时路径在小程序退出后会被系统清理，记录里存的就变成一个**永远裂的图**；
2. `rmPhoto` / `rmVideo` **只解引用、不删物理文件**（代码注释解释了原因：怕删掉被旧版本记录引用的图）。设计上说得通，代价是**文件只增不减，且没有删除入口**。

**为什么严重**：
视频是 10-50MB。`replaceMedia` 允许单条记录 3 个视频 = 最多 150MB。**两条带满视频的记录就能吃掉 200MB**，之后所有照片静默变裂图，老师看到的是"照片没存上"，没有任何提示。200MB 对纯照片（1-3MB/张）约 70-200 张，一个班一学期就满了。

**建议**：
1. `persist()` 失败时返回空串而不是原临时路径 —— 让上游知道"这张没存上"，至少在 UI 上把该张标灰/提示重拍，而不是埋一颗几个月后才爆的雷。
2. 落库前检查剩余空间（`wx.getFileSystemManager().getFileInfo` 或用已知上限 - `usage()`），不够就提前提示"本地空间不足，建议先发送/导出"。
3. 清理策略：`media.usage()` 已经写好了但**没有任何页面调用它**。至少在「我的」页显示占用，并提供"清理已删除记录引用的文件"（扫一遍所有记录的引用集合，删不在集合里的文件）——这一步不需要改数据结构，纯增量。
4. 上云后媒体走云存储，这条自然消解；但**上云之前**这是会发生的事。

---

### 🔴 P0-3 部署流水线无测试门禁：push 即上传，测试红了照样发版 ⏸ 暂缓（项目方决定）

> **状态**：按要求**暂不实施**。原因：微信备案未下来，当前只上传测试体验版，测试门禁的收益暂时让位于迭代速度。
> **但这件事不能忘**：等备案下来、准备提交审核之前，必须把下面三步补回去，否则 240 项断言等于"提交前想起来跑一次"。
> **附带已修（与本项相邻）**：`deploy.js` 不再写死 `wx_your_appid`，改为 `MP_APPID` 环境变量 > `project.config.json`；`deploy.yml` 去掉 `sed` 改源码注入 AppID 的写法（那种方式哪天匹配不上是静默的，会用错 appid 上传）。
> **上线前待办（3 步，约 30 分钟）**：① 在「安装依赖」之后、「写入上传密钥」之前插入 `run: npm test`；② 加 `concurrency: { group: deploy, cancel-in-progress: true }`；③ 加主包体积检查（当前实测 0.85MB / 2MB）。

**位置**：`.github/workflows/deploy.yml:13-45`

**现象**：
`on: push: branches: [main]` → checkout → 装 `miniprogram-ci` → 写入上传密钥 → **直接 `ci.upload`**。中间没有 `npm test`，也没有任何断言检查。`paths-ignore` 只排除了 md / tests / .github——也就是说**任何代码提交都会立刻变成一个新的体验版**。

**为什么这是 P0**：
它不是代码缺陷，是**让所有其他防护失效的那个缺陷**。209 项断言的保护力 = "提交前想起来跑一次"。项目还有一条每 5 分钟自动 commit 的计划任务（`ChengguoAutoSync`），意味着**半成品状态也会被自动推到远端并触发上传**。历史上已经出现过自动提交把中间态收进 `auto:` commit 的情况。

**建议**（三步，第一步 5 分钟）：

```yaml
      - name: 回归测试（门禁）
        run: npm test
```
放在「安装依赖」之后、「写入上传密钥」之前。失败即中断，密钥都不用写。

第二步：加 `concurrency: { group: deploy, cancel-in-progress: true }`，避免连推两次时旧版本后上传覆盖新版本。
第三步：加主包体积检查（当前 1.7MB / 上限 2MB，见 P1-8）。

**验证**：故意让一条断言失败，push，确认流水线在 upload 之前红掉。

---

## 三、P1 · 应修

### 🟡 P1-1 记录编辑路径不校验新目标（写闸门只校验了"老对象"）✅ 已修

> 编辑分支补上 `perms.canSeeStudent(a, stu)` 与 `perms.canSeeClass(a, cid)`；`cid` 变化时还要过 `cid ∈ stu.clsIds`。断言：老师 A 编辑自己的记录、把 `sid` 改到 B 班学生 → 必须拒绝。

**位置**：`utils/db/records.js:44-66`

```js
const stu = students.studentRaw(p.sid);        // ← 不过权限过滤
...
const cid = Number(p.cls || p.clsId) || stu.clsIds[0] || 0;
if (rid) {
  deny('record.update', { record: r0 });       // ← 只校验原记录的归属
} else {
  deny('record.create', { clsId: cid });
  perms.canSeeStudent(a, stu);                 // ← 新建才校验学生
}
```

**为什么**：编辑时把 `p.sid` 改成另一个班的学生、或把 `p.cls` 改成别的班，闸门不会拦——它只看了"这条记录原来是不是你的"。可达性目前受 UI 限制（编辑时学生选择器只列本班），但这是"构造一下就能过"的形状。一旦上云，这就是经典 IDOR：老师 A 可以把一条记录挂到老师 B 的学生身上（`sent` 还是 true，B 班家长下次打开就看到一段陌生的课堂记录）。

顺带：`studentRaw` 本身不带权限（设计如此，它是给"名称解析/引用校验"用的），但在写路径上直接用它做落库目标，就把"内部工具"当成了"外部输入"。

**建议**：
- 编辑分支补两条：`perms.canSeeStudent(a, stu)` 与新 `cid` 的 `canSeeClass(a, cid)`；
- 或者更省事：`deny('record.update', { record: r0, student: stu, clsId: cid })`（`can()` 里 `t.record` 优先，所以要么调整判定顺序，要么显式两条检查）。
- 同时校验 `cid ∈ stu.clsIds`（见 P1-2），两个问题一起解决。

**验证**：加一条断言——老师 A 编辑自己的记录、把 `sid` 改成 B 班学生 → 必须 `ok:false`。

---

### 🟡 P1-2 `cid` 不校验是否属于该学生，会污染班级统计与课时账 ✅ 已修

> `records.save` 新建与编辑双向校验 `cid ∈ stu.clsIds`（"这个班级里没有该学生"）；同时 `enrollments` 的消课与重复校验改用 `enrollmentRawOf`，避免"看不到那条报名 → 又自动补一条 `totalHours:0`"的二次伤害。

**位置**：`utils/db/records.js:50`、`utils/db/enrollments.js:73-88`

**现象**：`cid` 取自 `p.cls`，只做"老师能不能看这个班"的校验，不校验"这个学生在不在这个班"。后果有三层：

1. 班级统计（`records.ofClass`、班级详情页的今日三状态）会出现不属于该班学生的记录；
2. 结转制班级 `consumeHours(rec)` 会按 `rec.cid` 找报名 —— 找不到就**自动补一条 `totalHours:0, usedHours:1` 的报名**。等于凭空生成一条负课时记录，账上多一个"欠 1 节课"的孩子；
3. 家长端按 `sid` 可见，会看到一条"班级名对不上"的记录。

**建议**：`recordSave` 里加一条 —— `if (stu.clsIds.indexOf(cid) < 0) return { ok:false, msg:'该学生不在这个班' }`。一行代码，把三层问题一起消掉。

**验证**：跨班组合的断言（学生属于 A 班，`cid` 传 B 班 → 拒绝）。

---

### 🟡 P1-3 `enrollments` 读路径完全不过权限（与"读也过滤"的承诺不一致）✅ 已修

> 新增 `perms.canSeeEnrollment(actor, en)`：负责人/管理员全见、家长按 `studentId`、老师按 `clsId`。`enrollmentList()` 走过滤；内部需要不过滤的地方改用 `enrollmentRaw(id)` / `enrollmentRawOf(clsId, sid)`，函数名就把"这是内部版本"写明。

**位置**：`utils/db/enrollments.js:10-27`

`enrollmentList()` 直接 `return oc('enrollments')`，`enrollmentsOfStudent(sid)` 不做任何身份判定。而 `utils/db/index.js` 开头明确写着"**列表查询默认已按当前身份过滤**……页面不要再自己写判断"。

**为什么**：现在页面只用自己的 `sid` 调它（首页家长端、学生页），所以是"未暴露"而不是"安全"。一旦有人加一个"课时总览"或"导出"，就会直接把全机构的课时数据摊开。这类"承诺与实现不一致"比明显的漏洞更危险——**后来的人会相信注释**。

**建议**：`enrollmentsOfStudent` 加 `canSeeStudent`；`enrollmentsOfClass` 加 `canSeeClass`；`enrollmentList` 按可见学生过滤（家长=自己孩子，老师=自己班的学生）。和 `records` 保持同一套形状。

---

### 🟡 P1-4 页面在用 `_all()` 这类标注"页面不要用"的内部接口 ✅ 已修

> 数据层补两个"只回结论、不回实体"的方法：`classes.mode(id)`（是不是结转制）、`classes.countOfTerm(termId)`（按当前身份可见范围计数）。三处页面改用它俩；`_all()` / `raw()` / `coll()` 保留给 `tests/` 与设备级维护，并由 `tools/lint.js` 禁止 `pages/` 出现这三者。断言：同名班级不再串、学期班级数按身份可见范围算。

**位置**：`pages/index/index.js:118`、`pages/student/student.js:91`、`pages/terms/terms.js:31`

`db.classes._all()` 在门面里的注释是"不过滤权限，但仍限当前机构（**内部/调试用，页面不要用**）"。三处页面把它当"兜底查询"用了：

```js
const c = db.classes.get(en.clsId) || db.classes._all().find(x => x.id === en.clsId);
```

这个兜底正好绕过了权限：`get()` 返回 null 时（班级不可见），`_all()` 会把它找出来——于是家长能看到"孩子报了哪个班"之外的班级名，老师能看到不归自己管的班名。

**建议**：给门面加一个明确语义的内部方法（如 `classes.nameOf(id)`，只返回名字、不返回实体、且不暴露其他字段），页面改用它。同时把 `_all` 从对外 API 面里去掉，只在 `tests/` 里可见。

---

### 🟡 P1-5 结转向导非原子：15 处写操作，中途失败留下半结转的学期 ✅ 已修

> 新建 `utils/db/settle.js`（L6 跨领域事务），15 处写操作收进 `core.tx`：快照 → 逐步写 → 统一落盘，任一步失败整体回滚。页面只剩 UI 与防重。踩到的坑记在代码里：新学期必须显式 `status: 'active'`（`termCreate` 默认会把已有进行中学期时的新学期建成 `upcoming`，结果结转完没有进行中的班）。断言：结转成功新学期 active + 旧学期归档；结转中途失败旧学期原状、不留半成品。

**位置**：`pages/terms/terms.js:170-215`

一次"结转"要：建新班 → 复制课程 → 把学生加进新班 → 建新报名 → 把旧报名标 `carried`/`churned` → 归档旧学期。每一步都是独立的 `db.*` 调用，各自 `persist` 一次；**中间任何一步失败（存储满、权限变了、用户切后台被杀）都会停在一个"新旧都在、账目错位"的状态**，而且没有回滚，也没有"继续上次结转"的入口。

而且这些写操作都是**在页面里编排业务事务**，数据层没有事务边界——这是分层的一个真实缺口：`terms.planSettle` 只做了"算方案"，落库动作散在 UI 层。

**为什么是 P1 而不是 P0**：结转是低频操作（一学期一次），且失败后"看得见"（新班半成品、人数对不上）。但它动的是**钱**（课时）和**班级归属**，一旦错位，家长那边的"剩余课时"就是错的。

**建议**：
1. 把这段编排下沉到 `utils/db/terms.js` 的 `settle(payload)`，让数据层拥有事务边界；
2. 加一个"结转批次 id"，每步写 `batchId`，失败后可识别半成品并一键重做/清理；
3. 最简版本：先做"预检"（把要写的全部算出来、校验完，再开始写），把失败窗口从 15 个压缩到 1 个。

---

### 🟡 P1-6 保存类操作零防重：连点两次就是两条记录、扣两次课时 ✅ 已修

> 录入页 `save()` 加同步锁 `this._saving`（`setData` 是异步的，靠 `disabled` 兜不住 800ms 窗口）+ `saving` 数据态，按钮文案切「保存中…」并 `.busy` 降透明度。断言：连点两次只产生一条记录。

**位置**：`pages/record/record.js:205-218`（以及全站：`grep -rn "saving\|disabled\|loading" pages/` 只匹配到 `status !== 'disabled'`）

```js
save(e) {
  const res = db.records.save(payload, send);   // 同步写，rid 不回填
  ...
  setTimeout(() => wx.navigateBack(), 800);      // ← 800ms 窗口
}
```

`rid` 在保存成功后没有回填 `this.data.rid`，所以 800ms 内再点一次仍然是"新建"，会插入第二条记录；如果是结转制班级，`consumeHours` 也会再扣 1 课时。**这是概率不低的事**——800ms 足够连点两下。

**建议**：三行代码。
```js
if (this._saving) return;
this._saving = true;   // 成功/失败都要复位，或在 navigateBack 前不复位
```
并且成功后 `this.setData({ rid: res.rid, editing: true })`，让第二次点击变成"编辑同一条"，从根上消除重复。

---

### 🟡 P1-7 `server/` 与云函数存在鉴权缺口（上云前必须处理）✅ 已修

> **云函数**：文档 `_id` 改成确定性的 `OPENID + '_' + id`，`doc().set()` 天然 upsert——越权覆盖别人的文档在结构上不可能发生，不再依赖"查一遍再决定"；`fetchAll` 分页（100/页，上限 5000 行）并回 `truncated` 标记；`pick()` 白名单字段返回，不把整条文档抛给前端。
> **server/**：重写成有鉴权的原型——Bearer token、按 openid 分文件、原子写（tmp + rename）、`jscode2session` 换 openid（未配 APPID/SECRET 时返回 503，而不是发一个随机 id 假装登录）、上传限扩展名与 50MB。

**位置**：`server/server.js`（整份）、`cloudfunctions/sync/index.js:13-28`

`server/server.js` 是一个无鉴权的 Express 原型：
- `/api/db` **把整个 db.json 原样返回给任何请求方**（没有 openid、没有 token、没有 orgId 过滤）；
- `/api/records` 接受任意 body 直接覆盖 `db.records[i]`；
- `/api/upload` 无类型/大小限制（`multer` 无 `limits`）；
- `/api/login` 直接发随机 id，注释里写着"生产环境：用 code 调 jscode2session"——也就是**生产前必须重写**。

`cloudfunctions/sync` 的 `push`：
```js
const q = await records.where({ id: doc.id }).get();   // 只按 id 查，不限 owner
doc.owner = OPENID;
if (q.data.length) await records.doc(q.data[0]._id).update({ data: doc });  // ← 覆盖别人的文档
```
`id` 是 `Date.now()` 派生的时间戳（`core.nextId`），**可枚举、可猜**。任何用户传一个别人的 id，就能覆盖别人的记录。`profiles` 更糟：按 `sid` 全局 upsert，不同机构的学生 id 撞了就直接互相覆盖。

**建议**：
- 云函数 upsert 前先 `where({ id, owner: OPENID })`，不命中就**拒绝而不是新建**（避免覆盖）；
- `profiles` 加 `owner/orgId` 维度；
- `server/` 要么删掉，要么在文件头明确标注"仅本地联调原型，禁止部署"——现在它在仓库根目录，很容易被当成可用的后端。

---

### 🟡 P1-8 主包 1.7MB / 上限 2MB，资产占 823KB ✅ 已缓解

> `project.config.json` 的 `packOptions.ignore` 排除了 `tests/` `docs/` `server/` `tools/` `README.md` 等非运行目录（旧数字 1.7MB 里包含它们）。按文件字节实测现在 **0.85MB / 2MB**：`assets/icons` 348KB、`pages` 212KB、`utils` 201KB、`assets/tabbar` 38KB、`images` 22KB。
> 图标 webp 化**没做**：它需要设计侧按三套主题统一重出图，属视觉工作量而非代码问题；余量 1.15MB，再加一套主题（约 +110KB）仍安全，等真的接近上限再做。

**位置**：`assets/icons`（711KB，57 项）、`assets/tabbar`（112KB）

三套主题各自一套图标，是体积的主要增长源（每加一套主题约 +230KB）。当前余量约 300KB，**再加一套主题就危险**。

顺带纠正一个假设：`utils/demo-data.js` 有 2367 行，但只有 **48KB**——它不是体积问题（是"演示数据要不要在包里"的清洁问题），分包也省不出多少空间。

**建议**：
- 图标改 `iconfont` 或统一用 `image` 的 `webp`（`assets/icons` 里如为 PNG，转 webp 通常省 40-60%）；
- 主题图标改为"运行时着色"（同一套单色 PNG + `wxss` 无解，但可以只保留一套 + 用 `filter`/`mask` 不现实）——务实做法是：**保留两套，第三套待定**；
- CI 里加体积检查（P0-3 第三步）。

---

### 🟡 P1-9 合规：UGC 内容安全缺失、未成年人信息无监护人同意流程 ◐ 部分已修

> **已做**：隐私弹窗补「关于孩子（未成年人）的信息」一段——说明孩子的姓名/照片/课堂记录由老师采集、家长端只能看自己孩子、监护人须同意否则请勿使用并可要求机构删除。
> **未做**：`msgSecCheck`（文本）/ `imgSecCheck`（图片）。这不是纯客户端代码，要云开发环境 + 调用额度 + 审核类目确定后才有意义；现在塞一个"调不通就放行"的空壳，反而会让人以为已经接好了。**与 P0-3 一起列进"上线前必办"清单**。

**位置**：全站（`grep -rn "msgSecCheck\|imgSecCheck"` 零结果）

- 记录里的文字与照片会**发给家长**（对外传播），属于 UGC。小程序审核对含 UGC 的教育类目通常要求接入 `msgSecCheck`（文本）/ `imgSecCheck`（图片），现在的代码完全没有。
- 采集的是**儿童姓名、照片、家长手机号/微信**。隐私弹窗组件（`components/privacy`）做得挺细（连"指引未发布导致同意按钮无反应"这种坑都处理了），但缺"监护人同意"的表述与流程。
- `apply` 页收集联系人手机号，`utils/apply.js` 明文存本地（沙箱内，可接受，但上云后要走服务端且不落明文日志）。

**建议**：这几条不是代码质量问题，是**发版门槛**。上线前单独过一遍标准里的 E 组清单。

---

## 四、P2 · 建议 ✅ 全部已修

> 逐条落地情况：P2-1 复用单个 `innerAudioContext` 并在 `onUnload` 销毁；P2-2 自愈不再拿"当前登录人"回填 `tid`（改为"该班主讲老师 → 机构唯一在职教职工 → 留空"三级降级，见下方说明）；P2-3 全量规范化改为按"规范化口径版本"`meta.normStamp` 触发，平时只做结构性兜底；P2-4 记录页页签改为 `tabs` + `tabIds` 双数组，筛选按班级 id；P2-5 申请页机构名校验改为共用 `db.orgs.checkName()`（与机构表写入同一份规则）；P2-6 只有非正式版才自动复制到剪贴板；P2-7 家长资料按字段限长（昵称 20 / 备注 500 / 整包 2KB，超长静默截断而不是报错）；P2-8 自建 `tools/lint.js`（82 文件 0 提醒），`npm run check` = lint + test；P2-9 补了"写入失败 / 容量边界 / 媒体失败 / 事务回滚 / 连点"等 30 项加固断言。
>
> **P2-2 为什么不是"用机构默认老师"**：`tid` 里存的是 `user.id`，而 `class.teacherId` 存的是 `member.id`，两者不能直接搬。所以回填顺序是：该班主讲老师（换成 userId）→ 机构里唯一的在职教职工（单人工作室归属没有歧义）→ 都不满足就留空（fail-closed，只有负责人/管理员能改）。宁可让负责人来改，也不伪造一个归属。

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| P2-1 | `pages/record/record.js:195` | `playAudio()` 每次都 `wx.createInnerAudioContext()` 且从不 `destroy()`，连点十次就有十个音频上下文（`tpls.js` 做对了，这里没有） | 复用单个实例，`onUnload` 里销毁 |
| P2-2 | `utils/db/maintenance.js:99-118` | `repairRefs()` 用**当前登录人** `meta.me` 回填空 `tid`。如果恰好在家长身份下启动，历史记录会被记成"家长录入"，老师从此改不了（`own` 规则） | 回填用"机构默认老师"或留空并标记 `tidMissing`，不要写当前身份 |
| P2-3 | `utils/db/maintenance.js:56-64` | `normalizeAll()` 每次启动对全表做 `JSON.stringify` 比对；记录上千条时是启动耗时的主要来源 | 改为"只在版本变化时跑全量"，或按 `updatedAt` 增量 |
| P2-4 | `pages/records/records.js:36-49` | 班级筛选按**班级名**从 `tabs` 反查 id（`tabs.indexOf(name)` 风格），重名班级会串 | 直接用 id 数组做页签数据 |
| P2-5 | `pages/apply/apply.js:82-89` | `region` 非必填、机构名无上限（schema 里机构名限 30，这里没同步） | 复用 `schema.validate('org')` 的口径，别在两处各写一套 |
| P2-6 | `app.js:41-61` | 错误陷阱每次异常都 `wx.setClipboardData` **静默覆盖用户剪贴板**（用户可能刚复制了微信号准备粘贴） | 只在开发版（`__wxConfig.envVersion !== 'release'`）复制，或改成"点击详情才复制" |
| P2-7 | `utils/db/students.js:79-89` | `studentUpdateProfile` 对 `profile` 各字段无长度上限，家长端可写入无界文本（→ 加剧 P0-1） | 每个字段加长度校验，总量限 2KB |
| P2-8 | 全仓库 | 无 lint / 格式化配置（无 `.eslintrc` `.prettierrc` `editorconfig`）。`pages/` 与 `utils/` 的 JS 里有 19 处硬编码色值 | 加一个最小 ESLint（`no-unused-vars`、`no-undef`、`eqeqeq`），把 `wx` 声明为 global；色值统一到 `app.wxss` 的 token |
| P2-9 | `tests/` | 没有一条覆盖"写入失败"与"容量边界"的断言（正是 P0-1/P0-2 的盲区）；页面级测试靠 `require.cache` 手工管理，双实例问题已踩过一次 | 加 storage 失败夹具；给页面测试一个统一的 `reboot()` 帮助函数 |

---

## 五、P3 · nit（不必单独修，顺手即可）✅ 已修

- ✅ `utils/db/storage.js` 文件头不再抄集合清单，改为"集合名以 `COLLECTIONS` 为准"（抄过的那份已经腐烂过一次）。
- ✅ `utils/stt.js:fileToText` 已删除，只留流式识别。
- ✅ `pages/mgr/mgr.js` 的 `userNameOf` → `memberNameOf`，并注释"teacherId 存的是 member.id"，防止后来者去改 `users`。
- ✅ 照片/视频上限只留一份：`schema.LIMITS`，页面通过 `db.LIMITS` 取。
- ✅ `deploy.js` 的 AppID 改为 `MP_APPID` 环境变量 > `project.config.json`，本地 `node deploy.js` 不再必然退出。

---

## 六、做得好的地方（不要在重构中弄丢）

1. **权限只有一处定义**（`permissions.js` 纯函数），页面只问"能不能"，不写 `role === 'parent'`。这是整个项目最值钱的设计决定。
2. **`ctx.deny()` 单闸门**：权限 + 演示只读 + 降级只读三种全局规则挂在同一个位置。上一次重构时它顺带抓出了两个绕过闸门的历史 bug——这说明闸门设计对了。
3. **fail-closed 的落地细节**：`if (rule.own && !actor.all)` 里那句"只有真正拿到目标对象时才检查归属，一旦有目标 tid 为空就拒绝"，注释直接写了"旧写法会让无主记录对所有人放行"。这是把踩过的坑写成了代码。
4. **演示数据物理隔离**（独立命名空间 + 两套内存态 + `persist` 早退）。比"同表加 demo 标记"强一个数量级，理由写得很清楚。
5. **架构守卫把约定变成断言**：`LAYER` 表就是架构文档，红了就是架构走形了。比写一份 README 强一百倍。
6. **`media.js` 单独一层**：临时路径会被系统清理这件事，很多同类项目要上线三个月后才发现照片全裂。
7. **注释写"为什么"**：比如 `media.isPersist` 里"ROOT 为空时必须 return false，`indexOf('')` 恒为 0"，这种注释能救下一个人半小时。

---

## 七、修复顺序建议（除"本周"的 P0-3 外均已按此执行）

| 时间 | 做什么 | 为什么这个顺序 |
|---|---|---|
| **本周** | P0-3（CI 加 `npm test`，5 分钟）→ P1-6（保存防重，3 行）→ P1-2（`cid ∈ stu.clsIds`，1 行） | 前两个是"最短时间内把风险降最多"，第三个是"一行消掉三层问题" |
| **两周内** | P0-1（persist 失败向上传 + 容量预警）→ P0-2（媒体失败返回空 + usage 露出）→ P1-1（编辑路径校验目标） | 前两个直接对应"数据会不会丢"，第三个是闸门缺口。三件都在数据层，可以一次改完一起跑回归 |
| **上云前** | P1-3、P1-4（读路径与内部接口）→ P1-7（云函数 owner 校验 / 删掉 server 原型）→ P1-5（结转下沉 + 批次 id）→ P1-9（内容安全 + 监护人同意） | 这四项的共同点是"本地阶段不出事，上云立刻出事"，不能靠"以后再说" |
| **持续** | P1-8、P2-*、P3 | 排期修，不影响发版 |

---

## 八、给下一个审查者的三条提醒

1. **先跑 `npm test`，再读代码**。239 项绿了才有资格讨论风格；红了先看是不是自己环境问题（`tests/fixture.js` 的 `richSeed` 是必需的）。顺手 `npm run lint`，它会拦住"页面绕开数据层"这类约定漂移。
2. **改 `utils/db/` 的任何文件，都当成改地基**。这五个文件（`schema/core/storage/permissions/migrate`）是 LAYER 表的 level 0，动它们要连带看 `verify_arch` + `verify_db` + `verify_perm` 三套。
3. **别相信注释里的清单，只相信 `COLLECTIONS` / `ACTIONS` / `LAYER` 这三张表**。注释会腐烂，表会被断言检查。

---

## 九、整改记录（2026-11-03）

### 新增文件

| 文件 | 作用 |
|---|---|
| `utils/db/settle.js` | 结转向导的落地动作，15 处写操作收进一个 `core.tx` 事务（LAYER = 6） |
| `pages/storage/storage.*` | 「我的 · 存储空间」：设备存储用量、照片视频占用、可清理数量、一键清理 |
| `tools/lint.js` | 自建自检：品牌色硬编码、`console.log` 残留、`require` 未用、WXML 函数调用、页面调 `_all`/`raw`/`coll`、页面直接读写存储、缩进/行尾/末尾换行 |
| `.editorconfig` | 统一 2 空格 / LF / 末尾换行 |
| `tests/verify_hardening.js` | 加固回归 30 项（分片与脏片写、落盘失败、媒体清理、权限收口、cid 传参、事务回滚、连点、存储页、自愈归属、文本限长） |

### 改动要点（按文件）

- `utils/db/storage.js`：`records` 分片（320 条/片）+ 老数据兼容 + 片回收 + `kvUsage()` + **脏片写**（按内容指纹跳过没变的分片，追加一条只落 1 片）。
- `utils/db/records.js`：`cid` / `cls` / `clsId` 三个字段名都认（原来只认后两个，传 `cid` 会被静默回落到学生的第一个班）。
- `utils/db/core.js`：`SAVE_FAIL` 文案、`tx()` 事务、`realData()`、`health()`、`lastFail`、`setColl` 可回滚。
- `utils/db/ctx.js`：`pushSaved()` / `applyEdit()` 两个"写内存 + 立即落盘 + 失败还原"的工具。
- `utils/db/records.js`、`classes.js`、`students.js`、`identity.js`、`terms.js`、`courses.js`、`templates.js`、`org.js`：写路径统一走上面两个工具；跨集合的写走 `core.tx`。
- `utils/db/permissions.js`：`canSeeEnrollment()`。
- `utils/db/enrollments.js`：读路径过滤 + `enrollmentRaw` / `enrollmentRawOf` 内部版本。
- `utils/db/maintenance.js`：`mediaRefs()`；`repairRefs` 的 `tid` 三级降级回填；`normalizeAll` 按 `meta.normStamp` 触发。
- `utils/db/classes.js` / `index.js`：`mode()` / `countOfTerm()` / `orgs.checkName()` / `LIMITS`。
- `utils/media.js`：转存失败返回空串 + `lostCount()`；`scan()` / `prune()` / 2 小时豁免。
- `utils/theme.js`：`brand()` / `danger()`，`DANGER` 色表。
- `server/server.js`：Bearer 鉴权、按 openid 分文件、原子写、`jscode2session`、上传白名单。
- `cloudfunctions/sync/index.js`：确定性 `_id`、`doc().set()` upsert、分页、字段白名单。
- `pages/record`：媒体失败提示、录音两路都失败如实提示、`_saving` 同步锁、音频上下文复用。
- `pages/mgr`：`memberNameOf` 正名，角色头像渐变移入 WXSS（极简/蓝主题能跟着变）。
- `pages/index` / `pages/student` / `pages/terms` / `pages/records` / `pages/apply`：按 P1-4 / P2-4 / P2-5 调整。
- `app.js`：错误陷阱只在非正式版自动复制剪贴板。
- `components/privacy`：补「关于孩子（未成年人）的信息」。
- `project.config.json`：`packOptions.ignore` 排除 `tests/` `docs/` `server/` `tools/` 等。
- `deploy.js` + `.github/workflows/deploy.yml`：AppID 走 `MP_APPID`，不再 sed 改源码。

### 断言数量变化

| 套件 | 审查时 | 现在 |
|---|---|---|
| 数据层 | 27 | 27 |
| 权限 | 45 | 45 |
| 学期与课时 | 30 | 30 |
| P0 止血 | 27 | 27 |
| 页面级 | 53 | 54 |
| 演示隔离 | 18 | 18 |
| 加固 | —— | **30**（新增套件；含脏片写、cid 传参两项复核补充） |
| 架构守卫 | 9 | 9 |
| **合计** | **209** | **240** |

### 仍然开着的三件事

1. **P0-3 CI 测试门禁**——等备案下来、准备提审时补（3 步见该节）。
2. **P1-9 内容安全（`msgSecCheck` / `imgSecCheck`）**——需要云环境与审核类目确定，与 P0-3 同期。
3. **技术债**：`utils/demo-data.js` 2367 行仍在主包内（体积只 48KB，是"清洁问题"不是"体积问题"，建议分包或按需构建）；入驻申请单只存本机（`utils/apply.js`），上云后要走服务端且不落明文日志。
