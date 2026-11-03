const db = require('../../utils/db');
const theme = require('../../utils/theme');
const apply = require('../../utils/apply');

// 表单选项：固定集合，避免自由输入导致口径混乱（后续可从服务端下发）
const TYPES = ['培训机构', '学校', '幼儿园', '个人工作室'];
const SCALES = ['50 人以下', '50–200 人', '200–500 人', '500 人以上'];
const COURSES = ['书法', '美术', '素描', '钢琴', '舞蹈', '声乐', '编程', '托育'];
const PHONE_RE = /^1[3-9]\d{9}$/;

Page({
  data: {
    types: TYPES, scales: SCALES,
    // 表单：机构名称 / 类型 / 地区 / 联系人 / 手机 / 规模 / 课程方向 / 邀请码
    form: {
      name: '', type: TYPES[0], region: [], regionText: '',
      contact: '', phone: '', scale: SCALES[0], courses: [], invite: ''
    },
    // 课程方向做成带 on 标记的数组（WXML 里不能调用 indexOf）
    courseChips: [],
    agreed: false,
    record: null,    // 已有申请单：有则本页是「机构信息」，无则是「入驻申请」
    isEdit: false,
    canManage: false,
    done: null,      // 刚提交成功的申请单（切到成功态）
    doneCourses: '',
    doneStatus: ''
  },
  onShow() {
    theme.apply(this);
    this.load();
  },
  load() {
    const s = db.settings();
    const r = apply.get();
    const u = db.users.current() || {};
    const f = Object.assign({}, this.data.form);
    if (r) {
      f.name = r.name || f.name;
      f.type = r.type || f.type;
      f.region = (r.region || []).slice();
      f.regionText = r.regionText || '';
      f.contact = r.contact || '';
      f.phone = r.phone || '';
      f.scale = r.scale || f.scale;
      f.courses = (r.courses || []).slice();
      f.invite = r.invite || '';
    } else if (s.orgName && s.orgName !== '我的机构') {
      f.name = s.orgName; // 已改过机构名的，先把名字带进来省一次输入
    }
    if (!f.contact) f.contact = u.name || '';
    this.setData({
      form: f, record: r, isEdit: !!r,
      canManage: db.auth.isAdmin(),
      courseChips: this._chips(f.courses)
    });
  },
  _chips(sel) {
    const list = sel || [];
    return COURSES.map(n => ({ name: n, on: list.indexOf(n) > -1 }));
  },
  onName(e) { this.setData({ 'form.name': e.detail.value }); },
  pickType(e) { this.setData({ 'form.type': e.currentTarget.dataset.v }); },
  onRegion(e) {
    const v = e.detail.value || [];
    this.setData({ 'form.region': v, 'form.regionText': v.join(' ') });
  },
  onContact(e) { this.setData({ 'form.contact': e.detail.value }); },
  onPhone(e) { this.setData({ 'form.phone': e.detail.value }); },
  onScale(e) { this.setData({ 'form.scale': e.currentTarget.dataset.v }); },
  onInvite(e) { this.setData({ 'form.invite': e.detail.value }); },
  toggleCourse(e) {
    const v = e.currentTarget.dataset.v;
    const cur = (this.data.form.courses || []).slice();
    const i = cur.indexOf(v);
    if (i > -1) cur.splice(i, 1); else cur.push(v);
    this.setData({ 'form.courses': cur, courseChips: this._chips(cur) });
  },
  toggleAgree() { this.setData({ agreed: !this.data.agreed }); },

  // 校验：只做"必填 + 格式"，不拦可选字段；返回错误文案，空串即通过
  _validate(f) {
    const name = (f.name || '').trim();
    if (!name) return '请填写机构名称';
    if (name.length < 2) return '机构名称至少 2 个字';
    if (!(f.contact || '').trim()) return '请填写联系人姓名';
    if (!PHONE_RE.test((f.phone || '').trim())) return '请填写正确的 11 位手机号';
    if (!this.data.agreed) return '请先勾选同意协议';
    return '';
  },

  submit() {
    const f = this.data.form;
    const err = this._validate(f);
    if (err) { wx.showToast({ title: err, icon: 'none' }); return; }

    const name = f.name.trim();
    // 机构名写进机构表（需要「机构管理」权限）；老师/家长提交只留申请单，等负责人开通
    const up = db.orgs.update({ name });
    const courses = (f.courses || []).slice();
    const item = apply.save({
      name,
      type: f.type,
      region: (f.region || []).slice(),
      regionText: f.regionText || '',
      contact: (f.contact || '').trim(),
      phone: (f.phone || '').trim(),
      scale: f.scale,
      courses,
      courseText: courses.join('、'),
      invite: (f.invite || '').trim(),
      status: up.ok ? 'active' : 'pending'
    });
    this.setData({
      done: item, record: item, isEdit: true,
      doneCourses: item.courseText,
      doneStatus: up.ok ? 'active' : 'pending'
    });
    wx.showToast({ title: up.ok ? (this.data.canManage ? '机构信息已保存' : '已提交') : '申请已提交', icon: 'none' });
  },
  backEdit() { this.setData({ done: null }); },
  goHome() { wx.switchTab({ url: '/pages/index/index' }); },
  goMgr() { wx.navigateTo({ url: '/pages/mgr/mgr' }); }
});
