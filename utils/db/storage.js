// utils/db/storage.js —— 存储适配器（本地实现）
//
// 【唯一的落盘位置】全项目只有这个文件碰 wx.setStorageSync / wx.getStorageSync。
//
// 【两套命名空间：真实数据与演示数据磁盘级分离】
//   真实：chengguo_v3_orgs / _members / _classes / _courses / _students / _records / _users / _templates
//   演示：chengguo_demo_orgs / _members / ...（结构一模一样，key 前缀不同）
// 为什么不用"同表加 demo 标记"：标记法的隔离靠每一处查询都记得 `!demo` 来维持，
// 新增一个统计、一个筛选、一次导出，漏写一次演示数据就混进真实数据里；
// 而"换一套 key"是结构性的——演示数据再怎么重播、清空、改造，物理上都碰不到真实数据。
//
// 【注意】前缀固定为 v3，不跟着 schema 版本走。版本号只记在 meta.version 里，
// 这样每次升级都是「原地加字段/加集合」，不会因为换 key 把老师手机上的历史数据读丢。
//
// 【换云端怎么做】新增 cloudAdapter，实现同样的 load / saveCollection / saveMeta / removeAll 接口：
//   - load()          启动时一次性把远端数据水合成同样结构（可改为异步 hydrate）
//   - saveCollection() 落盘同时把变更推给远端（失败进重试队列）
// 演示命名空间只存在于本地，云端永远只有真实数据 —— 换适配器时 demo 那套不参与同步。
const PREFIX = 'chengguo_v3_';
const DEMO_PREFIX = 'chengguo_demo_';
const META_KEY = 'meta';

// 实体集合（顺序即初始化顺序，被 load 与迁移共用）
// orgs / members 是机构与成员关系：权限的唯一来源，云端对应 org 表与 member 授权表
// terms / enrollments 是学期与报名（课时账本）：学期制与结转制的载体
const COLLECTIONS = ['orgs', 'members', 'terms', 'classes', 'courses', 'students', 'enrollments', 'records', 'users', 'templates'];

// v2 遗留的单一大对象（迁移源，保留不动作为兜底备份）
const LEGACY_DB_KEY = 'chengguo_v2';
const LEGACY_TPL_KEY = 'chengguo_tpls';

// 一个命名空间 = 一套完整的 load/save/remove，前缀不同而已
function makeNs(prefix, tag) {
  function read(key) {
    try {
      const v = wx.getStorageSync(prefix + key);
      return v === '' || v === undefined ? null : v;
    } catch (e) {
      console.error('[db] 读取失败', tag, key, e);
      return null;
    }
  }
  function write(key, value) {
    try {
      wx.setStorageSync(prefix + key, value);
      return true;
    } catch (e) {
      // 本地存储超限（10MB）时最可能在这里失败，返回 false 由上层提示
      console.error('[db] 写入失败', tag, key, e);
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
    if (COLLECTIONS.indexOf(name) < 0) { console.error('[db] 未知集合', tag, name); return false; }
    return write(name, list);
  }
  function saveMeta(meta) { return write(META_KEY, meta); }
  function removeAll() {
    try {
      COLLECTIONS.forEach(n => wx.removeStorageSync(prefix + n));
      wx.removeStorageSync(prefix + META_KEY);
      return true;
    } catch (e) { return false; }
  }
  return { load, saveCollection, saveMeta, removeAll };
}

const local = makeNs(PREFIX, 'real');
const demoNs = makeNs(DEMO_PREFIX, 'demo');

// 遗留数据（只读，迁移用）
function readLegacy() {
  let db = null, tpls = null;
  try { db = wx.getStorageSync(LEGACY_DB_KEY) || null; } catch (e) { db = null; }
  try { tpls = wx.getStorageSync(LEGACY_TPL_KEY) || null; } catch (e) { tpls = null; }
  return { db, tpls };
}

module.exports = {
  COLLECTIONS, PREFIX, DEMO_PREFIX, META_KEY, LEGACY_DB_KEY, LEGACY_TPL_KEY,
  load: local.load,
  saveCollection: local.saveCollection,
  saveMeta: local.saveMeta,
  removeAll: local.removeAll,
  demo: demoNs,
  readLegacy
};
