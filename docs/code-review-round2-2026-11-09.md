# 代码审查报告（第二轮 · 全系统）· 2026-11-09

> 审查对象：`chengguo-miniprogram`（v1147，提交 `8b20297`）
> 审查方式：静态检查基线 + 人工精读权限/同步/云函数/后台四条链路
> 本轮**未改任何代码**，只出结论与方案。

---

## 0. 基线事实

| 项目 | 结果 |
|---|---|
| `node tools/lint.js` | 145 个文件，**0 提醒** |
| `node tests/run.js` | **44 套件全绿** |
| 主包体积 | 1367.3 KB / 2048 KB（66.8%） |
| 工作区 | 干净，无未提交改动 |

**结论：工程纪律很好，问题不在代码质量，在权限边界。**

前两轮审查（AI 改造、限流收口）聚焦在「功能是否可用」，这一轮补上「别人拿这个功能能做什么」。**2 个 Critical、4 个 Major、9 个 Minor**，其中两个 Critical 同一个根因。

---

## 1. Critical

### C-1　pull 全量下发：家长手机里存着全机构孩子的个人信息

**位置**：`cloudfunctions/syncv2/index.js:761-820`（`action === 'pull'`）

**事实**：

```js
// 入口门禁（560 行）只校验"我有没有这家机构的工牌"
if (orgsOf(u).indexOf(orgId) < 0) return { ok: false, code: 'FORBIDDEN', ... };

// pull 的查询条件（770 行前后）——没有任何角色/范围条件
r = await db.collection(c).where({ orgId, srvAt: _.gt(since) })
  .orderBy('srvAt', 'asc').limit(PAGE).get();
```

`COLLS` 共 12 个集合（第 18 行），**全部无差别下发**给任何有该机构工牌的人，包括 `role: 'parent'` 的家长：

| 集合 | 家长实际拿到的内容 |
|---|---|
| `students` | 全机构孩子的姓名、家长姓名、微信号、家长手机号、所属班级、备注 |
| `members` | 全机构老师的姓名、手机号、微信号、**openid** |
| `records` | 全机构评语、分数、照片 `fileID`、视频 `fileID`（含未发布的草稿） |
| `enrollments` / `classes` / `courses` | 全部报名与排课信息 |

**根因**（推断，有依据）：权限过滤被实现在客户端。`utils/db/permissions.js` 算出的 `actorOf()` 只决定「屏幕上显示什么」，而数据在 pull 那一刻已经整包落到 `wx.setStorageSync`。`family` 云函数的顶部注释其实是作者自己写下的旁证：

> `// syncv2 的 records 是按 orgId 全量 pull 的，塞进去等于把别家孩子的留言同步到所有设备，家长还能伪造写入。`

说明这个缺陷是**已知但只在 family 里绕开了**，syncv2 本体没修。

**影响判断**：

- 现实利用需要「解包小程序 → 自建客户端 → 调 `syncv2.pull`」或「拿到用户手机」。**不是点两下就能中**，所以我不说它一定会立刻出事；
- 但云函数的调用协议是固定的、小程序代码可解包（官方机制），攻击成本属于「脚本几十分钟」级别；
- 数据性质是**未成年人及其家长的个人信息**（姓名 + 手机号 + 微信 + 照片）。按《个人信息保护法》，不满十四周岁未成年人的个人信息属**敏感个人信息**，超范围收集与存储的合规风险是实打实的；
- 一旦有家长投诉或平台抽查，这是「技术上无法自证已最小化」的局面。

**我的判断**：**在你只有几个班试点的阶段，风险确实低；但只要开始大规模铺家长端（哪怕只有一个学校），就必须先修这个。** 决定权给你，但按「宁可误报」原则，我建议排在 C-2 之后立刻做。

**正确方案**（完整，可照抄）

改 `pull` 的查询条件 + 处理「孩子的范围会变」带来的游标问题：

