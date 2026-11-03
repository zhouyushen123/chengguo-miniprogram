// tests/fixture.js —— 测试共用夹具
//
// 演示数据现在住在独立的存储命名空间里（chengguo_demo_*），真实库不该自带演示行。
// 但页面级与流程级测试需要一份"有内容"的真实库 —— 这里用演示数据集造一份，
// 并去掉 demo 标记，等价于"这位老师自己把这些学生和记录录进了自己的机构"。
const COLLS = ['orgs', 'members', 'terms', 'classes', 'courses', 'students', 'enrollments', 'records', 'users', 'templates'];

function richSeed() {
  const built = require('../utils/db/maintenance').buildDemoData();
  const meta = Object.assign({}, built.meta, {
    orgName: '我的机构', sandbox: false, createdAt: 1000, updatedAt: 1000
  });
  delete meta.demoVersion;
  const seed = { chengguo_v3_meta: meta };
  COLLS.forEach(n => {
    const list = (built[n] || []).map(x => {
      const y = Object.assign({}, x);
      delete y.demo;
      if (n === 'orgs') y.name = '我的机构';
      return y;
    });
    seed['chengguo_v3_' + n] = JSON.parse(JSON.stringify(list));
  });
  return seed;
}

module.exports = { richSeed, COLLS };
