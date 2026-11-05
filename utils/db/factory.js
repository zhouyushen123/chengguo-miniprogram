// utils/db/factory.js —— 回到出厂：把本机清空并按当前 schema 重建
//
// 【为什么单独成文件】它和 maintenance（启动/自愈/演示/合并）职责不同：
// maintenance 是"每次启动都要跑的一整套"，本文件是"只在坏档时才按一下的红色按钮"。
// 放一起会把 maintenance 顶过 500 行上限，也会让两个不同生命周期的东西混在一处。
//
// 【为什么必须有这个出口】数据层是 fail-closed 的：没有成员记录 → actor 为空 →
// 一切写操作都被拦（提示「请先登录」），连「开通向导」第一步的 db.orgs.update
// 都过不了权限闸。于是出现死结：机构在、成员没了，用户既改不了也建不了。
// 2026-11-05 真机就卡在这里，当时界面上没有任何自救入口。
//
// 【只清本机，不碰云端】云端数据一条不动；重置后重走开通向导，
// 第一次同步会重新绑定机构并把新内容推上去。
const storage = require('./storage');
const migrate = require('./migrate');
const core = require('./core');
const schema = require('./schema');
const entities = require('./entities');
const ctx = require('./ctx');

const { actor, pushSaved } = ctx;

function resetReal() {
  if (core.isSandbox()) return { ok: false, msg: '演示数据里不能重置本机数据' };
  if (core.isReadOnly()) return { ok: false, msg: '当前是只读模式，请重启小程序后再重置' };
  storage.removeAll();
  const fresh = migrate.buildFresh(Date.now(), { sample: false });
  core.hydrate(fresh);
  const ok = core.flushAll();
  if (!ok) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, orgId: fresh.meta.orgId, members: fresh.members.length };
}

/* ---------------------------------------------------------------------
 * 半坏档自救：机构在、成员表空（或全死行）→ actor 为空 → 一切写被「请先登录」拦住
 *
 * 2026-11-05/06 真机两次卡死在这：昨晚只在存储页留了「重置本机数据」，但用户
 * 不知道入口在哪，向导第一步照旧弹「请先登录」。自救必须长在被卡住的地方。
 *
 * 分两档，按「业务数据还在不在」选，绝不清掉还有用的数据：
 *  A. 本机构没有任何业务数据 → resetReal()（空壳，回出厂最干净；云端有货会拉回来）
 *  B. 学生/记录等还在、只是身份没了 → 原地重建负责人（新 user + 新 member，挂现有机构下），
 *     新行不会被旧死行的合并覆盖（合并按 id 走，新 id 是全新行），数据原地就能看到。
 * 返回 code：FINE（本来就好）/ RESET（回出厂）/ REBUILT（重建身份）/ FAIL。
 */
function repairIdentity() {
  if (core.isSandbox()) return { ok: false, code: 'SANDBOX', msg: '演示数据是样板间，不能修复' };
  if (core.isReadOnly()) return { ok: false, code: 'READONLY', msg: core.SAVE_FAIL };
  if (actor()) return { ok: true, code: 'FINE' };

  const raw = core.realData() || {};
  const alive = n => (Array.isArray(raw[n]) ? raw[n] : []).filter(x => x && !x.removed);
  const cur = String(core.meta().orgId || '');
  const orgs = alive('orgs');
  // 本机构业务数据量（orgs/members/users 是身份三件套，不算业务）
  const bizMine = entities.ALL_COLLS.reduce((s, n) => {
    if (n === 'orgs' || n === 'members' || n === 'users') return s;
    return s + alive(n).filter(x => String(x.orgId || '') === cur).length;
  }, 0);

  if (!bizMine || !orgs.length) {
    const r = resetReal();
    return r.ok
      ? { ok: true, code: 'RESET', msg: '本机数据是空壳，已恢复出厂，请重新填写' }
      : r;
  }

  const org = orgs.find(x => String(x.id) === cur) || orgs[0];
  const stamp = Date.now();
  const uid = 'u' + stamp;
  const u = schema.normalizeUser({ id: uid, name: '负责人', role: 'owner' }, org.id, stamp);
  const eu = schema.validate('user', u);
  if (eu) return { ok: false, code: 'FAIL', msg: eu };
  const m = schema.normalizeMember({
    id: core.nextId(), orgId: org.id, userId: uid, role: 'owner', name: '负责人'
  }, org.id, stamp);
  const em = schema.validate('member', m);
  if (em) return { ok: false, code: 'FAIL', msg: em };
  if (!pushSaved('users', u) || !pushSaved('members', m)) {
    return { ok: false, code: 'FAIL', msg: core.SAVE_FAIL };
  }
  // me 指到新账号：memberCurrent 的单成员/按 me 兜底才能命中
  core.updateMeta({ me: uid, orgId: org.id });
  return { ok: true, code: 'REBUILT', msg: '负责人身份已重建' };
}

module.exports = { resetReal, repairIdentity };
