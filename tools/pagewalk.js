// tools/pagewalk.js — 页面代码级走查（QA 辅助，不改业务代码）
// 检查项：
//   1. WXML {{ }} 里引用的顶层变量在 JS data/setData 里存在（wx:for 的 item/index 除外）
//   2. WXML bind/catch 事件函数在 JS 里有定义
//   3. JS 跳转 url 的页面在 app.json 已注册
//   4. setData 调用次数（>20 提示性能关注）
//   5. WXML 组件标签在 usingComponents（组件级，宽松提示）
// 用法：node tools/pagewalk.js  → 退出码 0=无硬伤，1=有硬伤
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const REG_PAGES = new Set(appJson.pages);
(appJson.subPackages || []).forEach(sp => sp.pages.forEach(p => REG_PAGES.add(sp.root + '/' + p)));
const GLOBAL_COMPS = Object.keys(appJson.usingComponents || {});

function listPages() {
  const out = [];
  appJson.pages.forEach(p => out.push({ rel: p, dir: path.join(ROOT, path.dirname(p)), name: path.basename(p) }));
  (appJson.subPackages || []).forEach(sp => sp.pages.forEach(p =>
    out.push({ rel: sp.root + '/' + p, dir: path.join(ROOT, sp.root, path.dirname(p)), name: path.basename(p) })));
  return out;
}

// ---- WXML 解析 ----
function walkWxml(wxml, pageComps) {
  const vars = new Set();      // {{ }} 顶层标识符
  const handlers = new Set();  // 事件函数名
  const comps = new Set();     // 自定义组件标签
  const LOOP_VARS = new Set(); // wx:for item/index 别名
  const hard = [];
  // 收集 wx:for 别名（含 wx:for-item / wx:for-index）
  const forRe = /wx:for(?:-item|-index)?\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = forRe.exec(wxml))) {
    const v = m[1].trim();
    if (v && !/^\{\{/.test(v)) LOOP_VARS.add(v);
  }
  // {{ }} 表达式：先剔除字符串字面量（{{x?'on':'off'}} 的 on 不是变量），
  // 只取点链/下标访问的首段标识符；<template data="{{...}}"> 传参键计入本地作用域
  const tplScope = new Set();
  const tplRe = /<template[^>]*data\s*=\s*"\{\{([^}]*)\}\}"/g;
  while ((m = tplRe.exec(wxml))) {
    (m[1].match(/([A-Za-z_$][\w$]*)\s*:/g) || []).forEach(k =>
      tplScope.add(k.replace(/[\s:]+$/, '')));
  }
  const exRe = /\{\{([^}]*)\}\}/g;
  while ((m = exRe.exec(wxml))) {
    const expr = m[1].replace(/'[^']*'|"[^"]*"/g, ' ');
    const chainRe = /([A-Za-z_$][\w$]*)(?:\.[\w$]+|\[[^\]]*\])*/g;
    let c;
    while ((c = chainRe.exec(expr))) {
      const id = c[1];
      if (['true', 'false', 'null', 'undefined', 'item', 'index'].indexOf(id) < 0
        && !LOOP_VARS.has(id) && !tplScope.has(id)) vars.add(id);
    }
  }
  // 事件绑定
  const evRe = /(?:bind|catch)[a-z:]*\s*=\s*"([\w$]+)"/g;
  while ((m = evRe.exec(wxml))) handlers.add(m[1]);
  // 标签（自定义组件：带连字符的标签或驼峰且非内置）
  const BUILTIN = ['view','text','image','button','input','textarea','scroll-view','swiper','swiper-item','navigator','block','checkbox','radio','switch','slider','picker','picker-view','picker-view-column','form','label','canvas','map','video','audio','camera','live-player','live-pusher','rich-text','progress','movable-view','movable-area','cover-view','cover-image','icon','page-container','root-portal','match-media','functional-page-navigator','page-meta','keyboard-accessory','editor','web-view','ad','official-account','open-data','template','import','include','slot','wxs'];
  const tagRe = /<([A-Za-z][\w-]*)/g;
  while ((m = tagRe.exec(wxml))) {
    const t = m[1];
    if (BUILTIN.indexOf(t) < 0) comps.add(t);
  }
  void pageComps;
  return { vars, handlers, comps, LOOP_VARS };
}