```js
if (action === 'pull') {
  const since = Number(event.since) || 0;
  const me = await memberOf(OPENID, orgId);
  const isParent = !!me && me.role === 'parent';
  // 家长可见的孩子；空数组 = 什么都不给（fail-closed，绝不退化成全量）
  const kidIds = isParent ? (me.studentIds || []).map(Number).filter(n => n > 0) : null;
  let kidCls = null;
  if (isParent) {
    if (!kidIds.length) return { ok: true, docs: [], cursor: since, more: false };
    // 班级名家长端要显示（"周六素描班"），但只给自家孩子所在的班
    const ks = await db.collection('students').where({ orgId, id: _.in(kidIds) })
      .limit(50).get().catch(() => ({ data: [] }));
    kidCls = [];
    (ks.data || []).forEach(s => (s.clsIds || []).forEach(c => {
      const n = Number(c); if (n && kidCls.indexOf(n) < 0) kidCls.push(n);
    }));
  }

  const docs = [];
  let cursor = since;
  let more = false;
  for (const c of COLLS) {
    // ---- 家长：按「自家孩子」逐集合收窄 ----
    const where = { orgId, srvAt: _.gt(since) };
    if (isParent) {
      if (c === 'students') { where.id = _.in(kidIds); }
      else if (c === 'records') { where.sid = _.in(kidIds); where.sent = true; } // 草稿不给
      else if (c === 'enrollments') { where.sid = _.in(kidIds); }
      else if (c === 'members') { where.openid = OPENID; }                      // 只给自己那条
      else if (c === 'classes') { if (!kidCls.length) continue; where.id = _.in(kidCls); }
      else if (c === 'orgs' || c === 'terms' || c === 'courses' ||
               c === 'class_courses' || c === 'subjects' || c === 'knowledge_points' ||
               c === 'templates') {
        // 机构配置与模板：不含个人信息，家长端展示需要，保持全量
      } else {
        continue;   // 其余一律不下发
      }
    }
    // ...下面沿用原有的 srvAt 升序查询、截断保护、cursor 推进逻辑
    r = await db.collection(c).where(where).orderBy('srvAt', 'asc').limit(PAGE).get();
    // ...
  }
```

**为什么这样是对的**：

1. 「空数组 = 不给」保证 fail-closed——最坏情况下家长看到空白，而不是看到全班；
2. 收窄发生在**数据库查询层**，不是拿到数据后再过滤，所以数据根本不会离开服务器；
3. `records` 加了 `sent: true`，和客户端「家长只看已发布」的规则对齐，服务端才是真闸；
4. 家长只需要自己的 member 那条（用来显示自己的名字/角色），不需要同事的手机号。

**必须一起改的两处（否则会引入新 bug）**：

**① 家长新增孩子后要重置游标。** 过滤条件让「新绑的孩子」的历史记录 `srvAt` 早已过去，游标已越过，永远拉不到。在 `finishJoin` 成功返回后，让客户端清一次游标：

```js
// utils/sync.js 的 adopt() 里，家长加入/绑定新孩子后
db.sync.setCursor(0);      // 已有这行（261 行）—— 确认 cardClaim 分支也走同一路径
```

`joinByCard` 的「再加一家」分支（`sync.js:292-300`）只调了 `pullNow(target)`，**没有重置这家的游标**。修复时要在那里补 `db.sync.setCursor(0, target)`。

**② 已经在家长手机上的历史全量数据要清一次。** 过滤上线前，家长本地已经存了全量。

**不要做「逐条剔除」**——那要写一个 `trimTo`，还要处理孤儿引用、事务回滚，容易出错。用现成的最干净路径：**家长端是只读的，本地没有任何「只存在于手机上」的数据，直接清库重拉。**

```js
// utils/db/maintenance.js 的启动迁移里加一次性动作（meta 标记防重复执行）
// 为什么这条路是对的：
//   resetReal() 会 storage.removeAll() 回出厂（factory.js:23），页面数据清空；
//   但家长的 openid / 机构号在云端有据可查，下次启动走 sync.js:56-72 的 whoami 恢复路径，
//   会自动拿回 orgId 并按新规则重新 pull 一份「只有自家孩子」的最小集 —— 身份不会丢。
const KEY = 'privacy_trim_v1';
if (!(db.real().meta || {})[KEY]) {
  const me = db.members.current && db.members.current();
  if (me && me.role === 'parent') {
    db.resetReal();              // 等价于「存储空间 → 重置本机数据」
    db.sync.setCursor(0);
  }
  db.patchMeta({ [KEY]: 1 });
}
```

