// 橙果自建同步服务（Node.js / Express）—— 参考实现，当前小程序没有接这条链路
//
// 【现状】小程序默认走本地存储（utils/db/storage.js），开启云同步后走微信云开发
// （cloudfunctions/sync）。这份 Express 服务是"不上云、自己搭服务器"时的备选方案，
// 代码保留在这里是为了让迁移路径清楚，但它没有被 utils/api.js 调用。
//
// 【上线前必须做的三件事】这份实现已经带了骨架，缺的是配置：
//   1. 配 APPID / APPSECRET —— 用 code 换 openid 才是微信认可的登录，禁止自己发随机 id
//   2. 换持久化存储 —— 现在的 db.json 只适合单机试跑，正式环境请接数据库
//   3. 加 HTTPS —— 小程序要求所有请求域名走 https
//
// 【安全底线（这里已经做掉的）】
//   - 所有数据接口都要 Bearer token，token 由 /api/login 签发
//   - 每个人只能读写自己的数据（按 openid 分文件），不是"登录了就能看全库"
//   - 上传限制体积与扩展名，避免被当成免费图床
//   - 落盘用"写临时文件再改名"，进程被杀也不会留下半个 JSON
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));

// 生产环境请用环境变量注入，不要写进代码
const APPID = process.env.CHENGGUO_APPID || '';
const APPSECRET = process.env.CHENGGUO_SECRET || '';
const TOKEN_TTL = 7 * 24 * 3600 * 1000;

const DATA_DIR = path.join(__dirname, 'data');
const UP_DIR = path.join(__dirname, 'uploads');
[DATA_DIR, UP_DIR].forEach(d => { try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 已存在 */ } });

/* ---------------- 存储：一人一个文件，原子写 ---------------- */
const fileOf = openid => path.join(DATA_DIR, crypto.createHash('sha1').update(openid).digest('hex') + '.json');

function loadDb(openid) {
  try { return JSON.parse(fs.readFileSync(fileOf(openid), 'utf8')); }
  catch (e) { return { records: [], students: [] }; }
}
function saveDb(openid, db) {
  const f = fileOf(openid);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, f);       // 原子替换：中途被杀也不会留下半个文件
}

/* ---------------- 登录：code → openid，签发 token ---------------- */
const tokens = new Map();      // token → { openid, exp }

function jscode2session(code) {
  const url = 'https://api.weixin.qq.com/sns/jscode2session?appid=' + encodeURIComponent(APPID) +
    '&secret=' + encodeURIComponent(APPSECRET) +
    '&js_code=' + encodeURIComponent(code) + '&grant_type=authorization_code';
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.openid) resolve(j.openid);
          else reject(new Error(j.errmsg || '登录失败'));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

app.post('/api/login', async (req, res) => {
  if (!APPID || !APPSECRET) {
    // 没配置就不发身份：以前这里会给一个随机 id，等于任何人都是"新用户"且没有归属保障
    return res.status(503).json({ ok: false, msg: '服务端未配置 APPID / APPSECRET' });
  }
  const code = req.body && req.body.code;
  if (!code) return res.status(400).json({ ok: false, msg: '缺少 code' });
  try {
    const openid = await jscode2session(code);
    const token = crypto.randomBytes(24).toString('hex');
    tokens.set(token, { openid, exp: Date.now() + TOKEN_TTL });
    res.json({ ok: true, token });
  } catch (e) {
    res.status(401).json({ ok: false, msg: '登录失败' });
  }
});

// 鉴权中间件：没有有效 token 一律 401
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.indexOf('Bearer ') === 0 ? h.slice(7) : '';
  const rec = token && tokens.get(token);
  if (!rec || rec.exp < Date.now()) return res.status(401).json({ ok: false, msg: '请重新登录' });
  req.openid = rec.openid;
  next();
}

/* ---------------- 数据接口（全部按 openid 隔离） ---------------- */
app.get('/api/db', auth, (req, res) => {
  res.json({ db: loadDb(req.openid) });
});

app.post('/api/records', auth, (req, res) => {
  const body = req.body || {};
  const db = loadDb(req.openid);
  if (body.type === 'profile') {
    const s = db.students.find(x => x.id === body.sid);
    if (s) s.profile = body.profile;
  } else if (body.id) {
    const i = db.records.findIndex(r => r.id === body.id);
    if (i >= 0) db.records[i] = body; else db.records.push(body);
  } else {
    return res.status(400).json({ ok: false, msg: '缺少记录 id' });
  }
  saveDb(req.openid, db);
  res.json({ ok: true });
});

/* ---------------- 上传：限类型、限体积 ---------------- */
const ALLOW_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.mp3', '.m4a'];
const upload = multer({
  dest: UP_DIR,
  limits: { fileSize: 50 * 1024 * 1024 }   // 与小程序端 MAX_FILE 一致
});

app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.json({ url: null });
  const ext = path.extname(req.file.originalname || '').toLowerCase();
  if (ALLOW_EXT.indexOf(ext) === -1) {
    try { fs.unlinkSync(req.file.path); } catch (e) { /* 忽略 */ }
    return res.status(415).json({ ok: false, msg: '不支持的文件类型' });
  }
  // 文件名带 openid 前缀：不同机构/老师上传的同名文件不会互相覆盖
  const owner = crypto.createHash('sha1').update(req.openid).digest('hex').slice(0, 12);
  const name = owner + '-' + req.file.filename + ext;
  fs.renameSync(req.file.path, path.join(UP_DIR, name));
  res.json({ url: '/uploads/' + name });
});

app.use('/uploads', express.static(UP_DIR));

module.exports = app;
if (require.main === module) {
  app.listen(3000, () => console.log('橙果同步服务已启动: http://localhost:3000'));
}
