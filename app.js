const db = require('./utils/db');
const api = require('./utils/api');

App({
  onLaunch() {
    // 主数据层：加载 → 迁移老数据 → 规范化 → 演示数据 → 引用自愈
    db.init();
    // 云开发：未认证前是空实现，pull 直接返回 null，不影响本地使用
    api.initCloud();
    api.pull().then(remote => { if (remote) db.merge(remote); }).catch(() => {});
  },
  globalData: { pick: null }
});
