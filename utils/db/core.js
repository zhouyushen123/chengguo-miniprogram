// utils/db/core.js —— 内存态与落盘
//
// 设计：启动时把全部集合水合到内存（storage.load），所有读操作走内存（页面渲染零延迟），
// 写操作改内存后立刻落盘。将来换云端时，读仍是内存、写变成"内存 + 异步推送"，
// 页面拿到的仍是同步结果，不用改成 await。
const storage = require('./storage');
const schema = require('./schema');

const EMPTY = { meta: null, classes: [], courses: [], students: [], records: [], users: [], templates: [] };

let state = Object.assign({}, EMPTY);
let lastId = 0;
let ready = false;

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

function setColl(name, list) {
  state[name] = list;
  persist(name);
}

function persist(name) { return storage.saveCollection(name, state[name]); }

function flushAll() {
  let ok = true;
  storage.COLLECTIONS.forEach(name => { if (!persist(name)) ok = false; });
  if (state.meta) storage.saveMeta(state.meta);
  return ok;
}

function updateMeta(patch) {
  state.meta = Object.assign({}, state.meta, patch);
  storage.saveMeta(state.meta);
  return state.meta;
}

// 单调递增 id：Date.now() 与"上一个 id + 1"取大，保证同一毫秒内连续创建也不撞号
function nextId() {
  const t = Date.now();
  lastId = t > lastId ? t : lastId + 1;
  return lastId;
}

module.exports = { hydrate, isReady, data, coll, meta, setColl, persist, flushAll, updateMeta, nextId, EMPTY };
