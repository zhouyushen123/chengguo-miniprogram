// 云函数：stuImport —— 学生批量导入
//
// 三条路统一出口 { ok, students:[{name,gender,parent}] }：
//   action=parseFile  { fileBase64, name }  xlsx/xls/csv 确定性解析；docx 抽文本后走 AI
//   action=parsePhoto { imageBase64 }       纸质名单拍照 → GLM-4V 识图抽名单
//   action=ping                                  连通性自检
//
// 【密钥安全】与 aiEval 相同：ZHIPU_API_KEY 只放云函数环境变量，绝不进前端。
// 【体积】base64 上限 4MB（约 3MB 原文件）——callFunction 的 event 上限是 5MB，必须留余量。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const https = require('https');
const XLSX = require('xlsx');
const JSZip = require('jszip');
const parse = require('./parse.js');

const HOST = 'open.bigmodel.cn';
const PATH = '/api/paas/v4/chat/completions';
const TIMEOUT_MS = 25000;
const MAX_B64 = 4 * 1024 * 1024;
const TEXT_MODEL = 'glm-4-flash';    // 文档文本抽取（免费档）
const VISION_MODEL = 'glm-4v-flash'; // 纸质名单识图（免费档）

function mimeOf(b64) {
  if (b64.indexOf('iVBOR') === 0) return 'image/png';
  if (b64.indexOf('UklGR') === 0) return 'image/webp';
  return 'image/jpeg';
}

// 通用 GLM 调用：messages 由调用方组装（文本 or 识图）
function callGLM(key, model, messages, maxTokens) {
  const body = JSON.stringify({ model, temperature: 0.1, max_tokens: maxTokens, messages });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST, path: PATH, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'Content-Length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          if (res.statusCode !== 200) return reject(new Error('GLM_' + res.statusCode + ': ' + ((j.error && j.error.message) || raw.slice(0, 120))));
          const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (!text) return reject(new Error('GLM 空响应'));
          resolve(text);
        } catch (e) { reject(new Error('GLM 响应解析失败')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GLM 请求超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const ROSTER_PROMPT = [
  '这是一份培训机构学生名单（可能是拍照的纸质名单或文档文本）。',
  '请提取其中所有学生，输出 JSON 数组：[{"name":"姓名","gender":"男或女","parent":"家长姓名"}]。',
  '规则：',
  '- gender/parent 拿不准就留空字符串，不要编造',
  '- 只收中文人名（2~20 个汉字），班级名/电话/序号/表头都不是姓名',
  '- 同一人只保留一次',
  '- 只输出 JSON 数组，不要任何解释或代码块标记'
].join('\n');

function visionMessages(b64) {
  return [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:' + mimeOf(b64) + ';base64,' + b64 } },
      { type: 'text', text: ROSTER_PROMPT }
    ]
  }];
}

// xlsx/xls → 二维数组
function sheetRows(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
}

exports.main = async (event) => {
  if (event && event.action === 'ping') {
    return { ok: true, pong: true, hasKey: !!process.env.ZHIPU_API_KEY };
  }
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, msg: '未登录，拒绝调用' };
  const key = process.env.ZHIPU_API_KEY;
  if (!key) return { ok: false, code: 'NO_KEY', msg: '云函数缺 ZHIPU_API_KEY 环境变量' };

  const b64 = String((event && (event.fileBase64 || event.imageBase64)) || '').replace(/^data:[^,]+;base64,/, '');
  if (!b64) return { ok: false, msg: '缺少文件内容' };
  if (b64.length > MAX_B64) return { ok: false, msg: '文件过大（上限约 3MB），请拆分后导入' };

  try {
    // ---- 表格文件：确定性解析，不走 AI ----
    if (event.action === 'parseFile') {
      const ext = String(event.name || '').split('.').pop().toLowerCase();
      if (ext === 'csv' || ext === 'txt') {
        const students = parse.tableFromRows(parse.parseCsvText(Buffer.from(b64, 'base64').toString('utf8')));
        return { ok: true, students };
      }
      if (ext === 'xlsx' || ext === 'xls') {
        return { ok: true, students: parse.tableFromRows(sheetRows(Buffer.from(b64, 'base64'))) };
      }
      if (ext === 'docx') {
        // docx = zip 包着 word/document.xml，抽出纯文本交给文本模型抽名单
        const zip = await JSZip.loadAsync(Buffer.from(b64, 'base64'));
        const doc = zip.file('word/document.xml');
        if (!doc) return { ok: false, msg: '这不是有效的 Word 文档' };
        const text = parse.stripDocxXml(await doc.async('string'));
        const out = await callGLM(key, TEXT_MODEL, [{ role: 'user', content: ROSTER_PROMPT + '\n\n名单文本：\n' + text.slice(0, 6000) }], 2000);
        return { ok: true, students: parse.pickAiStudents(out) };
      }
      return { ok: false, msg: '暂不支持 .' + ext + '，请用 Excel / CSV / Word 文档' };
    }

    // ---- 纸质名单拍照：GLM-4V 识图 ----
    if (event.action === 'parsePhoto') {
      const out = await callGLM(key, VISION_MODEL, visionMessages(b64), 2000);
      return { ok: true, students: parse.pickAiStudents(out) };
    }

    return { ok: false, msg: '未知 action' };
  } catch (e) {
    return { ok: false, msg: (e && e.message) || '解析失败' };
  }
};
