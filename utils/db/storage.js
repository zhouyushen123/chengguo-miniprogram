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
// 【分片：records 一个 key 装不下】
// 微信硬限制是「单个 key 1MB」，不是整个存储 1MB（总量 10MB）。records 是唯一会
// 无限增长的集合：一条记录 250~760 字节，一条带 3 张照片的记录 760 字节，
// 45 个学生每天一条，约 30 天就顶到 1MB。顶到之后 setStorageSync 抛异常，
// 以前是被 catch 掉返回 false，页面照样弹「已保存」——用户不知道自己丢了东西。
// 所以 records 按条数切片：records / records_2 / records_3 ...，每片 ≤320 条
// （最坏 760 字节 × 320 ≈ 243KB，离 1MB 有 4 倍余量）。
// 读的时候不需要索引：从第一片往后读，读到空片或没填满的片就停，老的单 key 数据
// 天然就是"只有第一片"，无需迁移。写的时候把多出来的旧分片删掉。
//
// 【换云端怎么做】新增 cloudAdapter，实现同样的 load / saveCollection / saveMeta / removeAll 接口：
//   - load()          启动时一次性把远端数据水合成同样结构（可改为异步 hydrate）
//   - saveCollection() 落盘同时把变更推给远端（失败进重试队列）
// 演示命名空间只存在于本地，云端永远只有真实数据 —— 换适配器时 demo 那套不参与同步。
const PREFIX = 'chengguo_v3_';
const DEMO_PREFIX = 'chengguo_demo_';
const META_KEY = 'meta';
const CHUNK_KEY = 'chunks';     // 各集合的分片数量索引，只用于清理旧分片

// 实体集合（顺序即初始化顺序，被 load 与迁移共用）
// orgs / members 是机构与成员关系：权限的唯一来源，云端对应 org 表与 member 授权表
// terms / enrollments 是学期与报名（课时账本）：学期制与结转制的载体
const COLLECTIONS = ['orgs', 'members', 'terms', 'classes', 'courses', 'students', 'enrollments', 'records', 'users', 'templates'];

// 需要分片的集合 → 每片最多多少条
// 只有"随上课天数线性增长"的集合才需要分片；其余集合体量由机构规模决定，不会失控
const SHARD = { records: 320 };
const MAX_SHARDS = 64;          // 兜底上限：320 × 64 ≈ 2 万条记录

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
      // 单 key 超 1MB 或总量超 10MB 都在这里失败，返回 false 由上层提示用户
      console.error('[db] 写入失败', tag, key, e);
      return false;
    }
  }
  function drop(key) {
    try { wx.removeStorageSync(prefix + key); return true; } catch (e) { return false; }
  }
  // 第 n 片（n 从 1 起）。第一片沿用集合本名，保持与老数据兼容
  const shardKey = (name, n) => (n === 1 ? name : name + '_' + n);

  // 读一个集合：分片集合逐片读到尽头，普通集合直接读
  function readColl(name) {
    if (!SHARD[name]) {
      const v = read(name);
      return Array.isArray(v) ? v : [];
    }
    const size = SHARD[name];
    const out = [];
    for (let n = 1; n <= MAX_SHARDS; n++) {
      const v = read(shardKey(name, n));
      if (!Array.isArray(v)) break;          // 空片 = 到头了
      out.push.apply(out, v);
      // 只有"刚好填满"才说明后面还有下一片。
      // v.length > size 是老版本的单 key 全量数据（那时还没分片），本身就是完整集合。
      if (v.length !== size) break;
    }
    return out;
  }

  function writeColl(name, list) {
    if (!SHARD[name]) return write(name, list);
    const size = SHARD[name];
    const arr = Array.isArray(list) ? list : [];
    const total = Math.max(1, Math.ceil(arr.length / size));   // 空集合也写第一片，保证"读取时存在"
    let ok = true;
    for (let n = 1; n <= total; n++) {
      if (!write(shardKey(name, n), arr.slice((n - 1) * size, n * size))) ok = false;
    }
    // 清掉上一次留下的多余分片（记录被删/清空后又变少时）
    const idx = read(CHUNK_KEY);
    const old = (idx && idx[name]) || 0;
    for (let n = total + 1; n <= old; n++) drop(shardKey(name, n));
    if (old !== total) {
      const next = Object.assign({}, idx || {});
      next[name] = total;
      write(CHUNK_KEY, next);
    }
    return ok;
  }

  // 一次性加载全部集合（启动时调用一次）
  function load() {
    const out = { meta: read(META_KEY) };
    COLLECTIONS.forEach(name => { out[name] = readColl(name); });
    return out;
  }
  function saveCollection(name, list) {
    if (COLLECTIONS.indexOf(name) < 0) { console.error('[db] 未知集合', tag, name); return false; }
    return writeColl(name, list);
  }
  function saveMeta(meta) { return write(META_KEY, meta); }
  function removeAll() {
    try {
      COLLECTIONS.forEach(n => {
        wx.removeStorageSync(prefix + n);
        for (let i = 2; i <= MAX_SHARDS; i++) wx.removeStorageSync(prefix + shardKey(n, i));
      });
      wx.removeStorageSync(prefix + META_KEY);
      wx.removeStorageSync(prefix + CHUNK_KEY);
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

// 本地 key-value 用量（KB）。用系统接口而不是自己累加：自己算容易漏掉 meta/分片/别人的 key。
// 拿不到时返回 null，页面显示"未知"而不是显示 0（0 会让人以为空间很充足）。
function kvUsage() {
  try {
    const i = wx.getStorageInfoSync();
    return {
      current: i.currentSize || 0,       // KB
      limit: i.limitSize || 0,           // KB
      keys: (i.keys || []).length
    };
  } catch (e) { return null; }
}

module.exports = {
  COLLECTIONS, PREFIX, DEMO_PREFIX, META_KEY, CHUNK_KEY, LEGACY_DB_KEY, LEGACY_TPL_KEY, SHARD,
  load: local.load,
  saveCollection: local.saveCollection,
  saveMeta: local.saveMeta,
  removeAll: local.removeAll,
  demo: demoNs,
  readLegacy, kvUsage
};
