// pkg-low/lessons/lessons.js —— 课次管理：一门课每个学期的每次课
// 功能：按学期分组的课次列表 / 单次添加 / 批量生成（起始日期+每周几+次数）/ 编辑 /
//       确认（软标记）/ 删除（作废）/ 序号错乱提示 + 一键重排。
// 入口：管理页课程列表「课次」。方案与行为规则见 docs/lesson-plan.md。
const db = require('../../utils/db');
const theme = require('../../utils/theme');
const voice = require('../../utils/voice');

const WEEK = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const TERM_STATUS_LABEL = { upcoming: '未开始', active: '进行中', archived: '已归档' };

Page({
  data: {
    courseId: 0, courseName: '',
    canWrite: false, canConfirm: false,
    groups: [],            // [{ id(termId), name, statusLabel, archived, disorder, lessons[] }]
    sheet: '',             // '' | add | edit | batch
    form: { id: 0, date: '', startTime: '', endTime: '', title: '', content: '' },
    formTermId: 0,         // 当前弹层操作的是哪个学期（添加/批量要挂对学期）
    batch: { startDate: '', weekdays: [], count: 8, startTime: '', endTime: '' },
    weekChips: WEEK.slice(1).map((t, i) => ({ k: i + 1, t }))
  },

  onLoad(q) {
    const courseId = Number(q.id) || 0;
    const c = db.courses.get(courseId);
    if (!c) { wx.showToast({ title: '课程不存在', icon: 'none' }); setTimeout(() => wx.navigateBack(), 600); return; }
    this.setData({ courseId, courseName: c.name });
    wx.setNavigationBarTitle({ title: '课次 · ' + c.name });
  },
  onShow() { theme.apply(this); this.refresh(); },

  refresh() {
    const courseId = this.data.courseId;
    if (!courseId) return;
    const canWrite = db.auth.can('lesson.write', { courseId });
    const canConfirm = db.auth.can('lesson.confirm', { courseId });
    const groups = db.lessons.groups(courseId).map(g => {
      const term = g.term;
      const archived = !term || term.status === 'archived';
      return {
        id: term ? term.id : 0,
        name: term ? term.name : '未挂学期',
        statusLabel: term ? (TERM_STATUS_LABEL[term.status] || term.status) : '',
        archived,
        // 归档学期只读；错乱检测只在可写时算（只读组提示了也点不了重排）
        disorder: canWrite && !archived ? db.lessons.disorder(courseId, term ? term.id : 0) : false,
        lessons: g.lessons.map(l => {
          const updated = l.status === 'confirmed' && l.contentEditedAt > l.confirmedAt;
          return {
            id: l.id, seq: l.seq,
            date: l.date || '', weekday: l.date ? WEEK[l.weekday] || '' : '',
            time: (l.startTime || l.endTime) ? (l.startTime || '--') + '~' + (l.endTime || '--') : '',
            title: l.title || '', content: l.content || '',
            status: l.status,
            statusLabel: l.status === 'confirmed' ? (updated ? '已确认 · 内容有更新' : '已确认') : '待确认',
            pill: l.status === 'confirmed' ? (updated ? 'pill-upd' : 'pill-active') : 'pill-draft',
            confirmed: l.status === 'confirmed'
          };
        })
      };
    });
    this.setData({ canWrite, canConfirm, groups });
  },

  /* ================= 单次添加 / 编辑 ================= */
  openAdd(e) {
    const termId = Number(e.currentTarget.dataset.tid) || 0;
    const today = new Date();
    const pad = n => (n < 10 ? '0' + n : '' + n);
    this.setData({
      sheet: 'add', formTermId: termId,
      form: { id: 0, date: today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate()), startTime: '', endTime: '', title: '', content: '' }
    });
  },
  openEdit(e) {
    const id = Number(e.currentTarget.dataset.id);
    // 从 view model 取展示值太绕，直接从数据层拿原始行（课程范围已过权限，能进列表的就能看）
    const l = db.lessons.get(id);
    if (!l) return;
    this.setData({
      sheet: 'edit', formTermId: l.termId,
      form: { id: l.id, date: l.date || '', startTime: l.startTime || '', endTime: l.endTime || '', title: l.title || '', content: l.content || '' }
    });
  },
  closeSheet() { this.setData({ sheet: '' }); },
  onForm(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ ['form.' + k]: e.detail.value });
  },
  saveForm() {
    const f = this.data.form;
    const r = this.data.sheet === 'edit'
      ? db.lessons.update(f.id, { date: f.date, startTime: f.startTime, endTime: f.endTime, title: f.title, content: f.content })
      : db.lessons.create(this.data.courseId, { termId: this.data.formTermId, date: f.date, startTime: f.startTime, endTime: f.endTime, title: f.title, content: f.content });
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.setData({ sheet: '' });
    this.refresh();
    // C' 序号：补录旧日期会提示重排；不点不强制
    if (r.disorder) {
      wx.showModal({
        title: '序号与日期顺序不一致',
        content: '刚建的课日期比前面的课早。要按日期重排后续序号吗？也可以在列表里随时重排。',
        confirmText: '按日期重排', cancelText: '先不动',
        success: m => { if (m.confirm) this.reorderNow(r.item.termId); }
      });
    }
  },

  /* ================= 批量生成 ================= */
  openBatch(e) {
    const termId = Number(e.currentTarget.dataset.tid) || 0;
    const today = new Date();
    const pad = n => (n < 10 ? '0' + n : '' + n);
    this.setData({
      sheet: 'batch', formTermId: termId,
      batch: { startDate: today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate()), weekdays: [], count: 8, startTime: '', endTime: '' }
    });
  },
  onBatch(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ ['batch.' + k]: e.detail.value });
  },
  toggleWeek(e) {
    const k = Number(e.currentTarget.dataset.k);
    const set = this.data.batch.weekdays.slice();
    const i = set.indexOf(k);
    if (i > -1) set.splice(i, 1); else set.push(k);
    set.sort();
    this.setData({ 'batch.weekdays': set });
  },
  saveBatch() {
    const b = this.data.batch;
    const r = db.lessons.batch(this.data.courseId, {
      termId: this.data.formTermId, startDate: b.startDate,
      weekdays: b.weekdays, count: b.count,
      startTime: b.startTime, endTime: b.endTime
    });
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.setData({ sheet: '' });
    this.refresh();
    wx.showToast({ title: '已生成 ' + r.items.length + ' 次课', icon: 'none' });
  },

  /* ================= 确认 / 删除 / 重排 ================= */
  confirmLesson(e) {
    const r = db.lessons.confirm(Number(e.currentTarget.dataset.id));
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.refresh();
    wx.showToast({ title: '已确认', icon: 'none' });
  },
  delLesson(e) {
    const id = Number(e.currentTarget.dataset.id);
    const linked = db.lessons.linked(id);
    const content = linked
      ? '已有 ' + linked + ' 条课堂记录关联这次课。删除后记录保留，但会显示为「未关联课次」。确定吗？'
      : '删除这次课后可从回收站还原。确定吗？';
    wx.showModal({
      title: '删除课次？',
      content,
      success: m => {
        if (!m.confirm) return;
        const r = db.lessons.remove(id);
        if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
        this.refresh();
        wx.showToast({ title: '已删除', icon: 'none' });
      }
    });
  },
  reorderTip(e) {
    const termId = Number(e.currentTarget.dataset.tid) || 0;
    wx.showModal({
      title: '按日期重排？',
      content: '有日期的课次将按（日期, 开始时间）重新编号，无日期的排在后面按创建顺序。课堂记录不受影响。',
      success: m => { if (m.confirm) this.reorderNow(termId); }
    });
  },
  reorderNow(termId) {
    const r = db.lessons.reorder(this.data.courseId, termId);
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.refresh();
    wx.showToast({ title: '已重排', icon: 'none' });
  },

  noop() {},
  onMic(e) { voice.dictate(this, e.currentTarget.dataset.k); },
  onHide() { voice.stop(this); }
});
