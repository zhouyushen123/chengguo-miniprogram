// tests/verify_layout.js —— 管理页左右对齐基线：所有内容外框统一 24rpx
//
// 真机 2026-11-07 截图：人员页签「全部 / 老师 / 家长」筛选胶囊和下面那行说明文字
// 贴着屏幕左边（0 / 4rpx），而顶部页签、成员卡片、底部双按钮都是 24rpx，
// 看起来像整块内容歪了。这套断言钉死统一基线，并防止以后新增元素再次裸奔。
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

const WXML = read('pages/mgr/mgr.wxml');
const WXSS = read('pages/mgr/mgr.wxss');
const APP = read('app.wxss');

// 把 wxml 里的 <view> 解析成带父节点的树，用来判断「谁在卡片里、谁贴在页面上」
function viewTree(src) {
  const clean = src.replace(/<!--[\s\S]*?-->/g, '');
  const re = /<(\/?)view\b[^>]*>/g;
  const stack = [], nodes = [];
  let m;
  while ((m = re.exec(clean))) {
    if (m[1] === '/') { stack.pop(); continue; }
    const node = { tag: m[0], parent: stack[stack.length - 1] || null };
    nodes.push(node);
    if (!/\/>$/.test(node.tag)) stack.push(node);
  }
  return nodes;
}
const nodes = viewTree(WXML);
const wrapNodes = nodes.filter(n => /class="wrap/.test(n.tag));
const topOfWrap = nodes.filter(n => wrapNodes.some(w => n.parent === w));
const ancestors = n => { const a = []; for (let p = n.parent; p; p = p.parent) a.push(p); return a; };

console.log('\n【统一基线：页签 / 卡片 / 底部按钮都是 24rpx】');
ok('.pagepad 只设左右 24rpx，不覆盖元素自己的上下间距', () => {
  const m = WXSS.match(/\.pagepad\s*\{([^}]*)\}/);
  assert.ok(m, 'mgr.wxss 里要有 .pagepad 定义');
  assert.ok(/margin-left:\s*24rpx/.test(m[1]));
  assert.ok(/margin-right:\s*24rpx/.test(m[1]));
  assert.ok(!/\bmargin\s*:/.test(m[1]), '不许写 margin 简写（会冲掉元素自己的上下间距）');
});
ok('页签 / 卡片 / 底部固定栏的左右边距都是 24rpx', () => {
  assert.ok(/\.tabs\s*\{[^}]*margin:\s*20rpx 24rpx 24rpx/.test(WXSS));
  assert.ok(/\.card\s*\{[^}]*margin:\s*0 24rpx 24rpx/.test(APP));
  assert.ok(/\.stufab\s*\{[\s\S]{0,160}padding:\s*16rpx 24rpx/.test(WXSS));
  assert.ok(/\.clsfab\s*\{[\s\S]{0,160}padding:\s*16rpx 24rpx/.test(WXSS));
});

console.log('\n【人员页签：筛选按钮与说明文字不再贴边】');
ok('「全部 / 老师 / 家长」筛选胶囊带 pagepad', () => {
  const n = nodes.find(x => /class="gswitch/.test(x.tag) && /pagepad/.test(x.tag));
  assert.ok(n, '筛选胶囊要用 .pagepad');
  assert.ok(wrapNodes.some(w => n.parent === w), '它确实直接挂在页面容器上（不是卡片里）');
});
ok('说明文字带 pagepad，且不再用 4rpx 的贴边 margin', () => {
  assert.ok(/老师只能看到并录入自己负责班级的成果/.test(WXML));
  const line = WXML.split('\n').find(l => /老师只能看到并录入自己负责班级的成果/.test(l));
  assert.ok(/class="mi pagepad"/.test(line));
  assert.ok(/style="margin-top:16rpx"/.test(line), '只写 margin-top，别用 margin 简写把左右冲掉');
  assert.ok(!/margin:\s*16rpx 4rpx 0/.test(WXML), '旧的 4rpx 贴边写法不许回来');
});
ok('机构页保存按钮也按同一基线对齐（只留上下间距）', () => {
  const line = WXML.split('\n').find(l => /保存机构资料/.test(l));
  assert.ok(/class="btn orgsave pagepad"/.test(line));
  assert.ok(/\.orgsave\s*\{[^}]*margin-top:\s*28rpx[^}]*margin-bottom:\s*44rpx/.test(WXSS));
});

console.log('\n【守卫：以后新增元素不许再裸奔】');
ok('五个页签的顶层元素，要么自带内边距，要么必须带 pagepad', () => {
  assert.strictEqual(wrapNodes.length, 5, '机构 / 班级 / 课程 / 学生 / 人员');
  const selfPadded = /class="[^"]*(card|empty|stufilter|mask|sheet)/;
  const bare = topOfWrap.filter(n => !selfPadded.test(n.tag) && !/pagepad/.test(n.tag));
  assert.strictEqual(bare.length, 0, '贴边元素：' + bare.map(n => n.tag.slice(0, 80)).join(' | '));
});
ok('选择班级的多选 chips 都在卡片 / 弹层里，与上方标题共用内边距', () => {
  const keys = ['courseClsChips', 'crsBind.chips', 'userClsChips'];
  for (const k of keys) {
    const n = nodes.find(x => x.tag.indexOf(k) > -1);
    assert.ok(n, '要能找到 ' + k + ' 的 chips');
    const chain = [n].concat(ancestors(n)).map(x => x.tag).join(' ');
    assert.ok(/class="card|class="sheet/.test(chain), k + ' 必须落在 .card / .sheet 内：' + chain.slice(0, 120));
  }
});

console.log('\n全部 ' + pass + ' 项布局对齐断言通过');
