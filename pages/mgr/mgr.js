const store = require('../../utils/store');

Page({
  data: { tab: 0, tabs: ['班级', '课程', '学生'], classes: [], courses: [], students: [], newCls: '', newCourse: '', courseClsIdx: 0, teacher: '' },
  onShow() {
    const db = store.get();
    this.setData({ teacher: db.teacher });
    this.refresh();
  },
  refresh() {
    const db = store.get();
    this.setData({
      classes: db.classes, courses: db.courses.map(c => ({ id: c.id, name: c.name, cls: store.clsName(c.clsId) })),
      students: db.students.map(s => ({ id: s.id, name: s.name, cls: (s.clsIds || []).map(store.clsName).join('、'), parent: s.parent || '', wechat: s.wechat || '' })),
      courseClsIdx: Math.min(this.data.courseClsIdx, Math.max(0, db.classes.length - 1))
    });
  },
  pickTab(e) { this.setData({ tab: +e.currentTarget.dataset.i }); },
  // 班级
  onNewCls(e) { this.setData({ newCls: e.detail.value }); },
  addClass() {
    const n = this.data.newCls.trim(); if (!n) return;
    const db = store.get(); db.classes.push({ id: Date.now(), name: n }); store.save();
    this.setData({ newCls: '' }); this.refresh();
  },
  delClass(e) {
    wx.showModal({ title: '删除班级不会删除学生记录，确定？', success: r => {
      if (r.confirm) { const db = store.get(); db.classes = db.classes.filter(c => c.id !== e.currentTarget.dataset.id); store.save(); this.refresh(); }
    } });
  },
  // 课程
  onNewCourse(e) { this.setData({ newCourse: e.detail.value }); },
  onCourseCls(e) { this.setData({ courseClsIdx: +e.detail.value }); },
  addCourse() {
    const n = this.data.newCourse.trim(); if (!n) return;
    const db = store.get(); const c = db.classes[this.data.courseClsIdx];
    if (!c) { wx.showToast({ title: '请先添加班级', icon: 'none' }); return; }
    db.courses.push({ id: Date.now(), name: n, clsId: c.id }); store.save();
    this.setData({ newCourse: '' }); this.refresh();
  },
  delCourse(e) {
    wx.showModal({ title: '确定删除该课程？', success: r => {
      if (r.confirm) { const db = store.get(); db.courses = db.courses.filter(c => c.id !== e.currentTarget.dataset.id); store.save(); this.refresh(); }
    } });
  },
  // 学生
  addStudent() {
    const db = store.get();
    wx.showModal({
      title: '添加学生', editable: true, placeholderText: '学生姓名',
      success: r => {
        if (r.confirm && r.content && r.content.trim()) {
          db.students.push({ id: Date.now(), name: r.content.trim(), clsIds: db.classes.length ? [db.classes[0].id] : [], parent: '', wechat: '' });
          store.save(); this.refresh(); wx.showToast({ title: '已添加' });
        }
      }
    });
  },
  delStudent(e) {
    wx.showModal({ title: '确定删除该学生？', success: r => {
      if (r.confirm) { const db = store.get(); db.students = db.students.filter(s => s.id !== e.currentTarget.dataset.id); store.save(); this.refresh(); }
    } });
  }
});
