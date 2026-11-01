const db = require('./utils/db');
const api = require('./utils/api');

App({
  onLaunch() {
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

  globalData: { pick: null, bootStatus: null }
});
