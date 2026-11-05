// pages/setup/setup.js —— 开通向导（首次进入的引导流程）
//
// 为什么要有这一页：新用户第一次打开时，库里没有班级、没有学生，首页是三块「0」和一片空白。
// 那看起来不像"还没开始填"，而像"这东西是坏的"。所以把第一件事变成一条能走完的路：
//   机构信息 → 学期 → 班级 → 学生 → 完成，四步都在这一页里做完，不用来回跳页面。
//
// 设计取舍：
// - 每步只问"再少就建不出东西"的必填项。机构类型/课程方向这些资料字段留给「机构资料」页，
//   第一屏多问一个字段，就多一批半途退出的人。
// - 每一步都允许「稍后再说」直接跳到完成，不锁死。已经建的不会白建，剩下的在各自的管理页补。
// - 建数据的权限在这个流程里天然满足：新机构的第一位用户是 owner（migrate.js 保证），
//   所以 term/class/student 的写权限都在。但代码仍按返回值判 ok，权限不足时原样回报文案。
const db = require('../../utils/db');
const theme = require('../../utils/theme');
const applyUtils = require('../../utils/apply');
const tel = require('../../utils/phone');

const TYPES = ['培训机构', '学校', '幼儿园', '个人工作室'];
const MODES = [{ k: 'term', t: '学期制' }, { k: 'carry', t: '课时结转' }];

const pad = n => (n < 10 ? '0' + n : '' + n);
const dateStr = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

// 学期默认名按当前月份推：3~8 月开春季，9 月到次年 2 月算秋季（秋季以开学那年的年份命名）
function seasonName() {
  const now = new Date();
  const m = now.getMonth() + 1;
  const y = now.getFullYear();
  if (m >= 3 && m <= 8) return y + ' 春季学期';
  return (m >= 9 ? y : y - 1) + ' 秋季学期';
}

