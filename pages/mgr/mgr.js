const store = require('../../utils/store');

Page({
  data: {
    tab: 0, tabs: ['班级', '课程', '学生', '人员'],
    classes: [], courses: [], students: [], users: [], teacher: '',
    newCls: '', newCourse: '', courseClsIdx: 0,
    // 学生表单弹层
    stuForm: null, stuClsSel: [],
    // 人员表单弹层
    userForm: null, userClsSel: [], userStuSel: [], userCrsSel: []
  },
  onShow() { this.refresh(); },
  refresh() {
    const db = store.get();
    // 数据兼容：老数据补 users 字段
    db.users = (db.users || []).map(u => Object.assign({ clsIds: [], courseIds: [], studentIds: [] }, u));
    this.setData({
      teacher: db.teacher,
      classes: db.classes,
      courses: db.courses.map(c => ({ id: c.id, name: c.name, cls: store.clsName(c.clsId) })),
      students: store.allStudents().map(s => ({
        id: s.id, name: s.name,
        cls: (s.clsIds || []).map(store.clsName).join('、') || '未加入班级',
        parent: s.parent || '', wechat: s.wechat || ''
      })),
      users: db.users.map(u => ({
        id: u.id, name: u.name, role: u.role,
        roleN: u.role === 'teacher' ? '老师' : u.role === 'parent' ? '家长' : '管理员',
        meta: u.role === 'teacher'
          ? '班级：' + ((u.clsIds || []).map(store.clsName).join('、') || '未分配') + ' · 课程：' + ((u.courseIds || []).length ? u.courseIds.map(id => (db.courses.find(c => c.id === id) || {}).name).join('、') : '全部')
          : u.role === 'parent' ? '孩子：' + ((u.studentIds || []).map(id => (store.student(id) || {}).name).join('、') || '未关联') : '全部管理权限',
        cur: u.id === db.me
      })),
      courseClsIdx: Math.min(this.data.courseClsIdx, Math.max(0, db.classes.length - 1))
    });
  },
  pickTab(e) { this.setData({ tab: +e.currentTarget.dataset.i }); },
  /* ================= 班级 / 课程 ================= */
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
  /* ================= 学生：弹层表单（姓名+班级多选+家长+微信） ================= */
  addStudent() { this.openStuForm(null); },
  editStudent(e) { this.openStuForm(e.currentTarget.dataset.id); },
  openStuForm(id) {
    const db = store.get();
    const s = id ? db.students.find(x => x.id === id) : null;
    this.setData({
      stuForm: { id: id || null, name: s ? s.name : '', parent: s ? (s.parent || '') : '', wechat: s ? (s.wechat || '') : '' },
      stuClsSel: s ? (s.clsIds || []).slice() : []
    });
  },
  onStuName(e) { this.setData({ 'stuForm.name': e.detail.value }); },
  onStuParent(e) { this.setData({ 'stuForm.parent': e.detail.value }); },
  onStuWechat(e) { this.setData({ 'stuForm.wechat': e.detail.value }); },
  stuClsTgl(e) {
    const id = e.currentTarget.dataset.id, sel = this.data.stuClsSel.slice();
    const i = sel.indexOf(id); i >= 0 ? sel.splice(i, 1) : sel.push(id);
    this.setData({ stuClsSel: sel });
  },
  stuCancel() { this.setData({ stuForm: null }); },
  stuSave() {
    const f = this.data.stuForm, sel = this.data.stuClsSel;
    const n = (f.name || '').trim(); if (!n) { wx.showToast({ title: '请输入姓名', icon: 'none' }); return; }
    const db = store.get();
    if (f.id) {
      const s = db.students.find(x => x.id === f.id);
      Object.assign(s, { name: n, clsIds: sel.slice(), parent: f.parent.trim(), wechat: f.wechat.trim() });
    } else {
      db.students.push({ id: Date.now(), name: n, clsIds: sel.slice(), parent: f.parent.trim(), wechat: f.wechat.trim() });
    }
    store.save(); this.setData({ stuForm: null }); this.refresh();
    wx.showToast({ title: '已保存', icon: 'success' });
  },
  goStudentPage(e) {
    wx.navigateTo({ url: '/pages/student/student?id=' + e.currentTarget.dataset.id });
  },
  delStudent(e) {
    wx.showModal({ title: '确定删除该学生？', success: r => {
      if (r.confirm) { const db = store.get(); db.students = db.students.filter(s => s.id !== e.currentTarget.dataset.id); store.save(); this.refresh(); }
    } });
  },
  /* ================= 人员（老师/家长） ================= */
  addUserTeacher() { this.openUserForm({ role: 'teacher' }); },
  addUserParent() { this.openUserForm({ role: 'parent' }); },
  editUser(e) {
    const db = store.get();
    const u = db.users.find(x => x.id === e.currentTarget.dataset.id);
    if (u) this.openUserForm(u);
  },
  openUserForm(u) {
    this.setData({
      userForm: { id: u.id || null, role: u.role, name: u.name || '' },
      userClsSel: (u.clsIds || []).slice(),
      userCrsSel: (u.courseIds || []).slice(),
      userStuSel: (u.studentIds || []).slice()
    });
  },
  onUserName(e) { this.setData({ 'userForm.name': e.detail.value }); },
  userClsTgl(e) { this._tgl('userClsSel', e); },
  userCrsTgl(e) { this._tgl('userCrsSel', e); },
  userStuTgl(e) { this._tgl('userStuSel', e); },
  _tgl(key, e) {
    const id = e.currentTarget.dataset.id, sel = this.data[key].slice();
    const i = sel.indexOf(id); i >= 0 ? sel.splice(i, 1) : sel.push(id);
    this.setData({ [key]: sel });
  },
  userCancel() { this.setData({ userForm: null }); },
  userSave() {
    const f = this.data.userForm;
    const n = (f.name || '').trim(); if (!n) { wx.showToast({ title: '请输入姓名', icon: 'none' }); return; }
    const db = store.get();
    const base = { name: n };
    if (f.role === 'teacher') Object.assign(base, { clsIds: this.data.userClsSel.slice(), courseIds: this.data.userCrsSel.slice(), studentIds: [] });
    else Object.assign(base, { studentIds: this.data.userStuSel.slice(), clsIds: [], courseIds: [] });
    if (f.id) {
      Object.assign(db.users.find(x => x.id === f.id), base);
    } else {
      db.users.push(Object.assign({ id: 'u' + Date.now(), role: f.role }, base));
    }
    store.save(); this.setData({ userForm: null }); this.refresh();
    wx.showToast({ title: '已保存', icon: 'success' });
  },
  delUser(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({ title: '确定删除该人员？', success: r => {
      if (r.confirm) { const db = store.get(); db.users = db.users.filter(u => u.id !== id); if (db.me === id) db.me = db.users[0] && db.users[0].id; store.save(); this.refresh(); }
    } });
  },
  switchMe(e) {
    const db = store.get();
    db.me = e.currentTarget.dataset.id;
    db.role = (db.users.find(u => u.id === db.me) || {}).role || 'teacher';
    store.save(); this.refresh();
    wx.showToast({ title: '已切换身份', icon: 'success' });
  }
});
