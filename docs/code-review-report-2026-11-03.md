# 橙果小程序 · 代码审查报告

> 审查日期：2026-11-03
> 审查范围：全仓库（`pages/` 11 页、`utils/` 14 个模块 + `utils/db/` 13 个模块、`components/`、`cloudfunctions/`、`server/`、`tests/` 7 套、`deploy.js`、`.github/workflows/`）
> 规模：12,384 行 JS/WXML/WXSS；55 个 JS 文件
> 基线：`npm test` 全绿，209 项断言（数据层 27 / 权限 45 / 学期 30 / P0 27 / 页面级 53 / 演示隔离 18 / 架构守卫 9）
> 配套标准：`docs/code-review-standard.md`
> **本次审查未修改任何代码。**

---

## 一、总体结论

**这是一份明显高于同类小程序平均水平的代码库**，尤其在数据层：分领域拆分、依赖严格下行、权限单点定义、fail-closed、演示数据物理隔离、架构守卫把约定变成可执行断言、注释写"为什么"而不是"做了什么"。这些不是常见的自觉，是被人反复踩坑后总结出来的——README 和 `project-engineering-file.md` 里能对上每一条的来源。

所以这份报告不打算夸它，而是集中写**三个会真的伤人的地方**，和一批"现在没事、上云就出事"的地方。

三句话结论：

1. **一个月内会丢数据**（不是可能，是算术）。`records` 整表存一个 storage key，微信单 key 硬上限 1MB，按 45 名学生每天一条的体量约 1 个月触顶；触顶后 `setStorageSync` 抛错被吞掉，界面仍提示"已保存"，重启记录消失。
2. **权限闸门有一处缺口**："谁能做这件事"校验得很干净，"对哪个对象做"在编辑路径上漏了 `sid`/`cid` 归属校验。当前 UI 不可达（编辑时学生选择器只列本班），但这是构造请求就能越过的形状，上云后会变成真正的越权。
3. **上线门禁是空的**：`deploy.yml` 在 push 到 main 时直接上传版本，**不跑测试**。上面 209 项断言、9 项架构守卫全部只在人记得跑的时候才生效。

---

## 二、P0 · 阻断（修复前不建议发版）

### 🔴 P0-1 记录集合触顶 1MB 后静默丢数据

**位置**：`utils/db/storage.js:43-52`、`utils/db/core.js:84-90`、`utils/db/records.js:92,105`

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

### 🔴 P0-2 媒体目录触顶 200MB 后静默裂图，且没有清理入口

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

### 🔴 P0-3 部署流水线无测试门禁：push 即上传，测试红了照样发版

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

### 🟡 P1-1 记录编辑路径不校验新目标（写闸门只校验了"老对象"）

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

### 🟡 P1-2 `cid` 不校验是否属于该学生，会污染班级统计与课时账

**位置**：`utils/db/records.js:50`、`utils/db/enrollments.js:73-88`

**现象**：`cid` 取自 `p.cls`，只做"老师能不能看这个班"的校验，不校验"这个学生在不在这个班"。后果有三层：

1. 班级统计（`records.ofClass`、班级详情页的今日三状态）会出现不属于该班学生的记录；
2. 结转制班级 `consumeHours(rec)` 会按 `rec.cid` 找报名 —— 找不到就**自动补一条 `totalHours:0, usedHours:1` 的报名**。等于凭空生成一条负课时记录，账上多一个"欠 1 节课"的孩子；
3. 家长端按 `sid` 可见，会看到一条"班级名对不上"的记录。

**建议**：`recordSave` 里加一条 —— `if (stu.clsIds.indexOf(cid) < 0) return { ok:false, msg:'该学生不在这个班' }`。一行代码，把三层问题一起消掉。

**验证**：跨班组合的断言（学生属于 A 班，`cid` 传 B 班 → 拒绝）。

---

### 🟡 P1-3 `enrollments` 读路径完全不过权限（与"读也过滤"的承诺不一致）

**位置**：`utils/db/enrollments.js:10-27`

