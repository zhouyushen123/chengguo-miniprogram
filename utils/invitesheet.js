// utils/invitesheet.js —— 「邀请成员」弹层（我的首屏与机构与身份页共用）
//
// 一个身份一个机构码（家长 / 老师 / 管理员各一个），30 天有效，可重复使用。
// 把"建成员"从"管理者手动填一张表"变成"对方自己填自己"：
// 老师不可能一个个录入全班家长的姓名和手机号。
const db = require('./db');
const api = require('./api');
const sync = require('./sync');

const ROLES = ['parent', 'teacher', 'admin'];
const NAMES = ['家长邀请码', '老师邀请码', '管理员邀请码'];
const HINTS = [
  '家长填码 + 孩子学号即可加入，只能看自己孩子已发布的成果',
  '老师填码 + 姓名即可加入，进来后你再给他分配班级',
  '管理员填码加入后可管理全机构（谨慎发放）'
];

function copyCode(code) {
  wx.setClipboardData({
    data: code,
    success: () => wx.showToast({ title: '已复制，发给对方即可', icon: 'none' })
  });
}

function showCode(code, title, hint, expiresAt) {
  const d = expiresAt ? new Date(expiresAt) : null;
  const exp = d ? (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日' : '';
  wx.showModal({
    title: title + '：' + code,
    content: hint + '\n\n看到这段码的人就能加入本机构，' + (exp ? exp + '前有效。' : ''),
    confirmText: '复制码',
    cancelText: '知道了',
    success: r => { if (r.confirm) copyCode(code); }
  });
}

// 取码前先推一轮：服务端判权限靠"成员表里有我这条 + openid 对得上"，
// 刚建好的机构如果还没推上去，会白挨一个"不在成员表里"。
// orgId 必须带上：服务端按它和我绑定机构的一致性判权限，漏传 = 无权访问。
function fetchCode(role) {
  wx.showLoading({ title: '生成中', mask: true });
  sync.syncNow({ force: true }).catch(() => {})
    .then(() => api.inviteGet(role, (db.auth.member() || {}).orgId))
    .then(out => {
      wx.hideLoading();
      if (!out || !out.ok) {
        const msg = out && out.code === 'NO_MEMBER'
          ? '云端还没同步完，等半分钟再试一次'
          : ((out && out.msg) || '生成失败，请检查网络');
        wx.showToast({ title: msg, icon: 'none' });
        return;
      }
      const i = ROLES.indexOf(role);
      showCode(out.code, NAMES[i] || '邀请码', HINTS[i] || '', out.expiresAt);
    })
    .catch(() => { wx.hideLoading(); wx.showToast({ title: '生成失败，请检查网络', icon: 'none' }); });
}

// 直接发某一种码（页面已经分清要哪种时用）
function openRole(role) { if (ROLES.indexOf(role) > -1) fetchCode(role); }

// 三种码里选一种
function open() {
  wx.showActionSheet({
    itemList: NAMES,
    success: r => openRole(ROLES[r.tapIndex])
  });
}

module.exports = { open, openRole, ROLES, NAMES, HINTS };
