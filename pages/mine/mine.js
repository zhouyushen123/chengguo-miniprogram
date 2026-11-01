const db = require('../../utils/db');

Page({
  data: {
    // 个人卡片
    name: '', roleLabel: '', orgName: '', meta: '', avaChar: '',
    isManager: false, canSwitchHome: false, homeName: '',
    hasDemo: false,
    // 入口列表
    entries: []
  },
  onShow() { this.refresh(); },
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
    const isManager = db.auth.isAdmin();
    const entries = [];
    // 家长不需要管理班级课程，入口整体隐藏
    if (!db.auth.isParent()) {
      entries.push({ k: 'mgr', t: '学生 / 课程管理', d: '添加学生、班级和课程' });
    }
    if (isManager) {
      entries.push({ k: 'member', t: '成员管理', d: '角色与数据范围分配' });
      entries.push({ k: 'switch', t: '切换身份', d: '管理员 / 老师 / 学生家长 演示切换' });
    }
    entries.push({ k: 'about', t: '关于橙果', d: '这是什么、怎么用' });
    this.setData({
      name: u.name || '未命名',
      avaChar: (u.name || '橙')[0],
      roleLabel: s.roleLabel,
      orgName: s.orgName,
      meta, isManager,
      canSwitchHome: s.canSwitchHome,
      homeName: ((db.users.get(s.homeMe) || {}).name) || '',
      hasDemo: (s.demoVersion || 0) > 0,
      entries
    });
  },
  tapEntry(e) {
    const k = e.currentTarget.dataset.k;
    if (k === 'mgr') { wx.navigateTo({ url: '/pages/mgr/mgr' }); return; }
    if (k === 'member') { wx.navigateTo({ url: '/pages/mgr/mgr?tab=3' }); return; }
    if (k === 'switch') { this.switchIdentity(); return; }
    if (k === 'about') { this.showAbout(); return; }
  },
  // 演示切换：从成员列表选一个人，以他的身份看全 App
  switchIdentity() {
    const list = db.members.list()
      .map(m => db.members.view(m))
      .filter(v => v.status !== 'disabled')
      .map(v => ({ userId: v.userId, label: v.name + '（' + v.roleLabel + '）' }));
    if (!list.length) { wx.showToast({ title: '还没有其他成员', icon: 'none' }); return; }
    wx.showActionSheet({
      itemList: list.slice(0, 6).map(x => x.label),
      success: r => {
        const pick = list[r.tapIndex];
        if (!pick) return;
        const res = db.users.switchTo(pick.userId);
        if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
        this.refresh();
        wx.showToast({ title: '已切换为 ' + pick.label, icon: 'none' });
      }
    });
  },
  backHome() {
    const r = db.users.switchHome();
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.refresh();
    wx.showToast({ title: '已切回 ' + (r.item.name || '本人'), icon: 'none' });
  },
  showAbout() {
    wx.showModal({
      title: '关于橙果',
      content: '橙果是课后机构用的「成果记录」工具：老师把每节课孩子的照片、语音点评和成长记录下来，家长在手机上就能看到孩子的每一点进步。\n\n第一次使用：先在「学生 / 课程管理」里建好班级、课程和学生，再在「记录」页给孩子录成果。',
      showCancel: false,
      confirmText: '知道了'
    });
  },
  clearDemo() {
    wx.showModal({
      title: '清空演示数据？',
      content: '所有标记为「演示」的学生和成果记录会被删除，你自己录入的真实数据不受影响。',
      confirmColor: '#c0564a',
      success: r => {
        if (!r.confirm) return;
        const res = db.demoClear();
        if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
        const n = res.item.records + res.item.students;
        wx.showToast({ title: n ? ('已清空 ' + n + ' 条演示数据') : '没有演示数据', icon: 'none' });
      }
    });
  }
});
