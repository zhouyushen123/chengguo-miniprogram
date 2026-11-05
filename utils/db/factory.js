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

module.exports = { resetReal };