`enrollmentList()` 直接 `return oc('enrollments')`，`enrollmentsOfStudent(sid)` 不做任何身份判定。而 `utils/db/index.js` 开头明确写着"**列表查询默认已按当前身份过滤**……页面不要再自己写判断"。

**为什么**：现在页面只用自己的 `sid` 调它（首页家长端、学生页），所以是"未暴露"而不是"安全"。一旦有人加一个"课时总览"或"导出"，就会直接把全机构的课时数据摊开。这类"承诺与实现不一致"比明显的漏洞更危险——**后来的人会相信注释**。

**建议**：`enrollmentsOfStudent` 加 `canSeeStudent`；`enrollmentsOfClass` 加 `canSeeClass`；`enrollmentList` 按可见学生过滤（家长=自己孩子，老师=自己班的学生）。和 `records` 保持同一套形状。

---

### 🟡 P1-4 页面在用 `_all()` 这类标注"页面不要用"的内部接口

**位置**：`pages/index/index.js:118`、`pages/student/student.js:91`、`pages/terms/terms.js:31`

`db.classes._all()` 在门面里的注释是"不过滤权限，但仍限当前机构（**内部/调试用，页面不要用**）"。三处页面把它当"兜底查询"用了：

```js
const c = db.classes.get(en.clsId) || db.classes._all().find(x => x.id === en.clsId);
```

这个兜底正好绕过了权限：`get()` 返回 null 时（班级不可见），`_all()` 会把它找出来——于是家长能看到"孩子报了哪个班"之外的班级名，老师能看到不归自己管的班名。

**建议**：给门面加一个明确语义的内部方法（如 `classes.nameOf(id)`，只返回名字、不返回实体、且不暴露其他字段），页面改用它。同时把 `_all` 从对外 API 面里去掉，只在 `tests/` 里可见。

---

### 🟡 P1-5 结转向导非原子：15 处写操作，中途失败留下半结转的学期

**位置**：`pages/terms/terms.js:170-215`

一次"结转"要：建新班 → 复制课程 → 把学生加进新班 → 建新报名 → 把旧报名标 `carried`/`churned` → 归档旧学期。每一步都是独立的 `db.*` 调用，各自 `persist` 一次；**中间任何一步失败（存储满、权限变了、用户切后台被杀）都会停在一个"新旧都在、账目错位"的状态**，而且没有回滚，也没有"继续上次结转"的入口。

而且这些写操作都是**在页面里编排业务事务**，数据层没有事务边界——这是分层的一个真实缺口：`terms.planSettle` 只做了"算方案"，落库动作散在 UI 层。

**为什么是 P1 而不是 P0**：结转是低频操作（一学期一次），且失败后"看得见"（新班半成品、人数对不上）。但它动的是**钱**（课时）和**班级归属**，一旦错位，家长那边的"剩余课时"就是错的。

**建议**：
1. 把这段编排下沉到 `utils/db/terms.js` 的 `settle(payload)`，让数据层拥有事务边界；
2. 加一个"结转批次 id"，每步写 `batchId`，失败后可识别半成品并一键重做/清理；
3. 最简版本：先做"预检"（把要写的全部算出来、校验完，再开始写），把失败窗口从 15 个压缩到 1 个。

---

### 🟡 P1-6 保存类操作零防重：连点两次就是两条记录、扣两次课时

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

### 🟡 P1-7 `server/` 与云函数存在鉴权缺口（上云前必须处理）

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

### 🟡 P1-8 主包 1.7MB / 上限 2MB，资产占 823KB

**位置**：`assets/icons`（711KB，57 项）、`assets/tabbar`（112KB）

三套主题各自一套图标，是体积的主要增长源（每加一套主题约 +230KB）。当前余量约 300KB，**再加一套主题就危险**。

顺带纠正一个假设：`utils/demo-data.js` 有 2367 行，但只有 **48KB**——它不是体积问题（是"演示数据要不要在包里"的清洁问题），分包也省不出多少空间。

**建议**：
- 图标改 `iconfont` 或统一用 `image` 的 `webp`（`assets/icons` 里如为 PNG，转 webp 通常省 40-60%）；
- 主题图标改为"运行时着色"（同一套单色 PNG + `wxss` 无解，但可以只保留一套 + 用 `filter`/`mask` 不现实）——务实做法是：**保留两套，第三套待定**；
- CI 里加体积检查（P0-3 第三步）。

