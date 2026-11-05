// utils/db/storage.js —— 存储适配器（本地实现）
//
// 【唯一的落盘位置】全项目只有这个文件碰 wx.setStorageSync / wx.getStorageSync。
//
// 【两套命名空间：真实数据与演示数据磁盘级分离】
//   真实：chengguo_v3_<集合名>    演示：chengguo_demo_<集合名>（结构一模一样，key 前缀不同）
//   集合名以 COLLECTIONS 为准，这里不再抄一遍清单——抄过的那份已经腐烂过一次。
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
// 【不要在这里加集合名】清单的唯一来源是 entities.js —— 以前这里、core、sync、
// syncv2、backup、admin 各抄一份，加表漏改一处就会出现"本地能存、云端没有"的静默分裂。
const entities = require('./entities');
const COLLECTIONS = entities.ALL_COLLS.slice();

// 需要分片的集合 → 每片最多多少条
// 只有"随上课天数线性增长"的集合才需要分片；其余集合体量由机构规模决定，不会失控
const SHARD = { records: 320 };
const MAX_SHARDS = 96;          // 兜底上限：320 × 96 ≈ 3 万条记录（再多会先撞 10MB 总配额，那条路有明确提示）

// v2 遗留的单一大对象（迁移源，保留不动作为兜底备份）
const LEGACY_DB_KEY = 'chengguo_v2';
const LEGACY_TPL_KEY = 'chengguo_tpls';

