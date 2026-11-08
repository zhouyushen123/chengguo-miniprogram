const db = require('../../utils/db');
const api = require('../../utils/api');
const icons = require('../../utils/icons');
const theme = require('../../utils/theme');
const voice = require('../../utils/voice');
const firstrun = require('../../utils/firstrun');
const sec = require('../../utils/sec');
const photocloud = require('../../utils/photocloud');
const sync = require('../../utils/sync');
const fbu = require('../../utils/fbunread');

Page({
  data: {
    isParent: false, kids: [], kidId: 0,
    // familyMode：家长端用跨机构视图（pid 归并）。成员关系还没拉回来时退回单机构视图，
    // 两种视图的 kidId 类型不同，页面靠这个开关决定走哪条渲染与跳转。
    familyMode: false, kOrgs: [], hoursGroups: [],
    kName: '', kCls: '', stats: null, kLatest: null, latestPhotos: [],
    kHistory: [], kCare: [],
    roleLabel: '', uName: '', dateStr: '',
    q: '', results: [], moreCount: 0,
    clsCount: 0, stuCount: 0, pending: 0,
    myClasses: [], recent: [],
    icoSearch: icons.search, icoClose: icons.close, icoChev: icons.chevron, icoCam: icons.camera,
    // 首页大卡图标：渐变卡上用白色加号，浅色记录卡用文档图标
    icoPlusW: icons.plus('#FFFFFF'), icoDoc: icons.doc,
    // 自定义导航栏：状态栏高度（px）+ 标题（跟机构名）
    statusBarH: 20, navTitle: '橙果',
    // 演示数据：独立的一套数据，只看不改（横幅在导航栏下方，随时能一键开始使用）
    sandbox: false,
    // 空库：没有班级也没有学生 → 首页改摆开通卡（见 wxml 的 onboard 块）
    empty: false,
    // 同步冲突：本机数据与云端绑定的机构不一致（换手机前后各建了一份），横幅提示 + 说明
    syncConflict: false,
    // 家长反馈：云通且是老师时出现入口；unread 只做红点提醒，不阻塞首页任何操作
    fbReady: false, fbUnread: 0, fbNote: '',
    // 多机构：我这个微信能进的机构（>=2 才显示切换器）。
    // 只有一家时整块不出现 —— 大多数老师一辈子只用一家，不该多一个按钮。
    orgs: [], curOrg: '', orgPickShow: false, orgSwitching: false,
    // 待上传：条数 > 0 才出提示条。自动重试在跑，这条只是"给个实话"，
    // 不是让用户来点（点了也只是催一下，不点它也会自己传）。
    pendingN: 0, flushBusy: false, rejectN: 0
  },
  onLoad() {
    // 自定义导航要自己腾出状态栏的空间；取不到时用常见默认值兜底
    try {
      const wi = wx.getWindowInfo ? wx.getWindowInfo() : null;
      if (wi && wi.statusBarHeight) this.setData({ statusBarH: wi.statusBarHeight });
    } catch (e) { /* 测试环境无此 API */ }
  },
  onShow() {
    theme.apply(this); // 主题：根类名 + 图标 + 原生 chrome
    // 导航栏标题跟随机构名称（在「我的-成员管理」里设置）；未设置时兜底「橙果」
    const st = db.settings();
    this.setData({
      navTitle: st.orgName || '橙果',
      sandbox: !!st.sandbox,
      // 冲突是同步层判的（见 utils/sync.js init）：这里只负责让人看见
      syncConflict: sync.isConflict()
    });
    // 有积压就直说（自动重试在跑，这条只是别让人误以为已经上云）
    this._loadPending();
    const u = db.users.current() || { role: 'teacher', name: '' };
    const d = new Date();
    const dateStr = (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + '日一二三四五六'[d.getDay()];
    // 身份与数据范围统一由权限层给出：下面拿到的 list 已经是过滤后的结果，
    // 页面不再自己写 role/clsIds 判断（那种写法漏一处就是越权）
    const isParent = db.auth.isParent();

    if (isParent) {
      /* 家长端首页：用跨机构视图（db.family）。
       * 一个孩子在 A、B 两家上课时，这里是"一个孩子一张卡"，卡片上标着他在几家机构；
       * 点进去两家的成果在同一页里，每条标明是哪家给的 —— 家长不需要知道"机构"是个什么东西，
       * 更不能被要求自己切换。 */
      const fam = db.family.kids();
      if (fam.length) {
        const kids = fam.map(k => ({
          id: k.pid, name: k.name, photo: k.photo,
          orgN: k.orgs.length,
          orgs: k.orgs.map(o => o.orgName).filter(Boolean).join(' · ')
        }));
        const kidId = kids.some(k => k.id === this.data.kidId) ? this.data.kidId : kids[0].id;
        this.setData({
          isParent: true, kids, kidId, roleLabel: '家长端', uName: u.name, dateStr,
          familyMode: true,
          notifyTip: kids.length > 0 && !sec.subscribed()
        });
        this.renderKidPid(kidId);
        return;
      }
      // 成员关系还没拉到本机（首次进入 / 换手机 / 云端未通）→ 退回单机构视图，别让首页空白
      const kids = db.students.list().map(s => ({ id: s.id, name: s.name, photo: s.photo || '', orgN: 1, orgs: '' }));
      const kidId = kids.some(k => k.id === this.data.kidId) ? this.data.kidId : (kids[0] ? kids[0].id : 0);
      this.setData({
        isParent: true, kids, kidId, roleLabel: '家长端', uName: u.name, dateStr,
        familyMode: false,
        notifyTip: kids.length > 0 && !sec.subscribed()
      });
      if (kidId) this.renderKid(kidId);
      return;
    }

    const vis = db.classes.list();
    const stu = db.students.list();
    const recs = db.records.list();
    const recOf = s => recs.filter(r => r.sid === s.id);
    // 「未录」按课次算而不是自然日：学生在任一个自己所在班的【当前课次】里还没有记录，就算未录。
    // 同一节课分两天录，第二天不再误报；结清过的课不再翻旧账。
    const curSessionOf = cid => {
      const c = vis.find(x => x.id === cid);
      return c ? Math.max(1, c.session || 1) : 0;
    };
    const notToday = s => (s.clsIds || []).some(cid => {
      const sess = curSessionOf(cid);
      return sess && !recOf(s).some(r => r.cid === cid && r.session === sess);
    });

    const myClasses = vis.map(c => {
      const cs = db.students.of(c.id);
      return { id: c.id, name: c.name, count: cs.length, pending: cs.some(notToday) };
    });
    // 历史照片补传云端（幂等：传完的记录不再进队列；防重入/云未开时自动跳过）
    photocloud.migrateAll();
    const recent = recs.slice(0, 5).map(r => ({
      id: r.id, sid: r.sid, name: db.students.name(r.sid) || '—',
      clsName: db.classes.name(r.cid), date: r.date,
      sd: (r.date || '').slice(5), score: r.score,
      ci: Math.max(0, vis.findIndex(c => c.id === r.cid)) % 3
    }));

    const label = { parent: '家长端', admin: '管理员端' }[db.auth.role()] || '老师端';
    // 空库 = 还没有学生（班级是空的壳子不算数）。此时首页不摆"开始录入"和三块 0（那看着像坏了），
    // 改摆开通卡；并且第一次进入时直接把人送进向导，只自动跳一次（跳过一次后由卡片接手）
    const empty = !stu.length && !recs.length;
    this.setData({
      isParent: false,
      roleLabel: label,
      // 名字可能还没填（新装为空），兜底叫「老师」，不显示空白也不显示"测试老师"
      uName: u.name || db.settings().teacher || '老师',
      dateStr,
      clsCount: vis.length, stuCount: stu.length,
      pending: stu.filter(notToday).length,
      myClasses, recent, empty
    });
    if (empty && !st.sandbox) this.autoSetup();
    this._loadFb();
    this._loadOrgs();
  },
  /* ---------------- 多机构：切换器 ----------------
   * 一个微信可以有多张机构工牌（老师同时在两家上课）。
   * 只有一家时整块不出现：多一个按钮对多数人是噪音。
   * 切换只换"当前是哪一家"这个指针，两家的数据在云端各自独立、互不可见。
   */
  _loadOrgs() {
    if (!api.syncOn() || this.data.sandbox || this.data.isParent) {
      if (this.data.orgs.length) this.setData({ orgs: [], curOrg: '' });
      return;
    }
    sync.orgList().then(r => {
      if (!r || !r.ok || !r.orgs || r.orgs.length < 2) {
        if (this.data.orgs.length) this.setData({ orgs: [], curOrg: '' });
        return;
      }
      const label = { owner: '负责人', admin: '管理员', teacher: '老师', parent: '家长' };
      this.setData({
        orgs: r.orgs.map(o => Object.assign({}, o, { roleLabel: label[o.role] || '成员' })),
        curOrg: r.cur || ''
      });
    }).catch(() => { /* 网络不通就当作只有一家，切换器不出现 */ });
  },
  openOrgPick() { this.setData({ orgPickShow: true }); },
  closeOrgPick() { this.setData({ orgPickShow: false }); },
  noop() { },
  pickOrg(e) {
    const id = String(e.currentTarget.dataset.id || '');
    if (!id || id === this.data.curOrg) { this.setData({ orgPickShow: false }); return; }
    if (this.data.orgSwitching) return;
    this.setData({ orgSwitching: true });
    wx.showLoading({ title: '正在切换…', mask: true });
    sync.switchOrg(id).then(r => {
      wx.hideLoading();
      if (!r || !r.ok) {
        this.setData({ orgSwitching: false });
        wx.showModal({ title: '切换不了', content: (r && r.msg) || '请稍后再试', showCancel: false });
        return;
      }
      // 整页重来：班级、学生、成果、角色全部跟着换一套，最不容易残留上家的状态
      wx.reLaunch({ url: '/pages/index/index' });
    }).catch(() => {
      wx.hideLoading();
      this.setData({ orgSwitching: false });
      wx.showModal({ title: '切换不了', content: '网络不通，请稍后再试', showCancel: false });
    });
  },
  goAddOrg() {
    this.setData({ orgPickShow: false });
    wx.navigateTo({ url: '/pages/join/join?add=1' });
  },
  // 家长反馈（已读回执 / 留言）：云没通或接口失败就整块不显示，绝不在首页摆假数据
  /* ---------------- 待上传提示 ----------------
   * 数据是自动推的（写后 1.5s / 失败退避重试 / 回前台 / 断网恢复），用户不需要点。
   * 这里只解决另一件事：**别让人以为已经传上去了**。有积压就说一条，传完自动消失。
   */
  _loadPending() {
    try {
      if (db.auth.isParent()) {
        if (this.data.pendingN || this.data.rejectN) this.setData({ pendingN: 0, rejectN: 0 });
        return;
      }
      const n = sync.pending();
      const bad = sync.rejectedCount();
      if (n !== this.data.pendingN || bad !== this.data.rejectN) {
        this.setData({ pendingN: n, rejectN: bad });
      }
    } catch (e) { /* 数据层不可用就不显示 */ }
  },
  // 退回原因在存储页（那儿有明细和"清空/重推"），首页只负责把人送过去
  goStorage() { wx.navigateTo({ url: '/pages/storage/storage' }); },
  // 催促一下（不是必须的）：点了就立刻推一轮，失败也只会更早进入下一次自动重试
  doFlush() {
    if (this.data.flushBusy) return;
    this.setData({ flushBusy: true });
    sync.flush().then(r => {
      this.setData({ flushBusy: false });
      this._loadPending();
      wx.showToast({
        title: (r && r.ok) ? '已传上云' : '还没连上，稍后自动补传',
        icon: 'none'
      });
    });
  },
  _loadFb() {
    // 未读数的口径与「我的」页共用一份（utils/fbunread.js），两处数字永远一致
    fbu.load().then(r => {
      if (!r.ready) { if (this.data.fbReady) this.setData({ fbReady: false, fbUnread: 0 }); return; }
      this.setData({ fbReady: true, fbUnread: r.unread, fbNote: r.note });
    });
  },
  goFeedback() { wx.navigateTo({ url: '/pages/feedback/feedback' }); },
  // 首次进入：先问"老师还是家长"。家长走邀请码，老师走开通向导——
  // 以前直接甩向导，家长会被要求给机构起名字，第一步就走错路了。
  // 只有真的跳成功了才记账：跳失败（页面未注册/栈满）不该把机会用掉，下次进来还能再跳
  autoSetup() {
    if (firstrun.autoShown()) return;
    wx.navigateTo({
      url: '/pages/join/join?pick=1',
      success: () => firstrun.markAutoShown()
    });
  },
  goSetup() { wx.navigateTo({ url: '/pages/setup/setup' }); },
  // 示例数据：样板间，只看不改；看够了点顶部横幅「开始使用」退出
  viewDemo() {
    const r = db.demo.enter();
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    this.onShow();
    wx.showToast({ title: '已进入示例数据（只看不改）', icon: 'none' });
  },
  /* ================= 家长端：孩子主页数据 ================= */
  /* 按平台身份（pid）渲染：孩子在 A、B 两家上课时，两家的成果并在这一页里。
   * 与 renderKid 的唯一差别是"记录从哪儿来"——这里用 db.family.records(pid)，
   * 它已经把两家机构的已发布记录并好、并标了 orgName；统计口径完全一样。 */
  renderKidPid(pid) {
    const k = db.family.kid(pid);
    if (!k) return;
    const GOOD = ['优秀', '最佳'], CARE = ['加油', '待提高'];
    const tcls = t => !t ? '' : GOOD.indexOf(t) > -1 ? 'good' : t === '良好' ? 'mid' : 'low';
    const parseLine = t => {
      const i = t.indexOf('：') > -1 ? t.indexOf('：') : t.indexOf(':');
      return i > -1
        ? { label: t.slice(0, i), text: t.slice(i + 1).replace(/^\s+/, '') }
        : { label: '', text: t };
    };
    const multi = k.orgs.length > 1;
    const deco = r => {
      const lines = (r.note || '').split('\n').filter(Boolean).map(parseLine);
      const first = lines[0] || null;
      let snip = first ? (first.text || first.label) : '';
      if (snip.length > 16) snip = snip.slice(0, 16) + '…';
      return {
        id: r.id, course: r.course, tag: r.tag, tcls: tcls(r.tag),
        date: r.date, score: r.score,
        // 一页里有好几家的记录，必须标清哪条是谁给的；只有一家时不占地方
        orgName: multi ? (r.orgName || '') : '',
        clsName: r.clsName || '',
        pcnt: (r.photos || []).length, snip, noteLines: lines
      };
    };
    const recs = db.family.records(pid);
    const daySet = {};
    recs.forEach(r => { daySet[r.date] = 1; });
    const stats = {
      lessons: recs.length,
      great: recs.filter(r => GOOD.indexOf(r.tag) > -1).length,
      days: Object.keys(daySet).length,
      care: recs.filter(r => CARE.indexOf(r.tag) > -1).length
    };
    // 课时包按机构分开：两家各买各的，加在一起是个没有意义的数字
    const hoursGroups = db.family.hours(pid);
    const latest = recs[0] ? deco(recs[0]) : null;
    this.setData({
      kName: k.name,
      kPhoto: k.photo || '',
      kCls: k.orgs.map(o => (o.orgName || '')
        + ((o.clsIds && o.clsIds.length) ? ' · ' + db.family.className(o.orgId, o.clsIds[0]) : '')
      ).filter(Boolean).join(' ｜ '),
      kOrgs: k.orgs,
      stats,
      hoursGroups,
      hoursRemain: hoursGroups.reduce((n, g) => n + g.remain, 0),
      hasCarry: hoursGroups.length > 0,
      kLatest: latest,
      latestPhotos: recs[0] ? (recs[0].photos || []).slice(0, 3) : [],
      kHistory: recs.slice(1).map(deco),
      // 需要注意：评价为加油/待提高的最近几次
      kCare: recs.filter(r => CARE.indexOf(r.tag) > -1).slice(0, 3).map(deco)
    });
  },
  renderKid(sid) {
    const s = db.students.get(sid);
    if (!s) return;
    const GOOD = ['优秀', '最佳'], CARE = ['加油', '待提高'];
    const tcls = t => !t ? '' : GOOD.indexOf(t) > -1 ? 'good' : t === '良好' ? 'mid' : 'low';
    // 评价行拆分：维度名 + 正文（与 student 页一致）
    const parseLine = t => {
      const i = t.indexOf('：') > -1 ? t.indexOf('：') : t.indexOf(':');
      return i > -1
        ? { label: t.slice(0, i), text: t.slice(i + 1).replace(/^\s+/, '') }
        : { label: '', text: t };
    };
    const deco = r => {
      const lines = (r.note || '').split('\n').filter(Boolean).map(parseLine);
      const first = lines[0] || null;
      let snip = first ? (first.text || first.label) : '';
      if (snip.length > 16) snip = snip.slice(0, 16) + '…';
      return {
        id: r.id, course: r.course, tag: r.tag, tcls: tcls(r.tag),
        date: r.date, score: r.score, clsName: db.classes.name(r.cid),
        pcnt: (r.photos || []).length, snip, noteLines: lines
      };
    };
    const recs = db.records.ofStudent(sid);
    const daySet = {};
    recs.forEach(r => { daySet[r.date] = 1; });
    const stats = {
      lessons: recs.length,
      great: recs.filter(r => GOOD.indexOf(r.tag) > -1).length,
      days: Object.keys(daySet).length,
      care: recs.filter(r => CARE.indexOf(r.tag) > -1).length
    };
    // 剩余课时：结转制班级的 active 报名求和（有课时包才显示）
    let hoursRemain = 0, hasCarry = false;
    db.enrollments.ofStudent(sid).forEach(en => {
      if (en.status !== 'active') return;
      // 只问一句"是不是结转制"，不取班级实体：班级不可见时也不该被顺带读出来
      if (db.classes.mode(en.clsId) !== 'carry') return;
      hasCarry = true;
      hoursRemain += Math.max(0, (en.totalHours || 0) - (en.usedHours || 0));
    });
    const latest = recs[0] ? deco(recs[0]) : null;
    this.setData({
      kName: s.name,
      kPhoto: s.photo || '',
      kCls: (s.clsIds || []).map(db.classes.name).join(' · '),
      stats,
      hoursRemain, hasCarry,
      kLatest: latest,
      latestPhotos: latest ? ((db.records.get(latest.id) || {}).photos || []).slice(0, 3) : [],
      kHistory: recs.slice(1).map(deco),
      // 需要注意：评价为加油/待提高的最近几次
      kCare: recs.filter(r => CARE.indexOf(r.tag) > -1).slice(0, 3).map(deco)
    });
  },
  pickKid(e) {
    const id = e.currentTarget.dataset.id;   // familyMode 下是 pid（跨机构），否则是学生 id
    this.setData({ kidId: id });
    if (this.data.familyMode) this.renderKidPid(id);
    else this.renderKid(Number(id));
  },
  goKidPage() {
    const q = this.data.familyMode
      ? '?id=' + encodeURIComponent(this.data.kidId) + '&pid=1'
      : '?id=' + this.data.kidId;
    wx.navigateTo({ url: '/pages/student/student' + q });
  },
  // 开启成绩通知：微信订阅消息授权 → openid 登记（bind 记授权额度）。
  // 模板未配（备案/类目未过）时云函数返回 NO_TPL，这里静默收起横幅，不弹任何报错。
  onSubscribe() {
    api.requestSubscribe().then(r => {
      if (!r.ok) {
        this.setData({ notifyTip: false }); // 暂不可订阅（无模板/未开云），收起横幅别堵眼
        return;
      }
      // 一次性订阅：授权一次 = 可收一条；发完额度自动清零，家长下次想收再点一次即可
      api.familyBind({
        sids: this.data.kids.map(k => k.id),
        name: this.data.uName,
        grants: 1
      });
      sec.markSubscribed();
      this.setData({ notifyTip: false });
      wx.showToast({ title: '已开启，发布后会提醒你', icon: 'success' });
    });
  },
  onSearch(e) {
    // 模糊搜索：输入单字（如"周"）即可匹配所有名字中含该字的学生
    const q = (e.detail.value || '').trim().replace(/\s+/g, '');
    const LIMIT = 20;
    let results = [], moreCount = 0;
    if (q) {
      const hit = db.students.search(q);
      results = hit.slice(0, LIMIT).map(s => ({
        id: s.id, name: s.name,
        meta: (s.clsIds || []).map(db.classes.name).join(' · ') || '未分班',
        ci: s.id % 3
      }));
      moreCount = Math.max(0, hit.length - LIMIT);
    }
    this.setData({ q, results, moreCount });
  },
  clearSearch() { this.setData({ q: '', results: [], moreCount: 0 }); },
  goRecord() {
    // 演示数据是样板间：进去录入也存不下来，不如在这里就说清楚
    if (db.demo.active()) {
      wx.showToast({ title: '演示数据只看不改，点上方「开始使用」', icon: 'none' });
      return;
    }
    // 进入录入页前给一个默认班级（已在可见范围内），避免无权限班被当默认值传下去
    const vis = db.classes.list();
    getApp().globalData.pick = { cls: vis[0] ? vis[0].id : null, sid: null, score: 85, photos: [], audio: null, tag: '', note: '', rid: null, course: '' };
    wx.navigateTo({ url: '/pages/record/record' });
  },
  goRecords() {
    // records 是 tabBar 页，switchTab 不带 query；用 globalData 传「今天未录」意图（B-06）
    getApp().globalData.recMiss = true;
    wx.switchTab({ url: '/pages/records/records' });
  },
  // 开始使用：退出演示，回到自己的机构（演示数据不删，随时能再看）
  startReal() {
    wx.showModal({
      title: '开始使用',
      content: '将回到你自己的机构。示例数据不会被删除，之后在「我的」里随时能再看。',
      confirmText: '开始使用',
      confirmColor: theme.danger(),
      success: r => {
        if (!r.confirm) return;
        db.demo.exit();
        this.onShow();
        wx.showToast({ title: '已回到你的机构', icon: 'none' });
      }
    });
  },
  // 同步冲突说明：不吓人，讲清楚"数据没丢、只是没合并"，并给出下一步
  explainConflict() {
    wx.showModal({
      title: '这台手机的数据没上云',
      content: '这个微信以前绑定过另一个机构（常见于换了手机后重新开通）。为了不把两家的学生混在一起，这台手机上新建的内容先留在本机，既没推上去，也没拉下云端的旧数据。\n\n内容还在，别卸载小程序。把情况告诉技术同学，可以从云端把两边合并。\n\n如果本来就是要另开一家机构：换一个微信号登录即可。',
      showCancel: false,
      confirmText: '知道了'
    });
  },
  goCls(e) { wx.navigateTo({ url: '/pages/cls/cls?id=' + e.currentTarget.dataset.id }); },
  // 统计卡直达对应页签：传页签名（cls/stu），负责人和老师的序号不同，名字不会漂
  goTab(e) { wx.navigateTo({ url: '/pages/mgr/mgr?tabK=' + e.currentTarget.dataset.k }); },
  // mgr 已从 tab 降为二级页，只能 navigateTo（switchTab 会静默失败）
  goMgr() { wx.navigateTo({ url: '/pages/mgr/mgr' }); },
  openRec(e) {
    const d = e.currentTarget.dataset;
    // familyMode 下 sid 是平台身份（pid），档案页要按它跨机构找这条记录
    const q = '?rid=' + d.rid + '&sid=' + encodeURIComponent(d.sid) + (this.data.familyMode ? '&pid=1' : '');
    wx.navigateTo({ url: '/pages/student/student' + q });
  },
  goStudent(e) {
    wx.navigateTo({ url: '/pages/student/student?id=' + e.currentTarget.dataset.sid });
    this.setData({ q: '', results: [], moreCount: 0 });
  },
  onPullDownRefresh() {
    api.pull().then(d => { if (d) db.merge(d); this.onShow(); wx.stopPullDownRefresh(); })
      .catch(() => wx.stopPullDownRefresh());
  },
  // 语音输入：点搜索框后的麦克风说话，再点一次结束
  onMic(e) { voice.dictate(this, e.currentTarget.dataset.k); },
  onHide() { voice.stop(this); }
});
