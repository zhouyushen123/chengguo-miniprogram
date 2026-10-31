const store = require('./utils/store');
const api = require('./utils/api');

App({
  onLaunch() {
    store.init();
    // 云开发：启动时拉取云端记录并按 id 合并（云开发模式下线上读写自动生效）
    api.initCloud();
    api.pull().then(remote => {
      if (!remote) return;
      const db = store.get();
      const byId = {};
      db.records.forEach(r => { byId[r.id] = r; });
      (remote.records || []).forEach(r => {
        if (!byId[r.id] || (r.updatedAt || 0) > (byId[r.id].updatedAt || 0)) byId[r.id] = r;
      });
      db.records = Object.values(byId);
      (remote.profiles || []).forEach(p => {
        const s = db.students.find(x => x.id === p.sid);
        if (s && p.profile) s.profile = p.profile;
      });
      store.save();
    }).catch(() => {});
  },
  globalData: { pick: null }
});