**代价**：家长升级后第一次打开会看到「数据重新下载一次」（几秒）。只在这次版本变更时发生一次，之后不再触发。**比起把全班孩子的信息留在家长手机上，这个代价我认为可以接受。**

---

### C-2　push 只拦 `members`：家长能改全班评语

**位置**：`cloudfunctions/syncv2/index.js:702-758`

**事实**：715-716 行已经算出身份，但只在 `members` 集合用上了：

```js
const mine = await memberOf(OPENID, orgId);
const isMgr = !!mine && (mine.role === 'owner' || mine.role === 'admin');
for (const it of docs) {
  // ...checkCore...
  if (c === 'members' && !isMgr) {        // ← 727 行，唯一的角色闸门
    if (String(d.openid || '') !== OPENID) { denied++; continue; }
    ...
  }
  // students / records / classes / courses / terms / templates …全都不看角色，直接写
  await col.doc(found.data[0]._id).update({ data: Object.assign({}, d, { orgId, srvAt: at }) });
```

**影响**：

一个家长账号（他自己就有 orgId、有合法工牌），构造一次 push 就能：

- 把自家孩子的评语改成「本次课表现极差」——家长收到的就是这条；
- 改**别人孩子**的姓名、家长姓名、微信号；
- 把 `records.sent` 从 `false` 改成 `true`，让未完成的草稿直接推送给家长；
- 把照片 `fileID` 换成任意图片。

覆盖判定只看 `updatedAt`（750 行），客户端传 `Date.now()` 必然赢，**没有一次会被 `newer` 挡下**。

**并且形成完整攻击链**：`aiEval` 云函数只校验登录 + 限流（`aiEval/index.js:150-175`），**不校验是不是老师**。家长可以先生成一份「专业评语」，再 push 覆盖。整条链不需要老师参与。

**我的判断**：这是本轮**最严重**的一条。它不是「可能泄露」，是「可以直接改坏别人的业务数据」，而且家长端天然有这个通道（`utils/sync.js` 全在客户端）。

**正确方案**（完整，可照抄）

在 `push` 的循环里，`checkCore` 之后插入写权限判定：

```js
// 顶部常量区：谁能写哪类集合
const COLL_MGR_ONLY = ['orgs', 'terms', 'classes', 'courses', 'class_courses',
  'subjects', 'knowledge_points', 'templates'];   // 机构配置：只有负责人/管理员
const COLL_TEACHER  = ['students', 'enrollments', 'records']; // 教学内容：老师也能写（受班级范围限制）

// push 循环内，checkCore 之后：
const role = mine ? String(mine.role) : '';
const mgr = role === 'owner' || role === 'admin';

// ① 机构配置类：非管理角色一律拒
if (COLL_MGR_ONLY.indexOf(c) > -1 && !mgr) { denied++; continue; }

// ② 教学内容：角色 + 范围两道都要过
if (COLL_TEACHER.indexOf(c) > -1) {
  if (role !== 'owner' && role !== 'admin' && role !== 'teacher') { denied++; continue; }
  if (!mgr && !(await inTeacherScope(c, d, mine))) { denied++; continue; }
}
```

```js
// 老师的写入范围：必须落在自己负责的班级里。
// 与 utils/db/permissions.js 的 record.create/student.write 完全同一套规则（scoped: true）。
async function inTeacherScope(c, d, me) {
  const cls = (me.clsIds || []).map(Number).filter(n => n > 0);
  if (!cls.length) return false;                    // 没分班 = 没有范围，fail-closed

  if (c === 'students' || c === 'enrollments') {
    const ids = (d.clsIds || []).map(Number);
    if (!ids.length) return true;                   // 还没分班：允许老师先建人（与前端一致）
    return ids.some(x => cls.indexOf(x) > -1);
  }

  if (c === 'records') {
    if (d.cid && cls.indexOf(Number(d.cid)) > -1) return true;
    const r = await db.collection('students')
      .where({ orgId: me.orgId, id: Number(d.sid) }).limit(1).get()
      .catch(() => ({ data: [] }));
    const s = (r.data || [])[0];
    if (!s) return false;
    return (s.clsIds || []).map(Number).some(x => cls.indexOf(x) > -1);
  }
  return false;
}
```

