# 代码审查报告 —— 2026-11-09

- **范围**：全仓库，重点为 1145 版 AI 评价改造（`cloudfunctions/aiEval`、`pages/record`、`pages/batch`、`utils/aipref.js`、`utils/api.js`）
- **基线**：`node tools/lint.js` 0 提醒；`node tests/run.js` 43 套件全绿；git 工作区干净（仅 `.release.json` 版本标记）
- **审查人**：代码审查专家（AI）
- **结论**：整体质量扎实，无 Critical。3 个 Major + 2 个 Minor，均有可直接照抄的修复方案。

---

## ✅ 值得点名做对的地方（保持，别在后续重构里丢掉）

1. **密钥零泄露**：`ZHIPU_API_KEY` 只在云函数环境变量，前端与仓库均无痕迹（`grep` 验证）。
2. **两端出口都有内容安全**：批量保存 `batch.js:335 sec.checkMany`、单条保存 `record.js:484 sec.checkMany`——AI 草稿经过老师修改后发家长前必过审，P1-9 的风险实际已被覆盖。
3. **`AI_VIEWS`（客户端）与 `VIEWS`（云端 prompt.js）键名由测试强制比对**——这是防「改一边忘另一边」的正确机制。
4. **prompt.js 独立成文件做行为断言**——把提示词当产品本体而不是胶水，29 项断言直接锁住「不出现群发腔」等产品底线。
5. 细节防御到位：OPENID 校验、base64 4MB 上限、MIME 魔数判断、超时主动留 2 秒余量而不是等微信掐断。

---

## 🔴 Major-1：aiEval 无按人限流（安全/成本，条件式）

**位置**：`cloudfunctions/aiEval/index.js:142-200`

**问题（事实）**：`exports.main` 只校验 `OPENID` 存在（登录），不校验身份、不限次数。任何登录用户——包括家长账号、已离职被移除的老师——都能无限次调用 aiEval，每次都烧一次智谱 API。

**判断（推断）**：glm-4v-flash 是免费档，配额烧干后**全机构**的 AI 评价一起瘫痪，这是最便宜的攻击面。当前体验版用户规模小、风险低；一旦放开推广，建议必须修。根因推断：开发时是「工具思维」（只想着老师会用），没有按「对外接口」思维设防——云函数一旦部署，它的调用者就是「任何拿到 appid 的人」。

**✅ 正确方案**（单实例内存限流，零额外成本，照抄即可）：

```js
// cloudfunctions/aiEval/index.js 顶部
const DAILY_LIMIT = 30;               // 一位老师一天 30 次，够用且防刷
const hitMap = new Map();             // openid -> { day, count }

// 简单限流：实例内存计数。冷启动会清零、多实例各记各的——不精确，
// 但足以挡住「单账号高频刷」这个真实威胁；要精确再升级成云数据库计数。
function allow(openid) {
  const today = new Date().toISOString().slice(0, 10);
  const h = hitMap.get(openid);
  if (!h || h.day !== today) { hitMap.set(openid, { day: today, count: 1 }); return true; }
  if (h.count >= DAILY_LIMIT) return false;
  h.count++;
  return true;
}
```

在 `exports.main` 中，紧跟 OPENID 校验之后加：

```js
if (!allow(OPENID)) {
  return { ok: false, code: 'RATE_LIMIT', msg: '今日 AI 次数已用完（30 次），请明天再试' };
}
```

**为什么对**：挡的是「量」而不是「人」——不需要引入身份体系就能护住配额；内存 Map 不产生任何数据库读写费用；免费额度下这是成本收益最优的档位。前端 `record.js` 已有按 `code` 提示的分支（NO_KEY 先例），把 `RATE_LIMIT` 加进同一串判断即可。

---

## 🔴 Major-2：batch 上限 60 人 vs 函数超时 20 秒，防御不一致（正确性，潜伏）

**位置**：`cloudfunctions/aiEval/index.js:155`（`students.slice(0, 60)`）与 `:23`（BATCH_SIZE=10）+ `config.json` timeout=20

**问题（事实）**：客户端 `batch.js:34 AI_BATCH=10` 每次只送 10 人，所以**现在线上不会炸**。但云函数自己允许一次收 60 人 = 6 次串行 GLM 调用，每次超时上限 18 秒——任何一次慢，整个函数被微信在 20 秒掐断，前端只能拿到 -504003，没有任何提示。防线只存在于客户端，服务端没有兜底。

**判断（推断）**：这是典型的「客户端当防线」失误。今天没事，是因为恰好客户端自觉；将来任何新入口（网页端、批量导入脚本、被伪造的请求）直接打云函数就会踩中。修的成本是 1 行。

**✅ 正确方案**：服务端上限与单批人数对齐，超出的明确报错而不是默默收下：

