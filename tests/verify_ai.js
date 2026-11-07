// tests/verify_ai.js —— AI 评：超时自动重试、真实错误不吞、云函数超时参数对齐
//
// 真机 2026-11-07 14:10：aiEval 云端超时仍停在 3 秒，GLM 识图要 5~10 秒，第一次几乎必被
// 微信掐断（-504003 time out），老师得连点两三次才出结果。这里钉死三件事：
//   ① 网络/超时失败自动补 2 次，一次点击就够；② 业务错误（NO_KEY 等）不白等重试；
//   ③ 失败必须带真实 errMsg，绝不吞成「网络不通」，还要给出改超时的一次性指引。
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

let mode = 'ok', calls = 0;
global.wx = {
  cloud: {
    init() {},
    callFunction(o) {
      calls++;
      if (mode === 'fail2' && calls <= 2) return o.fail({ errMsg: 'cloud.callFunction:fail -504003 time out' });
      if (mode === 'fail3') return o.fail({ errMsg: 'cloud.callFunction:fail -504003 time out' });
      if (mode === 'business') return o.success({ result: { ok: false, code: 'NO_KEY', msg: 'x' } });
      return o.success({ result: { ok: true, text: '生成好了' } });
    }
  },
  showLoading() {}, hideLoading() {}, showToast() {}, showModal() {}
};
process.env.CG_CLOUD = '1';
const api = require('../utils/api');
api.initCloud();

// 重试间隔 0.8s / 1.5s 在 Node 里会拖慢套件；运行时查找全局 setTimeout，这里压成 0ms
const realSetTimeout = global.setTimeout;
global.setTimeout = fn => realSetTimeout(fn, 0);
const reset = (m) => { mode = m; calls = 0; };

(async () => {
  console.log('\n【一次点击就够了：网络/超时自动重试】');
  reset('ok');
  let r = await api.aiEvalDraft({ imageBase64: 'ZmFrZQ==' });
  assert.strictEqual(r.text, '生成好了');
  assert.strictEqual(calls, 1, '一次就成功时不该有任何重试');
  console.log('  ✓ 首次成功：只调 1 次，不做无谓重试'); pass++;

  reset('fail2');
  const retries = [];
  r = await api.aiEvalDraft({ imageBase64: 'ZmFrZQ==' }, { onRetry: n => retries.push(n) });
  assert.strictEqual(r.text, '生成好了', '第 3 次要拿到结果');
  assert.strictEqual(calls, 3, '一共 1 + 自动补 2 次');
  assert.deepStrictEqual(retries, [1, 2], '进度回调要能报出第 2 / 第 3 次尝试');
  console.log('  ✓ 前两次超时：自动补 2 次成功，老师不用连点'); pass++;

  reset('business');
  r = await api.aiEvalDraft({ imageBase64: 'ZmFrZQ==' });
  assert.strictEqual(r.code, 'NO_KEY');
  assert.strictEqual(calls, 1, '业务错误重试也没用，别白等 2.3 秒');
  console.log('  ✓ 业务错误（NO_KEY）原样带回、不重试'); pass++;

  reset('fail3');
  let err = null;
  try { await api.aiEvalDraft({ imageBase64: 'ZmFrZQ==' }); } catch (e) { err = e; }
  assert.ok(err, '三次都失败要 reject，不能假装成功');
  assert.ok(/-504003|time out/.test(err.message), '真实 errMsg 要透出来：' + err.message);
  assert.ok(!/网络不通|请重试$/.test(err.message), '不许把错误吞成笼统的「网络不通」');
  assert.strictEqual(calls, 3);
  console.log('  ✓ 三次都失败：抛出真实 errMsg，不吞错'); pass++;

  global.setTimeout = realSetTimeout;

  console.log('\n【源码守卫：配置与指引不许被改回去】');
  const API = read('utils/api.js');
  const REC = read('pages/record/record.js');
  const CF = read('cloudfunctions/aiEval/index.js');
  const CFG = JSON.parse(read('cloudfunctions/aiEval/config.json'));

  ok('aiEvalDraft 只对调用失败重试，业务 result 原样 resolve', () => {
    const body = API.slice(API.indexOf('function aiEvalDraft'), API.indexOf('// 学生批量导入云函数'));
    assert.ok(/attempt\s*\(0\)/.test(body));
    assert.ok(/800/.test(body) && /1500/.test(body), '退避间隔 0.8s / 1.5s');
    assert.ok(/success:\s*r\s*=>\s*resolve/.test(body), 'success 不走 catch，业务错误不重试');
    assert.ok(/if\s*\(n\s*>=\s*2\)\s*throw e/.test(body), '最多补两次，不能无限重试');
    assert.ok(/onRetry/.test(body), '要能把重试进度回调给页面');
  });
  ok('录入页显示重试进度，超时弹窗给出「把 aiEval 改 20 秒」的一次性指引', () => {
    assert.ok(/AI 识图中，约需几秒/.test(REC), '一开始就说清要等，别让人以为没反应');
    assert.ok(/onRetry:\s*n\s*=>/.test(REC));
    assert.ok(/const timeout\s*=/.test(REC) && /-504003/.test(REC) && /timeout/.test(REC),
      '要认得出微信的 -504003 / time out');
    assert.ok(/showModal/.test(REC) && /20 秒/.test(REC) && /aiEval/.test(REC));
    assert.ok(/m\.slice\(0,\s*120\)/.test(REC), '弹窗里要带真实错误原文');
    assert.ok(/已自动重试 2 次/.test(REC));
  });
  ok('云函数内部超时 < 控制台超时，失败时能返回明确错误而不是被微信掐断', () => {
    assert.strictEqual(CFG.timeout, 20, 'config.json 记录目标超时 20 秒（CLI 不应用，仅文档化）');
    const ms = Number((CF.match(/const TIMEOUT_MS\s*=\s*(\d+)/) || [])[1]);
    assert.ok(ms > 0 && ms < CFG.timeout * 1000, 'GLM 超时 ' + ms + 'ms 必须小于函数超时 ' + CFG.timeout + 's');
    assert.ok(/timeout:\s*TIMEOUT_MS/.test(CF), '请求要带超时，不能无限挂着');
  });
  ok('批量评语也走同一个 aiEvalDraft，自动重试对它同样生效', () => {
    const b = read('pages/batch/batch.js');
    assert.ok(/api\.aiEvalDraft\(\{\s*action:\s*'batch'/.test(b));
    assert.ok(/\.catch\(/.test(b), '三次都失败时批量页要有兜底');
  });

  console.log('\n全部 ' + pass + ' 项 AI 评断言通过');
})().catch(e => {
  global.setTimeout = realSetTimeout;
  console.error('AI 评断言失败:', (e && e.message) || e);
  process.exit(1);
});
