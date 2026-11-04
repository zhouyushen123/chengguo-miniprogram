const db = require('../../utils/db');
const icons = require('../../utils/icons');
const media = require('../../utils/media');
const theme = require('../../utils/theme');
const voice = require('../../utils/voice');

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
    // 新建班级表单：学期 / 模式 / 主讲
    clsTerms: [], clsTermIdx: 0, clsMode: 'term', clsTeachers: [], clsTeacherIdx: 0,
    // 学生表单弹层
    // icoCameraW：压在全品牌色头像块上的相机图标，必须恒为白色，故不参与主题图标整包（换肤会覆盖）
    stuForm: null, stuClsSel: [], stuClsChips: [], icoCamera: icons.camera, icoUser: icons.user,
    icoCameraW: '/assets/icons/camera-white.png',
    // 学生筛选：模糊搜索（姓名/家长/微信号）+ 入学年份 + 性别；stuYears 由现有学生倒推
    stuQ: '', stuYears: [{ y: 0, name: '全部' }], stuYearIdx: 0, stuGender: '', stuCount: 0,
    // 班级页签：卡片展开看本班学生（clsExpand=展开的班级 id，0=全部收起）
    clsExpand: 0, clsStuQ: '', clsStus: [], clsFormOpen: false,
    icoChev: icons.chevron,
    // 学生表单：入学年份选择器（未填 + 近 13 年，倒序）
    enrollYearOpts: [{ y: 0, name: '未填' }], stuEnrollYearIdx: 0,
    // 成员表单弹层（chips = 预计算好 on 标记的渲染数组，WXML 不做任何方法调用）
    userForm: null, userClsSel: [], userStuSel: [], userCrsSel: [],
    userClsChips: [], userStuChips: [], userCrsChips: [],
    roleOpts: ROLE_OPTS
  },
  // 从个人中心带参进入：?tab=3 直达人员管理
  onLoad(q) {
    if (q && q.tab !== undefined) this.setData({ tab: Math.min(+q.tab || 0, 3) });
  },
  onShow() { theme.apply(this); this.refresh(); },
  // 阻止弹窗内点击冒泡到遮罩层（关闭弹窗）的空处理
  noop() {},
  refresh() {
    const s = db.settings();
    // 班级视图：补学期名 / 模式 / 主讲，列表直接可读
    const terms = db.terms.list();
    const staff = db.members.list()
      .filter(m => m.role !== 'parent' && m.status === 'active')
      .map(m => ({ id: m.id, name: m.name || '（未命名）' }));
    // 主讲老师姓名：teacherId 存的是 member.id（不是 user.id），所以查 members。
    // 旧名字叫 userNameOf，容易让人以为该去 users 里找，改专业一点。
    const memberNameOf = memberId => {
      const m = db.members.get(memberId);
      return m ? (m.name || '') : '';
    };
    // 各班在读人数（班级卡展开前的概览数字）
    const stuList = db.students.list();
    const stuNOf = cid => stuList.reduce((n, st) => n + ((st.clsIds || []).indexOf(cid) >= 0 ? 1 : 0), 0);
    const classes = db.classes.list().map(c => ({
      id: c.id, name: c.name, sort: c.sort,
      termName: ((terms.find(t => t.id === c.termId)) || {}).name || '',
      modeLabel: c.mode === 'carry' ? '课时结转' : '学期制',
      teacherLabel: c.teacherId ? (memberNameOf(c.teacherId) || '') : '',
      stuN: stuNOf(c.id)
    }));
    // 只有负责人/管理员能进人员管理；老师进来看不到别人的权限范围
    const isManager = db.auth.isAdmin();
    // 新建班级表单：学期下拉默认当前进行中学期
    const actTerms = terms.filter(t => t.status !== 'archived');
    let clsTermIdx = this.data.clsTermIdx || 0;
    if (clsTermIdx >= actTerms.length) clsTermIdx = 0;

    // 学生列表：附加性别与入学年份（筛选用），真正的过滤在 _applyStuFilter
    const stuAll = db.students.list().map(st => ({
      id: st.id, name: st.name,
      cls: (st.clsIds || []).map(db.classes.name).join('、') || '未加入班级',
      parent: st.parent || '', wechat: st.wechat || '',
      gender: st.gender || '',
      year: st.enrollYear || 0
    }));
    // 年份选项由现有学生的入学年份倒推；数据变化后原选中年份可能已不存在，回退到「全部」
    const ys = Array.from(new Set(stuAll.map(s => s.year).filter(y => y > 0))).sort((a, b) => b - a);
    const stuYears = [{ y: 0, name: '全部' }].concat(ys.map(y => ({ y, name: y + ' 年' })));
    let stuYearIdx = this.data.stuYearIdx;
    if (stuYearIdx >= stuYears.length) stuYearIdx = 0;
    this._stuAll = stuAll;
    // 入学年份选项：未填 + 近 13 年（含当年），倒序新→旧（放 refresh 里兜底，不依赖 onLoad 时序）
    const nowY = new Date().getFullYear();
    const enrollYearOpts = [{ y: 0, name: '未填' }];
    for (let y = nowY; y >= nowY - 12; y--) enrollYearOpts.push({ y, name: y + ' 年' });

    this.setData({
      orgName: s.orgName,
      isManager,
      myRole: s.role,
      myRoleLabel: s.roleLabel,
      canSwitchHome: s.canSwitchHome,
      meName: (db.users.current() || {}).name || '',
      tabs: isManager ? ['班级', '课程', '学生', '人员'] : ['班级', '课程', '学生'],
      tab: Math.min(this.data.tab, isManager ? 3 : 2),
      teacher: s.teacher,
      classes,
      clsTerms: actTerms, clsTermIdx,
      clsTeachers: [{ id: 0, name: '暂不指派' }].concat(staff),
      clsTeacherIdx: this.data.clsTeacherIdx || 0,
      stuYears, stuYearIdx, enrollYearOpts,
      courses: db.courses.list().map(c => ({ id: c.id, name: c.name, cls: db.classes.name(c.clsId) })),
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
    // 展开的班级被删掉后要收回展开态，避免指向不存在的班
    if (this.data.clsExpand && !classes.some(c => c.id === this.data.clsExpand)) {
      this.setData({ clsExpand: 0, clsStuQ: '' });
    }
    this._applyStuFilter(stuAll);
    this._applyClsMembers();
  },
  /* ================= 班级：展开看本班学生 ================= */
  // 点班级卡展开/收起；展开时列出该班学生，输入框实时筛选（姓名/家长）
  onClsTap(e) {
    const id = +e.currentTarget.dataset.id;
    const next = this.data.clsExpand === id ? 0 : id;
    this.setData({ clsExpand: next, clsStuQ: '' });
    this._applyClsMembers();
  },
  onClsStuQ(e) { this.setData({ clsStuQ: e.detail.value }); this._applyClsMembers(); },
  _applyClsMembers() {
    const cid = this.data.clsExpand;
    if (!cid) { this.setData({ clsStus: [] }); return; }
    const q = (this.data.clsStuQ || '').trim().toLowerCase();
    const all = db.students.list()
      .filter(st => (st.clsIds || []).indexOf(cid) >= 0)
      .map(st => ({ id: st.id, name: st.name, parent: st.parent || '' }));
    const shown = q
      ? all.filter(s => (s.name + ' ' + s.parent).toLowerCase().indexOf(q) >= 0)
      : all;
    this.setData({ clsStus: shown });
  },
  /* ================= 添加班级：底部固定入口 + 弹层表单 ================= */
  openClsForm() { this.setData({ clsFormOpen: true }); },
  closeClsForm() { this.setData({ clsFormOpen: false }); },
  /* ================= 学生筛选 ================= */
  // 统一过滤入口：模糊匹配 姓名/家长/微信号 + 入学年份 + 性别（未知=尚未补录）
  _applyStuFilter(all) {
    const list = all || this._stuAll || [];
    const q = (this.data.stuQ || '').trim().toLowerCase();
    const y = ((this.data.stuYears || [])[this.data.stuYearIdx] || {}).y || 0;
    const g = this.data.stuGender || '';
    const shown = list.filter(st => {
      if (q && ((st.name + ' ' + st.parent + ' ' + st.wechat).toLowerCase().indexOf(q) < 0)) return false;
      if (y && st.year !== y) return false;
      if (g === '未知') { if (st.gender) return false; }
      else if (g && st.gender !== g) return false;
      return true;
    });
    this.setData({ students: shown, stuCount: list.length });
  },
  onStuQ(e) { this.setData({ stuQ: e.detail.value }); this._applyStuFilter(); },
  onStuYear(e) { this.setData({ stuYearIdx: +e.detail.value }); this._applyStuFilter(); },
  onStuGender(e) {
    const v = e.currentTarget.dataset.v || '';
    // 二段开关：再点已选中的那段 = 取消筛选（显示全部，含没填性别的）
    this.setData({ stuGender: this.data.stuGender === v ? '' : v });
    this._applyStuFilter();
  },
  pickTab(e) { this.setData({ tab: +e.currentTarget.dataset.i }); },
  // 预览他人身份后回到自己：没有这个出口，切到家长就再也回不来了
  backHome() {
    const r = db.users.switchHome();
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.refresh();
    wx.showToast({ title: '已切回 ' + (r.item.name || '本人'), icon: 'none' });
  },

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
  onClsTerm(e) { this.setData({ clsTermIdx: +e.detail.value }); },
  onClsMode(e) { this.setData({ clsMode: e.currentTarget.dataset.v }); },
  onClsTeacher(e) { this.setData({ clsTeacherIdx: +e.detail.value }); },
  addClass() {
    const n = (this.data.newCls || '').trim();
    const t = (this.data.clsTerms || [])[this.data.clsTermIdx] || {};
    const tc = (this.data.clsTeachers || [])[this.data.clsTeacherIdx] || { id: 0 };
    const r = db.classes.create({
      name: n, termId: t.id, mode: this.data.clsMode || 'term', teacherId: tc.id
    });
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.setData({ newCls: '', clsFormOpen: false }); this.refresh();
    wx.showToast({ title: '已添加', icon: 'success' });
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
  // 班级展开区里加人：新学生默认勾选这个班
  addClsStudent(e) { this.openStuForm(null, [+e.currentTarget.dataset.id]); },
  openStuForm(id, preCls) {
    const s = id ? db.students.get(id) : null;
    const clsSel = s ? (s.clsIds || []).slice() : (preCls || []);
    // 入学年份：编辑沿用原值；新建默认当年（绝大多数学生就是今年入的，
    // 让最常见的情况零操作；「未填」仍是可选项，排在列表最后）
    const nowY = new Date().getFullYear();
    const year = s ? (s.enrollYear || 0) : nowY;
    this.setData({
      stuForm: { id: id || null, name: s ? s.name : '', gender: s ? (s.gender || '') : '', enrollYear: year, parent: s ? (s.parent || '') : '', wechat: s ? (s.wechat || '') : '', photo: s ? (s.photo || '') : '' },
      stuClsSel: clsSel,
      stuClsChips: this._chips(db.classes.list(), clsSel),
      stuEnrollYearIdx: Math.max(0, this.data.enrollYearOpts.findIndex(o => o.y === year))
    });
  },
  // 把列表 + 选中集合压成带 on 标记的渲染数组。
  // 为什么不在 WXML 里写 arr.indexOf(id)>=0：WXML 表达式不支持方法调用，
  // 开发者工具里静默失效，真机渲染层直接抛异常导致点击即崩。
  _chips(list, sel) {
    return (list || []).map(c => ({ id: c.id, name: c.name, on: sel.indexOf(c.id) >= 0 }));
  },
  onStuName(e) { this.setData({ 'stuForm.name': e.detail.value }); },
  // 表单里的性别：再点一次已选中的取消（记为未知）
  onStuGenderSet(e) {
    const v = e.currentTarget.dataset.v || '';
    this.setData({ 'stuForm.gender': (this.data.stuForm || {}).gender === v ? '' : v });
  },
  // 表单里的入学年份：选中项同步到 stuForm，保存时落库
  onStuEnrollYear(e) {
    const idx = +e.detail.value, o = this.data.enrollYearOpts[idx] || { y: 0 };
    this.setData({ stuEnrollYearIdx: idx, 'stuForm.enrollYear': o.y });
  },
  // 上传学生照片：拍照/相册均可，统一走 media 转存到用户目录
  onStuPhoto() {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'],
      success: r => {
        const tmp = r.tempFiles[0] && r.tempFiles[0].tempFilePath;
        if (!tmp) return;
        this.setData({ 'stuForm.photo': media.persist(tmp, 'photo') });
      },
      fail: err => media.handleChooseFail(err, this)
    });
  },
  onStuParent(e) { this.setData({ 'stuForm.parent': e.detail.value }); },
  onStuWechat(e) { this.setData({ 'stuForm.wechat': e.detail.value }); },
  stuClsTgl(e) {
    const id = +e.currentTarget.dataset.id, sel = this.data.stuClsSel.slice();
    const i = sel.indexOf(id); i >= 0 ? sel.splice(i, 1) : sel.push(id);
    this.setData({ stuClsSel: sel, stuClsChips: this._chips(db.classes.list(), sel) });
  },
  stuCancel() { this.setData({ stuForm: null }); },
  stuSave() {
    const f = this.data.stuForm, sel = this.data.stuClsSel;
    const n = (f.name || '').trim();
    const payload = {
      name: n, clsIds: sel.slice(), gender: f.gender || '', enrollYear: f.enrollYear || 0,
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
  // 点成员卡进档案页：老师看教学档案；其他角色页面同样能渲染（负责人/管理员也录成果）
  goTeacher(e) {
    wx.navigateTo({ url: '/pages/teacher/teacher?id=' + (+e.currentTarget.dataset.id || 0) });
  },
  openUserForm(u) {
    const clsSel = (u.clsIds || []).slice(), crsSel = (u.courseIds || []).slice(), stuSel = (u.studentIds || []).slice();
    this.setData({
      userForm: { id: u.id || null, role: u.role, name: u.name || '', phone: u.phone || '', wechat: u.wechat || '' },
      userClsSel: clsSel, userCrsSel: crsSel, userStuSel: stuSel,
      userClsChips: this._chips(db.classes.list(), clsSel),
      userCrsChips: this._chips(db.courses.list(), crsSel),
      userStuChips: this._chips(db.students.list(), stuSel)
    });
  },
  onUserName(e) { this.setData({ 'userForm.name': e.detail.value }); },
  onUserPhone(e) { this.setData({ 'userForm.phone': e.detail.value }); },
  onUserWechat(e) { this.setData({ 'userForm.wechat': e.detail.value }); },
  pickRole(e) { this.setData({ 'userForm.role': e.currentTarget.dataset.k }); },
  userClsTgl(e) { this._tgl('userClsSel', 'classes', e); },
  userCrsTgl(e) { this._tgl('userCrsSel', 'courses', e); },
  userStuTgl(e) { this._tgl('userStuSel', 'students', e); },
  _tgl(key, srcKey, e) {
    const id = +e.currentTarget.dataset.id, sel = this.data[key].slice();
    const i = sel.indexOf(id); i >= 0 ? sel.splice(i, 1) : sel.push(id);
    // 同步重建对应的 chips 渲染数组（userClsSel -> userClsChips）
    const upd = { [key]: sel };
    upd[key.replace('Sel', 'Chips')] = this._chips(this.data[srcKey], sel);
    this.setData(upd);
  },
  userCancel() { this.setData({ userForm: null }); },
  userSave() {
    const f = this.data.userForm;
    const n = (f.name || '').trim();
    if (!n) { wx.showToast({ title: '请填写姓名', icon: 'none' }); return; }
    // 三类身份的范围互斥：老师带班、家长带孩子、管理员全可见无需范围
    // 手机号/微信号是档案字段，三类身份都存（老师方便家长联系，家长方便机构联系）
    const contact = { phone: (f.phone || '').trim(), wechat: (f.wechat || '').trim() };
    let payload;
    if (f.role === 'parent') {
      const kids = this.data.userStuSel.slice();
      if (!kids.length) { wx.showToast({ title: '请至少绑定一个孩子', icon: 'none' }); return; }
      payload = Object.assign({ name: n, role: 'parent', studentIds: kids, clsIds: [], courseIds: [] }, contact);
    } else if (f.role === 'admin') {
      payload = Object.assign({ name: n, role: 'admin', clsIds: [], courseIds: [], studentIds: [] }, contact);
    } else {
      const cls = this.data.userClsSel.slice();
      // 老师没有班级 = 什么都看不到。与其建一个空权限账号，不如当场拦住
      if (!cls.length) { wx.showToast({ title: '老师至少要分配一个班级', icon: 'none' }); return; }
      payload = Object.assign({ name: n, role: 'teacher', clsIds: cls, courseIds: this.data.userCrsSel.slice(), studentIds: [] }, contact);
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
  },
  // 语音输入：点输入框右端的麦克风说话，再点一次结束（utils/voice.js）
  onMic(e) { voice.dictate(this, e.currentTarget.dataset.k); },
  onHide() { voice.stop(this); } // 离开页面别让麦克风一直开着
});
