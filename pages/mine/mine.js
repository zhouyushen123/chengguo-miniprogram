const db = require('../../utils/db');
const theme = require('../../utils/theme');
const invitesheet = require('../../utils/invitesheet');
const fbu = require('../../utils/fbunread');

// 「我的」首屏只回答三件事：我是谁（身份卡）、现在有多少东西（三个数字）、
// 今天要处理什么（家长反馈 / 邀请成员）。
// 其余低频项在「机构与身份」「设置」两个二级页里，各一屏能看完。
Page({
  data: {
    // 身份卡
    name: '', roleLabel: '', orgName: '', meta: '', uPhoto: '',
    isParent: false, isManager: false, canSwitchHome: false, sandbox: false,
    // 三个数字：学生 / 班级 / 课程（家长/老师数、学期数在二级页里）
    stats: [],
    // 首屏入口：家长反馈（带未读数）、邀请成员、空库时的两条明路
    entries: [],
    // 家长端：我的孩子
    kids: [],
    fbUnread: 0
  },
  onShow() { theme.apply(this); this.refresh(); this.loadFb(); },
  refresh() {
    const s = db.settings();
    const u = db.users.current() || {};
    const a = db.auth.actor() || {};
    const m = a.memberId ? db.members.get(a.memberId) : null;
    const v = m ? db.members.view(m) : null;
    // 副标题：老师列班级、家长列孩子、管理级全机构
    const meta = v
      ? v.full ? '全机构可见' : v.role === 'parent' ? ('孩子：' + (v.kidText || '未绑定')) : ('负责：' + (v.clsText || '未分配'))
      : '';
    const isParent = db.auth.isParent();
    const isManager = db.auth.isAdmin();
    const stuN = db.students.list().length;

    // 统计层：3 格，全部点得动（进管理页对应页签）
    const stats = [];
    if (!isParent) {
      stats.push({ k: 'stu', n: stuN, t: '学生', tab: 2 });
      stats.push({ k: 'cls', n: db.classes.list().length, t: '班级', tab: 0 });
      stats.push({ k: 'crs', n: db.courses.list().length, t: '课程', tab: 1 });
    }

    const entries = [];
    if (!isParent) entries.push({ k: 'feedback', t: '家长反馈', d: '谁看过成果、家长说了什么' });
    if (isManager) entries.push({ k: 'invite', t: '邀请成员', d: '生成机构码，家长 / 老师凭码加入' });
    // 空库才出现的两条明路：数据建完之后它们就是噪音（首页也有开通卡）
    if (!stuN && isManager) entries.push({ k: 'setup', t: '开通引导', d: '机构 → 学期 → 班级 → 学生' });
    if (!stuN && !isManager && !isParent) entries.push({ k: 'join', t: '输入邀请码加入', d: '老师发了机构码，从这儿加入' });

    // 家长端：孩子是谁要能一眼看见，其余全在「设置」里
    const kids = isParent
      ? db.students.list().map(x => ({ id: x.id, name: x.name, photo: x.photo || '' }))
      : [];

    this.setData({
      name: u.name || '未命名',
      uPhoto: u.photo || '',
      roleLabel: s.roleLabel,
      orgName: s.orgName,
      meta, isParent, isManager,
      canSwitchHome: s.canSwitchHome,
      sandbox: !!s.sandbox,
      stats, entries, kids
    });
  },
  // 未读数：云没通就整块不显示，绝不在首屏摆一个猜出来的数字
  loadFb() {
    if (this.data.isParent) { if (this.data.fbUnread) this.setData({ fbUnread: 0 }); return; }
    fbu.load().then(r => {
      const un = r.ready ? r.unread : 0;
      if (un !== this.data.fbUnread) this.setData({ fbUnread: un });
    });
  },
  goOrgId() { wx.navigateTo({ url: '/pages/orgid/orgid' }); },
  goSetting() { wx.navigateTo({ url: '/pages/setting/setting' }); },
  goKid(e) { wx.navigateTo({ url: '/pages/student/student?id=' + e.currentTarget.dataset.id }); },
  // 统计卡点按：负责人管理页多了「机构」页签插在最前（0机构 1班级 2课程 3学生 4人员），所以 tab 统一 +1
  tapStat(e) {
    const tab = (+e.currentTarget.dataset.tab || 0) + (db.auth.isAdmin() ? 1 : 0);
    wx.navigateTo({ url: '/pages/mgr/mgr?tab=' + tab });
  },
  tapEntry(e) {
    const k = e.currentTarget.dataset.k;
    if (k === 'feedback') { wx.navigateTo({ url: '/pages/feedback/feedback' }); return; }
    if (k === 'invite') { invitesheet.open(); return; }
    if (k === 'setup') { wx.navigateTo({ url: '/pages/setup/setup' }); return; }
    if (k === 'join') { wx.navigateTo({ url: '/pages/join/join' }); return; }
  },
  backHome() {
    const r = db.users.switchHome();
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.refresh();
    wx.showToast({ title: '已切回 ' + (r.item.name || '本人'), icon: 'none' });
  }
});
