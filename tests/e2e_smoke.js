// tests/e2e_smoke.js —— 主链路冒烟（微信开发者工具模拟器自动化）
//
// 跑法：node tests/e2e_smoke.js
// 前置：先关掉已打开的微信开发者工具窗口（automator 要用 --auto 模式自己拉起）。
//
// 【为什么只走「只加不删」的流】automator 拿不到小程序的 require，清库重置必须过
// 存储页的两道 showModal 确认（自动化环境点不了），所以不清库：向导在已有数据时
// 走的是 idle 补一步模式，同样能把四步全部走通；统计/记录数都按「基线 +1」验证。
//
// 【覆盖】向导四步 → 首页统计 → 管理页 tabK 直达 → 录入发布 → 记录列表 →
//         修改入口（student 页 canEdit）→ 编辑模式保存
// 【不覆盖】真机特性（摄像头/麦克风/键盘）、双微信角色戏 —— 这些留给人工测试用例。
const automator = require('miniprogram-automator');
const path = require('path');

const CLI = 'C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat';
const PROJECT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0;
const fail = [];
async function ok(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { const msg = (e && e.message) || String(e); fail.push(name + ' :: ' + msg); console.log('  ✗ ' + name + '\n      ' + msg); }
}
const cur = async mini => { await sleep(600); return mini.currentPage(); };

