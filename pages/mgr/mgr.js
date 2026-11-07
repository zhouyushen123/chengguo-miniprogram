const db = require('../../utils/db');
const icons = require('../../utils/icons');
const media = require('../../utils/media');
const theme = require('../../utils/theme');
const voice = require('../../utils/voice');
const tel = require('../../utils/phone');
const applyStore = require('../../utils/apply');

// 机构资料选项：与入驻申请页（pages/apply）同一套口径，避免两处填的不一样
const ORG_TYPES = ['培训机构', '学校', '幼儿园', '个人工作室'];
const ORG_SCALES = ['50 人以下', '50–200 人', '200–500 人', '500 人以上'];
const ORG_COURSES = ['书法', '美术', '素描', '钢琴', '舞蹈', '声乐', '编程', '托育'];

// 角色选项目：负责人不在新建时出现（一个机构只能有一个，靠「移交」转移）
const ROLE_OPTS = [
  { k: 'teacher', n: '老师', d: '可录入与管理自己班级的成果' },
  { k: 'parent', n: '家长', d: '只能看自己孩子已发布的成果' },
  { k: 'admin', n: '管理员', d: '等同负责人，可管理全部班级与成员' }
];

Page({
  data: {
    // tab 按名字判断（tabK）：负责人多一个「机构」页签插在最前面，索引不再可靠
    tab: 0, tabs: ['班级', '课程', '学生', '人员'], tabK: 'cls',
    orgName: '', isManager: false, myRole: '', myRoleLabel: '',
    // 机构资料表单（负责人专用）：预填开通引导/入驻申请里填过的内容
    orgForm: { name: '', type: ORG_TYPES[0], region: [], regionText: '', contact: '', phone: '', scale: ORG_SCALES[0], courses: [] },
    orgTypes: ORG_TYPES, orgScales: ORG_SCALES, orgCourseChips: [], orgPhoneBad: false,
    classes: [], courses: [], students: [], members: [],
    newCls: '', newCourse: '', newIntro: '',
    // 建课时一次勾选多个班（课程是内容单元，可同时开在任意多个班）
    courseClsSel: [], courseClsChips: [],
    // 课程批量开设弹层 / 课程详情编辑弹层
    crsBind: null, crsDetail: null,
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
    courseFormOpen: false,   // 课程页签：添加表单默认收起，底部按钮唤起（与班级/学生一致）
    icoChev: icons.chevron,
    // 学生表单：入学年份选择器（未填 + 近 13 年，倒序）
    enrollYearOpts: [{ y: 0, name: '未填' }], stuEnrollYearIdx: 0,
    // 成员表单弹层（chips = 预计算好 on 标记的渲染数组，WXML 不做任何方法调用）
    userForm: null, userClsSel: [], userStuSel: [], userCrsSel: [], userBindNo: '',
    // G05：绑定孩子不必背学号——可按姓名/家长搜索，或直接点候选名单
    userStuQ: '', userStuCands: [],
    memTab: 'all', memShown: [],   // 人员页签：全部/老师/家长三个分类，默认全部
    userClsChips: [], userStuChips: [], userCrsChips: [],
    roleOpts: ROLE_OPTS
  },
  // 从个人中心带参进入：?tab=3 直达人员管理；?tabK=cls/stu 按页签名跳（首页统计卡用，
  // 负责人和老师的页签序号不同，传名字才能两边都落对）
  onLoad(q) {
    // 从别的页面带页签跳转过来（q.tab 传的是页签序号，按负责人全量页签 0-4）
    if (q && q.tab !== undefined) { this._tabReady = true; this.setData({ tab: Math.max(0, Math.min(+q.tab || 0, 4)) }); }
    if (q && q.tabK) this._tabKWant = String(q.tabK);
  },
  onShow() { theme.apply(this); this.refresh(); },
  // 阻止弹窗内点击冒泡到遮罩层（关闭弹窗）的空处理
  noop() {},
  refresh() {
    const s = db.settings();
    // 页签定位先算好再进 setData（避免两次调用读到不同的 data.tab）
    const isManager = db.auth.isAdmin();
    let tab = this.data.tab;
    if (!this._tabReady) { this._tabReady = true; tab = isManager ? 1 : 0; }  // 默认落在「班级」，与旧版一致
    // 按页签名定位（优先于序号）：负责人是 0-4、老师是 0-2，序号会因角色漂移，名字不会
    if (this._tabKWant) {
      const i = (isManager ? ['org', 'cls', 'course', 'stu', 'member'] : ['cls', 'course', 'stu']).indexOf(this._tabKWant);
      if (i > -1) { tab = i; this.setData({ tab: i }); }
      this._tabKWant = null;
    }
    tab = Math.max(0, Math.min(tab, isManager ? 4 : 2));
    const tabK = (isManager ? ['org', 'cls', 'course', 'stu', 'member'] : ['cls', 'course', 'stu'])[tab] || 'cls';
    if (tabK === 'org' && !this._orgLoaded) this.loadOrgForm();
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
    // 只有负责人/管理员能进人员管理；老师进来看不到别人的权限范围（isManager 已在 refresh 开头算过）
    // 新建班级表单：学期下拉默认当前进行中学期
    const actTerms = terms.filter(t => t.status !== 'archived');
    let clsTermIdx = this.data.clsTermIdx || 0;
    if (clsTermIdx >= actTerms.length) clsTermIdx = 0;

    // 学生列表：附加性别与入学年份（筛选用），真正的过滤在 _applyStuFilter。
    // F-08 / F-03 回归：photo 与 no 必须一起带出来——WXML 用 <ava src="{{item.photo}}">
    // 和「学号 {{item.no}}」，少了字段就会静默显示成首字色块、学号空白，
    // 而库里其实存得好好的（用户会以为「照片没改成」）。
    const stuAll = db.students.list().map(st => ({
      id: st.id, name: st.name, no: st.no || '', photo: st.photo || '',
      cls: (st.clsIds || []).map(db.classes.name).join('、') || '未加入班级',
      parent: st.parent || '',
      parentPhone: st.parentPhone ? tel.fmt(st.parentPhone) : '',
      wechat: st.wechat || '',
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
      tabs: isManager ? ['机构', '班级', '课程', '学生', '人员'] : ['班级', '课程', '学生'],
      tab,
      tabK,
      teacher: s.teacher,
      classes,
      clsTerms: actTerms, clsTermIdx,
      clsTeachers: [{ id: 0, name: '暂不指派' }].concat(staff),
      clsTeacherIdx: this.data.clsTeacherIdx || 0,
      stuYears, stuYearIdx, enrollYearOpts,
      // V10：课程是独立的内容单元，可能同时开在多个班，也可能暂时没开在任何班
      courses: db.courses.list().map(c => {
        const intro = String(c.intro || '').replace(/\s+/g, ' ').trim();
        return {
          id: c.id, name: c.name, intro,
          introBrief: intro.length > 42 ? intro.slice(0, 42) + '…' : intro,
          clsList: (c.classIds || []).map(id => ({ id, name: db.classes.name(id) })).filter(x => x.name),
          canBind: (c.classIds || []).length < classes.length
        };
      }),
      // 同名课程分组数：老数据「一个班一条课」留下的副本，给一键合并用
      crsDupGroups: isManager ? db.courses.duplicates().length : 0,
      members: isManager ? db.members.list().map(m => {
        const v = db.members.view(m);
        return {
          id: v.id, userId: v.userId, name: v.name,
          role: v.role, roleLabel: v.roleLabel,
          photo: v.photo,
          // G02：编辑表单要回填联系方式。memberView 里有 phone/wechat，
          // 但以前映射漏了这两项，点「修改」进去是空的，一保存反而把原值清空。
          phone: v.phone || '', wechat: v.wechat || '',
          // 头像色块：老师=品牌色，负责人/管理员=蓝，家长=绿（全站统一口径，见 components/ava）
          avaTone: v.role === 'parent' ? 'parent' : (v.role === 'teacher' ? 'brand' : 'owner'),
          status: v.status, invited: v.status === 'invited',
          // 账号绑定状态：bound = 对方已经用微信加入（能换手机找回）；否则是管理者手工建的档案
          bound: v.bound,
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
      // 建课时的班级多选：一个都不选 = 先进课程库，之后随时开到任意多个班
      courseClsChips: this._chips(classes, this.data.courseClsSel)
    });
    // 展开的班级被删掉后要收回展开态，避免指向不存在的班
    if (this.data.clsExpand && !classes.some(c => c.id === this.data.clsExpand)) {
      this.setData({ clsExpand: 0, clsStuQ: '' });
    }
    this._applyStuFilter(stuAll);
    this._applyClsMembers();
    this._applyMemFilter();   // 人员列表按当前分类（全部/老师/家长）过滤
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
      // 班级展开里的头像同样走 <ava>，photo 不能漏（F-08 同一类断链）
      .map(st => ({ id: st.id, name: st.name, parent: st.parent || '', photo: st.photo || '' }));
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
      // 搜索命中范围：姓名 / 家长 / 微信号 / 学号（家长报学号时最常见）
      if (q && ((st.name + ' ' + st.parent + ' ' + st.wechat + ' ' + st.no).toLowerCase().indexOf(q) < 0)) return false;
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
  pickTab(e) {
    const i = +e.currentTarget.dataset.i;
    const keys = this.data.isManager ? ['org', 'cls', 'course', 'stu', 'member'] : ['cls', 'course', 'stu'];
    this.setData({ tab: i, tabK: keys[i] || 'cls' });
    if (keys[i] === 'org' && !this._orgLoaded) this.loadOrgForm();
  },

  // 人员页签顶部分类：全部 / 老师（负责人·管理员·老师）/ 家长
  pickMemTab(e) {
    this.setData({ memTab: e.currentTarget.dataset.k });
    this._applyMemFilter();
  },
  _applyMemFilter() {
    const t = this.data.memTab, all = this.data.members || [];
    const shown = t === 'parent' ? all.filter(m => m.role === 'parent')
      : t === 'teacher' ? all.filter(m => m.role !== 'parent')
      : all;
    this.setData({ memShown: shown });
  },

  /* ================= 机构资料（负责人） ================= */
  // 预填优先级：入驻申请留档 → 现机构名 / 当前用户姓名，引导页填过的直接带进来
  loadOrgForm() {
    const rec = applyStore.get() || {};
    const s = db.settings();
    const u = db.users.current() || {};
    const f = {
      name: rec.name || (s.orgName && s.orgName !== '我的机构' ? s.orgName : ''),
      type: rec.type || ORG_TYPES[0],
      region: (rec.region || []).slice(),
      regionText: rec.regionText || '',
      contact: rec.contact || u.name || '',
      phone: rec.phone || '',
      scale: rec.scale || ORG_SCALES[0],
      courses: (rec.courses || []).slice()
    };
    this._orgLoaded = true;
    this.setData({
      orgForm: f,
      orgPhoneBad: false,
      orgCourseChips: ORG_COURSES.map(n => ({ name: n, on: f.courses.indexOf(n) > -1 }))
    });
  },
  onOrgName(e) { this.setData({ 'orgForm.name': e.detail.value }); },
  onOrgContact(e) { this.setData({ 'orgForm.contact': e.detail.value }); },
  pickOrgType(e) { this.setData({ 'orgForm.type': e.currentTarget.dataset.v }); },
  pickOrgScale(e) { this.setData({ 'orgForm.scale': e.currentTarget.dataset.v }); },
  onOrgRegion(e) {
    const v = e.detail.value || [];
    this.setData({ 'orgForm.region': v, 'orgForm.regionText': v.join(' ') });
  },
  onOrgPhone(e) {
    const raw = tel.digits(e.detail.value);
    // 输入中只放裸数字，失焦再分段（type="number" 容不下 "-"，真机会调乱）
    this.setData({ 'orgForm.phone': raw, orgPhoneBad: raw.length > 0 && !tel.valid(raw) });
  },
  onOrgPhoneBlur() { this.setData({ 'orgForm.phone': tel.fmt(this.data.orgForm.phone) }); },
  toggleOrgCourse(e) {
    const v = e.currentTarget.dataset.v;
    const cur = (this.data.orgForm.courses || []).slice();
    const i = cur.indexOf(v);
    if (i > -1) cur.splice(i, 1); else cur.push(v);
    this.setData({
      'orgForm.courses': cur,
      orgCourseChips: this.data.orgCourseChips.map(c => ({ name: c.name, on: cur.indexOf(c.name) > -1 }))
    });
  },
  // 保存：机构名落 orgs 表（会同步到首页/记录页的口径），其余资料留在申请单档（utils/apply.js）
  saveOrgFull() {
    const f = this.data.orgForm || {};
    const name = (f.name || '').trim();
    if (!name) { wx.showToast({ title: '机构名称不能为空', icon: 'none' }); return; }
    if ((f.phone || '').replace(/\D/g, '') && this.data.orgPhoneBad) {
      wx.showToast({ title: '手机号格式不对', icon: 'none' }); return;
    }
    const r = db.orgs.update({ name });
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    applyStore.save({
      name, type: f.type, region: f.region, regionText: f.regionText,
      contact: (f.contact || '').trim(), phone: f.phone, scale: f.scale, courses: f.courses
    });
    wx.showToast({ title: '已保存', icon: 'success' });
    this.loadOrgForm();   // 从留档重读一遍，展示的就是已保存的内容
    this.refresh();
  },
  // 预览他人身份后回到自己：没有这个出口，切到家长就再也回不来了
  backHome() {
    const r = db.users.switchHome();
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.refresh();
    wx.showToast({ title: '已切回 ' + (r.item.name || '本人'), icon: 'none' });
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
      content: '该班会进回收站（可恢复），学生变为未分班，历史成果记录保留。该班开设的课程只是取消开设，课程本身不会被删掉。负责该班的老师会同步失去这个班。',
      success: r => {
        if (!r.confirm) return;
        const res = db.classes.remove(id);
        if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
        this.refresh();
      }
    });
  },
  onNewCourse(e) { this.setData({ newCourse: e.detail.value }); },
  onNewIntro(e) { this.setData({ newIntro: e.detail.value }); },
  // 建课时一次勾选多个班；一个都不勾 = 先进课程库，之后随时开到任意多个班
  toggleCourseCls(e) {
    const id = +e.currentTarget.dataset.id;
    const sel = this.data.courseClsSel.slice();
    const i = sel.indexOf(id);
    if (i > -1) sel.splice(i, 1); else sel.push(id);
    this.setData({ courseClsSel: sel, courseClsChips: this._chips(this.data.classes, sel) });
  },
  addCourse() {
    const n = (this.data.newCourse || '').trim();
    if (!n) { wx.showToast({ title: '请填写课程名称', icon: 'none' }); return; }
    const picked = this.data.courseClsSel.slice();
    const r = db.courses.create({ name: n, intro: this.data.newIntro || '', clsIds: picked });
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.setData({ newCourse: '', newIntro: '', courseClsSel: [], courseFormOpen: false });
    this.refresh();
    // 课程库里已有同名课时不会新建，直接复用它开到勾选的班——得让人知道发生了什么
    if (r.reused) wx.showToast({ title: '课程库已有「' + n + '」，已直接开设', icon: 'none' });
    else if (picked.length > 1) wx.showToast({ title: '已同时开设到 ' + picked.length + ' 个班', icon: 'none' });
  },
  // 批量开设：列出全部班级一次勾选。原来用 ActionSheet 一次只能挑一个班、还只显示前 6 个，
  // 「一门语文课开给 1~6 班」得点 6 次，第 7 个班根本选不到。
  addCourseCls(e) {
    const id = +e.currentTarget.dataset.id;
    const c = db.courses.get(id);
    if (!c) { wx.showToast({ title: '课程不存在', icon: 'none' }); return; }
    if (!this.data.classes.length) { wx.showToast({ title: '请先添加班级', icon: 'none' }); return; }
    const have = db.courses.classIdsOf(id);
    this.setData({ crsBind: { id, name: c.name, sel: have, chips: this._chips(this.data.classes, have) } });
  },
  crsBindTgl(e) {
    const id = +e.currentTarget.dataset.id;
    const b = this.data.crsBind;
    if (!b) return;
    const sel = b.sel.slice();
    const i = sel.indexOf(id);
    if (i > -1) sel.splice(i, 1); else sel.push(id);
    this._crsBindSet(sel);
  },
  crsBindAll() { this._crsBindSet(this.data.classes.map(c => c.id)); },
  crsBindNone() { this._crsBindSet([]); },
  _crsBindSet(sel) {
    this.setData({ 'crsBind.sel': sel, 'crsBind.chips': this._chips(this.data.classes, sel) });
  },
  closeCrsBind() { this.setData({ crsBind: null }); },
  saveCrsBind() {
    const b = this.data.crsBind;
    if (!b) return;
    // 一次写定结果状态：勾上的绑、没勾的解绑，历史记录与课程本身都不受影响
    const r = db.courses.setClasses(b.id, b.sel);
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.setData({ crsBind: null });
    this.refresh();
    let tip = '已开设到 ' + b.sel.length + ' 个班';
    if (r.removed) tip += '，撤下 ' + r.removed + ' 个';
    wx.showToast({ title: tip, icon: 'none' });
  },
  // 取消某班的这门课：只解绑，课程本身和其他班不受影响
  delCourseCls(e) {
    const id = +e.currentTarget.dataset.id;
    const cid = +e.currentTarget.dataset.cid;
    const name = e.currentTarget.dataset.name || '';
    wx.showModal({
      title: '取消「' + name + '」的开设？',
      content: '只是这个班不再开这门课。课程本身保留（其他班照常），历史记录也不受影响。',
      success: r => {
        if (!r.confirm) return;
        const res = db.courses.unbind(cid, id);
        if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
        this.refresh();
      }
    });
  },
  openCourseForm() { this.setData({ courseFormOpen: true }); },
  // 课程详情：介绍是课程本体的一部分，改它不动班级开设关系与历史记录
  openCrsDetail(e) {
    const id = +e.currentTarget.dataset.id;
    const c = db.courses.get(id);
    if (!c) { wx.showToast({ title: '课程不存在', icon: 'none' }); return; }
    this.setData({ crsDetail: { id, name: c.name, intro: c.intro || '' } });
  },
  onCrsIntro(e) { this.setData({ 'crsDetail.intro': e.detail.value }); },
  closeCrsDetail() { this.setData({ crsDetail: null }); },
  saveCrsDetail() {
    const d = this.data.crsDetail;
    if (!d) return;
    const r = db.courses.update(d.id, { intro: String(d.intro || '').trim().slice(0, 500) });
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.setData({ crsDetail: null });
    this.refresh();
    wx.showToast({ title: '课程介绍已保存', icon: 'success' });
  },
  // E-01 课程支持改名（showModal 自带输入框，不另做弹层）
  renameCourse(e) {
    const id = +e.currentTarget.dataset.id;
    wx.showModal({
      title: '修改课程名称', editable: true, placeholderText: '新的课程名称',
      content: e.currentTarget.dataset.name || '',
      success: r => {
        if (!r.confirm) return;
        const n = (r.content || '').trim();
        if (!n) { wx.showToast({ title: '名称不能为空', icon: 'none' }); return; }
        const res = db.courses.update(id, { name: n });
        if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
        this.refresh();
      }
    });
  },
  delCourse(e) {
    const id = +e.currentTarget.dataset.id;
    // E-04：删除前先看有多少成果记录引用了这门课（按 id；老记录只有名字的按名字补计），
    // 把影响说清楚再让确认；删除是软删、可从回收站恢复，历史记录上的课程名保留
    const item = this.data.courses.find(c => c.id === id) || {};
    const recs = db.records.list();
    const n = recs.filter(x => x.courseId === id || (!x.courseId && x.course === item.name)).length;
    wx.showModal({
      title: '确定删除该课程？',
      content: n
        ? '已有 ' + n + ' 条成果记录使用了这门课：删除后历史记录照常保留，但录入时不能再选它。课程会进入回收站，可恢复。'
        : '还没有成果记录使用这门课，删除后可在回收站恢复。',
      success: r => {
        if (!r.confirm) return;
        const res = db.courses.remove(id);
        if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
        this.refresh();
      }
    });
  },
  // 一键合并同名课程：老数据里同一门课每个班各存一条，收拢成一条，
  // 班级开设关系、成果记录的课程指针、成员课程授权一起改过去（记录上的课程名文字不动）
  mergeCourses() {
    const n = this.data.crsDupGroups || 0;
    if (!n) return;
    wx.showModal({
      title: '合并同名课程？',
      content: '有 ' + n + ' 组同名课程，合并后每组只留一条，各班照常开课，历史记录不受影响。合并不可撤销。',
      confirmText: '合并',
      success: r => {
        if (!r.confirm) return;
        const res = db.courses.mergeAll();
        if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
        this.refresh();
        wx.showToast({ title: '已合并 ' + res.merged + ' 条', icon: 'none' });
      }
    });
  },

  /* ================= 学生：弹层表单（姓名+班级多选+家长+微信） ================= */
  addStudent() { this.openStuForm(null); },
  // 批量导入：文件表格（Excel/CSV/Word）或纸质名单拍照 AI 识别，进导入页走
  goImport() { wx.navigateTo({ url: '/pages/import/import' }); },
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
      stuForm: { id: id || null, name: s ? s.name : '', no: s ? (s.no || '') : '', gender: s ? (s.gender || '') : '', enrollYear: year, parent: s ? (s.parent || '') : '', parentPhone: s ? tel.fmt(s.parentPhone || '') : '', wechat: s ? (s.wechat || '') : '', photo: s ? (s.photo || '') : '', char: (s && s.name ? s.name : '')[0] || '' },
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
  // 家长选孩子的 chips：学生重名多（两个「王五」不在一个班），露出学号才能分清选的是谁
  _stuChips(sel) {
    return db.students.list().map(s => ({
      id: s.id, name: s.no ? (s.name + ' ' + s.no) : s.name, on: sel.indexOf(s.id) >= 0
    }));
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
  // F-04：家长手机号。口径与向导/机构页一致——输入中只留裸数字，失焦才分段显示，
  // 保存时再 digits() 一次；type=number 且不加 maxlength，否则格式化串会被截断。
  // 格式化字段不配麦克风（语音念中文得不到合法号码）。
  onStuPhone(e) { this.setData({ 'stuForm.parentPhone': tel.digits(e.detail.value) }); },
  onStuPhoneBlur() { this.setData({ 'stuForm.parentPhone': tel.fmt(this.data.stuForm.parentPhone) }); },
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
    const ph = tel.digits(f.parentPhone || '');
    if (ph && !tel.valid(ph)) { wx.showToast({ title: '手机号需 11 位、1 开头', icon: 'none' }); return; }
    const payload = {
      name: n, clsIds: sel.slice(), gender: f.gender || '', enrollYear: f.enrollYear || 0,
      parent: (f.parent || '').trim(), parentPhone: ph,
      wechat: (f.wechat || '').trim(), photo: f.photo || ''
    };
    const r = f.id ? db.students.update(f.id, payload) : db.students.create(payload);
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.setData({ stuForm: null }); this.refresh();
    // 同家长号码下已有孩子 → 已自动把新学生补进家长账号，明确告诉操作者一声
    const linked = (r.linked || []);
    if (linked.length) {
      wx.showToast({ title: '已保存，已归入家长 ' + linked[0] + (linked.length > 1 ? ' 等' : ''), icon: 'none', duration: 2200 });
    } else {
      wx.showToast({ title: '已保存', icon: 'success' });
    }
  },
  // 学号只读：编辑时可点按复制，方便发给家长
  copyStuNo() {
    const no = (this.data.stuForm || {}).no;
    if (!no) return;
    wx.setClipboardData({ data: String(no), success: () => wx.showToast({ title: '学号已复制', icon: 'success' }) });
  },
  // G05 / F-03：列表上学号也能点一下复制，发给家长绑定，不用手抄数字
  copyStuNoList(e) {
    const no = e.currentTarget.dataset.no;
    if (!no) return;
    wx.setClipboardData({ data: String(no), success: () => wx.showToast({ title: '学号已复制', icon: 'success' }) });
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
    // G02：标题说清「这是改资料」，别让人以为只能改分配范围
    const title = u.id
      ? '编辑' + (u.role === 'teacher' ? '老师' : u.role === 'parent' ? '家长' : '成员') + '资料'
      : '新增成员';
    this.setData({
      userFormTitle: title,
      userForm: { id: u.id || null, role: u.role, name: u.name || '', phone: u.phone || '', wechat: u.wechat || '', photo: u.photo || '', char: ((u.name || '').trim())[0] || '' },
      userBindNo: '', userStuQ: '',
      userClsSel: clsSel, userCrsSel: crsSel, userStuSel: stuSel,
      userClsChips: this._chips(db.classes.list(), clsSel),
      userCrsChips: this._chips(db.courses.list(), crsSel),
      userStuChips: this._stuChips(stuSel)
    });
    this._refreshStuCands();
  },
  onUserName(e) {
    this.setData({ 'userForm.name': e.detail.value, 'userForm.char': (e.detail.value || '').trim()[0] || '' });
  },
  // 上传成员头像：拍照/相册均可，统一走 media 转存（与学生照片同一套）
  onUserPhoto() {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'],
      success: r => {
        const tmp = r.tempFiles[0] && r.tempFiles[0].tempFilePath;
        if (!tmp) return;
        this.setData({ 'userForm.photo': media.persist(tmp, 'photo') });
      },
      fail: err => media.handleChooseFail(err, this)
    });
  },
  // 一键同步微信头像：头像填写能力回传的临时文件同样要转存，避免路径失效
  onWxAvatar(e) {
    const tmp = e.detail && e.detail.avatarUrl;
    if (tmp) this.setData({ 'userForm.photo': media.persist(tmp, 'photo') });
  },
  onUserPhone(e) {
    const raw = tel.digits(e.detail.value);
    this.setData({ 'userForm.phone': raw });
  },
  onUserPhoneBlur() { this.setData({ 'userForm.phone': tel.fmt(this.data.userForm.phone) }); },
  onUserWechat(e) { this.setData({ 'userForm.wechat': e.detail.value }); },
  pickRole(e) { this.setData({ 'userForm.role': e.currentTarget.dataset.k }); },
  userClsTgl(e) { this._tgl('userClsSel', 'classes', e); },
  userCrsTgl(e) { this._tgl('userCrsSel', 'courses', e); },
  userStuTgl(e) { this._tgl('userStuSel', 'students', e); this._refreshStuCands(); },
  onBindNo(e) { this.setData({ userBindNo: e.detail.value }); },
  /* G05：学号是 1001 这种编号，靠背不现实。除了按学号快捷绑定，
    还提供「按姓名/家长搜索 + 点名字」的候选名单，两条路都自动带上同家长的孩子。 */
  onVoiceDone(key) { if (key === 'userStuQ') this._refreshStuCands(); },
  onUserStuQ(e) { this.setData({ userStuQ: e.detail.value }); this._refreshStuCands(); },
  _refreshStuCands() {
    const q = String(this.data.userStuQ || '').trim().toLowerCase();
    const sel = this.data.userStuSel || [];
    const all = db.students.list();
    const hit = all.filter(s => !q || [s.name, s.no, s.parent, s.parentPhone, s.wechat]
      .some(v => String(v || '').toLowerCase().indexOf(q) > -1));
    // 没输关键词时优先列「还没绑定」的，最常用的就是打开弹层直接点名字
    const pool = (q ? hit : hit.filter(s => sel.indexOf(s.id) < 0)).slice(0, 8);
    this.setData({
      userStuCands: pool.map(s => ({
        id: s.id, name: s.name,
        sub: [s.no ? '学号 ' + s.no : '', s.parent ? '家长 ' + s.parent : '',
          (s.clsIds || []).map(db.classes.name).filter(Boolean).join('、')]
          .filter(Boolean).join(' · ') || '未填班级',
        on: sel.indexOf(s.id) > -1
      }))
    });
  },
  pickStuCand(e) {
    const r = this._addStudentById(+e.currentTarget.dataset.id);
    if (!r) return;
    this._refreshStuCands();
    wx.showToast({
      title: r.added ? (r.sibs ? '已加 ' + r.name + ' 等 ' + (r.sibs + 1) + ' 个孩子' : '已加 ' + r.name)
        : r.name + ' 已在列表中',
      icon: 'none'
    });
  },
  _addStudentById(id) {
    const s = db.students.list().find(x => x.id === id) || null;
    if (!s) return null;
    const ids = this.data.userStuSel.slice();
    const sibs = db.students.siblings(s);
    const add = [s.id].concat(sibs.map(x => x.id)).filter(x => ids.indexOf(x) < 0);
    add.forEach(x => ids.push(x));
    this.setData({ userStuSel: ids, userStuChips: this._stuChips(ids) });
    return { name: s.name, added: add.length, sibs: sibs.length };
  },
  /* 按学号绑定（快捷方式，可留空）：输入学号 → 找到学生 → 连同同家长孩子一起加入 */
  bindByNo() {
    const k = (this.data.userBindNo || '').trim();
    if (!k) { wx.showToast({ title: '请输入学号，或直接在上面点名字', icon: 'none' }); return; }
    const s = db.students.byNo(k);
    if (!s) { wx.showToast({ title: '没有学号 ' + k + ' 的学生', icon: 'none' }); return; }
    const r = this._addStudentById(s.id);
    this.setData({ userBindNo: '' });
    this._refreshStuCands();
    if (!r || !r.added) { wx.showToast({ title: s.name + ' 已在列表中', icon: 'none' }); return; }
    wx.showToast({
      title: r.sibs ? ('已加 ' + s.name + ' + ' + r.sibs + ' 个同家长孩子') : ('已加 ' + s.name),
      icon: 'none', duration: 1800
    });
  },
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
    const ph = tel.digits(f.phone);
    if (ph && !tel.valid(ph)) { wx.showToast({ title: '手机号需 11 位、1 开头', icon: 'none' }); return; }
    const contact = { phone: ph, wechat: (f.wechat || '').trim(), photo: (f.photo || '').trim() };
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
    // 后端会把同家长号码的孩子一并带上，多出来的要告诉操作者，否则他会以为选错了
    const extra = f.role === 'parent' && r.item ? r.item.studentIds.length - this.data.userStuSel.length : 0;
    if (extra > 0) {
      wx.showToast({ title: '已保存，自动带出 ' + extra + ' 个同家长孩子', icon: 'none', duration: 2200 });
    } else {
      wx.showToast({ title: '已保存', icon: 'success' });
    }
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
  onHide() { voice.stop(this); }, // 离开页面别让麦克风一直开着
  onUnload() { voice.stop(this); }
});
