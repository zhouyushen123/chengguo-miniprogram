const db = require('../../utils/db');
const api = require('../../utils/api');
const icons = require('../../utils/icons');
const theme = require('../../utils/theme');
const voice = require('../../utils/voice');
const firstrun = require('../../utils/firstrun');
const sec = require('../../utils/sec');
const photocloud = require('../../utils/photocloud');

Page({
  data: {
    isParent: false, kids: [], kidId: 0,
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
    empty: false
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
    this.setData({ navTitle: st.orgName || '橙果', sandbox: !!st.sandbox });
    const u = db.users.current() || { role: 'teacher', name: '' };
    const d = new Date();
    const dateStr = (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + '日一二三四五六'[d.getDay()];
    // 身份与数据范围统一由权限层给出：下面拿到的 list 已经是过滤后的结果，
    // 页面不再自己写 role/clsIds 判断（那种写法漏一处就是越权）
    const isParent = db.auth.isParent();

    if (isParent) {
      // 家长端首页：统计 + 最近一次详情 + 需要注意 + 历史列表（数据已经权限层过滤，只见已发布）
      const kids = db.students.list().map(s => ({ id: s.id, name: s.name, photo: s.photo || '' }));
      const kidId = kids.some(k => k.id === this.data.kidId) ? this.data.kidId : (kids[0] ? kids[0].id : 0);
      // 订阅横幅：开过就不再骚扰；云/模板未配时点击后静默降级，横幅也收起（家长少一块无用区域）
      this.setData({
        isParent: true, kids, kidId, roleLabel: '家长端', uName: u.name, dateStr,
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
  },
  // 首次进入自动打开开通向导：用一次性标记记一笔，之后只在首页留卡片，不再强行跳
  // （标记走 utils/firstrun.js：页面不许直接读写本地存储）
  autoSetup() {
    if (firstrun.autoShown()) return;
    // 只有真的跳成功了才记账：跳失败（页面未注册/栈满）不该把机会用掉，下次进来还能再跳
    wx.navigateTo({
      url: '/pages/setup/setup',
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
  // 评价分档配色：优秀/最佳绿、良好橙、加油/待提高蓝灰
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
    const id = +e.currentTarget.dataset.id;
    this.setData({ kidId: id });
    this.renderKid(id);
  },
  goKidPage() { wx.navigateTo({ url: '/pages/student/student?id=' + this.data.kidId }); },
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
  goRecords() { wx.switchTab({ url: '/pages/records/records' }); },
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
  goCls(e) { wx.navigateTo({ url: '/pages/cls/cls?id=' + e.currentTarget.dataset.id }); },
  // mgr 已从 tab 降为二级页，只能 navigateTo（switchTab 会静默失败）
  goMgr() { wx.navigateTo({ url: '/pages/mgr/mgr' }); },
  openRec(e) { wx.navigateTo({ url: '/pages/student/student?rid=' + e.currentTarget.dataset.rid + '&sid=' + e.currentTarget.dataset.sid }); },
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
