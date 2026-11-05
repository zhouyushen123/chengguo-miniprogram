// utils/dailybackup.js —— 每天自动备一次云端（不需要任何控制台配置）
//
// 【为什么要这条路径，而不是只靠云函数定时触发器】
// backup 云函数的 config.json 里已经写了每天 03:00 的定时触发器，但触发器要人去控制台
// 或开发者工具点一次"上传触发器"才会真正生效。需要人记得点的备份，等于没有。
// 所以这里再补一条不依赖任何配置的兜底：负责人/管理员任意一次打开小程序，若当天还没
// 备过，就在后台静默跑一遍。两条路径并存不冲突——backup 云函数同一机构同一天是覆盖写
// 清单，不堆副本。
//
// 【边界】
// 1. 只对负责人/管理员生效：云函数也会校验，这里先挡掉白跑一趟的调用。
// 2. 每天最多一次：只有云函数明确返回"完整"才写日期；失败不写，下次前台再试。
// 3. 一个会话只试一次：避免网络不通时每次切前台都烧一次 60 秒云函数。
// 4. 完全不干扰界面：延迟 10 秒再发，结果记在 globalData.backupLast 供排查，不弹窗。
const api = require('./api');
const db = require('./db');

const KEY = 'cg_bk_day';   // 上次完整备份成功的日期（YYYY-MM-DD）
const DELAY = 10000;

function today() {
  const d = new Date();
  const p = x => (x < 10 ? '0' + x : '' + x);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function done() {
  try { return wx.getStorageSync(KEY) === today(); } catch (e) { return false; }
}

function mark() {
  try { wx.setStorageSync(KEY, today()); } catch (e) { /* 记不住最多明天再备一次，无害 */ }
}

let tried = false;   // 本会话是否已经试过（不论成败）

function maybe() {
  if (tried) return Promise.resolve({ ok: false, code: 'ONCE' });
  if (done()) return Promise.resolve({ ok: false, code: 'DONE' });
  let admin = false;
  try { admin = db.auth.isAdmin(); } catch (e) { admin = false; }
  if (!admin) return Promise.resolve({ ok: false, code: 'NOT_ADMIN' });

  tried = true;
  return new Promise(resolve => {
    setTimeout(() => {
      let p;
      try { p = api.cloudBackup('run'); } catch (e) { resolve({ ok: false, code: 'ERR' }); return; }
      Promise.resolve(p)
        .then(r => {
          const item = r && r.items && r.items[0];
          // status: ok / partial / empty —— 只有 ok 才算今天备完；partial 说明被 60 秒掐断，
          // 明天（或下次前台）还要再试，不能因为"跑过一次"就标记完成。
          if (r && r.ok && item && item.status === 'ok') mark();
          resolve(r || { ok: false, code: 'EMPTY' });
        })
        .catch(() => resolve({ ok: false, code: 'NET' }));
    }, DELAY);
  });
}

module.exports = { maybe, done, KEY };