Page({
  data: {
    step: 1,
    total: 4,
    steps: [
      { n: 1, t: '机构' },
      { n: 2, t: '学期' },
      { n: 3, t: '班级' },
      { n: 4, t: '学生' }
    ],
    types: TYPES,
    modes: MODES,
    // 机构
    org: { name: '', type: TYPES[0], contact: '', phone: '' },
    // 学期
    term: { name: '', startDate: '', endDate: '' },
    // 班级
    cls: { name: '', mode: 'term', course: '' },
    // 学生
    stuName: '',
    added: [],
    done: false,
    summary: { org: '', term: '', cls: '', stu: 0 },
    idle: false   // 已经开通过（有班级或有学生）：这一页只当"补一步"用，标题换说法
  },

  onLoad() {
    theme.apply(this);
    const today = new Date();
    const end = new Date();
    end.setMonth(end.getMonth() + 6);
    const u = (db.users.current && db.users.current()) || {};
    const rec = applyUtils.get() || {};
    const orgName = (db.settings().orgName || '').replace(/^我的机构$/, '');
    this.setData({
      'term.name': seasonName(),
      'term.startDate': dateStr(today),
      'term.endDate': dateStr(end),
      'org.name': rec.name || orgName || '',
      'org.type': rec.type || TYPES[0],
      'org.contact': rec.contact || u.name || '',
      'org.phone': rec.phone || '',
      idle: db.classes.list().length > 0 || db.students.list().length > 0
    });
  },

  onShow() { theme.apply(this); },

  /* ---------------- 表单 ---------------- */
  onOrgName(e) { this.setData({ 'org.name': e.detail.value }); },
  pickType(e) { this.setData({ 'org.type': e.currentTarget.dataset.v }); },
  onContact(e) { this.setData({ 'org.contact': e.detail.value }); },
  // 手机号边输边格式化（3-4-4）：存的是带横线的展示串，提交时 tel.digits 还原裸数字
  onPhone(e) {
    const raw = tel.digits(e.detail.value);
    this.setData({ 'org.phone': tel.fmt(raw), 'org.phoneBad': raw.length > 0 && !tel.valid(raw) });
  },
  onTermName(e) { this.setData({ 'term.name': e.detail.value }); },
  onStart(e) { this.setData({ 'term.startDate': e.detail.value }); },
  onEnd(e) { this.setData({ 'term.endDate': e.detail.value }); },
  onClsName(e) { this.setData({ 'cls.name': e.detail.value }); },
  pickMode(e) { this.setData({ 'cls.mode': e.currentTarget.dataset.v }); },
  onStuName(e) { this.setData({ stuName: e.detail.value }); },

  /* ---------------- 流程 ---------------- */
  // 每一步先校验、再落库，落库失败就停在原地并把原因说出来（不吞错）
  next() {
    const s = this.data.step;
    if (s === 1) return this.commitOrg();
    if (s === 2) return this.commitTerm();
    if (s === 3) return this.commitClass();
    return this.commitStudent();
  },
  back() {
    if (this.data.done) return;
    if (this.data.step > 1) this.setData({ step: this.data.step - 1 });
  },
  // 稍后再说：直接跳到完成页。已经建好的保留，没建的以后在对应管理页补
  later() {
    this.setData({ done: true, summary: this._summary() });
  },
  // 家长/老师走错门：从向导拐到邀请码加入（向导里已经存的东西不会丢，它本来就没提交）
  goJoin() { wx.redirectTo({ url: '/pages/join/join' }); },

  _toast(title) { wx.showToast({ title, icon: 'none' }); },

  commitOrg() {
    const f = this.data.org;
    const name = (f.name || '').trim();
    if (name.length < 2) return this._toast('请填写机构名称（至少 2 个字）');
    const nameErr = db.orgs.checkName(name);
    if (nameErr) return this._toast(nameErr);
    if (!(f.contact || '').trim()) return this._toast('请填写联系人');
    if (!tel.valid(f.phone)) return this._toast('请填写正确的 11 位手机号（1 开头）');

    const up = db.orgs.update({ name });
    if (!up.ok) return this._toast(up.msg || '机构名保存失败');
    // 申请单与「机构资料」页共用同一份留档（utils/apply.js），这里填的字段那边能看到
    applyUtils.save({
      name,
      type: f.type,
      contact: (f.contact || '').trim(),
      phone: tel.digits(f.phone),
      status: 'active'
    });
    // 顺手把出厂名「测试老师」换成他填的联系人：首页一进来就叫"测试老师"，
    // 是那种会让人立刻觉得"这东西是给我用的吗"的细节
    this._renameMe((f.contact || '').trim());
    this.setData({ step: 2 });
  },
  _renameMe(name) {
    if (!name) return;
    try {
      const me = db.members.current && db.members.current();
      if (me && /^测试老师$/.test(me.name || '')) db.members.update(me.id, { name });
    } catch (e) { /* 改名失败不影响开通，名字能在「我的」里改 */ }
  },

  commitTerm() {
    const f = this.data.term;
    const name = (f.name || '').trim();
    if (!name) return this._toast('请给学期起个名字');
    if (!f.startDate || !f.endDate) return this._toast('请选择学期起止日期');
    if (f.endDate < f.startDate) return this._toast('结束日期不能早于开始日期');

    const r = db.terms.create({ name, startDate: f.startDate, endDate: f.endDate, status: 'active' });
    if (!r.ok) return this._toast(r.msg || '学期创建失败');
    this._termId = r.item.id;
    // 班级默认名跟着机构名给个建议值，省一次输入（用户可改）；课程默认同名
    if (!this.data.cls.name) {
      const guess = (this.data.org.name || '').replace(/(培训|教育|有限|公司|中心)/g, '').slice(0, 6);
      this.setData({ 'cls.name': (guess || '') + '常规班' });
    }
    // 课程默认跟班级同名：录入页选课需要一个可选项，不预填的话用户走到录入页会被空选框卡住
    if (!this.data.cls.course) this.setData({ 'cls.course': this.data.cls.name });
    this.setData({ step: 3 });
  },

  onClsCourse(e) { this.setData({ 'cls.course': e.detail.value }); },

  commitClass() {
    const f = this.data.cls;
    const name = (f.name || '').trim();
    if (!name) return this._toast('请给班级起个名字');
    const course = (f.course || '').trim();

    const r = db.classes.create({ name, termId: this._termId || 0, mode: f.mode });
    if (!r.ok) return this._toast(r.msg || '班级创建失败');
    this._clsId = r.item.id;
    // 第一门课程随班级一起建（选填）：录入页、AI 评的提示语都依赖它
    if (course) {
      const cr = db.courses.create({ name: course, clsId: this._clsId });
      if (!cr.ok) return this._toast(cr.msg || '课程创建失败，可稍后在「管理 · 课程」里补');
    }
    this.setData({ step: 4 });
  },

  // 第 4 步：学生可以加多个。「完成开通」时若输入框里还有名字，先把它加上再收尾
  addStudent() {
    const name = (this.data.stuName || '').trim();
    if (!name) return this._toast('请填写学生姓名');
    const r = db.students.create({ name, clsIds: this._clsId ? [this._clsId] : [] });
    if (!r.ok) return this._toast(r.msg || '学生添加失败');
    this.setData({
      added: this.data.added.concat([{ id: r.item.id, name: r.item.name, no: r.item.no }]),
      stuName: ''
    });
    wx.showToast({ title: r.linked ? ('已添加，并归入家长「' + r.linked + '」') : '已添加', icon: 'none' });
  },

  commitStudent() {
    if ((this.data.stuName || '').trim()) this.addStudent();
    this.setData({ done: true, summary: this._summary() });
  },

  _summary() {
    const t = this._termId ? db.terms.get(this._termId) : (db.terms.list()[0] || null);
    const c = this._clsId ? db.classes.get(this._clsId) : (db.classes.list()[0] || null);
    return {
      org: db.settings().orgName || '',
      term: (t && t.name) || '',
      cls: (c && c.name) || '',
      stu: this.data.added.length
    };
  },

  /* ---------------- 完成页出口 ---------------- */
  goRecord() {
    const c = this._clsId || ((db.classes.list()[0] || {}).id || null);
    const s = this.data.added[0] || {};
    getApp().globalData.pick = {
      cls: c, sid: s.id || null, score: 85,
      photos: [], videos: [], audio: null, tag: '', note: '', rid: null, course: ''
    };
    wx.navigateTo({ url: '/pages/record/record' });
  },
  goMgr() { wx.navigateTo({ url: '/pages/mgr/mgr' }); },
  goHome() {
    // 首页是 tab：navigateBack 可能回到半路，switchTab 更稳
    wx.switchTab({ url: '/pages/index/index' });
  }
});
