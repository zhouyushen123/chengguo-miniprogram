// cloudfunctions/admin/lib.js —— 电脑端后台的纯函数
//
// 这里刻意不 require wx-server-sdk：所有不碰数据库的判断（口令校验节奏、CSV 转义、
// 字段白名单、分页参数）都能在 node 里直接跑，tests/verify_admin.js 才测得到。
// 云函数入口 index.js 只负责"取数据 → 调这里的函数 → 写回库"。
//
// 【口令怎么存（M-2，2026-11-18）】库里只存 HMAC-SHA256 + 随机盐（hmac$<salt>$<hash>），
// 不存明文：拖库拿不到口令。明文只在「生成/重置」的响应里出现一次，负责人抄走即焚。
// 为了不把哈希当作唯一防线，登录端做了失败计数与锁账号：连续错 5 次锁 10 分钟，
// 6 位数字口令在锁之前最多被穷举 5 次。旧明文记录在登录成功那一刻懒迁移成哈希，
// 不需要停机迁移脚本；明文忘了就丢（小程序端负责人可用「重置口令」换新的）。
const crypto = require('crypto');
const ALPHABET = 'ACDEFGHJKLMNPQRSTUVWXY3456789'; // 去掉了 0/O/1/I/2/Z，抄写不会看错

// 后台账号：6 位，字母数字，统一大写。输入时的空格、短横一律忽略，
// 因为它是给人抄的，不是给程序拼的。
function normAccount(v) {
  return String(v === undefined || v === null ? '' : v)
    .toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function isAccount(v) {
  return /^[A-Z0-9]{4,10}$/.test(normAccount(v));
}
// rand: 可注入的随机源（测试用固定序列），返回 [0,1)
function pick(rand, list) {
  const x = Math.min(0.999999, Math.max(0, Number(rand()) || 0));
  return list[Math.floor(x * list.length)];
}
function newAccount(rand) {
  const r = rand || Math.random;
  let s = '';
  for (let i = 0; i < 6; i++) s += pick(r, ALPHABET.split(''));
  return s;
}
function newPin(rand) {
  const r = rand || Math.random;
  let s = '';
  for (let i = 0; i < 6; i++) s += String(Math.floor(Math.min(0.999999, Math.max(0, r())) * 10));
  return s;
}

/* ---------------- 口令哈希（M-2）----------------
 * 存储格式：hmac$<salt>$<hash>。盐随机 16 字节 hex，每条记录各不相同——
 * 同一个口令在两家机构里哈希值也不同，彩虹表没用。
 * 比对用 timingSafeEqual 恒时比较，长度不一致直接判负（不等时比较会抛错）。
 */
function hashPin(plain, salt) {
  return crypto.createHmac('sha256', String(salt)).update(String(plain)).digest('hex');
}
function newPinRecord(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  return 'hmac$' + salt + '$' + hashPin(plain, salt);
}
function isHashedPin(pin) {
  return String(pin === undefined || pin === null ? '' : pin).indexOf('hmac$') === 0;
}
// 登录比对。返回 { ok, migrated }：
//   · 哈希记录：恒时比对，migrated 恒为 false
//   · 旧明文记录：命中时 migrated = true，调用方必须立刻把库里那条换成哈希
//     （懒迁移——部署新版后不需要任何一次性脚本，老账号首次登录自动升级）
function pinMatches(input, rec) {
  const p = String(input === undefined || input === null ? '' : input).trim();
  const raw = rec ? rec.pin : undefined;
  const stored = String(raw === undefined || raw === null ? '' : raw).trim();
  if (isHashedPin(stored)) {
    const parts = stored.split('$');           // ['hmac', salt, hash]
    const expect = parts[2] || '';
    const got = hashPin(p, parts[1] || '');
    const ok = expect.length === got.length
      && crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(got));
    return { ok, migrated: false };
  }
  const ok = p !== '' && p === stored;
  return { ok, migrated: ok };
}
function newToken(rand) {
  const r = rand || Math.random;
  let s = '';
  for (let i = 0; i < 32; i++) s += pick(r, '0123456789abcdef'.split(''));
  return s;
}

/* ---------------- 登录节流 ----------------
 * 【为什么是"锁 10 分钟"而不是"永久锁"】后台是机构自己在用的工具，锁死等于把人关在门外，
 * 还得去数据库改。累计失败到 5 次锁 10 分钟，10 分钟后再错继续锁——暴力破解实际不可行，
 * 而忘了口令的人等一会儿就能重来。
 */
