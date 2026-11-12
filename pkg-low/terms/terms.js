// pages/terms/terms.js —— 学期管理：学期列表 / 新建 / 结束本学期（四步结转向导）
const db = require('../../utils/db');
const theme = require('../../utils/theme');
const voice = require('../../utils/voice');
const termPresets = require('../../utils/term-presets');

const STATUS_LABEL = { upcoming: '未开始', active: '进行中', archived: '已归档' };
const MODE_LABEL = { term: '学期制', carry: '课时结转' };

Page({
  data: {
    mode: 'list',            // list 学期列表 / wizard 结转向导
    terms: [],
    // 新建学期表单
    showCreate: false,
    form: { name: '', startDate: '', endDate: '' },
    formKind: '',          // 当前选中的预设（秋季/寒假/春季/暑假/长期班），手动改过就清空
    termKinds: termPresets.KINDS,  // 历法预设胶囊：点一下填好名称+起止日期
    // 结转向导
    wz: null
  },

  onShow() { theme.apply(this); this.refresh(); },

  refresh() {
    const staff = db.members.list()
      .filter(m => m.role !== 'parent' && m.status === 'active')
      .map(m => ({ id: m.id, name: m.name || m.roleLabel }));
    const terms = db.terms.list().map(t => ({
      id: t.id, name: t.name,
      // 结束日期留空 = 长期班：只展示开工日；两段都没有才说“未设置”
      dates: t.endDate
        ? [t.startDate, t.endDate].filter(Boolean).join(' ~ ')
        : (t.startDate ? t.startDate + ' 起' : '未设置起止日期'),
      status: t.status, statusLabel: STATUS_LABEL[t.status] || t.status,
      builtIn: !!t.builtIn,
      // 班级数由数据层按当前身份可见范围算，页面不碰全量
      clsCount: db.classes.countOfTerm(t.id),
      canSettle: t.status === 'active' && !t.builtIn && !!t.endDate,
      // 没约结束日期的长期班：给「结课」动作（归档，结束日期记为当天）；内置长期班是免维护兜底，不给
      canClose: t.status === 'active' && !t.builtIn && !t.endDate
    }));
    const y = new Date().getFullYear();
    this.setData({
      terms,
      staff,
      // 结转向导第 1 步的命名胶囊（新学期名，只填名不填日期）
      sugg: [y + ' 春季班', y + ' 暑假班', y + ' 秋季班', y + ' 寒假班', (y + 1) + ' 春季班', '第 1 期']
    });
  },

  /* ================= 新建学期 ================= */
  // 打开弹层就按中小学历预填（11 月 → 「2026 秋季学期 · 今天~次年1/20」），不想用就点胶囊换
  openCreate() {
    const p = termPresets.smart(new Date());
    this.setData({
      showCreate: true,
      form: { name: p.name, startDate: p.startDate, endDate: p.endDate },
      formKind: p.k
    });
  },
  closeCreate() { this.setData({ showCreate: false }); },
  // 点预设胶囊：名称 + 起止日期整套填好（学期中途建的从今天起）
  pickPreset(e) {
    const k = e.currentTarget.dataset.k;
    const p = termPresets.pick(k, new Date());
    if (!p) return;
    this.setData({
      form: { name: p.name, startDate: p.startDate, endDate: p.endDate },
      formKind: k
    });
  },
  onF(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ ['form.' + k]: e.detail.value, formKind: '' });
  },
  saveTerm() {
    const f = this.data.form;
    const name = (f.name || '').trim();
    if (!name) { wx.showToast({ title: '请给学期起个名字', icon: 'none' }); return; }
    // 长期班（结束日期留空）不设重名闸：尤其不能和内置「长期班」撞名造出第二个
    if (!f.endDate) {
      const dup = db.terms.list().find(t => t.status !== 'archived' && t.name === name);
      if (dup) {
        wx.showToast({ title: '已有同名的进行中学期，无需重复创建', icon: 'none' });
        this.setData({ showCreate: false });
        return;
      }
    }
    const r = db.terms.create({ name, startDate: f.startDate, endDate: f.endDate });
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.setData({ showCreate: false });
    this.refresh();
    wx.showToast({ title: '已创建「' + r.item.name + '」', icon: 'none' });
  },

  /* ================= 长期班结课 ================= */
  // 结束日期留空的学期没有「到期日」可等，用主动结课收尾：结束日期=今天，学期归档为只读
  closeTerm(e) {
    const id = +e.currentTarget.dataset.id;
    const t = db.terms.get(id);
    if (!t) return;
    wx.showModal({
      title: '结课「' + t.name + '」？',
      content: '结束日期将记为今天，学期归档后只读（课堂成果全部保留），此操作不可撤销。',
      success: r => {
        if (!r.confirm) return;
        const res = db.terms.update(id, { status: 'archived', endDate: termPresets.dateStr(new Date()) });
        if (!res.ok) { wx.showToast({ title: res.msg || '结课失败', icon: 'none' }); return; }
        this.refresh();
        wx.showToast({ title: '已结课归档', icon: 'none' });
      }
    });
  },

  /* ================= 结转向导 ================= */
  // 进入向导：数据准备（班级 / 课程 / 学生 / 剩余课时）
  startWizard(e) {
    const termId = +e.currentTarget.dataset.id;
    const r = db.terms.planSettle(termId);
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    const y = new Date().getFullYear();
    const classes = r.classes.map(x => ({
      id: x.cls.id,
      name: x.cls.name,
      mode: x.cls.mode, modeLabel: MODE_LABEL[x.cls.mode] || x.cls.mode,
      // 默认决策：结转制班级默认延续，学期制默认随学期结束
      decision: x.cls.mode === 'carry' ? 'carry' : 'end',
      courses: x.courses.map(c => ({ id: c.id, name: c.name, sel: true })),
      teacherId: 0,
      teacherName: '',
      students: x.students.map(s => ({
        sid: s.student.id, name: s.student.name,
        remain: s.remain,
        hasEn: !!s.enrollment, enId: s.enrollment ? s.enrollment.id : 0,
        act: 're'   // re 续报 / churn 流失（默认续报）
      })),
      reCount: x.students.length,
      churnCount: 0
    }));
    this.setData({
      mode: 'wizard',
      wz: {
        termId, termName: r.term.name,
        step: 1,
        newTerm: { name: (y + 1) + ' 春季班', startDate: '' },
        classes,
        staff: this.data.staff || []
      }
    });
  },
  wzStep(e) { this.setData({ 'wz.step': +e.currentTarget.dataset.s }); },

  // 步骤1：新学期信息
  onWzTerm(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ ['wz.newTerm.' + k]: e.detail.value });
  },
  wzPickSugg(e) { this.setData({ 'wz.newTerm.name': e.currentTarget.dataset.v }); },

  // 步骤1：逐班决策（随学期结束 / 延续到下学期）
  wzDecision(e) {
    const cid = +e.currentTarget.dataset.cid, v = e.currentTarget.dataset.v;
    const classes = this.data.wz.classes.map(c =>
      c.id === cid ? Object.assign({}, c, { decision: v }) : c);
    this.setData({ 'wz.classes': classes });
  },

  // 步骤2：延续班级的课程勾选与老师指派
  wzCourse(e) {
    const ci = +e.currentTarget.dataset.ci, i = +e.currentTarget.dataset.i;
    const classes = this.data.wz.classes.map((c, k) => k !== ci ? c : Object.assign({}, c, {
      courses: c.courses.map((cr, j) => j !== i ? cr : Object.assign({}, cr, { sel: !cr.sel }))
    }));
    this.setData({ 'wz.classes': classes });
  },
  wzTeacher(e) {
    const ci = +e.currentTarget.dataset.ci;
    const t = this.data.wz.staff[+e.detail.value] || { id: 0, name: '' };
    const classes = this.data.wz.classes.map((c, k) =>
      k !== ci ? c : Object.assign({}, c, { teacherId: t.id, teacherName: t.name }));
    this.setData({ 'wz.classes': classes });
  },

  // 步骤3：学生结转（单个切换 + 整班批量）
  wzAct(e) {
    const ci = +e.currentTarget.dataset.ci, i = +e.currentTarget.dataset.i, v = e.currentTarget.dataset.v;
    const classes = this.data.wz.classes.map((c, k) => {
      if (k !== ci) return c;
      const students = c.students.map((s, j) => j !== i ? s : Object.assign({}, s, { act: v }));
      return Object.assign({}, c, {
        students,
        reCount: students.filter(x => x.act === 're').length,
        churnCount: students.filter(x => x.act === 'churn').length
      });
    });
    this.setData({ 'wz.classes': classes });
  },
  wzBatch(e) {
    const ci = +e.currentTarget.dataset.ci, v = e.currentTarget.dataset.v;
    const classes = this.data.wz.classes.map((c, k) => {
      if (k !== ci) return c;
      const students = c.students.map(s => Object.assign({}, s, { act: v }));
      return Object.assign({}, c, {
        students,
        reCount: students.filter(x => x.act === 're').length,
        churnCount: students.filter(x => x.act === 'churn').length
      });
    });
    this.setData({ 'wz.classes': classes });
  },

  // 步骤4：确认生成
  wzReady() {
    const wz = this.data.wz;
    const carry = wz.classes.filter(c => c.decision === 'carry');
    if (!carry.length) return { ok: true, carry, issues: [] };
    const issues = [];
    const noTeacher = carry.filter(c => !c.teacherId);
    if (noTeacher.length) issues.push('有 ' + noTeacher.length + ' 个延续班级未指派老师');
    const noName = !wz.newTerm.name.trim();
    if (noName) issues.push('请填写新学期名称');
    return { ok: !issues.length, carry, issues };
  },
  wzGenerate() {
    const chk = this.wzReady();
    if (!chk.ok) { wx.showToast({ title: chk.issues[0], icon: 'none' }); return; }
    if (this._settling) return;
    this._settling = true;
    const wz = this.data.wz;
    // 落库动作整体交给数据层的 settle()：它把这些写操作包在一个事务里，
    // 中途任何一步失败都整体回滚，旧学期保持原状，老师可以直接重来一次。
    // 以前这里是页面顺序调十几个 db 方法，失败就留下"新班建了一半、旧学期已归档"的现场。
    const res = db.terms.settle({
      termId: wz.termId,
      newTerm: wz.newTerm,
      // chk.carry 已经筛过，这里把 decision 一并带上：settle 会再按它分一次
      classes: chk.carry.map(c => ({
        name: c.name, teacherId: c.teacherId, decision: c.decision,
        courses: c.courses, students: c.students
      }))
    });
    this._settling = false;
    if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
    this.setData({ mode: 'list', wz: null });
    this.refresh();
    const msg = res.clsN
      ? '已完成：延续 ' + res.clsN + ' 个班，续报 ' + res.reN + ' 人，流失 ' + res.churnN + ' 人'
      : '学期已归档';
    wx.showModal({ title: '结转完成', content: msg, showCancel: false, confirmText: '好的' });
  },
  wzCancel() {
    wx.showModal({
      title: '退出结转向导？',
      content: '已做的选择不会保存，旧学期保持原状。',
      success: r => { if (r.confirm) this.setData({ mode: 'list', wz: null }); }
    });
  },
  // 阻止弹层内点击冒泡到遮罩层的空处理
  noop() {},
  // 语音输入：点输入框右端的麦克风说话，再点一次结束
  onMic(e) { voice.dictate(this, e.currentTarget.dataset.k); },
  onHide() { voice.stop(this); }
});
