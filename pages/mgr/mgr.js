const db = require('../../utils/db');
const icons = require('../../utils/icons');

// 角色选项目：负责人不在新建时出现（一个机构只能有一个，靠「移交」转移）
const ROLE_OPTS = [
  { k: 'teacher', n: '老师', d: '可录入与管理自己班级的成果' },
  { k: 'parent', n: '家长', d: '只能看自己孩子已发布的成果' },
  { k: 'admin', n: '管理员', d: '等同负责人，可管理全部班级与成员' }
];

Page({
  data: {
    tab: 0, tabs: ['班级', '课程', '学生', '人员'],
    orgName: '', isManager: false, myRole: '', myRoleLabel: '',
    classes: [], courses: [], students: [], members: [],
    newCls: '', newCourse: '', courseClsIdx: 0,
    // 学生表单弹层
    stuForm: null, stuClsSel: [], icoCamera: icons.camera,
    // 成员表单弹层
    userForm: null, userClsSel: [], userStuSel: [], userCrsSel: [],
    roleOpts: ROLE_OPTS
  },
  onShow() { this.refresh(); },
  refresh() {
    const s = db.settings();
    const classes = db.classes.list();
    // 只有负责人/管理员能进人员管理；老师进来看不到别人的权限范围
    const isManager = db.auth.isAdmin();

    this.setData({
      orgName: s.orgName,
      isManager,
      myRole: s.role,
      myRoleLabel: s.roleLabel,
      tabs: isManager ? ['班级', '课程', '学生', '人员'] : ['班级', '课程', '学生'],
      tab: Math.min(this.data.tab, isManager ? 3 : 2),
      teacher: s.teacher,
      classes,
      courses: db.courses.list().map(c => ({ id: c.id, name: c.name, cls: db.classes.name(c.clsId) })),
      students: db.students.list().map(st => ({
        id: st.id, name: st.name,
        cls: (st.clsIds || []).map(db.classes.name).join('、') || '未加入班级',
        parent: st.parent || '', wechat: st.wechat || ''
      })),
      members: isManager ? db.members.list().map(m => {
        const v = db.members.view(m);
        return {
          id: v.id, userId: v.userId, name: v.name,
          role: v.role, roleLabel: v.roleLabel,
          status: v.status, invited: v.status === 'invited',
          // 范围描述：管理级无需范围，老师列班级，家长列孩子
          meta: v.full
            ? '全机构可见'
            : v.role === 'parent'
              ? ('孩子：' + (v.kidText || '未绑定'))
              : ('班级：' + (v.clsText || '未分配')),
          cur: v.userId === s.me,
          clsIds: v.clsIds, courseIds: v.courseIds, studentIds: v.studentIds
        };
      }) : [],
      courseClsIdx: Math.min(this.data.courseClsIdx, Math.max(0, classes.length - 1))
    });
  },
  pickTab(e) { this.setData({ tab: +e.currentTarget.dataset.i }); },

  /* ================= 机构名称 ================= */
  onOrgName(e) { this.setData({ orgName: e.detail.value }); },
  saveOrg() {
    const n = (this.data.orgName || '').trim();
    if (!n) { wx.showToast({ title: '机构名称不能为空', icon: 'none' }); return; }
    const r = db.orgs.update({ name: n });
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    wx.showToast({ title: '已保存', icon: 'success' });
    this.refresh();
  },

  /* ================= 班级 / 课程 ================= */
  onNewCls(e) { this.setData({ newCls: e.detail.value }); },
  addClass() {
    const n = (this.data.newCls || '').trim();
    const r = db.classes.create({ name: n });
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.setData({ newCls: '' }); this.refresh();
  },
  delClass(e) {
    const id = +e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除这个班级？',
      content: '该班课程会一并删除，学生变为未分班，历史成果记录保留，负责该班的老师会同步失去这个班。',
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
    const n = (this.data.newCourse || '').trim();
    const c = this.data.classes[this.data.courseClsIdx];
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

  /* ================= 成员（角色 + 数据范围） ================= */
  addUserTeacher() { this.openUserForm({ role: 'teacher' }); },
  addUserParent() { this.openUserForm({ role: 'parent' }); },
  editUser(e) {
    const m = this.data.members.find(x => x.id === +e.currentTarget.dataset.id);
    if (m) this.openUserForm(m);
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
  pickRole(e) { this.setData({ 'userForm.role': e.currentTarget.dataset.k }); },
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
    if (!n) { wx.showToast({ title: '请填写姓名', icon: 'none' }); return; }
    // 三类身份的范围互斥：老师带班、家长带孩子、管理员全可见无需范围
    let payload;
    if (f.role === 'parent') {
      const kids = this.data.userStuSel.slice();
      if (!kids.length) { wx.showToast({ title: '请至少绑定一个孩子', icon: 'none' }); return; }
      payload = { name: n, role: 'parent', studentIds: kids, clsIds: [], courseIds: [] };
    } else if (f.role === 'admin') {
      payload = { name: n, role: 'admin', clsIds: [], courseIds: [], studentIds: [] };
    } else {
      const cls = this.data.userClsSel.slice();
      // 老师没有班级 = 什么都看不到。与其建一个空权限账号，不如当场拦住
      if (!cls.length) { wx.showToast({ title: '老师至少要分配一个班级', icon: 'none' }); return; }
      payload = { name: n, role: 'teacher', clsIds: cls, courseIds: this.data.userCrsSel.slice(), studentIds: [] };
    }
    const r = f.id
      ? db.members.update(f.id, payload)
      : db.members.create(payload);
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.setData({ userForm: null }); this.refresh();
    wx.showToast({ title: '已保存', icon: 'success' });
  },
  delUser(e) {
    const id = +e.currentTarget.dataset.id;
    const m = this.data.members.find(x => x.id === id);
    wx.showModal({
      title: '移出这个成员？',
      content: (m ? m.name : '该成员') + ' 将无法再进入本机构，其录入的历史记录会保留。',
      success: r => {
        if (!r.confirm) return;
        const res = db.members.remove(id);
        if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
        this.refresh();
      }
    });
  },
  switchMe(e) {
    const m = this.data.members.find(x => x.id === +e.currentTarget.dataset.id);
    if (!m) return;
    const res = db.users.switchTo(m.userId);
    if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
    this.refresh();
    wx.showToast({ title: '已切换为 ' + (res.item.name || '') + '（' + (m.roleLabel || '') + '）', icon: 'none' });
  }
});