const MAX_FAIL = 5;
const LOCK_MS = 10 * 60 * 1000;
function lockedUntil(acc, now) {
  const t = Number(acc && acc.lockUntil) || 0;
  return t > (now || Date.now()) ? t : 0;
}
// 返回下一次失败后应该写入的 {fail, lockUntil}
function afterFail(acc, now) {
  const t = now || Date.now();
  const fail = (Number(acc && acc.fail) || 0) + 1;
  return { fail, lockUntil: fail >= MAX_FAIL ? t + LOCK_MS : 0 };
}
// 会话有效期：7 天。老师一周至少开一次，过期就重新抄一次口令，不给人长期挂着的机会。
const SESSION_MS = 7 * 24 * 3600 * 1000;

/* ---------------- 字段白名单 ----------------
 * 后台能改什么，在这里一次说清。allow 之外的字段一律丢弃（不是报错）——
 * 前端多传一个 updatedAt 就能把 LWW 弄坏，这类事故不值得靠"前端会传对"来防。
 */
const EDIT = {
  students: ['name', 'no', 'gender', 'enrollYear', 'parent', 'wechat'],
  classes: ['name', 'session', 'teacherId', 'termId', 'mode'],
  records: ['note', 'date', 'session', 'score', 'tag', 'sent']
};
const CREATE = {
  students: ['name', 'gender', 'enrollYear', 'parent', 'wechat', 'clsIds'],
  records: ['sid', 'cid', 'note', 'date', 'session', 'tag', 'score']
};

function safePatch(patch, allow) {
  const src = patch && typeof patch === 'object' ? patch : {};
  const out = {};
  (allow || []).forEach(k => {
    if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) out[k] = src[k];
  });
  return out;
}

/* ---------------- CSV ----------------
 * Excel 直接双击打开的中文 CSV，三件事必须做对：
 *   1. 带 BOM，否则 Excel 按 GBK 解，中文全是乱码；
 *   2. 含逗号/引号/换行的字段加引号并双写引号；
 *   3. 以 = + - @ 开头的值前面加一个 '，否则 Excel 会当公式执行（CSV 注入）。
 */
function csvCell(v) {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
// cols: [{ k, t }]
function csvOf(rows, cols) {
  const head = cols.map(c => csvCell(c.t)).join(',');
  const body = (rows || []).map(r => cols.map(c => csvCell(c.f ? c.f(r) : r[c.k])).join(','));
  return [head].concat(body).join('\r\n');
}

/* ---------------- 分页 ----------------
 * 云数据库单次最多 100 条，且 skip 越大越慢。后台是给人看的，一页 50 条足够，
 * 上限压到 2000 条：再大的机构也不该在浏览器里翻两万行，该用导出。
 */
const PAGE_SIZE = 50;
const MAX_ROWS = 2000;
function normPage(p) {
  const page = Math.max(1, Math.min(9999, Number(p && p.page) || 1));
  const size = Math.max(10, Math.min(200, Number(p && p.size) || PAGE_SIZE));
  return { page, size, skip: (page - 1) * size };
}

/* ---------------- 记录的展示口径 ----------------
 * 小程序里"已发布"= sent，家长能看到。后台要把这件事说人话，
 * 而不是让人对着 true/false 猜。
 */
function schoolYear(d) {
  const y = Number(String(d || '').slice(0, 4));
  return isFinite(y) && y > 1900 ? y : 0;
}
function pct(a, b) {
  const x = Number(a) || 0, y = Number(b) || 0;
  return y ? Math.round((x / y) * 100) : 0;
}

/* ---------------- 后台网址 ----------------
 * 云开发「HTTP 访问服务」给的是 `https://<环境ID>.service.tcloudbase.com`，
 * 路径按控制台里配的来（建议配成 /admin，和这里拼的一致）。
 * 环境 ID 允许用函数环境变量 ADMIN_ENV 覆盖，换环境不用改代码。
 */
const DEFAULT_ENV = 'cloud1-d9gca4e7q307c4564';
const ADMIN_PATH = 'admin';
function adminUrl(env) {
  const id = String(env || DEFAULT_ENV).trim();
  return id ? 'https://' + id + '.service.tcloudbase.com/' + ADMIN_PATH : '';
}

module.exports = {
  ALPHABET, MAX_FAIL, LOCK_MS, SESSION_MS, PAGE_SIZE, MAX_ROWS, DEFAULT_ENV, ADMIN_PATH,
  EDIT, CREATE,
  normAccount, isAccount, newAccount, newPin, newToken,
  hashPin, newPinRecord, isHashedPin, pinMatches,
  lockedUntil, afterFail, safePatch, csvCell, csvOf, normPage,
  schoolYear, pct, adminUrl
};
