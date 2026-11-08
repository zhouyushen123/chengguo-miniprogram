// utils/fbunread.js —— 家长反馈未读数（首页与「我的」共用一份口径）
//
// 两处都要显示同一个数字。各写一遍的话，某天一定会分叉（一处算 unhandled、
// 一处算 total），老师看到"首页 3、我的 5"只会认为系统坏了。所以只留这一个实现。
const api = require('./api');

// 云没通、接口失败 → 一律当作"不可用"，绝不在界面上摆一个猜出来的数。
// 家长反馈是"有没有事要处理"的信号，猜错比不显示更糟：会让人白点一趟。
const EMPTY = { ready: false, unread: 0, total: 0, note: '' };

function load() {
  if (!api.enabled()) return Promise.resolve(EMPTY);
  return api.fbList('teacher').then(r => {
    if (!r || !r.ok) return EMPTY;
    const un = r.unhandled || 0;
    const total = r.total || 0;
    return {
      ready: true,
      unread: un,
      total,
      note: un ? (un + ' 条新留言待处理') : (total ? '留言都处理完了' : '家长留言与已读回执')
    };
  }).catch(() => EMPTY);
}

module.exports = { load };
