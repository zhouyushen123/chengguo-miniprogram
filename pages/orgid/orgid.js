// 「机构与身份」二级页 —— 从「我的」首屏搬出来的低频项：
// 当前机构 / 切换机构 / 再加一家 / 机构资料 / 电脑端后台 / 邀请成员。
//
// 为什么单独一页：这些事一个机构一年碰几次（开张、加人、换电脑），
// 天天摆在首屏只会把"家长反馈"这种每天要点的挤到下面去。
const db = require('../../utils/db');
const api = require('../../utils/api');
const sync = require('../../utils/sync');
const theme = require('../../utils/theme');
const apply = require('../../utils/apply');
const invitesheet = require('../../utils/invitesheet');

Page({
  data: {
    orgName: '', roleLabel: '', meta: '',
    isManager: false, isParent: false, sandbox: false,
    // 机构里的人数：负责人才关心，放在这儿而不是首屏（首屏只留学生/班级/课程）
    parentN: 0, teacherN: 0,
    orgs: [], curOrg: '', switching: false,
    entries: []
  },
  onShow() { theme.apply(this); this.refresh(); this.loadOrgs(); },
  refresh() {
    const s = db.settings();
    const a = db.auth.actor() || {};
    const m = a.memberId ? db.members.get(a.memberId) : null;
    const v = m ? db.members.view(m) : null;
    const meta = v
      ? (v.full ? '全机构可见' : v.role === 'parent' ? ('孩子：' + (v.kidText || '未绑定')) : ('负责：' + (v.clsText || '未分配')))
      : '';
    const isManager = db.auth.isAdmin();
    const isParent = db.auth.isParent();
    const roles = isManager ? db.members.list().map(x => x.role) : [];
    const appRec = apply.get();
    const entries = [
      { k: 'addorg', t: '再加一家机构', d: '在别家也带课？输入那家的机构码，数据各归各家' },
      {
        k: 'apply',
        t: appRec ? '机构资料' : '机构入驻申请',
        d: appRec ? (appRec.type + (appRec.regionText ? ' · ' + appRec.regionText : '')) : '填写机构名称、类型与联系方式'
      }
    ];
    if (isManager) {
      // 电脑端后台：浏览器里看全机构学员与记录、改评语、导出 Excel（数据走云端，不占手机）
      entries.push({ k: 'web', t: '电脑端后台', d: '浏览器打开，看全班记录、改评语、导出 Excel' });
      entries.push({ k: 'invite', t: '邀请成员', d: '生成机构码，家长 / 老师 / 管理员凭码加入' });
    }
    this.setData({
      orgName: s.orgName, roleLabel: s.roleLabel, meta,
      isManager, isParent, sandbox: !!s.sandbox,
      parentN: roles.filter(r => r === 'parent').length,
      teacherN: roles.filter(r => r !== 'parent').length,
      entries
    });
  },
  /* ---------------- 多机构：可进入的机构列表 ----------------
   * 只有一家时整块不出现：多一个按钮对多数人是噪音。
   */
  loadOrgs() {
    if (!api.syncOn() || this.data.sandbox) {
      if (this.data.orgs.length) this.setData({ orgs: [], curOrg: '' });
      return;
    }
    sync.orgList().then(r => {
      if (!r || !r.ok || !r.orgs || r.orgs.length < 2) {
        if (this.data.orgs.length) this.setData({ orgs: [], curOrg: '' });
        return;
      }
      const label = { owner: '负责人', admin: '管理员', teacher: '老师', parent: '家长' };
      this.setData({
        orgs: r.orgs.map(o => Object.assign({}, o, { roleLabel: label[o.role] || '成员' })),
        curOrg: r.cur || ''
      });
    }).catch(() => { /* 网络不通就当作只有一家 */ });
  },
  pickOrg() {
    const list = this.data.orgs;
    if (!list.length || this.data.switching) return;
    wx.showActionSheet({
      itemList: list.map(o => (o.orgName || o.orgId) + '（' + o.roleLabel + '）' + (o.orgId === this.data.curOrg ? ' · 当前' : '')),
      success: r => {
        const pick = list[r.tapIndex];
        if (!pick || pick.orgId === this.data.curOrg) return;
        this.doSwitch(pick.orgId);
      }
    });
  },
  doSwitch(id) {
    this.setData({ switching: true });
    wx.showLoading({ title: '正在切换…', mask: true });
    sync.switchOrg(id).then(r => {
      wx.hideLoading();
      if (!r || !r.ok) {
        this.setData({ switching: false });
        wx.showModal({ title: '切换不了', content: (r && r.msg) || '请稍后再试', showCancel: false });
        return;
      }
      // 整页重来：班级、学生、成果、角色全部跟着换一套，最不容易残留上家的状态
      wx.reLaunch({ url: '/pages/index/index' });
    }).catch(() => {
      wx.hideLoading();
      this.setData({ switching: false });
      wx.showModal({ title: '切换不了', content: '网络不通，请稍后再试', showCancel: false });
    });
  },
  tapEntry(e) {
    const k = e.currentTarget.dataset.k;
    if (k === 'addorg') { wx.navigateTo({ url: '/pages/join/join?add=1' }); return; }
    if (k === 'apply') { wx.navigateTo({ url: '/pages/apply/apply' }); return; }
    if (k === 'invite') { invitesheet.open(); return; }
    if (k === 'web') { this.webAdmin(); return; }
  },
  /* ---------------- 电脑端后台 ----------------
   * 浏览器拿不到微信身份，所以后台用「账号 + 6 位口令」登录。
   * 账号由服务端按机构发一份（同一机构永远同一个），口令可以在这里重置。
   */
  webAdmin() {
    wx.showLoading({ title: '准备中', mask: true });
    // 先同步一轮：服务端靠"成员表里有我这条 + openid 对得上"判权限，
    // 刚建好的机构如果还没推上去，会白挨一个"没有权限"。
    sync.syncNow({ force: true }).catch(() => {}).then(() => api.adminAccount()).then(out => {
      wx.hideLoading();
      if (!out || !out.ok) {
        const msg = (out && out.msg) || '取账号失败，请检查网络';
        // 别再用一句「网络不通」糊过去：把真实错误码给出来（截图发来即可定位），
        // 并让用户自己分清楚是「这个接口超时」还是「整台手机没连上云」。
        wx.showModal({
          title: '暂时取不到后台账号',
          content: msg + (out && out.err ? '\n\n错误信息：' + out.err : '') +
            '\n\n先到「设置 → 存储空间」点一次「立即同步」：同步正常说明只是这个接口偶尔超时，再试一次即可；同步也失败则是这台手机没连上云。',
          confirmText: '再试一次', cancelText: '知道了',
          success: r => { if (r.confirm) this.webAdmin(); }
        });
        return;
      }
      const url = out.url || '';
      const txt = '账号：' + out.account + '\n口令：' + out.pin + (url ? '\n网址：' + url : '');
      wx.showModal({
        title: '电脑端后台登录信息',
        content: txt + '\n\n在电脑浏览器打开网址，输入上面两行即可。口令只给负责人和管理员，别发到班级群。',
        confirmText: '复制全部',
        cancelText: '知道了',
        success: r => {
          if (r.confirm) {
            wx.setClipboardData({
              data: txt,
              success: () => wx.showToast({ title: '已复制', icon: 'none' })
            });
          }
        }
      });
    }).catch(e => {
      wx.hideLoading();
      wx.showToast({ title: '取账号失败：' + String((e && e.message) || e).slice(0, 12), icon: 'none' });
    });
  }
});
