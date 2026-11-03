// utils/db/core.js —— 内存态与落盘
//
// 设计：启动时把全部集合水合到内存（storage.load），所有读操作走内存（页面渲染零延迟），
// 写操作改内存后立刻落盘。将来换云端时，读仍是内存、写变成"内存 + 异步推送"，
// 页面拿到的仍是同步结果，不用改成 await。
//
// 【两套内存态】真实数据一套、演示数据一套，磁盘上同样是两套 key（见 storage.js）。
// 当前看哪一套由 mode 决定：real | demo。切换只换指针，不做数据搬运 ——
// 这是"演示数据不可能污染真实数据"的最后一道保证：
// 演示模式下任何写操作都只落在 demoState 上，而且不落盘（重启复原）。
//
// 【落盘失败必须让调用方知道】persist 返回 false 就是"这条没存到磁盘上"。
// 以前所有写函数都忽略这个返回值，页面照样弹「已保存」，用户不会重录 ——
// 这是最贵的一种数据丢失。所以写函数都要检查返回值，失败时回滚内存并回报错误。
const storage = require('./storage');
const schema = require('./schema');

const COLLS = ['orgs', 'members', 'terms', 'classes', 'courses', 'students', 'enrollments', 'records', 'users', 'templates'];

// 落盘失败时给用户看的统一文案（各领域模块直接用它，避免说法不一致）
const SAVE_FAIL = '本地存储空间不足，这次没能保存。请到「我的 · 存储空间」清理后重试';

// 空态用工厂而不是共享常量：两套状态各自持有独立数组，避免互相改到同一份内存
function emptyState() {
  const s = { meta: null };
  COLLS.forEach(n => { s[n] = []; });
  return s;
}
const EMPTY = emptyState();

let realState = emptyState();
let demoState = emptyState();
let mode = 'real';          // real | demo
let lastId = 0;
let ready = false;          // 真实数据是否已水合
let demoReady = false;      // 演示数据是否已水合
// 降级态：启动失败（读盘异常 / 数据损坏）时为 true。
// 此时内存里是空库，绝不能落盘——否则会拿空库把磁盘上的真实数据覆盖掉，
// 一次读取失败就变成永久数据丢失。
let readOnly = false;

// 最近一次落盘失败（供「存储空间」页显示，排查"为什么刚才没存上"）
let lastFail = null;        // { coll, at }

// 事务态：事务内所有 persist 只记脏不落盘，提交时统一写、失败统一回滚
let txDepth = 0;
let txDirty = {};

const cur = () => (mode === 'demo' ? demoState : realState);
const isSandbox = () => mode === 'demo';

function hydrateInto(which, loaded) {
  const s = emptyState();
  storage.COLLECTIONS.forEach(name => {
    s[name] = Array.isArray(loaded && loaded[name]) ? loaded[name] : [];
  });
  s.meta = (loaded && loaded.meta) || null;
  // id 分配器从现有最大值起步，避免系统时间回拨时生成重复 id。
  // 两套数据共用一个分配器：跨库取最大，两个库的 id 都不会撞。
  let max = 0;
  ['terms', 'classes', 'courses', 'students', 'enrollments', 'records', 'templates'].forEach(name => {
    s[name].forEach(e => { if (typeof e.id === 'number' && e.id > max) max = e.id; });
  });
  if (max > lastId) lastId = max;
  if (which === 'demo') { demoState = s; demoReady = true; }
  else { realState = s; ready = true; }
}

const hydrate = loaded => hydrateInto('real', loaded);
const hydrateDemo = loaded => hydrateInto('demo', loaded);

const isReady = () => ready;
const isDemoReady = () => demoReady;
const data = () => cur();
const coll = name => cur()[name];
const meta = () => cur().meta || {};
// 真实库的 meta：模式开关、当前登录人这类"设备级"信息只能落在真实库上，
// 否则演示模式一写就把自己关在沙盒里出不来了
const realMeta = () => realState.meta || {};

// 当前机构视图：读取一律用这个，绝不要把 coll() 直接交给页面
// 【为什么需要】coll() 返回全量（含其他机构的数据）。之前列表只过滤了"已删除"和
// "权限范围"，没过滤 orgId，实测中另一个机构的班级会直接出现在当前机构的列表里。
// 写入仍走 coll()（要保留其他机构的数据），读取走 orgColl()。
function orgColl(name) {
  const list = cur()[name] || [];
  const o = (cur().meta && cur().meta.orgId) || schema.DEFAULT_ORG;
  // orgs 集合的主键就是机构 id；其余实体靠 orgId 外键
  if (name === 'orgs') return list.filter(x => !x.removed && x.id === o);
  return list.filter(x => !x.removed && (x.orgId || o) === o);
}

function setColl(name, list) {
  cur()[name] = list;
  persist(name);
}

function writeNow(name) {
  const ok = storage.saveCollection(name, cur()[name]);
  if (!ok) lastFail = { coll: name, at: Date.now() };
  return ok;
}

