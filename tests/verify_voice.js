// tests/verify_voice.js —— 语音输入：识别结果不重复累积 + 全站麦克风覆盖
//
// 真机 2026-11-07：课堂评价的语音录入把每一次 onRecognize 回调都换行追加到输入框，
// 而插件回调给的是「截至此刻的累计全文」，于是一句话被叠成 8 行越来越长的重复评语。
// 这套断言钉死两件事：① 识别结果只能整体替换；② 所有要打字的输入框都得有统一麦克风。
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

const stt = require('../utils/stt');
const voice = require('../utils/voice');

console.log('\n【识别结果：全文替换，不许累积】');
ok('插件的连续中间结果只会得到最终一句，不会越叠越长', () => {
  let full = '';
  ['很不错哦', '很不错哦整体的表', '很不错哦整体的表现很丰富',
    '很不错，整体的表现很丰富', '很不错，整体的表现很丰富']
    .forEach(t => { full = stt.mergeText(full, t); });
  assert.strictEqual(full, '很不错，整体的表现很丰富');
  assert.ok(full.length < 20, '结果不该把 5 次回调都拼进去');
});
ok('onStop 回空 / 回旧片段时保留已识别的全文', () => {
  const f = '很不错，整体的表现很丰富';
  assert.strictEqual(stt.mergeText(f, ''), f);
  assert.strictEqual(stt.mergeText(f, '很不错哦'), f);
  assert.strictEqual(stt.mergeText(f, '整体的表现很丰富'), f);
});
ok('stt 的 onPartial / onDone 都只吐全文（合约写在源码里）', () => {
  const src = read('utils/stt.js');
  assert.ok(/mergeText/.test(src));
  assert.ok(/mgr\.onRecognize[\s\S]{0,120}take\(r\)/.test(src));
  assert.ok(/mgr\.onStop[\s\S]{0,120}take\(r\)/.test(src));
  assert.ok(!/text\s*\+\s*\(r\.result/.test(src), '不该再把 result 拼到旧变量上');
});
ok('课堂评价麦克风：底稿 + 全文替换，不再逐次往 note 追加换行', () => {
  const src = read('pages/record/record.js');
  const body = src.slice(src.indexOf('toggleRec()'), src.indexOf('// 播放语音'));
  assert.ok(/const base =/.test(body), '要记住开录前的底稿');
  assert.ok(/const join =/.test(body), '要用同一个拼接函数做整体替换');
  assert.ok(!/this\.data\.note[^\n]*\+ '\\n'/.test(body), '不得再把中间结果追加到 note 后面');
  assert.ok(/if \(this\._leaving\) return;/.test(body), '页面卸载后回调不能继续 setData');
});
ok('输入框语音：读值支持 rows[0].note 这类数组路径', () => {
  const page = { data: { rows: [{ note: '很好' }, { note: '' }], form: { name: '张三' } } };
  assert.strictEqual(voice.current(page, 'rows[0].note'), '很好');
  assert.strictEqual(voice.current(page, 'rows[1].note'), '');
  assert.strictEqual(voice.current(page, 'form.name'), '张三');
  assert.strictEqual(voice.current(page, 'form.none'), '');
});
ok('输入框语音：已有文字与识别结果之间有分隔，仍然只替换一次', () => {
  const src = read('utils/voice.js');
  assert.ok(/const glue =/.test(src));
  assert.ok(/base \+ glue \+ t/.test(src));
  assert.ok(!/page\.setData\(\{ \[key\]: this\.data/.test(src), '不许按当前值追加');
});

console.log('\n【全站覆盖：自由文本输入框都配麦克风】');
// 格式化字段不配语音：数字手机号、学号、邀请码、生日/日期。语音识别出的是自然中文，
// 念一遍也得不到合法格式，配了只会制造废数据（utils/voice.js 开头的范围约定）。
const EXEMPT = /(birth|phone|code|invite|stuNo|BindNo|startDate|endDate|date)/i;
const PAGE_DIR = path.join(ROOT, 'pages');
const files = fs.readdirSync(PAGE_DIR).filter(d => fs.existsSync(path.join(PAGE_DIR, d, d + '.wxml')));

ok('每个自由文本输入框都有麦克风（数量守恒，新增输入框漏配即失败）', () => {
  files.forEach(d => {
    const s = read('pages/' + d + '/' + d + '.wxml');
    const inputs = (s.match(/<(?:input|textarea)\b[\s\S]*?\/>/g) || [])
      .filter(tag => !/type="number"/.test(tag) && !EXEMPT.test(tag));
    const mics = (s.match(/class="(?:vmic|smic)\b|class="micbtn\b/g) || []).length;
    assert.ok(mics >= inputs.length,
      d + '.wxml：' + inputs.length + ' 个自由文本输入框，只有 ' + mics + ' 枚麦克风');
  });
});
ok('所有小麦克风都在录音态换成白图标（不能靠 filter 把圆钮背景也变白）', () => {
  files.forEach(d => {
    const s = read('pages/' + d + '/' + d + '.wxml');
    (s.match(/<image class="(?:vmic|smic)[^>]*>/g) || []).forEach(tag => {
      assert.ok(/icoWhite/.test(tag) && /icoMic/.test(tag),
        d + '.wxml 有麦克风没切白图标：' + tag.slice(0, 90));
    });
  });
  const css = read('app.wxss');
  assert.ok(!/filter:\s*brightness\(0\)\s*invert\(1\)/.test(css), 'filter 会把整颗圆钮刷白');
});
ok('视觉与交互统一在 app.wxss，页面不再各写一套圆形麦克风', () => {
  const css = read('app.wxss');
  [/\.vin \.vmic, \.smic\s*\{/, /\.micbtn\s*\{/, /@keyframes micscale/, /:active/].forEach(re =>
    assert.ok(re.test(css), 'app.wxss 缺少 ' + re));
  assert.ok(!/\.micbtn\s*\{/.test(read('pages/record/record.wxss')), '录入页不该再重复定义 .micbtn');
});
ok('新接入的页面都接了 onMic，并在离开页面时关掉麦克风', () => {
  ['setup', 'batch', 'join'].forEach(d => {
    const src = read('pages/' + d + '/' + d + '.js');
    assert.ok(/onMic\(e\)\s*\{\s*voice\.dictate/.test(src), d + ' 缺 onMic');
    assert.ok(/onHide\(\)[\s\S]{0,120}voice\.stop\(this\)/.test(src), d + ' 缺 onHide 停录');
  });
});

console.log('\n全部 ' + pass + ' 项语音输入断言通过');
