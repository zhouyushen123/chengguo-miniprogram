const db = require('../../utils/db');
const theme = require('../../utils/theme');
const apply = require('../../utils/apply');

Page({
  data: {
    // 个人卡片
    name: '', roleLabel: '', orgName: '', meta: '', avaChar: '',
    isManager: false, canSwitchHome: false, homeName: '',
    sandbox: false,
    // 管理统计层（两行三列：上行「学生·家长·老师」机构的人，下行「班级·课程·学期」教学组织）
    statRows: [],
    // 入口列表
    entries: []
  },
  onShow() { theme.apply(this); this.setData({ themes: theme.LIST, theme: theme.current() }); this.refresh(); },
  // 换肤：落盘 + 立即应用（本页 CSS 变量与图标即时切换，其他页面在下一次 onShow 跟上）
  pickTheme(e) {
    const t = theme.setTheme(e.currentTarget.dataset.k);
    theme.apply(this);
    this.setData({ theme: t });
    wx.showToast({ title: '已换为「' + (theme.LIST.find(x => x.k === t) || {}).name + '」', icon: 'none' });
  },
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
    // 统计层：两行三列。上行是机构里的人（学生/家长/老师），下行是教学组织（班级/课程/学期）；
    // 家长/老师/学期仅负责人/管理员可见（与人员页签、学期管理入口的可见性一致）。
    // 学期不走管理页页签，点按进独立的学期管理页（k='term'，无 tab）
    const statRows = [];
    if (!db.auth.isParent()) {
      const stu = { k: 'stu', n: db.students.list().length, t: '学生', tab: 2 };
      const cls = { k: 'cls', n: db.classes.list().length, t: '班级', tab: 0 };
      const crs = { k: 'crs', n: db.courses.list().length, t: '课程', tab: 1 };
      if (isManager) {
        const roles = db.members.list().map(m => m.role);
        statRows.push(
          [stu,
            { k: 'parent', n: roles.filter(r => r === 'parent').length, t: '家长', tab: 3 },
            { k: 'teacher', n: roles.filter(r => r !== 'parent').length, t: '老师', tab: 3 }],
          [cls, crs,
            { k: 'term', n: db.terms.list().length, t: '学期', tab: null }]
        );
      } else {
        statRows.push([stu, cls, crs]);
      }
    }
    // 演示数据：能看、能重置，但改不了（样板间）
    entries.push({
      k: 'demo',
      t: s.sandbox ? '退出演示数据' : '看演示数据',
      d: s.sandbox ? '当前看的是示例数据，只看不改' : '一整套示例学生与记录，随便翻'
    });
    // 机构信息：没提交过入驻申请时是「入驻申请」入口，提交过就是机构资料维护
    const appRec = apply.get();
    entries.push({
      k: 'apply',
      t: appRec ? '机构信息' : '机构入驻申请',
      d: appRec ? (appRec.type + (appRec.regionText ? ' · ' + appRec.regionText : '')) : '填写机构名称、类型与联系方式'
    });
    if (isManager) {
      // 开通引导：不依赖"空库"判断，任何时候都能重走一遍（机构→学期→班级→学生）
      entries.push({ k: 'setup', t: '开通引导', d: '按步骤走一遍：机构 → 学期 → 班级 → 学生' });
      entries.push({ k: 'term', t: '学期管理', d: '开班学期、课时结转与续报' });
      entries.push({ k: 'switch', t: '切换身份', d: '管理员 / 老师 / 学生家长 演示切换' });
    }
    // 存储空间：照片视频占的是这台手机的空间，满了会静默存不进去，所以给一个能看见的地方
    entries.push({ k: 'storage', t: '存储空间', d: '照片视频占用与清理' });
    entries.push({ k: 'about', t: '关于橙果', d: '这是什么、怎么用' });
    this.setData({
      name: u.name || '未命名',
      avaChar: (u.name || '橙')[0],
      roleLabel: s.roleLabel,
      orgName: s.orgName,
      meta, isManager,
      canSwitchHome: s.canSwitchHome,
      homeName: ((db.users.get(s.homeMe) || {}).name) || '',
      sandbox: !!s.sandbox,
      statRows,
      entries
    });
  },
  tapEntry(e) {
    const k = e.currentTarget.dataset.k;
    if (k === 'apply') { wx.navigateTo({ url: '/pages/apply/apply' }); return; }
    if (k === 'term') { wx.navigateTo({ url: '/pages/terms/terms' }); return; }
    if (k === 'setup') { wx.navigateTo({ url: '/pages/setup/setup' }); return; }
    if (k === 'switch') { this.switchIdentity(); return; }
    if (k === 'about') { this.showAbout(); return; }
    if (k === 'demo') { this.demoMenu(); return; }
    if (k === 'storage') { wx.navigateTo({ url: '/pages/storage/storage' }); return; }
  },
  // 统计卡点按：学期进独立学期管理页，其余跳管理页对应页签（0班级 1课程 2学生 3人员）
  tapStat(e) {
    if (e.currentTarget.dataset.k === 'term') { wx.navigateTo({ url: '/pages/terms/terms' }); return; }
    wx.navigateTo({ url: '/pages/mgr/mgr?tab=' + (+e.currentTarget.dataset.tab || 0) });
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