function persist(name) {
  if (readOnly) { console.warn('[db] 降级态，跳过落盘', name); return false; }
  // 演示态只改内存、不落盘：演示数据包是每次启动按 demo-data 重建的，
  // 落盘反而会让"重置演示数据"失效，也可能把演示内容混进真实 key。
  if (mode === 'demo') return true;
  if (txDepth) { txDirty[name] = 1; return true; }   // 事务内：先记账，提交时一起写
  return writeNow(name);
}

/* =====================================================================
 * 事务：一次业务动作要写多个集合时用它，避免留下半成品
 * ---------------------------------------------------------------------
 * 为什么需要：结转向导一次要新建学期、复制班级、复制课程、把学生加进新班、
 * 建报名、改旧报名状态、归档旧学期——十几处写操作。中间任何一步失败
 * （空间不足、数据异常、用户中途杀掉小程序）都会留下"新班建了一半、
 * 旧学期已归档"的现场，账对不上也没法重来。
 *
 * 用法：const r = core.tx(() => { ...写...; return { ok: true, ... } });
 *   - fn 返回 { ok: false } 或抛错 → 内存整体回滚，磁盘不动
 *   - fn 正常返回 → 脏集合逐个落盘；某个写失败 → 已写的用快照恢复，整体回滚
 * 事务内不要调用 flushAll（它不受事务控制）；嵌套调用会并入外层事务。
 * ===================================================================*/
function snapState() { return JSON.parse(JSON.stringify(cur())); }

function restoreState(snap) {
  const s = cur();
  s.meta = snap.meta;
  COLLS.forEach(n => { s[n] = snap[n] || []; });
}

function tx(fn) {
  if (txDepth) return fn();          // 嵌套：并入外层，由外层决定成败
  const snap = snapState();
  txDepth = 1; txDirty = {};
  let res;
  try {
    res = fn();
  } catch (e) {
    txDepth = 0; txDirty = {};
    restoreState(snap);
    return { ok: false, msg: (e && e.message) || '操作中断，已回滚' };
  }
  txDepth = 0;
  const dirty = Object.keys(txDirty);
  txDirty = {};

  // 业务主动判失败（比如"班级名重复"）：回滚，磁盘本来就没动
  if (res && res.ok === false) { restoreState(snap); return res; }

  // 演示态不落盘，直接成功
  if (mode === 'demo' || readOnly) return res || { ok: true };

  const written = [];
  let ok = true;
  for (let i = 0; i < dirty.length; i++) {
    if (!writeNow(dirty[i])) { ok = false; break; }
    written.push(dirty[i]);
  }
  if (ok) return res || { ok: true };

  // 落盘失败：把已经写进去的几个集合用快照写回旧值，尽量让磁盘与内存都回到事务前
  restoreState(snap);
  written.forEach(n => writeNow(n));
  return { ok: false, msg: SAVE_FAIL };
}

function setReadOnly(v) { readOnly = !!v; }
const isReadOnly = () => readOnly;

function flushAll() {
  if (readOnly) { console.warn('[db] 降级态，跳过全量落盘'); return false; }
  if (mode === 'demo') return true;
  let ok = true;
  storage.COLLECTIONS.forEach(name => { if (!writeNow(name)) ok = false; });
  if (realState.meta) storage.saveMeta(realState.meta);
  return ok;
}

function updateMeta(patch) {
  cur().meta = Object.assign({}, cur().meta, patch);
  if (!readOnly && mode === 'real') storage.saveMeta(cur().meta);
  return cur().meta;
}

// 设备级 meta 必须写到真实库：进入/退出演示、记住当前身份这类开关都走这里
function updateRealMeta(patch) {
  realState.meta = Object.assign({}, realState.meta, patch);
  if (!readOnly) storage.saveMeta(realState.meta);
  return realState.meta;
}

function setMode(m) {
  mode = m === 'demo' && demoReady ? 'demo' : 'real';
  return mode;
}

// 单调递增 id：Date.now() 与"上一个 id + 1"取大，保证同一毫秒内连续创建也不撞号
function nextId() {
  const t = Date.now();
  lastId = t > lastId ? t : lastId + 1;
  return lastId;
}

// 存储健康度：给「我的 · 存储空间」页看。一次读取失败就是一次静默丢数据的机会，
// 让用户能自己看见"上次没存上"比在控制台打日志有用得多。
function health() {
  return {
    usage: storage.kvUsage(),
    lastFail,
    readOnly,
    mode,
    counts: COLLS.reduce((o, n) => { o[n] = (cur()[n] || []).length; return o; }, {})
  };
}

module.exports = {
  hydrate, hydrateDemo, isReady, isDemoReady, data, coll, orgColl, meta, realMeta,
  setColl, persist, flushAll, updateMeta, updateRealMeta, setMode, isSandbox, nextId,
  setReadOnly, isReadOnly, EMPTY, tx, health, SAVE_FAIL
};
