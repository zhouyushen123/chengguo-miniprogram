const db = require('../../utils/db');
const api = require('../../utils/api');
const icons = require('../../utils/icons');
const theme = require('../../utils/theme');
const voice = require('../../utils/voice');

// 评价分档配色：优秀/最佳绿、良好橙、加油/待提高蓝灰
const TAG_GOOD = ['优秀', '最佳'];
const tagCls = t => !t ? '' : TAG_GOOD.indexOf(t) > -1 ? 'good' : t === '良好' ? 'mid' : 'low';

Page({
  data: {
    s: null, tab: 0, latest: null, history: [], rec: null, photoUrls: [], videoUrls: [], photoCls: '',
    // 照片轮播高度（rpx）：按真实宽高比自适应，加载失败回落 660
    pswH: 660,
    // 照片轮播：swAuto=自动播放开关（手指按住暂停，松手延迟恢复）；_swTimer 挂 this 上不进 data
    swAuto: true,
    filters: [], filt: '全部', total: 0, shown: 0, expandId: 0,
    // 新增：个人卡统计 / 资料入口 / 班级筛选 / 评价汇总
    stats: null, profileFilled: true, clsFilters: [], clsF: 'all', tagCounts: [],
    hoursRemain: 0, hasCarry: false,
    playing: '', teacher: '', icoPlay: icons.play(icons.brand()), icoPause: icons.pause(icons.brand()),
    icoChev: icons.chevron, icoPlus: icons.plus('#FFFFFF'), icoCam: icons.camera, icoUser: icons.user,
    // 家长留言 / 已读回执：fbOn = 云通 + 真的是家长，入口才出现（失败就整块不显示，绝不吓家长）
    fbOn: false, fbCard: [], fbMine: [],
    fbSheet: false, fbRid: 0, fbCourse: '', fbDate: '',
    fbText: '', fbBusy: false, fbErr: '', fbNotes: []
  },
  onLoad(q) {
    this.sid = +q.id || +q.sid || 0; // 兼容 id / sid 两种参数名
    this.rid = +q.rid || 0;
  },
  onShow() {
    theme.apply(this);
    // icoPlus 是品牌色按钮上的白色加号，std() 的整包刷新给的是品牌色版，这里单独纠正
    this.setData({ icoPlus: icons.plus('#FFFFFF') });
    this.render();
    // 家长留言 / 已读回执：先问云端「我是谁、我写过什么」，成功才显示入口
    this._initFb();
  },
  // 统一渲染：拉记录 → 按班级/课程双维过滤 → 首条做详情，其余进历史列表
  render() {
    // 兼容只带 rid 的入口（如首页最近成果）：先从记录反查学生
    if (!this.sid && this.rid) {
      const r0 = db.records.get(this.rid);
      if (r0) this.sid = r0.sid;
    }
    const s = db.students.get(this.sid);
    // 学生不在可见范围（老师跨班、家长非自家孩子）时明确提示，不留白屏
    if (!s) {
      wx.showToast({ title: this.sid ? '该学生不在你的查看范围' : '没有找到这个学生', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 900);
      return;
    }
    const recs = db.records.ofStudent(this.sid);
    // 语音条上的老师名：优先用这条记录的录入老师，老数据回退到机构默认老师
    // 署名兜底：新装没填名字时不留空白，署「老师」
    const tname = r => (r && db.users.name(r.tid)) || db.settings().teacher || '老师';
    // 评价行拆分：维度名（浅色）+ 正文（深色），如「上课态度：听讲认真」
    const parseLine = t => {
      const i = t.indexOf('：') > -1 ? t.indexOf('：') : t.indexOf(':');
      return i > -1
        ? { label: t.slice(0, i), text: t.slice(i + 1).replace(/^\s+/, '') }
        : { label: '', text: t };
    };
    const withLines = r => r ? Object.assign({}, r, { noteLines: (r.note || '').split('\n').filter(Boolean).map(parseLine) }) : r;
    // 照片网格自适应：1 张铺满整行，2 张对半，3 张及以上三列
    const pgCls = n => n >= 3 ? 'pg3' : n === 2 ? 'pg2' : n === 1 ? 'pg1' : '';
    // 记录的可读视图：班级名 + 评价分档配色 + 照片数 + 评价首行摘要（历史行用）
    // null 入参直接返回 null：零记录学生的 list[0]、rid 找不到记录时都会传 null 进来，
    // 不设防会在 onLoad 阶段抛异常 → 白屏 + 错误陷阱弹「内容已复制」
    const deco = r => {
      if (!r) return null;
      const x = withLines(r);
      const first = (x.noteLines && x.noteLines[0]) || null;
      let snip = first ? (first.text || first.label) : '';
      if (snip.length > 16) snip = snip.slice(0, 16) + '…';
      // 班级结课前的记录随时可改：能不能改由权限层判定（负责人/管理员全可改，老师限本人）
      return x && Object.assign(x, { clsName: db.classes.name(r.cid), tcls: tagCls(r.tag), pcnt: (r.photos || []).length, snip, sess: r.session || 0, canEdit: db.auth.can('record.update', { record: r }) });
    };

    // 指定某条记录（从记录列表点入）
    if (this.rid) {
      const rec = deco(recs.find(r => r.id === this.rid) || null);
      this.setData({
        s: this.stuView(s), rec, latest: null, history: [],
        photoUrls: (rec || {}).photos || [], videoUrls: (rec || {}).videos || [],
        photoCls: pgCls(((rec || {}).photos || []).length),
        filters: [], filt: '全部', total: 0, shown: 0, teacher: tname(rec)
      });
      this._sizePhotos((rec || {}).photos || []);
      // 家长从记录列表/首页点进来的「单条成果」：打开即算看过
      this._markSeen();
      this._syncFbCard();
      return;
    }

    // ---- 个人卡统计（口径对全量记录，不随筛选变，避免数字跳来跳去） ----
    const daySet = {};
    recs.forEach(r => { daySet[r.date] = 1; });
    const stats = {
      lessons: recs.length,
      great: recs.filter(r => TAG_GOOD.indexOf(r.tag) > -1).length,
      days: Object.keys(daySet).length
    };
    // ---- 剩余课时：结转制班级的 active 报名求和（课时包家庭最关心的数字） ----
    let hoursRemain = 0, hasCarry = false;
    db.enrollments.ofStudent(s.id).forEach(en => {
      if (en.status !== 'active') return;
      if (db.classes.mode(en.clsId) !== 'carry') return;
      hasCarry = true;
      hoursRemain += Math.max(0, (en.totalHours || 0) - (en.usedHours || 0));
    });
    // ---- 资料入口：家长资料表单（profile）一个字没填才提示「待填写」 ----
    const p = s.profile || {};
    const profileFilled = ['nick', 'birth', 'school', 'phone', 'wechat', 'level', 'goal', 'note'].some(k => p[k]);
    // ---- 班级筛选：学生同时在一个以上班级时才出现 ----
    const clsFilters = (s.clsIds || []).length > 1
      ? [{ k: 'all', n: '全部班级' }].concat(s.clsIds.map(id => ({ k: id, n: db.classes.name(id) })))
      : [];
    const clsF = clsFilters.some(f => String(f.k) === String(this.data.clsF)) ? this.data.clsF : 'all';
    let pool = recs;
    if (clsF !== 'all') pool = recs.filter(r => r.cid === Number(clsF));

    const courses = [];
    pool.forEach(r => { if (r.course && courses.indexOf(r.course) === -1) courses.push(r.course); });
    const filters = ['全部'].concat(courses);
    const filt = filters.indexOf(this.data.filt) > -1 ? this.data.filt : '全部';
    const list = filt === '全部' ? pool : pool.filter(r => r.course === filt);

    // ---- 评价汇总：当前筛选下各档评价的次数 ----
    const tc = {};
    list.forEach(r => { if (r.tag) tc[r.tag] = (tc[r.tag] || 0) + 1; });
    const tagCounts = db.TAGS.filter(t => tc[t]).map(t => ({ t, n: tc[t], cls: tagCls(t) }));

    this.setData({
      s: this.stuView(s), rec: null,
      stats, profileFilled, clsFilters, clsF, tagCounts,
      hoursRemain, hasCarry,
      filters, filt, total: recs.length, shown: list.length,
      latest: deco(list[0] || null),
      // 历史条目带全量字段，行内展开详情用（不再跳新页）
      history: list.slice(1).map(r => Object.assign(deco(r), { pcls: pgCls((r.photos || []).length) })),
      photoUrls: (list[0] || {}).photos || [],
      videoUrls: (list[0] || {}).videos || [],
      photoCls: pgCls(((list[0] || {}).photos || []).length),
      teacher: tname(list[0])
    });
    this._sizePhotos((list[0] || {}).photos || []);
    // 学生页最新一次成果就是详情本身（首页只摆摘要，不算看过）
    this._markSeen();
    this._syncFbCard();
  },
  /* ================= 家长已读回执 + 留言 =================
   * 口径：只有家长「真正打开某条已发布成果的详情」才算看过。进首页看摘要不算，
   * 收到微信服务通知也不算 —— 否则老师会看到一片假已读。
   * 两张表在云端（不进同步集合），所以这里只要失败就整块不显示，不做任何乐观假设。
   */
  _initFb() {
    if (!db.auth.isParent()) return;
    if (!api.enabled()) return;
    api.fbList('parent').then(r => {
      if (!r || !r.ok) return;
      const mine = (r.notes || []).map(n => Object.assign({}, n, { time: this._fmtTime(n.createdAt) }));
      this.setData({ fbOn: true, fbMine: mine });
      // 首次进来时 fbOn 还是 false，render 里的上报会被跳过，这里补一次
      this._markSeen();
      this._syncFbCard();
    });
  },
  _fmtTime(ts) {
    const t = Number(ts) || 0;
    if (!t) return '';
    const d = new Date(t);
    const hh = ('0' + d.getHours()).slice(-2), mm = ('0' + d.getMinutes()).slice(-2);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hh + ':' + mm;
  },
  // 当前详情是哪条记录（单条视图优先，否则最新一次）
  _curRec() { return this.data.rec || this.data.latest || null; },
  _markSeen() {
    if (!this.data.fbOn || !db.auth.isParent()) return;
    const r = this._curRec();
    if (!r || !r.id || !r.sent) return;
    this._seen = this._seen || {};
    if (this._seen[r.id]) return;
    this._seen[r.id] = 1;
    api.fbView(r.id, this.sid);   // 静默失败，不提示、不阻塞
  },
  _syncFbCard() {
    if (!this.data.fbOn) return;
    const r = this._curRec();
    const rid = r ? r.id : 0;
    const list = rid ? (this.data.fbMine || []).filter(n => Number(n.rid) === rid) : [];
    this.setData({ fbCard: list });
  },
  openNote(e) {
    const d = e.currentTarget.dataset;
    const rid = Number(d.rid) || 0;
    if (!rid) return;
    const mine = (this.data.fbMine || []).filter(n => Number(n.rid) === rid);
    this.setData({
      fbSheet: true, fbRid: rid, fbCourse: d.course || '', fbDate: d.date || '',
      fbText: '', fbErr: '', fbBusy: false, fbNotes: mine
    });
  },
  closeNote() {
    voice.stop(this);
    this.setData({ fbSheet: false, fbText: '', fbErr: '' });
  },
  noop() { /* 弹层内的点击不穿透到遮罩 */ },
  onFbInput(e) { this.setData({ fbText: e.detail.value, fbErr: '' }); },
  onFbMic() { voice.dictate(this, 'fbText'); },
  sendNote() {
    if (this.data.fbBusy) return;
    const text = String(this.data.fbText || '').trim();
    if (!text) { this.setData({ fbErr: '先写一句再发吧' }); return; }
    if (!this.data.fbOn) { this.setData({ fbErr: '网络未就绪，稍后再试' }); return; }
    voice.stop(this);
    this.setData({ fbBusy: true, fbErr: '' });
    api.fbNote(this.data.fbRid, this.sid, text).then(r => {
      if (!r || !r.ok) {
        this.setData({ fbBusy: false, fbErr: (r && r.msg) || '发送失败，请重试' });
        return;
      }
      const one = {
        id: r.id, rid: this.data.fbRid, sid: this.sid, text,
        createdAt: r.createdAt || Date.now(), handled: false, time: this._fmtTime(r.createdAt || Date.now())
      };
      const mine = [one].concat(this.data.fbMine || []);
      this.setData({
        fbBusy: false, fbText: '',
        fbMine: mine,
        fbNotes: [one].concat(this.data.fbNotes || []),
        fbCard: mine.filter(n => Number(n.rid) === Number(this.data.fbRid))
      });
      wx.showToast({ title: '已送达老师', icon: 'success' });
    });
  },
  // 照片轮播自适应：按真实宽高比算高度（宽度铺满卡片内容区 646rpx），取各图最高者并封顶；
  // 单图失败不影响整体，全失败回落默认 660rpx
  _sizePhotos(urls) {
    const W = 646; // 750 - 左右卡片边距 24*2 - 卡片内边距 28*2
    if (!urls || !urls.length) { this.setData({ pswH: 660 }); return; }
    Promise.all(urls.map(u => new Promise(res => {
      wx.getImageInfo({ src: u, success: r => res({ w: r.width, h: r.height }), fail: () => res(null) });
    }))).then(list => {
      const hs = list.filter(Boolean).map(d => Math.round(W * d.h / d.w));
      const h = hs.length ? Math.min(Math.max.apply(null, hs), 1100) : 660;
      this.setData({ pswH: h });
    });
  },
  // 语音条：替代原生 audio 组件（那会显示"未知歌曲"），播放老师的课堂语音
  toggleAudio(e) {
    const key = e.currentTarget.dataset.key, src = e.currentTarget.dataset.src;
    if (!src) return;
    if (this.data.playing === key) { // 再点一次：停止
      if (this.audio) this.audio.stop();
      this.setData({ playing: '' });
      return;
    }
    if (!this.audio) {
      this.audio = wx.createInnerAudioContext();
      this.audio.onEnded(() => this.setData({ playing: '' }));
      this.audio.onError(() => { this.setData({ playing: '' }); wx.showToast({ title: '播放失败', icon: 'none' }); });
    }
    this.audio.stop();
    this.audio.src = src;
    this.audio.play();
    this.setData({ playing: key });
  },
  stuView(s) {
    return {
      name: s.name, photo: s.photo || '', no: s.no || '',
      meta: (s.clsIds || []).map(db.classes.name).join(' · '),
      parent: s.parent || '', wechat: s.wechat || ''
    };
  },
  pickCls(e) {
    // 切班级后课程集合会变，课程筛选一并回到「全部」
    this.setData({ clsF: e.currentTarget.dataset.k, filt: '全部', expandId: 0 }, () => this.render());
  },
  pickFilter(e) {
    this.setData({ filt: e.currentTarget.dataset.f, expandId: 0 }, () => this.render());
  },
  // 历史条目行内展开/收起（同一时间只展开一条）
  toggleExpand(e) {
    const id = +e.currentTarget.dataset.rid;
    const next = this.data.expandId === id ? 0 : id;
    this.setData({ expandId: next });
    // 展开 = 真的看到了这条记录的内容 → 家长端上报已读（老师端无需上报）
    if (next && this.data.fbOn && db.auth.isParent()) {
      const item = (this.data.history || []).filter(h => h.id === id)[0];
      if (item && item.sent) api.fbView(id, this.sid);
    }
  },
  // 修改已有记录：J-07 以前只把 rid 挂在 URL 上，录入页却完全不读参数，
  // 于是变成空白新建态、还残留上一次的班级/学生（看起来像改到别的同学）。
  // 现在和记录列表页一样先塞完整的 pick，URL 的 rid 由录入页再回库校验一次。
  editRec(e) {
    const r = db.records.get(Number(e.currentTarget.dataset.rid) || 0);
    if (!r) { wx.showToast({ title: '记录不存在', icon: 'none' }); return; }
    if (!db.auth.can('record.update', { record: r })) {
      wx.showToast({ title: db.auth.denyReason('record.update'), icon: 'none' });
      return;
    }
    getApp().globalData.pick = {
      cls: r.cid, sid: r.sid, score: r.score, photos: r.photos || [], videos: r.videos || [], audio: r.audio,
      tag: r.tag || '', note: r.note || '', rid: r.id, course: r.course, sent: !!r.sent
    };
    wx.navigateTo({ url: '/pages/record/record?rid=' + r.id });
  },
  goRecord() {
    const s = db.students.get(this.sid);
    getApp().globalData.pick = {
      cls: (s && s.clsIds && s.clsIds[0]) || null, sid: this.sid,
      score: 85, photos: [], videos: [], audio: null, tag: '', note: '', rid: null, course: ''
    };
    wx.navigateTo({ url: '/pages/record/record' });
  },
  goProfile() { wx.navigateTo({ url: '/pages/profile/profile?id=' + this.sid }); },
  previewPhoto(e) { wx.previewImage({ urls: this.data.photoUrls, current: this.data.photoUrls[e.currentTarget.dataset.i] }); },
  // —— 照片轮播：按住暂停，松手后多等 2.5 秒再继续（比正常 4 秒间隔多留一点观看时间） ——
  swTouchStart() {
    if (this._swTimer) { clearTimeout(this._swTimer); this._swTimer = null; }
    if (this.data.swAuto) this.setData({ swAuto: false });
  },
  swTouchEnd() {
    if (this._swTimer) clearTimeout(this._swTimer);
    this._swTimer = setTimeout(() => {
      this._swTimer = null;
      if (!this.data.swAuto) this.setData({ swAuto: true });
    }, 2500);
  },
  onUnload() { voice.stop(this); if (this._swTimer) { clearTimeout(this._swTimer); this._swTimer = null; } }
});
