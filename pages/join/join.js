// pages/join/join.js —— 用机构邀请码加入（家长 / 老师的入口）
//
// 场景：家长第一次装这个小程序，本机什么都没有。他要做的不是"建机构"，而是"进老师的机构"。
// 所以这里只问三件事：机构码、你叫什么、（家长）孩子的学号。
//
// 【为什么家长要填学号】孩子是谁不能由家长自己从名单里挑——那等于把全班名单给家长看。
// 学号是机构自己发的，家长手里有，服务端按学号认人，家长看不到其他孩子。
const api = require('../../utils/api');
const sync = require('../../utils/sync');
const theme = require('../../utils/theme');
const firstrun = require('../../utils/firstrun');

const ROLE_LABEL = { parent: '家长', teacher: '老师', admin: '管理员' };

Page({
  data: {
    stage: 1,           // 0 选身份 → 1 填码 → 2 填人
    pick: false,        // 从首页首次进入时先问"老师还是家长"
    code: '', name: '', stuNo: '',
    orgName: '', role: '', roleLabel: '',
    busy: false,
    err: ''
  },
  onLoad(q) {
    theme.apply(this);
    // 直接进来时云可能还没初始化（比如从分享卡片冷启动到这一页），补一次
    try { api.initCloud(); } catch (e) { /* 没云就用不了邀请码，页面会提示网络未就绪 */ }
    // 支持从分享/二维码带码进来：/pages/join/join?code=ABC123
    const c = String((q && q.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const pick = !!(q && q.pick);
    if (c.length === 6) { this.setData({ code: c, pick: false, stage: 1 }, () => this.check()); return; }
    if (pick) this.setData({ pick: true, stage: 0 });
  },
  // 老师这条路：去开通向导自己建机构（把首次引导的那次机会用掉，别再被弹一次）
  goSetup() {
    firstrun.markAutoShown();
    wx.redirectTo({ url: '/pages/setup/setup' });
  },
  goCode() { this.setData({ stage: 1, err: '' }); },
  onCode(e) {
    // 只留大写字母数字，家长少打错
    const v = String(e.detail.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    this.setData({ code: v, err: '' });
    return v;
  },
  onName(e) { this.setData({ name: e.detail.value, err: '' }); },
  onStuNo(e) {
    const v = String(e.detail.value || '').replace(/[^\d]/g, '').slice(0, 8);
    this.setData({ stuNo: v, err: '' });
    return v;
  },
  // 第一步：先验码，把机构名和身份亮出来让人确认，再让人填名字
  check() {
    if (this.data.busy) return;
    const code = this.data.code;
    if (code.length < 4) { this.setData({ err: '请填写老师给的邀请码' }); return; }
    if (!api.enabled()) { this.setData({ err: '网络未就绪，请稍后重试' }); return; }
    this.setData({ busy: true, err: '' });
    api.inviteInfo(code).then(r => {
      this.setData({ busy: false });
      if (!r || !r.ok) { this.setData({ err: (r && r.msg) || '邀请码无效' }); return; }
      this.setData({
        stage: 2, orgName: r.orgName || '该机构',
        role: r.role, roleLabel: ROLE_LABEL[r.role] || '成员'
      });
    });
  },
  back() { this.setData({ stage: 1, err: '' }); },
  // 第二步：真正加入（云端建绑定 + 成员关系，本机改挂过去并全量拉回）
  doJoin() {
    if (this.data.busy) return;
    if (!this.data.name.trim()) { this.setData({ err: '请填写你的姓名' }); return; }
    if (this.data.role === 'parent' && !this.data.stuNo) { this.setData({ err: '请填写孩子的学号' }); return; }
    this.setData({ busy: true, err: '' });
    sync.join(this.data.code, this.data.name.trim(), this.data.stuNo).then(r => {
      this.setData({ busy: false });
      if (!r || !r.ok) {
        const msg = r && r.code === 'LOCAL_DATA'
          ? '这台手机已经有数据了，请先在「我的 → 存储空间」清空后再加入'
          : ((r && r.msg) || '加入失败，请重试');
        this.setData({ err: msg });
        return;
      }
      wx.showToast({ title: '已加入 ' + (this.data.orgName || '该机构'), icon: 'success' });
      setTimeout(() => {
        wx.reLaunch({ url: '/pages/index/index' });
      }, 700);
    });
  }
});
