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
const TIMEOUT_MS = 25000;
const MAX_B64 = 4 * 1024 * 1024;   // base64 超过 4MB 直接拒绝（约 3MB 原图）
const BATCH_SIZE = 10;             // 批量评语每批人数：一次太多容易超时/截断

function buildPrompt(hint) {
  return [
    '你是一位课外培训机构的授课老师，请根据这张课堂照片，写一条发给家长的课后评价草稿。',
    '要求：',
    '- 60~120 字，亲切自然、具体可信，最后给孩子一句鼓励',
    '- 只描述照片里能看到的表现或作品（如书写、绘画、动作、神态），不要编造看不清的细节',
    '- 不出现"照片""图片"这类字眼，直接以课堂口吻描述',
    '- 直接输出评价正文，不要任何前缀、引号或解释',
    hint ? '课程类型：' + hint : ''
  ].filter(Boolean).join('\n');
}

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
async function batchNotes(key, students, topic) {
  const out = {};
  for (let i = 0; i < students.length; i += BATCH_SIZE) {
    const slice = students.slice(i, i + BATCH_SIZE);
    const roster = slice.map((s, k) =>
      (k + 1) + '. 姓名：' + s.name + '；本次等第：' + (s.tag || '未评') +
      (s.prev ? '；上次评价：' + s.prev : '')).join('\n');
    const prompt = [
      '你是一位课外培训机构的授课老师。根据下面的学生名单和本次课程信息，给每位学生写一条发给家长的课后评价。',
      '要求：',
      '- 每条 50~100 字，亲切自然、具体可信，结尾给孩子一句鼓励',
      '- 结合等第高低调子不同：优秀多表扬细节，待提高提期望但不批评',
      '- 同一批人的评语不许雷同，各人侧重点不同',
      topic ? '- 本次课程主题：' + topic : '',
      '- 输出严格的 JSON 数组，不要任何其它文字：[{"name":"学生姓名","note":"评价正文"}]，姓名必须与名单完全一致',
      '',
      '学生名单：',
      roster
    ].filter(Boolean).join('\n');
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
    max_tokens: 300,
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
      const notes = await batchNotes(key, students, String(event.topic || '').slice(0, 100));
      return { ok: true, notes };
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
    const text = await callGLM(key, buildPrompt(event.hint || ''), b64);
    return { ok: true, text: String(text).trim() };
  } catch (e) {
    return { ok: false, msg: (e && e.message) || 'AI 调用失败' };
  }
};