---

### 🟡 P1-9 合规：UGC 内容安全缺失、未成年人信息无监护人同意流程

**位置**：全站（`grep -rn "msgSecCheck\|imgSecCheck"` 零结果）

- 记录里的文字与照片会**发给家长**（对外传播），属于 UGC。小程序审核对含 UGC 的教育类目通常要求接入 `msgSecCheck`（文本）/ `imgSecCheck`（图片），现在的代码完全没有。
- 采集的是**儿童姓名、照片、家长手机号/微信**。隐私弹窗组件（`components/privacy`）做得挺细（连"指引未发布导致同意按钮无反应"这种坑都处理了），但缺"监护人同意"的表述与流程。
- `apply` 页收集联系人手机号，`utils/apply.js` 明文存本地（沙箱内，可接受，但上云后要走服务端且不落明文日志）。

**建议**：这几条不是代码质量问题，是**发版门槛**。上线前单独过一遍标准里的 E 组清单。

---

## 四、P2 · 建议

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

## 五、P3 · nit（不必单独修，顺手即可）

- `utils/db/storage.js` 文件头把集合列表写了一遍（`_orgs/_members/_classes/...`），漏了 `terms`/`enrollments`/`orgs`，与 `COLLECTIONS` 已经不同步——**注释里的清单是最容易腐烂的东西**，建议只指向 `COLLECTIONS`。
- `utils/stt.js:fileToText` 是个永远 reject 的死函数（注释已说明），可以删掉，减少误用。
- `pages/mgr/mgr.js:51-54` `userNameOf` 的命名暗示它拿 user，实际取的是 member 的名字（`db.members.get`），容易误导后来者去改 `users`。
- `pages/record/record.js:9-11` 的 `MAX_FILE/MAX_PHOTOS/MAX_VIDEOS` 与 `schema.validate('record')` 里的 9/3 重复定义，改一处必忘另一处。
- `deploy.js:11` `APPID = 'wx_your_appid'` 与 `project.config.json` 里的真实 appid 不一致，靠 CI 注入覆盖——本地跑 `node deploy.js` 会直接退出，容易让人误判"CI 坏了"。

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

## 七、修复顺序建议

| 时间 | 做什么 | 为什么这个顺序 |
|---|---|---|
| **本周** | P0-3（CI 加 `npm test`，5 分钟）→ P1-6（保存防重，3 行）→ P1-2（`cid ∈ stu.clsIds`，1 行） | 前两个是"最短时间内把风险降最多"，第三个是"一行消掉三层问题" |
| **两周内** | P0-1（persist 失败向上传 + 容量预警）→ P0-2（媒体失败返回空 + usage 露出）→ P1-1（编辑路径校验目标） | 前两个直接对应"数据会不会丢"，第三个是闸门缺口。三件都在数据层，可以一次改完一起跑回归 |
| **上云前** | P1-3、P1-4（读路径与内部接口）→ P1-7（云函数 owner 校验 / 删掉 server 原型）→ P1-5（结转下沉 + 批次 id）→ P1-9（内容安全 + 监护人同意） | 这四项的共同点是"本地阶段不出事，上云立刻出事"，不能靠"以后再说" |
| **持续** | P1-8、P2-*、P3 | 排期修，不影响发版 |

---

## 八、给下一个审查者的三条提醒

1. **先跑 `npm test`，再读代码**。209 项绿了才有资格讨论风格；红了先看是不是自己环境问题（`tests/fixture.js` 的 `richSeed` 是必需的）。
2. **改 `utils/db/` 的任何文件，都当成改地基**。这五个文件（`schema/core/storage/permissions/migrate`）是 LAYER 表的 level 0，动它们要连带看 `verify_arch` + `verify_db` + `verify_perm` 三套。
3. **别相信注释里的清单，只相信 `COLLECTIONS` / `ACTIONS` / `LAYER` 这三张表**。注释会腐烂，表会被断言检查。