**为什么这样是对的**：

1. 用**白名单**而不是黑名单：将来新增集合时默认「谁都不能写」，而不是默认全开（fail-closed，和 `permissions.js` 的原则一致）；
2. `denied` 计数会让客户端记入 rejects（`utils/sync.js:204`），老师能在界面上看到「有 N 条被云端丢弃」，不会静默消失；
3. `inTeacherScope` 直接对应 `permissions.js` 的 `ACTIONS['record.create'].scoped`，两套规则语义相同（但**分处两个文件仍是隐患**，见 M-1）。

**顺带一起改**：`aiEval` 加角色校验，把这条链掐断。

```js
// cloudfunctions/aiEval/index.js，登录校验之后、限流之前
// 只有老师及以上能生成评语：家长不需要这个能力，放开等于给了"伪造评语"的素材工厂
const mem = await db.collection('members')
  .where({ openid: OPENID }).limit(5).get().catch(() => ({ data: [] }));
const WRITERS = ['owner', 'admin', 'teacher'];
if (!(mem.data || []).some(m => !m.removed && WRITERS.indexOf(m.role) > -1)) {
  return { ok: false, code: 'FORBIDDEN', msg: '只有老师可以使用 AI 评语' };
}
```

（需在 `aiEval/index.js` 顶部 `const db = cloud.database();`，目前只 init 了 cloud。）

---

## 2. Major

### M-1　权限模型只活在客户端（C-1 / C-2 的共同根因）

**位置**：`utils/db/permissions.js:14-16` vs `cloudfunctions/syncv2/index.js:12`

`permissions.js` 开头明确承诺：

> `// 【换云端怎么用】这里全是纯函数，不依赖存储。服务端拿到 token 里的 member 记录后，用同样的文件做判定，前后端一套规则，不会出现"客户端拦了服务端没拦"。`

**事实上云端从来没引用过它**——`syncv2` 只 `require('wx-server-sdk')`，全项目没有任何服务端 require。承诺写下来了，实现没做。C-1 和 C-2 都是从这句话的落空里长出来的。

**影响判断**：这不是「代码写得差」，是**架构上少了一层**。只要权限还在客户端，任何新增的云端接口都会重复踩同一个坑（`family` 已经踩过一次）。

**正确方案**：把权限判定变成「一份源码，两端共用」。

```
项目结构：
utils/db/permissions.js           ← 唯一真源（纯函数，无 wx 依赖，已是这个形态）
cloudfunctions/syncv2/permissions.js ← 由构建脚本从真源复制（部署前自动生成，不手改）
```

`tools/` 里加一步，并配一条守卫测试：

```js
// tests/verify_perm_parity.js —— 两份文件必须逐字节一致，否则测试红
const fs = require('fs');
const a = fs.readFileSync('utils/db/permissions.js', 'utf8');
const b = fs.readFileSync('cloudfunctions/syncv2/permissions.js', 'utf8');
assert.strictEqual(b, a, '云端权限文件与真源不一致：请运行 node tools/sync-perm.js');
```

`tools/sync-perm.js`：读真源 → 去掉 `/* 前端注释 */` 不需要的部分（实际上不需要去，纯函数可直接跑）→ 写入云函数目录。`npm run cloud -- syncv2` 之前自动跑一次。

**为什么这样是对的**：复制不优雅，但比「云端 require 一个不存在的路径」现实——云函数目录是独立上传单元，无法引用小程序主包。**用一条测试钉住一致性，比靠人记住可靠得多**，这和你们 `verify_ai_guide.js` 里「客户端 AI_VIEWS 键必须与云端 VIEWS 完全一致」是同一个套路，只是那次做对了，这次漏了。

---

### M-2　后台口令明文存库

**位置**：`cloudfunctions/admin/index.js:120`（存）、`162`（比）

```js
account, orgId, pin: lib.newPin(),          // ← 明文
if (str(data.pin).trim() !== str(rec.pin)) { // ← 明文比较
```

