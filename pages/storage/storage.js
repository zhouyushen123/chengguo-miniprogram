// pages/storage/storage.js —— 存储空间：本地数据与媒体的占用、清理
//
// 【为什么需要这个页面】小程序本地文件空间约 200MB，课堂视频 10–50MB 一条，
// 两条带满视频的记录就能吃掉 150MB。以前 media.usage() 写好了却没有页面调用，
// 空间满了只会表现为"新照片存不下来"，用户完全不知道为什么。
//
// 【清理策略】只删"没有任何记录引用、且不是最近两小时内新建"的文件：
//   - 已删除的记录仍算引用 —— 照片删掉就找不回来，多占几百 KB 可以接受
//   - 两小时内新建的不动 —— 可能是用户在录入页选好、还没保存的素材
const db = require('../../utils/db');
const media = require('../../utils/media');
const theme = require('../../utils/theme');
const api = require('../../utils/api');
const sync = require('../../utils/sync');

const KB = 1024;
const MB = 1024 * 1024;

// 备份时间戳：只到分钟，够用且不占宽度
function fmtTime(ts) {
  const n = Number(ts) || 0;
  if (!n) return '';
  const d = new Date(n);
  const p = x => (x < 10 ? '0' + x : '' + x);
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function size(bytes) {
  const n = Number(bytes) || 0;
  if (n >= MB) return (n / MB).toFixed(n >= 10 * MB ? 0 : 1) + ' MB';
  if (n >= KB) return Math.round(n / KB) + ' KB';
  return n + ' B';
}

Page({
  data: {
    kvText: '暂不可用', kvPct: 0, kvNote: '',
    mdText: '0 B', mdPct: 0, mdFiles: 0, mdLimit: '200 MB',
    orphanCount: 0, orphanText: '0 B', recent: 0, cleanText: '暂无可清理的文件',
    students: 0, records: 0, classes: 0,
    failed: false,
    // 数据体检：核心资产（学生 / 成员 / 机构）之间的引用是否对得上
    auditOk: true, auditErr: 0, auditWarn: 0, auditItems: [], fixable: false, auditNote: '',
    // 关系检查：课程开设、记录的班级/学生/课程指针、老师与学生的范围、课时账
    // wait 的那一类是"本机还没收到这条数据"，不修，等同步自己补上
    linkOk: true, linkItems: [], linkWait: 0, linkFault: 0,
    headOk: true, headHint: '一切正常',
    // 本地备份：核心资产的滚动快照（最多 3 份）
    snaps: [], snapCount: 0, snapHint: '还没有备份',
    // 云端备份：云开发每天凌晨 3 点自动打包（云数据库被改坏时的最后一道保险）
    cbShow: true, cbBusy: false, cbHint: '读取中…',
    // 被云端拒绝的改动：本地改成功了、云端没接受，不说出来就是静默不一致
    rejects: [], rejectCount: 0, trashCount: 0,
    rawRows: [],
    dirtyCount: 0, syncHint: '', syncBusy: false
  },

  onShow() { theme.apply(this); this.refresh(); this.refreshCloud(); this.refreshSync(); },

  refresh() {
    const h = db.health();
    const kv = h.usage;
    const md = media.scan(db.mediaRefs());
    const c = h.counts || {};
    this.setData({
      kvText: kv ? (size(kv.current * KB) + ' / ' + size(kv.limit * KB)) : '暂不可用',
      kvPct: (kv && kv.limit) ? Math.min(100, Math.round(kv.current / kv.limit * 100)) : 0,
      kvNote: kv ? (kv.keys + ' 个存储项') : '',
      mdText: size(md.bytes) + ' / ' + size(media.LIMIT),
      mdPct: Math.min(100, Math.round(md.bytes / media.LIMIT * 100)),
      mdFiles: md.files,
      orphanCount: md.orphan.length,
      orphanText: size(md.orphanBytes),
      // WXML 里不做字符串拼接：文案统一在这里算好，模板只负责展示
      cleanText: md.orphan.length ? ('清理这 ' + md.orphan.length + ' 个文件') : '暂无可清理的文件',
      recent: md.recent,
      students: c.students || 0,
      records: c.records || 0,
      classes: c.classes || 0,
      failed: !!h.lastFail
    });
    this.refreshRaw();
    this.refreshAudit();
    this.refreshLinks();
    this.refreshSnaps();
    this.refreshRejects();
    this.syncHead();
  },

  // 体检与备份要单独 try：它们是"附加信息"，坏了不能让整页白屏
  refreshAudit() {
    let a = null;
    try { a = db.audit.scan(); } catch (e) { a = null; }
    if (!a) { this.setData({ auditOk: true, auditItems: [] }); return; }
    this.setData({
      auditOk: a.healthy,
      auditErr: a.errors,
      auditWarn: a.warns,
      auditItems: (a.issues || []).map(x => ({ k: x.k, level: x.level, title: x.title, count: x.count })),
      // 只有这两类是"修了绝不会更糟"的，其它（比如重复学生）必须人来判断
      fixable: (a.issues || []).some(x => x.k === 'stuDanglingCls' || x.k === 'memDangling' || x.k === 'dupNo' || x.k === 'noNo'),
      auditNote: '学生 ' + (this.data.students || 0) + ' 人、班级 ' + (this.data.classes || 0)
        + ' 个、记录 ' + (this.data.records || 0) + ' 条，' + (a.healthy ? '互相引用都对得上。' : '人和机构本身的记录有问题。')
    });
  },

  // 关系检查：这一层看的是"连线"，不是"人"。课程开设挂在哪个班、记录指向哪个学生、
  // 老师负责哪些班——任何一条指着空气，表现出来都是"这个班选不到课"这种偶发怪事。
  refreshLinks() {
    let items = [];
    try { items = db.integrityGroups() || []; } catch (e) { items = []; }
    let wait = 0, fault = 0;
    items.forEach(x => { if (x.wait) wait += x.count; else fault += x.count; });
    this.setData({
      linkOk: !items.length,
      linkItems: items.map(x => ({
        kind: x.kind, label: x.label,
        // 数字后面的说明在这里拼好：模板里不做字符串运算
        text: String(x.count) + (x.wait ? ' 待同步' : ''),
        wait: x.wait
      })),
      linkWait: wait,
      linkFault: fault
    });
  },

  // 头部一句话要综合两层：只看 audit 会出现"一切正常"下面却列着断线的自相矛盾
  syncHead() {
    const d = this.data;
    const n = (d.auditErr || 0) + (d.linkFault || 0);
    this.setData({
      headOk: n === 0,
      headHint: n ? (n + ' 处需要处理') : (d.linkWait ? '正常（' + d.linkWait + ' 处待同步）' : '一切正常')
    });
  },

  // 断线修复：启动时已经跑过一次，这里是给"刚同步完、想立刻再看一眼"的人一个按钮
  fixLinks() {
    let r = null;
    try { r = db.repairLinks(); } catch (e) { r = null; }
    const n = r ? (r.bindings + r.dupBind + r.records + r.members + r.students) : 0;
    this.refreshLinks();
    this.syncHead();
    if (n) { wx.showToast({ title: '已修复 ' + n + ' 处', icon: 'none' }); return; }
    wx.showToast({
      title: this.data.linkWait ? '缺的数据要等同步补上' : '没有需要修的',
      icon: 'none'
    });
  },

  // 同步被拒 + 回收站条数：都是"数据没在预期位置"的信号，放在一起看
  refreshRejects() {
    let list = [];
    let trash = 0;
    try { list = db.sync.rejects() || []; } catch (e) { list = []; }
    try { const r = db.trash.list(); trash = (r && r.ok) ? r.total : 0; } catch (e) { trash = 0; }
    this.setData({
      rejectCount: list.length,
      rejects: list.slice(0, 5).map((x, i) => ({ idx: i, msg: x.msg || x.code, time: fmtTime(x.at) })),
      trashCount: trash
    });
  },

  goTrash() { wx.navigateTo({ url: '/pages/trash/trash' }); },

  clearRejects() {
    try { db.sync.clearRejects(); } catch (e) { /* 清不掉也不影响业务 */ }
    this.refreshRejects();
  },

  refreshSnaps() {
    let list = [];
    try { list = db.snapshots.list() || []; } catch (e) { list = []; }
    const snaps = list.map(x => ({
      id: x.id, tag: x.tag || '备份', at: x.at, time: fmtTime(x.at),
      text: x.counts ? (x.counts.students + ' 学生 · ' + x.counts.records + ' 记录') : ''
    }));
    this.setData({
      snaps,
      snapCount: snaps.length,
      snapHint: snaps.length ? ('最近 ' + snaps[0].time) : '还没有备份'
    });
  },

  // 只修悬空引用与学号，重复学生/孤儿记录只报告不自动处理
  fixData() {
    wx.showModal({
      title: '修复这些对不上的引用？',
      content: '会做两件事：把指向"已删除班级/学生"的引用摘掉；给重复或缺失的学号重新发号。学生、老师、机构本身一条都不会删。',
      confirmText: '修复',
      success: r => {
        if (!r.confirm) return;
        const res = db.audit.fix(['dangling', 'noNo']);
        if (!res || !res.ok) { wx.showToast({ title: (res && res.msg) || '修复失败', icon: 'none' }); return; }
        const n = (res.fixed.dangling || 0) + (res.fixed.noNo || 0);
        this.refresh();
        wx.showToast({ title: n ? ('已修复 ' + n + ' 处') : '没有需要修的', icon: 'none' });
      }
    });
  },

  // 同步状态：待推送条数 + 手动触发。以前的同步完全静默——失败用户不知道，
  // 成功用户也不知道，排查"数据怎么没上云"只能靠开发者工具（手机上没有）。
  refreshSync() {
    let n = 0;
    try { n = (db.sync.dirtyCols() || []).length; } catch (e) { n = 0; }
    this.setData({ dirtyCount: n });
  },

  doSync() {
    if (this.data.syncBusy) return;
    this.setData({ syncBusy: true, syncHint: '' });
    wx.showLoading({ title: '同步中…', mask: true });
    sync.kick().then(r => {
      wx.hideLoading();
      const out = r || {};
      let hint;
      if (out.ok) hint = '同步完成：推送 ' + (out.pushed || 0) + ' 项' + (out.pulled ? '，拉回 ' + out.pulled + ' 项' : '');
      else if (out.code === 'SYNC_OFF') hint = '同步未开启（云开发未就绪）';
      else if (out.code === 'EMPTY') hint = '本机还没有数据，暂不同步';
      else if (out.busy || out.throttled) hint = '刚同步过，稍等几秒再试';
      else hint = '同步失败' + (out.msg ? '：' + out.msg : (out.code ? '（' + out.code + '）' : ''));
      this.setData({ syncHint: hint, syncBusy: false });
      // 同步之后正好是"待同步的断线应该自己消失"的时刻：三层一起刷，别让旧数字留在屏幕上
      this.refreshSync(); this.refreshAudit(); this.refreshLinks(); this.refreshRaw(); this.syncHead();
    }).catch(e => {
      wx.hideLoading();
      this.setData({ syncHint: '同步失败：' + ((e && e.errMsg) || '网络不通'), syncBusy: false });
    });
  },

  // 原始条数：每张表「总条数 / 当前机构条数」
  // 这两个数字的差是"数据在、但身份/机构号对不上"的唯一线索——没有它，
  // 界面上一律显示 0，用户和我们都只能猜"是不是丢了"（2026-11-05 真机踩过）。
  refreshRaw() {
    let rows = [];
    try { rows = db.rawCounts() || []; } catch (e) { rows = []; }
    this.setData({ rawRows: rows });
  },

  // 回到出厂：数据层是 fail-closed 的，成员表丢了以后连开通向导都过不了权限闸，
  // 界面上必须有这个出口，否则这台手机永远改不了也建不了。
  doReset() {
    wx.showModal({
      title: '重置本机数据？',
      content: '会清掉这台手机上的全部学生、班级、记录与成员，不能撤销。云端数据不受影响。重置后重新走一遍开通向导即可。',
      confirmText: '继续',
      confirmColor: theme.danger(),
      success: r => {
        if (!r.confirm) return;
        // 第二道确认：这一步没有回收站，误点就是全没
        wx.showModal({
          title: '再确认一次',
          content: '重置后本机将回到刚安装的状态（没有学生、没有记录）。确定继续？',
          confirmText: '确定重置',
          confirmColor: theme.danger(),
          success: m => {
            if (!m.confirm) return;
            const res = db.resetReal();
            if (!res || !res.ok) { wx.showToast({ title: (res && res.msg) || '重置失败', icon: 'none' }); return; }
            wx.showToast({ title: '已重置，正在重新启动', icon: 'none' });
            setTimeout(() => wx.reLaunch({ url: '/pages/index/index' }), 600);
          }
        });
      }
    });
  },

  doBackup() {
    const r = db.snapshots.save('手动备份');
    if (!r || !r.ok) { wx.showToast({ title: (r && r.msg) || '备份失败', icon: 'none' }); return; }
    this.refreshSnaps();
    wx.showToast({ title: '已备份到本机', icon: 'none' });
  },

  doRestore() {
    const list = this.data.snaps;
    if (!list.length) { wx.showToast({ title: '还没有备份', icon: 'none' }); return; }
    wx.showActionSheet({
      itemList: list.map(x => x.tag + ' · ' + x.time + '（' + x.text + '）'),
      success: r => {
        const s = list[r.tapIndex];
        if (!s) return;
        wx.showModal({
          title: '恢复到 ' + s.time + '？',
          content: '当前数据会先自动存一份「恢复前」，再回到这份备份。恢复后会自动与云端重新对齐。',
          confirmText: '恢复',
          confirmColor: theme.danger(),
          success: m => {
            if (!m.confirm) return;
            const res = db.snapshots.restore(s.id);
            if (!res || !res.ok) { wx.showToast({ title: (res && res.msg) || '恢复失败', icon: 'none' }); return; }
            this.refresh();
            wx.showToast({ title: '已恢复', icon: 'none' });
          }
        });
      }
    });
  },

  // 云端备份：只给能看到全班数据的人（家长看到"机构有多少条记录"没有意义）
  refreshCloud() {
    if (db.auth.isParent()) { this.setData({ cbShow: false }); return; }
    this.setData({ cbShow: true });
    api.cloudBackup('info').then(r => {
      if (!r || !r.ok) {
        this.setData({ cbHint: (r && r.code === 'FORBIDDEN') ? '仅负责人/管理员可操作' : '暂时读不到' });
        return;
      }
      const m = r.latest;
      this.setData({
        cbHint: m ? ('最近 ' + m.date + ' · ' + (m.total || 0) + ' 条') : '还没有备份'
      });
    }).catch(() => {});
  },

  // 一次只备一个集合：云函数 60 秒超时，整包一次数据多的机构会被掐断，掐断时还不知道停在哪。
  // 中途失败不谎报成功——剩下一半会在提示里说清楚。
  doCloudBackup() {
    if (this.data.cbBusy) return;
    // 清单从注册表来：以前这里手抄了一份，加新表时漏掉 → 云端备份少一张表（静默）
    const COLLS = db.sync.COLLS.slice();
    this.setData({ cbBusy: true });
    wx.showLoading({ title: '备份中 1/' + COLLS.length, mask: true });
    let i = 0;
    const step = () => {
      if (i >= COLLS.length) {
        wx.hideLoading();
        this.setData({ cbBusy: false });
        this.refreshCloud();
        wx.showToast({ title: '已备份到云端', icon: 'none' });
        return;
      }
      api.cloudBackup('run', { coll: COLLS[i] }).then(r => {
        if (!r || !r.ok) {
          wx.hideLoading();
          this.setData({ cbBusy: false });
          wx.showToast({ title: (r && r.msg) || '备份失败', icon: 'none' });
          this.refreshCloud();
          return;
        }
        i++;
        wx.showLoading({ title: '备份中 ' + (i + 1) + '/' + COLLS.length, mask: true });
        step();
      }).catch(() => {
        wx.hideLoading();
        this.setData({ cbBusy: false });
        wx.showToast({ title: '网络不通，请重试', icon: 'none' });
      });
    };
    step();
  },

  clean() {
    if (!this.data.orphanCount) {
      wx.showToast({ title: '没有可清理的文件', icon: 'none' });
      return;
    }
    const n = this.data.orphanCount, s = this.data.orphanText;
    wx.showModal({
      title: '清理 ' + n + ' 个文件？',
      content: '这些照片/视频已经没有任何课堂记录引用（约 ' + s + '）。已保存的记录不受影响。',
      confirmText: '清理',
      confirmColor: theme.danger(),
      success: r => {
        if (!r.confirm) return;
        const res = media.prune(db.mediaRefs());
        this.refresh();
        wx.showToast({
          title: res.removed ? ('已释放 ' + size(res.bytes)) : '没有可清理的文件',
          icon: 'none'
        });
      }
    });
  }
});