```js
// index.js:155 改为
const students = Array.isArray(event.students) ? event.students.slice(0, 10) : [];
if (Array.isArray(event.students) && event.students.length > 10) {
  return { ok: false, msg: '一次最多 10 人，请分批调用' };
}
```

**为什么对**：10 人 = 1 次 GLM 调用 = 18 秒超时预算内，与函数 20 秒超时自洽。客户端本来每批就送 10 人，行为零变化；只是把「约定」变成「契约」。

---

## 🟠 Major-3：callGLM / callGLMText 近 40 行复制粘贴（可维护性）

**位置**：`cloudfunctions/aiEval/index.js:38-74` 与 `97-140`

**问题（事实）**：两个函数除 body 组装（模型名、temperature、messages 结构）外完全相同：同样的 https.request、同样的错误处理、同样的 JSON 解析。改超时、换域名、加日志要改两处。

**判断**：不是 bug，但这是「下一次改超时只改了一处」这类事故的标准温床。本轮 `max_tokens 300→420` 就是只在 callGLM 改了——恰好批量走另一个默认值没被波及，纯属运气。

**✅ 正确方案**：抽公共传输层，两个入口只组 body：

```js
// 公共传输层：只管「发请求、收响应」，不管业务字段
function callGLMApi(key, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      host: HOST, path: PATH, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: TIMEOUT_MS
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          if (res.statusCode !== 200) {
            return reject(new Error('GLM_' + res.statusCode + ': ' + ((j.error && j.error.message) || raw.slice(0, 120))));
          }
          const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (!text) return reject(new Error('GLM 空响应'));
          resolve(text);
        } catch (e) { reject(new Error('GLM 响应解析失败')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('GLM 请求超时')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function callGLMText(key, messages, maxTokens) {
  return callGLMApi(key, { model: TEXT_MODEL, temperature: 0.7, max_tokens: maxTokens || 2000, messages });
}

function callGLM(key, prompt, b64) {
  return callGLMApi(key, {
    model: MODEL, temperature: 0.6, max_tokens: 420,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:' + mimeOf(b64) + ';base64,' + b64 } },
        { type: 'text', text: prompt }
      ]
    }]
  });
}
```

**为什么对**：传输细节收敛到一处，模型参数（temperature/max_tokens）留在各自入口——它们本来就是「每个通道各自的业务决策」。重构后 `tests/verify_ai_guide.js` 与现有测试应全绿（该套件只断言 prompt.js 与页面行为，不碰传输层）。

---

## 🔵 Minor-1：同名学生对不上号（数据边缘）

**位置**：`cloudfunctions/aiEval/index.js:91`（`out[name]` 键）、`:94`（`out[s.name]` 读）；`pages/batch/batch.js:314`（`slice.find` 取第一个匹配）

**问题（事实）**：一个班两个「张伟」时：云端 `out` 按姓名做键、两条评语互相覆盖；前端 `find` 只命中第一个——第二人的评语要么丢、要么错位到第一人头上。

**判断**：实际培训机构同班同名概率低，可不修；但修起来 6 行，建议顺手做掉。另外云端写键时 `String(item.name).trim()`、读键时 `s.name` 不 trim——两边不对称，姓名带空格就对不上（顺带一起修）。

**✅ 正确方案**：同名时宁可置 null 让老师手写，不猜：

```js
// batchNotes 尾部（替换 return students.map(...)）
const dup = {};
students.forEach(s => { const k = String(s.name || '').trim(); dup[k] = (dup[k] || 0) + 1; });
return students.map(s => {
  const k = String(s.name || '').trim();
  // 同名一条 note 无法区分给谁：宁可置 null（前端留空让老师手写），不错位
  return { name: s.name, note: dup[k] > 1 ? null : (out[k] || null) };
});
```

---

## 🔵 Minor-2：提示注入面（低风险，记录备查）

**位置**：`prompt.js:87`（`say`）、`:108`（`topic`）等老师可控文本直接拼进提示词。

**判断**：老师注入「忽略以上所有要求」最多让 AI 写歪一条草稿，出口有两道闸（老师过目 + msgSecCheck），家长端不直接消费 AI 原文。**可不修**。若将来开放「家长留言给 AI」之类入口，必须重估。

---

## 修复优先级建议

| 序 | 项 | 工作量 | 建议时机 |
|---|---|---|---|
| 1 | Major-1 限流 | ~15 行 | 推广前必须；现在做也行 |
| 2 | Major-2 batch 上限 10 | 1 行 | 顺手就改 |
| 3 | Major-3 去重复 | ~30 行搬移 | 下一轮动 aiEval 时一起 |
| 4 | Minor-1 同名 | 6 行 | 顺手 |
| 5 | Minor-2 注入 | 0 | 只记录，不动 |

修完任何一项后：`node tools/lint.js && node tests/run.js` 应全绿；涉及 aiEval 的改动需 `npm run cloud -- aiEval` 重新部署，并 bump 体验版。
