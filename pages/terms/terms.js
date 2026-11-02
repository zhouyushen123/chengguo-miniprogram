// pages/terms/terms.js —— 学期管理：学期列表 / 新建 / 结束本学期（四步结转向导）
const db = require('../../utils/db');
const theme = require('../../utils/theme');

const STATUS_LABEL = { upcoming: '未开始', active: '进行中', archived: '已归档' };
const MODE_LABEL = { term: '学期制', carry: '课时结转' };

Page({
  data: {
    mode: 'list',            // list 学期列表 / wizard 结转向导
    terms: [],
    // 新建学期表单
    showCreate: false,
    form: { name: '', startDate: '', endDate: '' },
    sugg: [],                // 命名建议胶囊（按当前年份生成，点一下填入）
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
      dates: [t.startDate, t.endDate].filter(Boolean).join(' ~ ') || '未设置起止日期',
      status: t.status, statusLabel: STATUS_LABEL[t.status] || t.status,
      builtIn: !!t.builtIn,
      clsCount: db.classes._all().filter(c => !c.removed && c.termId === t.id).length,
      canSettle: t.status === 'active' && !t.builtIn
    }));
    const y = new Date().getFullYear();
    this.setData({
      terms,
      staff,
      sugg: [y + ' 春季班', y + ' 暑假班', y + ' 秋季班', y + ' 寒假班', (y + 1) + ' 春季班', '第 1 期']
    });
  },

  /* ================= 新建学期 ================= */
  openCreate() { this.setData({ showCreate: true, form: { name: '', startDate: '', endDate: '' } }); },
  closeCreate() { this.setData({ showCreate: false }); },
  onF(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ ['form.' + k]: e.detail.value });
  },
  // 点建议胶囊填入名称
  pickSugg(e) { this.setData({ 'form.name': e.currentTarget.dataset.v }); },
  saveTerm() {
    const f = this.data.form;
    const r = db.terms.create({ name: (f.name || '').trim(), startDate: f.startDate, endDate: f.endDate });
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.setData({ showCreate: false });
    this.refresh();
    wx.showToast({ title: '已创建「' + r.item.name + '」', icon: 'none' });
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
    const i = this.data.wz.classes.findIndex(c => c.id === cid);
    this.setData({ ['wz.classes[' + i + '].decision']: v });
  },

  // 步骤2：延续班级的课程勾选与老师指派
  wzCourse(e) {
    const ci = +e.currentTarget.dataset.ci, i = +e.currentTarget.dataset.i;
    const key = 'wz.classes[' + ci + '].courses[' + i + '].sel';
    this.setData({ [key]: !this.data.wz.classes[ci].courses[i].sel });
  },
  wzTeacher(e) {
    const ci = +e.currentTarget.dataset.ci;
    const idx = +e.detail.value;
    const t = this.data.wz.staff[idx] || { id: 0, name: '' };
    this.setData({ ['wz.classes[' + ci + '].teacherId']: t.id, ['wz.classes[' + ci + '].teacherName']: t.name });
  },

  // 步骤3：学生结转（单个切换 + 整班批量）
  wzAct(e) {
    const ci = +e.currentTarget.dataset.ci, i = +e.currentTarget.dataset.i, v = e.currentTarget.dataset.v;
    this.setData({ ['wz.classes[' + ci + '].students[' + i + '].act']: v });
    this._recount(ci);
  },
  wzBatch(e) {
    const ci = +e.currentTarget.dataset.ci, v = e.currentTarget.dataset.v;
    const students = this.data.wz.classes[ci].students.map(s => Object.assign(s, { act: v }));
    this.setData({ ['wz.classes[' + ci + '].students']: students });
    this._recount(ci);
  },
  _recount(ci) {
    const st = this.data.wz.classes[ci].students;
    this.setData({
      ['wz.classes[' + ci + '].reCount']: st.filter(s => s.act === 're').length,
      ['wz.classes[' + ci + '].churnCount']: st.filter(s => s.act === 'churn').length
    });
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
    const wz = this.data.wz;
    let reN = 0, churnN = 0, clsN = 0;
    const carry = chk.carry;

    if (carry.length) {
      // 新学期：已有同名进行中学期就直接用，否则创建
      let nt = db.terms.list().find(t => t.name === wz.newTerm.name.trim() && t.status !== 'archived');
      if (!nt) {
        const r = db.terms.create({ name: wz.newTerm.name.trim(), startDate: wz.newTerm.startDate });
        if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
        nt = r.item;
      }
      carry.forEach(c => {
        const rc = db.classes.create({ name: c.name, termId: nt.id, mode: 'carry', teacherId: c.teacherId });
        if (!rc.ok) return;
        clsN++;
        const newId = rc.item.id;
        // 复制勾选的课程到新班
        c.courses.filter(x => x.sel).forEach(x => { db.courses.create({ name: x.name, clsId: newId }); });
        c.students.forEach(s => {
          if (s.act === 're') {
            // 续报：加入新班 + 剩余课时带入 + 溯源旧报名
            const stu = db.students.get(s.sid);
            if (stu && stu.clsIds.indexOf(newId) < 0) {
              db.students.update(s.sid, { clsIds: stu.clsIds.concat([newId]) });
            }
            const er = db.enrollments.create({
              studentId: s.sid, clsId: newId,
              totalHours: s.remain, usedHours: 0, carriedFrom: s.enId || 0
            });
            if (er.ok) reN++;
            if (s.enId) db.enrollments.update(s.enId, { status: 'carried' });
          } else {
            churnN++;
            if (s.enId) db.enrollments.update(s.enId, { status: 'churned' });
          }
        });
      });
    }
    // 旧学期归档（只读）
    db.terms.archive(wz.termId);
    this.setData({ mode: 'list', wz: null });
    this.refresh();
    const msg = clsN
      ? '已完成：延续 ' + clsN + ' 个班，续报 ' + reN + ' 人，流失 ' + churnN + ' 人'
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
  noop() {}
});
