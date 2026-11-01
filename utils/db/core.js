// utils/db/core.js —— 内存态与落盘
//
// 设计：启动时把全部集合水合到内存（storage.load），所有读操作走内存（页面渲染零延迟），
// 写操作改内存后立刻落盘。将来换云端时，读仍是内存、写变成"内存 + 异步推送"，
// 页面拿到的仍是同步结果，不用改成 await。
const storage = require('./storage');
const schema = require('./schema');

const EMPTY = {
  meta: null, orgs: [], members: [], classes: [], courses: [],
  students: [], records: [], users: [], templates: []
};

let state = Object.assign({}, EMPTY);
let lastId = 0;
let ready = false;
// 降级态：启动失败（读盘异常 / 数据损坏）时为 true。
// 此时内存里是空库，绝不能落盘——否则会拿空库把磁盘上的真实数据覆盖掉，
// 一次读取失败就变成永久数据丢失。
let readOnly = false;

function hydrate(loaded) {
  state = Object.assign({}, EMPTY);
  storage.COLLECTIONS.forEach(name => {
    state[name] = Array.isArray(loaded[name]) ? loaded[name] : [];
  });
  state.meta = loaded.meta || null;
  // id 分配器从现有最大值起步，避免系统时间回拨时生成重复 id
  let max = 0;
  ['classes', 'courses', 'students', 'records', 'templates'].forEach(name => {
    state[name].forEach(e => { if (typeof e.id === 'number' && e.id > max) max = e.id; });
  });
  lastId = max;
  ready = true;
}

const isReady = () => ready;
const data = () => state;
const coll = name => state[name];
const meta = () => state.meta || {};

// 当前机构视图：读取一律用这个，绝不要把 coll() 直接交给页面
// 【为什么需要】coll() 返回全量（含其他机构的数据）。之前列表只过滤了"已删除"和
// "权限范围"，没过滤 orgId，实测中另一个机构的班级会直接出现在当前机构的列表里。
// 写入仍走 coll()（要保留其他机构的数据），读取走 orgColl()。
function orgColl(name) {
  const list = state[name] || [];
  const o = (state.meta && state.meta.orgId) || schema.DEFAULT_ORG;
  // orgs 集合的主键就是机构 id；其余实体靠 orgId 外键
  if (name === 'orgs') return list.filter(x => !x.removed && x.id === o);
  return list.filter(x => !x.removed && (x.orgId || o) === o);
}

function setColl(name, list) {
  state[name] = list;
  persist(name);
}

function persist(name) {
  if (readOnly) { console.warn('[db] 降级态，跳过落盘', name); return false; }
  return storage.saveCollection(name, state[name]);
}

function setReadOnly(v) { readOnly = !!v; }
const isReadOnly = () => readOnly;

function flushAll() {
  if (readOnly) { console.warn('[db] 降级态，跳过全量落盘'); return false; }
  let ok = true;
  storage.COLLECTIONS.forEach(name => { if (!persist(name)) ok = false; });
  if (state.meta) storage.saveMeta(state.meta);
  return ok;
}

function updateMeta(patch) {
  state.meta = Object.assign({}, state.meta, patch);
  if (!readOnly) storage.saveMeta(state.meta);
  return state.meta;
}

// 单调递增 id：Date.now() 与"上一个 id + 1"取大，保证同一毫秒内连续创建也不撞号
function nextId() {
  const t = Date.now();
  lastId = t > lastId ? t : lastId + 1;
  return lastId;
}

module.exports = {
  hydrate, isReady, data, coll, orgColl, meta, setColl, persist, flushAll, updateMeta, nextId,
  setReadOnly, isReadOnly, EMPTY
};