**影响**：任何能读 `admin_accounts` 的人——云开发控制台的其他协作者、导出的备份文件、日后若接第三方分析——直接拿到**所有机构**的后台口令，进而读写该机构全部学生与家长信息。口令是 6 位、且**长期不变**（`mkAccount` 有则原样返回）。

**根因推断**：这是个「能省则省」的阶段（一个人开发、要能随时帮用户查口令），不是疏忽。但当机构数上去、协作者变多，明文口令的暴露面就变了性质。

**正确方案**

```js
const crypto = require('crypto');
const hashPin = (pin, salt) => crypto.createHmac('sha256', salt).update(String(pin)).digest('hex');
const sameBytes = (a, b) => {
  const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);  // 长度不等会抛错
};

// 生成时（mkAccount）：只在这一刻把 pin 明文返回给负责人（他自己记下来），库里不落地
const pin = lib.newPin();
const pinSalt = crypto.randomBytes(16).toString('hex');
doc = { account, orgId, pinSalt, pinHash: hashPin(pin, pinSalt), fail: 0, lockUntil: 0, ... };

// 校验时（doLogin）：两条路都要走通，否则存量账号（只有明文 pin）会永远登不进去
const plainOk = !rec.pinHash && str(data.pin).trim() === str(rec.pin);   // 存量明文
const hashOk  = !!rec.pinHash && sameBytes(hashPin(data.pin, rec.pinSalt), rec.pinHash);
if (!plainOk && !hashOk) { /* 原来的失败计数逻辑不变，一行都不用改 */ }

// 存量账号：这次登录既然明文对上了，顺手迁移成 hash，下一次起就走 hash 分支
if (plainOk && !rec.pinHash) {
  await db.collection(ACCOUNTS).doc(account).update({
    data: { pinSalt, pinHash: hashPin(data.pin, pinSalt), pin: _.remove() }
  }).catch(() => {});
}
```

**代价要说明**：改完之后「查看口令」变成「重置口令」——`mkAccount` 不能再返回明文。这对你有影响：现在用户丢了口令你会让他回小程序看一眼，改后只能重置。**我认为这个代价可以接受**（重置是 1 秒的事），但决定权在你。如果暂时不想动，至少把「查看」改成需要重新验证 openid 是负责人（现在是每次调都返回明文）。

---

### M-3　`callGLM` / `callGLMText` 四十行重复（上轮遗留，仍未修）

**位置**：`cloudfunctions/aiEval/index.js:57`（文本）、`116`（识图）

两个函数各自拼 `req` 选项、挂 `timeout`、处理 `error`、解析 `choices[0].message.content`。上轮审查标为 Major-3、这轮仍原样：改 `max_tokens` 只改一处没出事，是运气。

**正确方案**：抽传输层，业务层只关心 payload。

```js
function callGLMApi(key, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      host: HOST, path: PATH, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: TIMEOUT_MS
    }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j.error) return reject(new Error(j.error.message || 'GLM 返回错误'));
          const text = j.choices && j.choices[0] && j.choices[0].message
            && j.choices[0].message.content;
          if (!text) return reject(new Error('GLM 返回空内容'));
          resolve(String(text).trim());
        } catch (e) { reject(new Error('GLM 响应解析失败')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GLM 请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 业务层只剩两个薄壳，参数差异一目了然
const callGLMText = (key, messages, maxTokens) =>
  callGLMApi(key, { model: TEXT_MODEL, temperature: 0.7, max_tokens: maxTokens, messages });
const callGLM = (key, prompt, b64) =>
  callGLMApi(key, { model: MODEL, temperature: 0.75, max_tokens: 420, messages: [{ role: 'user', content: [
    { type: 'image_url', image_url: { url: 'data:' + mimeOf(b64) + ';base64,' + b64 } },
    { type: 'text', text: prompt }
  ] }] });
```

**为什么这样是对的**：超时、错误码、空内容兜底只有一处实现，改一次全生效；两个业务函数的差异（模型、温度、messages 形状）全部显式可见，不会再出现「以为是同一个东西、其实参数不同」。

---

### M-4　平台后台的聚合在数据量增长后会撞超时

