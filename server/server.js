// 橙果小程序线上同步服务（Node.js / Express）
// 部署：npm i && node server.js  （建议放到 HTTPS 域名后，把 BASE_URL 配到小程序 utils/api.js）
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const DB_FILE = path.join(__dirname, 'db.json');
function loadDb() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { return null; } }
function saveDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db)); }
const clients = new Map(); // openid -> db 副本（简单单租户版，多租户请扩展）

app.post('/api/login', (req, res) => {
  // 生产环境：用 code 调 https://api.weixin.qq.com/sns/jscode2session 换 openid
  // 演示环境直接发一个临时 id
  res.json({ openid: 'u_' + Math.random().toString(36).slice(2, 10) });
});
app.get('/api/db', (req, res) => {
  const db = loadDb();
  res.json({ db: db || null });
});
app.post('/api/records', (req, res) => {
  const db = loadDb() || { records: [], students: [] };
  if (req.body.type === 'profile') {
    const s = db.students.find(x => x.id === req.body.sid);
    if (s) s.profile = req.body.profile;
  } else {
    const i = db.records.findIndex(r => r.id === req.body.id);
    if (i >= 0) db.records[i] = req.body; else db.records.push(req.body);
  }
  saveDb(db);
  res.json({ ok: true });
});
const upload = multer({ dest: path.join(__dirname, 'uploads') });
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.json({ url: null });
  const ext = (req.file.originalname || '').split('.').pop() || 'bin';
  const name = req.file.filename + '.' + ext;
  fs.renameSync(req.file.path, path.join(__dirname, 'uploads', name));
  res.json({ url: '/uploads/' + name }); // 生产环境请返回完整 https URL
});
app.listen(3000, () => console.log('橙果同步服务已启动: http://localhost:3000'));