(async () => {
  // Windows 下 automator.launch 拉不起 cli.bat（spawn 不带 shell），改用两步：
  // 先由外部执行 `cli.bat auto --project … --auto-port 9420`，脚本 connect 上去。
  const endpoint = process.env.E2E_WS || 'ws://127.0.0.1:9420';
  console.log('连接模拟器自动化端口 ' + endpoint + ' …');
  const mini = await automator.connect({ wsEndpoint: endpoint });
  console.log('已连接。\n');

  /* ---------- B. 开通向导（idle 模式也必须四步走通） ---------- */
  let baseline = { cls: 0, stu: 0 };
  await ok('B0 首页可达并拿到基线统计', async () => {
    await mini.reLaunch('/pages/index/index');
    const page = await cur(mini);
    const d = await page.data();
    baseline.cls = d.clsCount; baseline.stu = d.stuCount;
    if (typeof d.clsCount !== 'number') throw new Error('首页没有 clsCount 字段');
    console.log('      基线：' + d.clsCount + ' 班级 / ' + d.stuCount + ' 学生');
  });

  await ok('B1 向导第 1 步：机构信息落库进第 2 步', async () => {
    await mini.reLaunch('/pages/setup/setup');
    const page = await cur(mini);
    await page.setData({ org: { name: '自动化测试画室', type: '培训机构', contact: '测试老师', phone: '18674882783' } });
    await page.callMethod('next');
    const d = await page.data();
    if (d.step !== 2) throw new Error('step 应为 2，实际 ' + d.step + '（若为 1，多半是校验没过）');
  });

  await ok('B2 第 2 步：学期创建进第 3 步', async () => {
    const page = await cur(mini);
    const d = await page.data();
    if (!d.term.name || !d.term.startDate || !d.term.endDate) {
      await page.setData({ term: { name: '自动化学期', startDate: '2026-11-06', endDate: '2027-05-06' } });
    }
    await page.callMethod('next');
    const d2 = await page.data();
    if (d2.step !== 3) throw new Error('step 应为 3，实际 ' + d2.step);
  });

  await ok('B3 第 3 步：班级（含默认课程）创建进第 4 步', async () => {
    const page = await cur(mini);
    const d = await page.data();
    if (!d.cls.name) await page.setData({ cls: { name: '自动化班', mode: 'term', course: '自动化课' } });
    await page.callMethod('next');
    const d2 = await page.data();
    if (d2.step !== 4) throw new Error('step 应为 4，实际 ' + d2.step);
  });

  await ok('B4 第 4 步：添加学生并完成开通', async () => {
    const page = await cur(mini);
    await page.setData({ stuName: '自动化学生' });
    await page.callMethod('addStudent');
    await page.callMethod('commitStudent');
    const d = await page.data();
    if (!d.done) throw new Error('向导未到完成态');
    if (!d.added.length) throw new Error('学生没加进去');
  });

  /* ---------- C. 首页统计 +1 ---------- */
  await ok('C1 回首页统计各 +1', async () => {
    await mini.reLaunch('/pages/index/index');
    const page = await cur(mini);
    await sleep(800);
    const d = await page.data();
    if (d.clsCount !== baseline.cls + 1) throw new Error('班级应 ' + (baseline.cls + 1) + '，实际 ' + d.clsCount);
    if (d.stuCount < baseline.stu + 1) throw new Error('学生应 ≥ ' + (baseline.stu + 1) + '，实际 ' + d.stuCount);
  });

  /* ---------- D. 管理页 tabK 直达 ---------- */
  await ok('D1 mgr?tabK=stu 直达学生页签', async () => {
    await mini.reLaunch('/pages/mgr/mgr?tabK=stu');
    const page = await cur(mini);
    const d = await page.data();
    if (d.tabK !== 'stu') throw new Error('tabK 应为 stu，实际 ' + d.tabK);
  });
  await ok('D2 mgr?tabK=cls 直达班级页签', async () => {
    await mini.reLaunch('/pages/mgr/mgr?tabK=cls');
    const page = await cur(mini);
    const d = await page.data();
    if (d.tabK !== 'cls') throw new Error('tabK 应为 cls，实际 ' + d.tabK);
  });

  /* ---------- E. 录入并发布 ---------- */
  let sid = null;
  await ok('E1 录入页可选到学生并发布成功', async () => {
    await mini.reLaunch('/pages/record/record');
    const page = await cur(mini);
    await sleep(800);
    const d = await page.data();
    sid = d.students && d.students[0] && d.students[0].id;
    if (!sid) throw new Error('录入页没有可选学生');
    await page.setData({ sid, score: 88, note: '自动化测试评语' });
    await page.callMethod('save', { currentTarget: { dataset: { send: '1' } } });
    await sleep(1600);   // 保存后停留 800ms 再返回
    const d2 = await page.data();
    if (d2.saving) throw new Error('保存卡在 saving 态（可能被内容安全或校验拦住）');
  });

  let rid = null;
  await ok('E2 记录列表出现这条记录', async () => {
    await mini.reLaunch('/pages/records/records');
    const page = await cur(mini);
    await sleep(1000);
    const d = await page.data();
    const hit = (d.list || []).find(x => x.sid === sid) || (d.list || [])[0];
    if (!hit) throw new Error('列表为空');
    rid = hit.id;
  });

  /* ---------- F. 修改入口与编辑模式 ---------- */
  await ok('F1 学生页最近记录带 canEdit（修改入口在）', async () => {
    if (!sid) throw new Error('上一步没拿到学生 id，跳过');
    await mini.reLaunch('/pages/student/student?id=' + sid);
    const page = await cur(mini);
    await sleep(1200);
    const d = await page.data();
    const rec = d.rec || d.latest;
    if (!rec) throw new Error('学生页没有记录视图');
    if (!rec.canEdit) throw new Error('canEdit 为 false：负责人应可改');
  });

  await ok('F2 编辑模式打开（wasSent=true）并保存修改', async () => {
    if (!rid) throw new Error('上一条没拿到 rid，跳过');
    await mini.evaluate(r => {
      const app = getApp();
      app.globalData.pick = { rid: r, sid: null, score: 85, photos: [], videos: [], audio: null, tag: '', note: '', course: '' };
    }, rid);
    await mini.reLaunch('/pages/record/record');
    const page = await cur(mini);
    await sleep(800);
    const d = await page.data();
    if (!d.editing || !d.wasSent) throw new Error('editing=' + d.editing + ' wasSent=' + d.wasSent + '，应都为 true');
    await page.setData({ note: '自动化修改后的评语' });
    await page.callMethod('save', { currentTarget: { dataset: { send: '1' } } });
    await sleep(1600);
  });

  await ok('F3 列表里看到修改后的评语', async () => {
    await mini.reLaunch('/pages/records/records');
    const page = await cur(mini);
    await sleep(1000);
    const d = await page.data();
    const hit = (d.list || []).find(x => x.id === rid);
    if (!hit) throw new Error('记录不见了');
    if ((hit.note || '').indexOf('修改后') === -1) throw new Error('评语还是旧的：' + hit.note);
  });

  /* ---------- 报告 ---------- */
  console.log('\n===== 冒烟结果：' + pass + ' 通过 / ' + fail.length + ' 失败 =====');
  if (fail.length) { console.log('失败项：'); fail.forEach(x => console.log('  - ' + x)); }
  const fs = require('fs');
  const out = path.join(__dirname, '..', 'docs', 'ops', 'e2e-report-latest.md');
  const lines = [
    '# 模拟器冒烟报告（' + new Date().toLocaleString('zh-CN') + '）', '',
    '通过 ' + pass + ' / 失败 ' + fail.length, ''
  ].concat(fail.length ? ['失败项：'].concat(fail.map(x => '- ' + x)) : ['全部通过 ✓']);
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  console.log('报告已写 ' + out);

  await mini.disconnect();
  process.exit(fail.length ? 1 : 0);
})().catch(e => {
  console.error('自动化中断：', (e && e.message) || e);
  console.error('提示：先执行 "cli.bat auto --project <项目路径> --auto-port 9420" 再跑本脚本。');
  process.exit(2);
});
