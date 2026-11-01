const db = require('../../utils/db');
const icons = require('../../utils/icons');

Page({
  data: {
    tab: 0, tabs: ['班级', '课程', '学生', '人员'],
    classes: [], courses: [], students: [], users: [], teacher: '',
    newCls: '', newCourse: '', courseClsIdx: 0,
    // 学生表单弹层
    stuForm: null, stuClsSel: [], icoCamera: icons.camera,
    // 人员表单弹层
    userForm: null, userClsSel: [], userStuSel: [], userCrsSel: []
  },
  onShow() { this.refresh(); },
  refresh() {
    const s = db.settings();
    const classes = db.classes.list();
    const users = db.users.list();
    this.setData({
      teacher: s.teacher,
      classes,
      courses: db.courses.list().map(c => ({ id: c.id, name: c.name, cls: db.classes.name(c.clsId) })),
      students: db.students.list().map(st => ({
        id: st.id, name: st.name,
        cls: (st.clsIds || []).map(db.classes.name).join('、') || '未加入班级',
        parent: st.parent || '', wechat: st.wechat || ''
      })),
      users: users.map(u => ({
        id: u.id, name: u.name, role: u.role,
        roleN: u.role === 'teacher' ? '老师' : u.role === 'parent' ? '家长' : '管理员',
        meta: u.role === 'teacher'
          ? '班级：' + ((u.clsIds || []).map(db.classes.name).join('、') || '未分配') +
            ' · 课程：' + ((u.courseIds || []).length
              ? u.courseIds.map(id => (db.courses.get(id) || {}).name).join('、') : '全部')
          : u.role === 'parent'
            ? '孩子：' + ((u.studentIds || []).map(id => (db.students.get(id) || {}).name).join('、') || '未关联')
            : '全部管理权限',
        cur: u.id === s.me
      })),
      courseClsIdx: Math.min(this.data.courseClsIdx, Math.max(0, classes.length - 1))
    });
  },
  pickTab(e) { this.setData({ tab: +e.currentTarget.dataset.i }); },

  /* ================= 班级 / 课程 ================= */
  onNewCls(e) { this.setData({ newCls: e.detail.value }); },
  addClass() {
    const n = this.data.newCls.trim();
    const r = db.classes.create({ name: n });
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.setData({ newCls: '' }); this.refresh();
  },
  delClass(e) {
    const id = +e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除这个班级？',
      content: '该班课程会一并删除，学生变为未分班，历史成果记录保留。',
      success: r => {
        if (!r.confirm) return;
        const res = db.classes.remove(id);
        if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
        this.refresh();
      }
    });
  },
  onNewCourse(e) { this.setData({ newCourse: e.detail.value }); },
  onCourseCls(e) { this.setData({ courseClsIdx: +e.detail.value }); },
  addCourse() {
    const n = this.data.newCourse.trim();
    const c = db.classes.list()[this.data.courseClsIdx];
    if (!c) { wx.showToast({ title: '请先添加班级', icon: 'none' }); return; }
    const r = db.courses.create({ name: n, clsId: c.id });
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.setData({ newCourse: '' }); this.refresh();
  },
  delCourse(e) {
    const id = +e.currentTarget.dataset.id;
    wx.showModal({ title: '确定删除该课程？', success: r => {
      if (!r.confirm) return;
      const res = db.courses.remove(id);
      if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
      this.refresh();
    } });
  },

  /* ================= 学生：弹层表单（姓名+班级多选+家长+微信） ================= */
  addStudent() { this.openStuForm(null); },
  editStudent(e) { this.openStuForm(e.currentTarget.dataset.id); },
  openStuForm(id) {
    const s = id ? db.students.get(id) : null;
    this.setData({
      stuForm: { id: id || null, name: s ? s.name : '', parent: s ? (s.parent || '') : '', wechat: s ? (s.wechat || '') : '', photo: s ? (s.photo || '') : '' },
      stuClsSel: s ? (s.clsIds || []).slice() : []
    });
  },
  onStuName(e) { this.setData({ 'stuForm.name': e.detail.value }); },
  // 上传学生照片：拍照/相册均可，拷贝到用户目录确保持久保存
  onStuPhoto() {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'],
      success: r => {
        const tmp = r.tempFiles[0] && r.tempFiles[0].tempFilePath;
        if (!tmp) return;
        try {
          const dest = wx.env.USER_DATA_PATH + '/stu_' + Date.now() + '.jpg';
          wx.getFileSystemManager().copyFileSync(tmp, dest);
          this.setData({ 'stuForm.photo': dest });
        } catch (e) { this.setData({ 'stuForm.photo': tmp }); }
      }
    });
  },
  onStuParent(e) { this.setData({ 'stuForm.parent': e.detail.value }); },
  onStuWechat(e) { this.setData({ 'stuForm.wechat': e.detail.value }); },
  stuClsTgl(e) {
    const id = +e.currentTarget.dataset.id, sel = this.data.stuClsSel.slice();
    const i = sel.indexOf(id); i >= 0 ? sel.splice(i, 1) : sel.push(id);
    this.setData({ stuClsSel: sel });
  },
  stuCancel() { this.setData({ stuForm: null }); },
  stuSave() {
    const f = this.data.stuForm, sel = this.data.stuClsSel;
    const n = (f.name || '').trim();
    const payload = {
      name: n, clsIds: sel.slice(),
      parent: (f.parent || '').trim(), wechat: (f.wechat || '').trim(), photo: f.photo || ''
    };
    const r = f.id ? db.students.update(f.id, payload) : db.students.create(payload);
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.setData({ stuForm: null }); this.refresh();
    wx.showToast({ title: '已保存', icon: 'success' });
  },
  goStudentPage(e) {
    wx.navigateTo({ url: '/pages/student/student?id=' + e.currentTarget.dataset.id });
  },
  delStudent(e) {
    const id = +e.currentTarget.dataset.id;
    const s = db.students.get(id);
    wx.showModal({
      title: '删除这个学生？',
      content: (s ? s.name : '该学生') + ' 的 ' + db.records.ofStudent(id).length + ' 条成果记录会一并删除，且不可恢复。',
      success: r => {
        if (!r.confirm) return;
        const res = db.students.remove(id);
        if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
        this.refresh();
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },

  /* ================= 人员（老师/家长） ================= */
  addUserTeacher() { this.openUserForm({ role: 'teacher' }); },
  addUserParent() { this.openUserForm({ role: 'parent' }); },
  editUser(e) {
    const u = db.users.get(e.currentTarget.dataset.id);
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
    const id = +e.currentTarget.dataset.id, sel = this.data[key].slice();
    const i = sel.indexOf(id); i >= 0 ? sel.splice(i, 1) : sel.push(id);
    this.setData({ [key]: sel });
  },
  userCancel() { this.setData({ userForm: null }); },
  userSave() {
    const f = this.data.userForm;
    const n = (f.name || '').trim();
    // 老师限定负责的班级/课程；家长限定关联的孩子，两类权限互斥
    const base = f.role === 'teacher'
      ? { name: n, clsIds: this.data.userClsSel.slice(), courseIds: this.data.userCrsSel.slice(), studentIds: [] }
      : { name: n, studentIds: this.data.userStuSel.slice(), clsIds: [], courseIds: [] };
    const r = f.id
      ? db.users.update(f.id, base)
      : db.users.create(Object.assign({ role: f.role }, base));
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.setData({ userForm: null }); this.refresh();
    wx.showToast({ title: '已保存', icon: 'success' });
  },
  delUser(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({ title: '确定删除该人员？', success: r => {
      if (!r.confirm) return;
      const res = db.users.remove(id);
      if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
      this.refresh();
    } });
  },
  switchMe(e) {
    const res = db.users.switchTo(e.currentTarget.dataset.id);
    if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
    this.refresh();
    wx.showToast({ title: '已切换身份', icon: 'success' });
  }
});
