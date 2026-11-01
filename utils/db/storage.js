// utils/db/storage.js —— 存储适配器（本地实现）
//
// 【唯一的落盘位置】全项目只有这个文件碰 wx.setStorageSync / wx.getStorageSync。
// 存储形态：一类实体一个 key（chengguo_v3_classes / _courses / _students / _records / _users / _templates）
// 每个 key 对应将来云端的一张表，迁移时一一对应即可。
//
// 【换云端怎么做】新增 cloudAdapter，实现同样的 load / saveCollection / saveMeta / removeCollection 接口：
//   - load()          启动时一次性把远端数据水合成同样结构（可改为异步 hydrate）
//   - saveCollection() 落盘同时把变更推给远端（失败进重试队列）
// 仓储层与页面代码都不需要改。
const PREFIX = 'chengguo_v3_';
const META_KEY = 'meta';

// 实体集合（顺序即初始化顺序，被 load 与迁移共用）
const COLLECTIONS = ['classes', 'courses', 'students', 'records', 'users', 'templates'];

// v2 遗留的单一大对象（迁移源，保留不动作为兜底备份）
const LEGACY_DB_KEY = 'chengguo_v2';
const LEGACY_TPL_KEY = 'chengguo_tpls';

function read(key) {
  try {
    const v = wx.getStorageSync(PREFIX + key);
    return v === '' || v === undefined ? null : v;
  } catch (e) {
    console.error('[db] 读取失败', key, e);
    return null;
  }
}

function write(key, value) {
  try {
    wx.setStorageSync(PREFIX + key, value);
    return true;
  } catch (e) {
    // 本地存储超限（10MB）时最可能在这里失败，返回 false 由上层提示
    console.error('[db] 写入失败', key, e);
    return false;
  }
}

// 一次性加载全部集合（启动时调用一次）
function load() {
  const out = { meta: read(META_KEY) };
  COLLECTIONS.forEach(name => {
    const v = read(name);
    out[name] = Array.isArray(v) ? v : [];
  });
  return out;
}

function saveCollection(name, list) {
  if (COLLECTIONS.indexOf(name) < 0) { console.error('[db] 未知集合', name); return false; }
  return write(name, list);
}

function saveMeta(meta) { return write(META_KEY, meta); }

function removeAll() {
  try {
    COLLECTIONS.forEach(n => wx.removeStorageSync(PREFIX + n));
    wx.removeStorageSync(PREFIX + META_KEY);
    return true;
  } catch (e) { return false; }
}

// 遗留数据（只读，迁移用）
function readLegacy() {
  let db = null, tpls = null;
  try { db = wx.getStorageSync(LEGACY_DB_KEY) || null; } catch (e) { db = null; }
  try { tpls = wx.getStorageSync(LEGACY_TPL_KEY) || null; } catch (e) { tpls = null; }
  return { db, tpls };
}

module.exports = {
  COLLECTIONS, PREFIX, META_KEY, LEGACY_DB_KEY, LEGACY_TPL_KEY,
  load, saveCollection, saveMeta, removeAll, readLegacy
};
