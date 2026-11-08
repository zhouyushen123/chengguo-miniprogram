// 云函数：aiEval —— AI 识图生成评价草稿（智谱 GLM-4V-Flash，免费档）
//
// 【密钥安全】ZHIPU_API_KEY 只存放在云开发控制台 → 云函数 → aiEval → 配置 → 环境变量。
//   绝不写进本文件或小程序前端——前端代码可被反编译，等于把钱包交出去。
// 【图片通道】两种入参，二选一：
//   - fileID：cloud:// 开头的云存储文件（云开发开启后照片上传所得），云函数端下载转 base64
//   - imageBase64：客户端压缩后的 JPEG base64（未开云存储时的兜底通道）
// 【合规】AI 生成的评价在发送给家长前仍需走内容审核（msgSecCheck，全局待办 P1-9）。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const https = require('https');
const MODEL = 'glm-4v-flash';
// 批量评语走纯文本模型：便宜、快、不需要识图
const TEXT_MODEL = 'glm-4-flash';
const HOST = 'open.bigmodel.cn';
const PATH = '/api/paas/v4/chat/completions';
// 云函数本身超时按 20 秒配置（控制台，微信 CLI 的 deploy 不应用 config.json 的 timeout）。
// 这里留 2 秒余量：18 秒还没回就主动放弃并返回明确错误，而不是等微信在 20 秒把函数掐断
// ——被掐断时前端只能拿到 -504003，什么信息都没有。
const TIMEOUT_MS = 18000;
const MAX_B64 = 4 * 1024 * 1024;   // base64 超过 4MB 直接拒绝（约 3MB 原图）
const BATCH_SIZE = 10;             // 批量评语每批人数：一次太多容易超时/截断

// 提示词与学科词表见 prompt.js：那是产品能力的本体，单独成文件才能直接做行为断言
const P = require('./prompt');

// 图片 MIME 必须与实际内容一致，否则智谱直接回 1210「图片格式/解析错误」。
// 按 base64 开头的魔数判断（PNG iVBOR / JPEG /9j/ / WEBP UklGR），默认 jpeg。
function mimeOf(b64) {
  if (b64.indexOf('iVBOR') === 0) return 'image/png';
  if (b64.indexOf('UklGR') === 0) return 'image/webp';
  if (b64.indexOf('/9j/') === 0) return 'image/jpeg';
  return 'image/jpeg';
}

// 纯文本调用（批量评语用）：不需要识图，走 glm-4-flash
function callGLMText(key, messages, maxTokens) {
  const body = JSON.stringify({
    model: TEXT_MODEL,
    temperature: 0.7,
    max_tokens: maxTokens || 2000,
    messages
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST, path: PATH, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(body)
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
    req.write(body);
    req.end();
  });
}

// 批量评语：一扫学生（姓名+分数+上次评语）+ 本课主题 → 逐人一条差异化评语。
// 从模型回的 JSON 里按姓名对号；解析不了/漏掉的返回 null，由前端保留原值并提示。
async function batchNotes(key, students, opts) {
  const o = opts || {};
  const out = {};
  for (let i = 0; i < students.length; i += BATCH_SIZE) {
    const slice = students.slice(i, i + BATCH_SIZE);
    const prompt = P.buildBatchPrompt(slice, { topic: o.topic, course: o.course, subjectGid: o.subjectGid });
    const text = await callGLMText(key, [{ role: 'user', content: prompt }], 2000);
    // 模型有时会包一层 ```json 围栏，剥掉再解析
    const clean = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    let arr = [];
    try { arr = JSON.parse(clean); } catch (e) { arr = []; }
    if (!Array.isArray(arr)) continue;
    arr.forEach(item => {
      if (item && item.name && item.note) out[String(item.name).trim()] = String(item.note).trim().slice(0, 300);
    });
  }
  return students.map(s => ({ name: s.name, note: out[s.name] || null }));
}

function callGLM(key, prompt, b64) {
  const body = JSON.stringify({
    model: MODEL,
    temperature: 0.6,
    // 150 字中文约 250 tokens，再加上模型偶尔啰嗦，300 会把结尾的期待截断
    max_tokens: 420,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'data:' + mimeOf(b64) + ';base64,' + b64 } },
        { type: 'text', text: prompt }
      ]
    }]
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST, path: PATH, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(body)
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
    req.write(body);
    req.end();
  });
}

exports.main = async (event) => {
  // 连通性自检：部署后在开发者工具里 ping 一下就知道通没通
  if (event && event.action === 'ping') {
    return { ok: true, pong: true, hasKey: !!process.env.ZHIPU_API_KEY };
  }
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, msg: '未登录，拒绝调用' };

  const key = process.env.ZHIPU_API_KEY;
  if (!key) return { ok: false, code: 'NO_KEY', msg: '云函数缺 ZHIPU_API_KEY 环境变量' };

  // 批量评语：纯文本通道，不需要照片
  if (event && event.action === 'batch') {
    const students = Array.isArray(event.students) ? event.students.slice(0, 60) : [];
    if (!students.length) return { ok: false, msg: '缺少学生名单' };
    try {
      const notes = await batchNotes(key, students, {
        topic: event.topic, course: event.course, subjectGid: event.subjectGid
      });
      // AI 生成的评语也是 UGC，逐条过微信内容安全；命中违规的直接置 null（前端保留原值并提示）。
      // fail-open：检查接口本身报错（非 87014）不拦截，保证 AI 主链路不被安全服务抖动拖死。
      let blocked = 0;
      await Promise.all(notes.map(async n => {
        if (!n || !n.note) return;
        try {
          const r = await cloud.openapi.security.msgSecCheck({ content: n.note });
          if (r && r.result && r.result.suggest && r.result.suggest !== 'pass') { n.note = null; blocked++; }
        } catch (e) {
          if (e && (e.errCode === 87014 || String(e.errMsg || '').indexOf('87014') > -1)) { n.note = null; blocked++; }
        }
      }));
      return { ok: true, notes, blocked };
    } catch (e) {
      return { ok: false, msg: (e && e.message) || 'AI 调用失败' };
    }
  }

  let b64 = '';
  try {
    if (event.fileID) {
      // 云存储通道：fileID → 云函数端下载 → base64
      const dl = await cloud.downloadFile({ fileID: event.fileID });
      b64 = dl.fileContent.toString('base64');
    } else if (event.imageBase64) {
      b64 = String(event.imageBase64).replace(/^data:image\/\w+;base64,/, '');
    }
  } catch (e) {
    return { ok: false, msg: '照片读取失败：' + ((e && e.message) || '未知错误') };
  }
  if (!b64) return { ok: false, msg: '缺少照片' };
  if (b64.length > MAX_B64) return { ok: false, msg: '照片过大，请压缩后重试' };

  try {
    const text = await callGLM(key, P.buildPrompt(event), b64);
    return { ok: true, text: String(text).trim() };
  } catch (e) {
    return { ok: false, msg: (e && e.message) || 'AI 调用失败' };
  }
};
