const db = require('./utils/db');
const api = require('./utils/api');
const theme = require('./utils/theme');

App({
  onLaunch() {
    // 主题：读回用户上次选的皮肤（图标模块同步 + 导航栏/tabBar 配色）
    theme.init();

    // 全局错误捕获：真机上任何未捕获异常都会弹出来并可复制，
    // 避免"点了没反应/闪退却拿不到报错"的排查黑盒
    this.setupErrorTrap();

    // 主数据层：加载 → 迁移老数据 → 规范化 → 演示数据 → 引用自愈
    // init 内部有兜底：读盘失败时降级为只读，不会抛错也不会覆盖磁盘上的数据
    db.init();
    this.reportBoot();

    // 云开发：未认证前是空实现，pull 直接返回 null，不影响本地使用
    try { api.initCloud(); } catch (e) { console.warn('[app] 云开发初始化失败', e); }
    try {
      api.pull().then(remote => { if (remote) db.merge(remote); }).catch(() => {});
    } catch (e) { /* 未接云端时静默 */ }
  },

  // 启动异常时明确告知用户当前是只读，避免他以为"保存成功了"其实没落盘
  reportBoot() {
    const st = db.status();
    this.globalData.bootStatus = st;
    if (!st.degraded) return;
    wx.showModal({
      title: '数据读取异常',
      content: '本地数据加载失败，当前为只读模式，原有数据没有被改动。请重启小程序后重试。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  // 错误陷阱：逻辑层未捕获异常 / 未处理的 Promise 拒绝 → 弹窗展示 + 自动复制到剪贴板。
  // 同一分钟内只弹一次，错误全文落盘（cg_last_error），开发调试时可从 vConsole 查看。
  setupErrorTrap() {
    const report = (kind, msg) => {
      const text = '[' + kind + '] ' + msg;
      console.error('[error-trap]', text);
      try {
        wx.setStorageSync('cg_last_error', { at: Date.now(), text: String(text).slice(0, 2000) });
        wx.setClipboardData({ data: String(text).slice(0, 500), fail: () => {} });
      } catch (e) { /* 落盘失败不再抛 */ }
      const now = Date.now();
      if (this._lastErrAt && now - this._lastErrAt < 60 * 1000) return;
      this._lastErrAt = now;
      wx.showModal({
        title: '程序出现异常（已自动复制错误）',
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

  globalData: { pick: null, bootStatus: null }
});