// ---- JS 解析 ----
function walkJs(js) {
  // data 字面量第一层键 + setData({k:..}) 与 setData('k',..)
  const dataKeys = new Set();
  const setDataKeys = new Set();
  let setDataCount = 0;
  // data 字面量：找 'data: {' 后括号配平截取
  let dBlock = '';
  const dRe = /(?:^|[,{\n])\s*data\s*:\s*\{/g;
  let dm;
  if ((dm = dRe.exec(js))) {
    const brace = dm.index + dm[0].length - 1;
    let depth = 0;
    for (let j = brace; j < js.length; j++) {
      const ch = js[j];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (!depth) { dBlock = js.slice(brace + 1, j); break; } }
    }
  }
  if (dBlock) {
    (dBlock.match(/(?:^|[{,\n])\s*(?:'([^']+)'|\"([^\"]+)\"|[A-Za-z_$][\w$]*)\s*:/g) || []).forEach(k => {
      const s = k.replace(/^[{,\s'\"]+/, '').replace(/[\s'":]+$/, '');
      if (s) dataKeys.add(s);
    });
  }
  const sdRe = /setData\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
  let m;
  while ((m = sdRe.exec(js))) {
    setDataCount++;
    (m[1].match(/(?:^|,)\s*(?:'([^']+)'|"([^"]+)"|[A-Za-z_$][\w$]*)\s*:/g) || []).forEach(k => {
      const s = k.replace(/^[,\s'"]+/, '').replace(/[\s'":]+$/, '');
      if (s) setDataKeys.add(s);
    });
  }
  const sd2 = /setData\s*\(\s*['"]([^'"]+)['"]/g;
  while ((m = sd2.exec(js))) { setDataCount++; setDataKeys.add(m[1]); }
  // 已定义函数（含对象方法、箭头函数赋值）
  const fns = new Set();
  const fnRe = /(?:^|\n)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(|(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s+)?\(?function|([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g;
  while ((m = fnRe.exec(js))) {
    [m[1], m[2], m[3]].forEach(x => { if (x) fns.add(x); });
  }
  // 跳转 url
  const navs = [];
  const navRe = /(navigateTo|redirectTo|switchTab|reLaunch|navigateBack)\s*\(\s*\{\s*url\s*:\s*['"`]([^'"`]+)['"`]/g;
  while ((m = navRe.exec(js))) navs.push(m[2]);
  const navRe2 = /url\s*:\s*['"`](\/(?:pages|pkg-low)\/[^'"`?]+)['"`]/g;
  while ((m = navRe2.exec(js))) navs.push(m[1]);
  return { dataKeys, setDataKeys, setDataCount, fns, navs };
}

function checkUrl(u) {
  if (!u.startsWith('/')) return true; // 相对/动态拼接，宽松放过
  const p = u.split('?')[0].replace(/^\//, '');
  return REG_PAGES.has(p);
}

const pages = listPages();
// 共享注入白名单：theme/icons/voice 等工具模块往页面 setData 的键（含 icons.std() 图标包）
const INJECTED = new Set();
['utils/theme.js', 'utils/icons.js', 'utils/voice.js'].forEach(f => {
  try {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    (src.match(/(?:^|[{,\n])\s*([A-Za-z_$][\w$]*)\s*:/g) || []).forEach(k => {
      const s = k.replace(/^[{,\s]+/, '').replace(/[\s:]+$/, '');
      if (s) INJECTED.add(s);
    });
  } catch (e) { /* 无此文件则跳过 */ }
});
const findings = [];
pages.forEach(pg => {
  const wxml = fs.readFileSync(path.join(pg.dir, pg.name + '.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(pg.dir, pg.name + '.js'), 'utf8');
  const json = JSON.parse(fs.readFileSync(path.join(pg.dir, pg.name + '.json'), 'utf8').replace(/\/\/[^\n]*/g, ''));
  const pageComps = Object.keys(json.usingComponents || {});
  const W = walkWxml(wxml, pageComps);
  const J = walkJs(js);

  // 1. 绑定变量：页面 data/setData、共享注入、以及「页面 JS 中任何地方提到过」都不算缺失
  //    （动态键如 voice 的 [key] 路径、模板 data 传参只能靠提及匹配兑底，宁漏报不误报）
  const known = new Set([...J.dataKeys, ...J.setDataKeys, 'wx']);
  W.vars.forEach(v => {
    if (known.has(v) || INJECTED.has(v)) return;
    if (!new RegExp('\\b' + v.replace(/\$/g, '\\$') + '\\b').test(js))
      findings.push({ page: pg.rel, type: '绑定变量缺失', detail: `{{${v}}} 不在 data/setData/共享注入中，且页面 JS 全文未提及` });
  });
  // 2. 事件函数
  W.handlers.forEach(h => {
    if (!J.fns.has(h)) findings.push({ page: pg.rel, type: '事件函数缺失', detail: `绑定 ${h}() 在 JS 中未定义` });
  });
  // 3. 跳转
  const uniqNavs = [...new Set(J.navs)];
  uniqNavs.forEach(u => {
    if (!checkUrl(u)) findings.push({ page: pg.rel, type: '跳转未注册', detail: `${u} 不在 app.json` });
  });
  // 4. setData 量级
  if (J.setDataCount > 20) findings.push({ page: pg.rel, type: 'setData 过多', detail: `${J.setDataCount} 处 setData，建议关注批量合并` });
  // 5. 组件
  [...W.comps].forEach(c => {
    if (pageComps.indexOf(c) < 0 && GLOBAL_COMPS.indexOf(c) < 0)
      findings.push({ page: pg.rel, type: '组件未注册(提示)', detail: `<${c}> 不在页面/全局 usingComponents（若为内置扩展请忽略）` });
  });
});

// ---- 输出 ----
const hard = findings.filter(f => f.type !== '组件未注册(提示)' && f.type !== 'setData 过多');
console.log(`页面走查：${pages.length} 页，发现 ${findings.length} 项（硬伤 ${hard.length}）`);
findings.forEach(f => console.log(`  [${f.type}] ${f.page} — ${f.detail}`));
if (!findings.length) console.log('  ✔ 未发现绑定/事件/跳转/注册问题');
process.exit(hard.length ? 1 : 0);
