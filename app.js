const db = require('./utils/db');
const api = require('./utils/api');
const sync = require('./utils/sync');
const theme = require('./utils/theme');
const dailybackup = require('./utils/dailybackup');

App({
  onLaunch() {
    // 主题：读回用户上次选的皮肤（图标模块同步 + 导航栏/tabBar 配色）
    theme.init();

    // 全局错误捕获：真机上任何未捕获异常都会弹出来并可复制，
    // 避免"点了没反应/闪退却拿不到报错"的排查黑盒
    this.setupErrorTrap();

    // 主数据层：加载 → 迁移老数据 → 规范化 → 演示数据包（独立命名空间）→ 引用自愈
    // init 内部有兜底：读盘失败时降级为只读，不会抛错也不会覆盖磁盘上的数据
    db.init();
    this.reportBoot();

    // 云开发：绑定机构 → 拉增量合并 → 推本地脏数据（云未通/未部署时全部静默降级）
    try { api.initCloud(); } catch (e) { console.warn('[app] 云开发初始化失败', e); }
    // 【为什么要留痕】以前这里失败是全静默的：同步没跑起来，页面照常能用，只是云端永远空着。
    // 现场只能靠"本机有 7 条、云端 0 条"来反推，排查成本极高。现在把结果记进 globalData
    // （控制台里 getApp().globalData.syncBoot 能直接看），并在失败时打一条 warn。
    this.globalData.syncBoot = null;
    this.globalData.syncLast = null;
    try {
      sync.init().then(r => {
        this.globalData.syncBoot = r || null;
        if (!r || !r.ok) { console.warn('[app] 同步未启动', r); return null; }
        return sync.kick();
      }).then(x => { this.globalData.syncLast = x || null; })
        .catch(e => {
          this.globalData.syncBoot = { ok: false, msg: (e && e.message) || String(e) };
          console.warn('[app] 同步启动异常', e);
        });
    } catch (e) { console.warn('[app] 同步启动异常', e); }

    // 断网恢复后立刻补推：离线时录的东西会一直躺在"待上传"里，
    // 以前只能等下次打开小程序、或者用户自己去存储页点「立即同步」。
    this.watchNetwork();
  },

  // 网络恢复 → 马上把积压的推上去（只推不拉，快）。低版本没有这个 API 就跳过，
  // 其余三条兜底（写后 1.5s、失败退避重试、前后台切换）仍然在。
  watchNetwork() {
    try {
      wx.onNetworkStatusChange(res => {
        if (!res || !res.isConnected) return;
        try { api.initCloud(); } catch (e) { /* 云初始化失败就走本地 */ }
        Promise.resolve(sync.flush()).then(x => { this.globalData.syncLast = x || null; })
          .catch(() => { /* 推不上去由退避重试接着试 */ });
      });
    } catch (e) { /* 无此 API 不影响其他路径 */ }
  },

  // 切后台是"人要走"的时刻，最后补一刀。手机切后台后进程可能很快被回收，
  // 没推上去的要等下次打开——能在能推的时候推，就别留给"下次"。
  onHide() {
    try { Promise.resolve(sync.flush()).catch(() => {}); } catch (e) { /* 同步不可用不影响使用 */ }
  },

  // 回到前台时补一轮同步（节流 20s，失败静默）
  onShow() {
    try {
      Promise.resolve(sync.kick()).then(x => { this.globalData.syncLast = x || null; });
    } catch (e) { /* 同步不可用不影响使用 */ }

    // 每日云端备份：定时触发器要人去控制台点一次才生效，这条路径不需要任何配置——
    // 负责人/管理员当天第一次打开小程序就静默补一次（延迟 10 秒、每天一次、不 popup）。
    this.globalData.backupLast = null;
    try {
      dailybackup.maybe().then(r => { this.globalData.backupLast = r || null; })
        .catch(() => { /* 备份失败不影响使用，下次前台再试 */ });
    } catch (e) { /* 备份不可用不影响使用 */ }
  },

  // 启动异常时明确告知用户当前是只读，避免他以为"保存成功了"其实没落盘
  reportBoot() {
    const st = db.status();
    this.globalData.bootStatus = st;
    // 从本地快照恢复过：必须告诉用户"数据回到了几点"，不能悄悄替换掉他刚才看到的内容
    if (st.restored) {
      const d = new Date(Number(st.restored.at) || 0);
      const p = x => (x < 10 ? '0' + x : '' + x);
      const when = d.getMonth() + 1 + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      wx.showModal({
        title: '已从备份恢复',
        content: '这次启动发现本机数据读取出错（' + st.restored.bad + '），已自动恢复到 ' + when + ' 的备份，'
          + '随后会与云端重新对齐。备份之后新录的内容，云端有的会补回来。',
        showCancel: false,
        confirmText: '知道了'
      });
      return;
    }
    if (!st.degraded) return;
    wx.showModal({
      title: '数据读取异常',
      content: '本地数据加载失败，当前为只读模式，原有数据没有被改动。请重启小程序后重试。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  // 错误陷阱：逻辑层未捕获异常 / 未处理的 Promise 拒绝 → 弹窗展示 + 错误全文落盘（cg_last_error）。
  // 同一分钟内只弹一次，开发调试时可从 vConsole 查看。
  // 【不要静默覆盖剪贴板】用户可能刚复制了微信号/地址准备粘贴，被一段堆栈冲掉是真实的伤害。
  // 所以只在非正式版（开发/体验）自动复制；正式版把错误留在「关于 · 最近错误」里，要复制由用户自己点。
  setupErrorTrap() {
    const isRelease = (() => {
      try { return wx.getAccountInfoSync().miniProgram.envVersion === 'release'; } catch (e) { return true; }
    })();
    const report = (kind, msg) => {
      const text = '[' + kind + '] ' + msg;
      console.error('[error-trap]', text);
      try {
        wx.setStorageSync('cg_last_error', { at: Date.now(), text: String(text).slice(0, 2000) });
        if (!isRelease) wx.setClipboardData({ data: String(text).slice(0, 500), fail: () => {} });
      } catch (e) { /* 落盘失败不再抛 */ }
      const now = Date.now();
      if (this._lastErrAt && now - this._lastErrAt < 60 * 1000) return;
      this._lastErrAt = now;
      wx.showModal({
        title: isRelease ? '程序出现异常' : '程序出现异常（已自动复制错误）',
        content: String(msg).slice(0, 300) || '未知错误',
        confirmText: '知道了',
        showCancel: false
      });
    };
    try { wx.onUnhandledRejection && wx.onUnhandledRejection(r => report('rejection', (r && r.reason && (r.reason.message || r.reason)) || '未处理的 Promise 拒绝')); } catch (e) { /* 低版本无此 API */ }
    this._report = report;
  },

  onError(msg) {
    if (this._report) this._report('error', msg);
  },

  globalData: { pick: null, bootStatus: null, syncBoot: null, syncLast: null, backupLast: null }
});