**位置**：`cloudfunctions/admin/index.js:603-628`（`recordStatsBySid`）、`65-79`（`findAll` 用 skip 翻页）

两处隐患：

1. **`_.in(sids)` 可能是全平台规模的数组**。`platStudents` 只传当前页（≤200），问题不大；但 **`platExport` 导出全平台学生时会传全部 sid**（上限 `lib.MAX_ROWS`），单条查询条件会随学生数线性膨胀，且 `_.in` 的大数组在云数据库上没有明确保证；
2. **`findAll` 用 `skip` 翻页**（`skip(skip).limit(100)`）。MongoDB 的 skip 是「扫过前 N 条再丢弃」，skip=5000 时每条都要白扫 5000 条文档——`platOrg` 里 `findAll('records', ..., 5000)`、平台概览的机构汇总都会越来越慢，最终撞上函数 20 秒上限。

**影响判断**：**现在不会出问题**（试点机构少）。但平台后台是你自己用的运营工具，等它超时的时候，正是你最需要看数据的时候。

**正确方案**：

```js
// ① 按机构分批，别把全平台 sid 塞一个 in
async function recordStatsBySid(pairs) {
  const out = {};
  const key = (orgId, sid) => String(orgId) + ':' + sid;
  const byOrg = {};
  pairs.forEach(p => {
    const o = String(p.orgId);
    (byOrg[o] || (byOrg[o] = [])).push(Number(p.sid));
  });
  const $ = db.command.aggregate;
  for (const orgId of Object.keys(byOrg)) {
    const sids = Array.from(new Set(byOrg[orgId].filter(n => n > 0)));
    // 每批 100 个，避免单条查询条件过大
    for (let i = 0; i < sids.length; i += 100) {
      const part = sids.slice(i, i + 100);
      const r = await aggTry(() => db.collection('records').aggregate()
        .match({ removed: _.neq(true), orgId, sid: _.in(part) })
        .group({ _id: '$sid', n: $.sum(1), last: $.max('$date') })
        .limit(part.length).end());
      (r && r.list || []).forEach(x => {
        out[key(orgId, x._id)] = { n: Number(x.n) || 0, last: str(x.last) };
      });
    }
  }
  return out;
}

// ② findAll 改成按 _id 游标翻页（replace skip），只对后台统计生效
//    云数据库没有稳定自增主键，用 createdAt+id 做复合游标也可以，最简单的是
//    直接依赖聚合 count/group（orgRows 已经是这个路子），把 findAll 保留给"确定条数很小"的集合。
```

**更省的路线**：`orgRows()` 已经在用 `countByOrg` 聚合，这条路是对的。把 `platStudents` / `platOrg` 里「先把所有 records 拉回来再在内存里 group」的写法，逐步换成聚合。**建议：等有机构超过 500 条记录时再做，现在记录一条 TODO 就够。**

---

## 3. Minor（每条一句方案，按性价比排序）

