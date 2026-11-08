// 「设置」二级页 —— 从「我的」首屏搬出来的低频项：
// 学期管理 / 开通引导 / 存储空间 / 外观 / 演示数据 / 切换身份 / 关于。
//
// 判断标准只有一条：**一年点几次的事，不该占首屏**。
// 留在首屏的只有"每天都会点"和"这一屏的身份证"。
const db = require('../../utils/db');
const sync = require('../../utils/sync');
const theme = require('../../utils/theme');

Page({
  data: {
    isParent: false, isManager: false, sandbox: false,
    themes: [], theme: '',
    pendingN: 0, rejectN: 0,
    entries: []
  },
  onShow() {
    theme.apply(this);
    this.setData({ themes: theme.LIST, theme: theme.current() });
    this.refresh();
  },
  refresh() {
    const s = db.settings();
    const isParent = db.auth.isParent();
    const isManager = db.auth.isAdmin();
    let pendingN = 0, rejectN = 0;
    try { pendingN = sync.pending(); rejectN = sync.rejectedCount(); } catch (e) { /* 数据层不可用就不显示 */ }

    const entries = [];
    if (!isParent) {
      // 家长不需要开班学期，也不需要重走开通引导
      if (isManager) entries.push({ k: 'term', t: '学期管理', d: '开班学期、课时结转与续报' });
      if (isManager) entries.push({ k: 'setup', t: '开通引导', d: '按步骤重走一遍：机构 → 学期 → 班级 → 学生' });
      if (!isManager && !db.students.list().length) {
        entries.push({ k: 'join', t: '输入邀请码加入', d: '老师发了机构码，从这儿加入' });
      }
    }
    // 存储空间：照片视频占的是这台手机的空间，满了会静默存不进去，所以给一个能看见的地方。
    // 顺手把"还没传上云"的条数写在副标题里——积压只在这里能看清具体数字。
    entries.push({
      k: 'storage',
      t: '存储空间',
      d: '照片视频占用与清理' + (pendingN ? ' · ' + pendingN + ' 条待上传' : '') + (rejectN ? ' · ' + rejectN + ' 条被退回' : '')
    });
    // 演示数据能看能重置但改不了（样板间），家长用不上
    if (!isParent) {
      entries.push({
        k: 'demo',
        t: s.sandbox ? '退出演示数据' : '看演示数据',
        d: s.sandbox ? '当前看的是示例数据，只看不改' : '一整套示例学生与记录，随便翻'
      });
    }
    if (isManager) entries.push({ k: 'switch', t: '切换身份', d: '管理员 / 老师 / 学生家长 演示切换' });
    entries.push({ k: 'about', t: '关于橙果', d: '这是什么、怎么用' });

    this.setData({
      isParent, isManager, sandbox: !!s.sandbox,
      pendingN, rejectN, entries
    });
  },
  /* ---------------- 外观 ----------------
   * 换一次就定了，不需要天天看，所以放在这里而不是首屏。
   */
  pickTheme(e) {
    const t = theme.setTheme(e.currentTarget.dataset.k);
    theme.apply(this);
    this.setData({ theme: t });
    wx.showToast({ title: '已换为「' + (theme.LIST.find(x => x.k === t) || {}).name + '」', icon: 'none' });
  },
  tapEntry(e) {
    const k = e.currentTarget.dataset.k;
    if (k === 'term') { wx.navigateTo({ url: '/pages/terms/terms' }); return; }
    if (k === 'setup') { wx.navigateTo({ url: '/pages/setup/setup' }); return; }
    if (k === 'join') { wx.navigateTo({ url: '/pages/join/join' }); return; }
    if (k === 'storage') { wx.navigateTo({ url: '/pages/storage/storage' }); return; }
    if (k === 'about') { this.showAbout(); return; }
    if (k === 'demo') { this.demoMenu(); return; }
    if (k === 'switch') { this.switchIdentity(); return; }
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
  showAbout() {
    wx.showModal({
      title: '关于橙果',
      content: '橙果是课后机构用的「成果记录」工具：老师把每节课孩子的照片、语音点评和成长记录下来，家长在手机上就能看到孩子的每一点进步。\n\n第一次使用：在「我的」页点上面的统计（学生 / 班级 / 课程）建好基础数据，再在「记录」页给孩子录成果。',
      showCancel: false,
      confirmText: '知道了'
    });
  },
  // 演示数据：独立的一套数据。进去看、看够了退出来，自己录的东西全程不受影响
  demoMenu() {
    if (!db.demo.active()) {
      const r = db.demo.enter();
      if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
      this.refresh();
      wx.showToast({ title: '已进入演示数据（只看不改）', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: ['退出演示，回到我的机构', '重置演示数据'],
      success: r => {
        if (r.tapIndex === 0) {
          db.demo.exit();
          this.refresh();
          wx.showToast({ title: '已回到你的机构', icon: 'none' });
          return;
        }
        const res = db.demo.reset();
        this.refresh();
        wx.showToast({ title: res.ok ? '演示数据已重置' : '重置失败', icon: 'none' });
      }
    });
  }
});