// 一个命名空间 = 一套完整的 load/save/remove，前缀不同而已
function makeNs(prefix, tag) {
  // 【读失败 ≠ 没有数据】这个区分是整个数据层最重要的一条。
  // 以前两者都返回 null：某一分片读异常 → 被当成"到这里就没了" → 后面所有记录静默消失，
  // 而下一次任何写入都会把这份残缺集合覆盖回磁盘 —— 一次读取抖动就变成永久丢失。
  // 现在 readState 把异常单独标出来，readColl 把它记进 damage，启动时据此走恢复流程。
  function readState(key) {
    try {
      const v = wx.getStorageSync(prefix + key);
      return { v: (v === '' || v === undefined ? null : v) };
    } catch (e) {
      console.error('[db] 读取失败', tag, key, e);
      return { err: e };
    }
  }
  function read(key) {
    const r = readState(key);
    return r.err ? null : r.v;
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

  /* ---------------- 脏片写：没变的片不再落盘 ----------------
   * 分片只解决了「单 key 装不下」，没解决「每次写都把整个集合重刷一遍」：
   * 录一条记录，前面几片的内容一个字都没变，却照样进了 setStorageSync。
   * 实测 2000 条记录时，落盘次数从 2000 次涨到 7287 次（分片越多越糟），
   * 而 setStorageSync 是同步 IO，真机上每次都是毫秒级的主线程阻塞。
   *
   * 这里给每片记一个「上次写进去的内容指纹」，写之前先比：
   * 一样就跳过，不一样才落盘。追加一条记录时只有最后一片会变，于是回到 1 次 IO。
   *
   * 为什么用「内容指纹」而不是「引用比较」或「updatedAt 比较」：
   *   - 引用比较没用：写路径改的是内存里的同一个对象，引用永远相等；
   *   - updatedAt 比较会漏写：repairRefs / 迁移这类自愈路径会改字段而不动时间戳。
   * 指纹用 djb2 + 长度双校验，320 条的片碰撞概率可以忽略；万一真碰撞，
   * 代价是「这次没写」，而下次任何真实变更都会让指纹失配 —— 不会永久性丢数据。
   */
  const PRINT = Object.create(null);   // 片 key → 'hash:len'
  function printOf(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h + ':' + s.length;
  }
  function writeShard(key, value) {
    let s;
    try { s = JSON.stringify(value); } catch (e) { return write(key, value); }  // 环形结构等异常数据，退回原路
    const p = printOf(s);
    if (PRINT[key] === p) return true;      // 一字未变，跳过这次同步 IO
    if (!write(key, value)) return false;
    PRINT[key] = p;
    return true;
  }

  // 读一个集合：分片集合逐片读到尽头，普通集合直接读。
  // damage 传数组时，读异常会往里记一条（'students' 或 'records#3'），
  // 调用方据此判定"这份数据不完整，不能拿它覆盖磁盘"。
  function readColl(name, damage) {
    const hit = e => { if (damage) damage.push(e); };
    if (!SHARD[name]) {
      const r = readState(name);
      if (r.err) { hit(name); return null; }
      return Array.isArray(r.v) ? r.v : [];
    }
    const size = SHARD[name];
    const out = [];
    for (let n = 1; n <= MAX_SHARDS; n++) {
      const r = readState(shardKey(name, n));
      // 读异常：后面的片不能再假设"没有了"，整份集合判定为不可信
      if (r.err) { hit(name + '#' + n); return null; }
      const v = r.v;
      if (!Array.isArray(v)) break;          // 空片 = 到头了
      out.push.apply(out, v);
      // 只有"刚好填满"才说明后面还有下一片。
      // v.length > size 是老版本的单 key 全量数据（那时还没分片），本身就是完整集合。
      if (v.length !== size) break;
    }
    return out;
  }

  function writeColl(name, list) {
    if (!SHARD[name]) return writeShard(name, list);
    const size = SHARD[name];
    const arr = Array.isArray(list) ? list : [];
    const total = Math.max(1, Math.ceil(arr.length / size));   // 空集合也写第一片，保证"读取时存在"
    // 超过上限必须显式失败：以前会照写不误，而读取只读到 MAX_SHARDS 片，
    // 超出的部分永远读不回来 —— 老师看到的条数突然少了一截，还以为是自己记错了。
    if (total > MAX_SHARDS) {
      console.error('[db] 集合过大，超出分片上限', name, arr.length, total, MAX_SHARDS);
      return false;
    }

    // 先把"需要写的片"筛出来（内容没变的不动，省一次同步 IO），并备份它们的旧内容。
    // 备份是为了失败时能整片回滚：以前第 3 片写失败、前 2 片已经落盘，
    // 磁盘上就变成"前半段新数据 + 后半段旧数据"，比整份没写还难收拾。
    const plan = [];
    for (let n = 1; n <= total; n++) {
      const key = shardKey(name, n);
      const slice = arr.slice((n - 1) * size, n * size);
      let s = null;
      try { s = JSON.stringify(slice); } catch (e) { s = null; }
      if (s !== null && PRINT[key] === printOf(s)) continue;
      const prev = readState(key);
      plan.push({ key, slice, s, prev: prev.err ? { unknown: true } : { v: prev.v } });
    }
    if (!plan.length) return true;

    let ok = true, done = 0;
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      const wrote = p.s === null ? write(p.key, p.slice) : write(p.key, p.slice);
      if (!wrote) { ok = false; break; }
      if (p.s !== null) PRINT[p.key] = printOf(p.s);
      done++;
    }
    if (!ok) {
      // 回滚已写的片，让磁盘回到这次写入之前的样子
      for (let i = done - 1; i >= 0; i--) {
        const b = plan[i];
        try {
          if (b.prev.unknown) { /* 旧值读不出来，只能保留现状 */ }
          else if (b.prev.v === null) drop(b.key);
          else write(b.key, b.prev.v);
        } catch (e) { /* 回滚也可能失败（配额满），下一次写入会再试 */ }
        delete PRINT[b.key];
      }
      return false;
    }

    // 清掉上一次留下的多余分片（记录被删/清空后又变少时）
    const idx = read(CHUNK_KEY);
    const old = (idx && idx[name]) || 0;
    for (let n = total + 1; n <= old; n++) {
      const k = shardKey(name, n);
      drop(k);
      delete PRINT[k];          // 片没了，指纹也要跟着清，否则重新长出这一片时会被误判成"没变"
    }
    if (old !== total) {
      const next = Object.assign({}, idx || {});
      next[name] = total;
      write(CHUNK_KEY, next);
    }
    return true;
  }

  // 一次性加载全部集合（启动时调用一次）
  function load() {
    // 指纹缓存只是"上次这个 key 我写了什么"的记忆。系统清理缓存、换设备、
    // 或用户在系统设置里清了小程序存储之后，它就和磁盘对不上了；
    // 继续信它会让下一次写入被误判成"没变"而被跳过 —— 用户看到"已保存"，磁盘却是空的。
    Object.keys(PRINT).forEach(k => { delete PRINT[k]; });
    const damage = [];
    const metaR = readState(META_KEY);
    if (metaR.err) damage.push('meta');
    const out = { meta: metaR.err ? null : metaR.v };
    COLLECTIONS.forEach(name => {
      const list = readColl(name, damage);
      // 读不出来的集合先给空数组占位，但 damage 里已经留了记录：
      // 上层看到 _damage 就知道这份数据不可信，绝不会把它写回磁盘
      out[name] = list === null ? [] : list;
    });
    if (damage.length) out._damage = damage;
    return out;
  }
  function saveCollection(name, list) {
    if (COLLECTIONS.indexOf(name) < 0) { console.error('[db] 未知集合', tag, name); return false; }
    return writeColl(name, list);
  }
  function saveMeta(meta) { return writeShard(META_KEY, meta); }
  function removeAll() {
    try {
      COLLECTIONS.forEach(n => {
        wx.removeStorageSync(prefix + n);
        for (let i = 2; i <= MAX_SHARDS; i++) wx.removeStorageSync(prefix + shardKey(n, i));
      });
      wx.removeStorageSync(prefix + META_KEY);
      wx.removeStorageSync(prefix + CHUNK_KEY);
      Object.keys(PRINT).forEach(k => { delete PRINT[k]; });   // 清空后指纹失效，否则重建同内容会被跳过
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

/* =====================================================================
 * 快照：核心资产的本地副本
 * ---------------------------------------------------------------------
 * 为什么需要：本地只有一份数据，写坏了、迁移出错了、被误清了，就再也没有第二份。
 * 云端虽然有，但没网/没部署时等于没有；而且云端是 LWW 合并，救不回"被新值覆盖掉的旧值"。
 *
 * 备份什么：学生、成员（老师）、班级、机构、学期、报名、记录、模板 —— 全量。
 * 唯一的例外是 records：它随上课天数无限增长，整份塞进来会把 10MB 配额吃光，
 * 反而让日常写入更容易失败。所以记录只留最近 300 条；更早的云端有。
 *
 * 保留几份：3 份滚动。按"迁移前 / 每天首次启动 / 手动"三个时机打点，
 * 一天最多一份日常快照，所以 3 份大约覆盖最近三天的状态。
 *
 * 【快照不参与同步、不进演示命名空间、清库时也不删】—— 它是安全网，不是业务数据。
 * ===================================================================*/
const SNAP_PREFIX = 'chengguo_snap_';
const SNAP_INDEX = 'chengguo_snaps';
const SNAP_KEEP = 3;
const SNAP_MAX_BYTES = 900 * 1024;    // 单份上限（单 key 1MB 硬限制，留 100KB 余量）
const SNAP_REC_CAP = 300;             // 快照里最多保留多少条记录

// 精确字节数（微信按 UTF-8 字节计，中文字符占 3 字节，用 s.length 会低估 3 倍）
function byteLen(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }   // 代理对（emoji）
    else n += 3;
  }
  return n;
}

function snapIndex() {
  try {
    const v = wx.getStorageSync(SNAP_INDEX);
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}
function snapSaveIndex(list) {
  try { wx.setStorageSync(SNAP_INDEX, list); return true; } catch (e) { return false; }
}
function snapDrop(id) {
  try { wx.removeStorageSync(SNAP_PREFIX + id); } catch (e) { /* 删不掉不影响新快照 */ }
}

// 生成一份快照。data 传内存里的完整集合（{ students: [...], ... }）。
// tag 只用于界面显示（"迁移前"/"每日备份"/"手动备份"）。
function saveSnapshot(tag, data) {
  if (!data) return { ok: false, msg: '没有可备份的数据' };
  const at = Date.now();
  const id = String(at);
  // meta 也要一起存：机构号、机构名、当前身份、"上次同步游标"全在里面。
  // 少了它，恢复回来的数据会因为"没有机构号"被判成全新安装，等于白备份。
  const meta = (data && data.meta) || null;
  const pack = d => JSON.stringify({ v: 1, at, tag: String(tag || ''), meta, data: d });
  const body = {};
  COLLECTIONS.forEach(n => { body[n] = Array.isArray(data[n]) ? data[n] : []; });

  let s = pack(body);
  // 超限先裁记录（唯一会无限增长的那个），核心资产一条都不裁
  if (byteLen(s) > SNAP_MAX_BYTES && body.records.length > SNAP_REC_CAP) {
    body.records = body.records.slice(-SNAP_REC_CAP);
    s = pack(body);
  }
  if (byteLen(s) > SNAP_MAX_BYTES) {
    return { ok: false, msg: '数据量过大，无法生成本地备份（建议先到电脑端后台导出）' };
  }

  // 先腾地方：保留份数超了、或剩余空间不够放这一份，就从最旧的开始删
  let idx = snapIndex().filter(x => x && x.id !== id);
  const need = byteLen(s) / 1024;
  const usage = kvUsage();
  let guard = 0;
  while (idx.length && (idx.length >= SNAP_KEEP ||
        (usage && usage.limit && usage.limit - usage.current < need + 200)) && guard++ < 10) {
    const old = idx.pop();
    snapDrop(old.id);
  }
  while (idx.length >= SNAP_KEEP) snapDrop(idx.pop().id);

  try {
    wx.setStorageSync(SNAP_PREFIX + id, JSON.parse(s));
  } catch (e) {
    console.error('[db] 快照写入失败', e);
    return { ok: false, msg: '存储空间不足，备份失败' };
  }
  idx = [{ id, at, tag: String(tag || ''), bytes: byteLen(s), counts: countOf(body) }].concat(idx);
  while (idx.length > SNAP_KEEP) { const o = idx.pop(); snapDrop(o.id); }
  snapSaveIndex(idx);
  return { ok: true, id, at, bytes: byteLen(s), counts: countOf(body) };
}

function countOf(body) {
  const c = {};
  COLLECTIONS.forEach(n => { c[n] = (body[n] || []).length; });
  return c;
}

function snapshotList() { return snapIndex(); }

function readSnapshot(id) {
  try {
    const v = wx.getStorageSync(SNAP_PREFIX + id);
    if (!v || !v.data) return null;
    return v;
  } catch (e) { return null; }
}
function latestSnapshot() {
  const list = snapIndex();
  for (let i = 0; i < list.length; i++) {
    const s = readSnapshot(list[i].id);
    if (s) return Object.assign({ id: list[i].id }, s);
  }
  return null;
}
function dropSnapshot(id) {
  snapDrop(id);
  snapSaveIndex(snapIndex().filter(x => x.id !== id));
  return true;
}

module.exports = {
  COLLECTIONS, PREFIX, DEMO_PREFIX, META_KEY, CHUNK_KEY, LEGACY_DB_KEY, LEGACY_TPL_KEY, SHARD, MAX_SHARDS,
  load: local.load,
  saveCollection: local.saveCollection,
  saveMeta: local.saveMeta,
  removeAll: local.removeAll,
  demo: demoNs,
  readLegacy, kvUsage,
  saveSnapshot, snapshotList, readSnapshot, latestSnapshot, dropSnapshot, byteLen
};