| # | 位置 | 问题 | 方案 |
|---|---|---|---|
| m-1 | `utils/sync.js:408` + `445-453` | `db.sync.onDirty` 注册了两次（一次直接 `schedule`，一次包了一层也调 `schedule`） | 删掉 408 行那条。现在无害只因为 `schedule` 有 `if (timer) return` 去重，但读代码的人会以为有两套调度 |
| m-2 | `utils/sync.js:128`、`138` | `pullNow` 返回 `{ more: true }` 但 `syncNow` 从不消费 | 换手机恢复时若单集合超 2000 条，只恢复一部分且无提示。在 `syncNow` 里 `if (p.more) return pullNow()` 再跑一轮（最多 3 轮防死循环） |
| m-3 | `utils/sync.js:292-300` | `joinByCard` 的「再加一家」分支只 `pullNow(target)`，没重置该机构的游标 | 修 C-1 时必须补 `db.sync.setCursor(0, target)`，否则家长新绑孩子看不到历史（这条是配合项，不是独立 bug） |
| m-4 | `cloudfunctions/aiEval/index.js:36` | 限流用 `toISOString()`（UTC），中国时间早 8 点前算「昨天」 | 改成和 `admin/index.js:35` 一样的本地日期函数。**同一个仓库里两种口径**，这本身就是隐患 |
| m-5 | `cloudfunctions/aiEval/index.js:37` | `hitMap` 只增不减，长期运行实例内存缓慢增长 | 每次 `allow` 时若 `hitMap.size > 5000`，清掉非今日的条目 |
| m-6 | `cloudfunctions/secCheck/index.js:22` | 任何登录用户可无限调用（无调用方限流、无角色限制） | 加与 aiEval 同款的轻量限流（如 200 次/天）；或只允许「有机构工牌」的人调 |
| m-7 | `utils/demo-data.js`（2369 行） | 演示数据整包进主包，主包已到 66.8% | 挪到分包（`subpackages`），或把长文案压成模板拼接。演示功能用户可不下载，不该占首屏体积 |
| m-8 | `pages/mgr/mgr.js`（893 行 / 78 处 `setData`） | 单文件承担 5 个 tab 的全部逻辑 | 按 tab 拆成 5 个自定义组件，页面只做路由。**不急**，但它是全项目最难改的文件，越晚拆越贵 |
| m-9 | `cloudfunctions/admin/index.js:914` | GET 也能走 `?api=update` 触发写接口（`api(str(q.api), q, headers)`） | GET 分支加只读白名单（`me/overview/list/export/audit/cbList/plat*`），写操作只允许 POST。现在不算漏洞（token 在 header，无 CSRF），但写操作出现在 URL 里会被各级日志记录 |

---

## 4. 待你确认的两件事（代码里看不出来）

1. **云存储的读权限**。`records.photos` 里存的是 `cloud://` fileID。如果云存储权限是「所有用户可读」，那么拿到 fileID 就能看图——这和 C-1 叠加会放大影响。请在云开发控制台 → 存储 → 权限设置确认是「仅创建者可读写」还是「所有用户可读」。**如果是后者，C-1 的优先级要提到最前。**
2. **是否已有真实家长在用**。如果目前只有你和同事的测试账号，C-1 的数据清理那一步可以先跳过；如果已有真实家长绑定，就必须做清理（我给的 `privacy_trim_v1` 迁移）。

---

## 5. 修复顺序建议

**P0（建议本轮就做，改动小、收益直接）**
1. **C-2** push 写权限白名单（约 40 行，含 `inTeacherScope`）
2. **C-2 附带** aiEval 角色校验（约 6 行）
3. **M-1** 把 `permissions.js` 复制到云函数 + 一致性守卫测试（防止下次再漏）

> 只做前两项，家长就越权写不了了。这是投入最小、止血最快的一刀。

**P1（下一轮，需要客户端配套）**
4. **C-1** pull 按孩子收窄 + `sync.js` 游标重置 + 本地数据清理迁移
5. **M-2** 后台口令改 hash（含存量兼容迁移）

**P2（顺手做）**
6. **M-3** `callGLM` 去重（下次动 aiEval 时一起）
7. **m-1 / m-2 / m-4 / m-5**（都是几行的事）
8. **M-4 / m-7 / m-8 / m-9**（等数据量或下次重构时）

---

## 6. 我这次审了什么、没审什么

**精读**：`cloudfunctions/syncv2/index.js`（825 行全读）、`admin/index.js`（入口/登录/权限/聚合）、`aiEval/index.js`、`family/index.js`、`secCheck/index.js`、`utils/sync.js`（465 行全读）、`utils/db/permissions.js`、`utils/db/storage.js`（容量）以及相关测试。

**没深审**：`pages/mgr/mgr.js`（893 行，只看了结构）、`utils/demo-data.js`（数据文件）、`cloudfunctions/backup`、`stuImport`、`pages/*` 的交互细节。**如果这些也要过一遍，说一声，我出第三轮。**

**一个整体判断**：这个项目的工程质量远高于同类小程序——注释写的是「为什么」而不是「做什么」，事务回滚、分片存储、截断保护、fail-closed 这些该有的都有，44 个测试套件也不是摆设。**唯一的系统性缺口是「信任边界画在了客户端」**，而这恰好是最容易被忽略、后果最重的一层。补上这一层，这个系统就相当可靠了。
