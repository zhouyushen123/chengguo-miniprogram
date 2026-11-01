// 姓氏拼音首字母速查：用于学生按姓氏排序（同姓聚在一起，按 A→Z 排列）
// 覆盖常见姓氏/常用字；未命中时用 localeCompare 中文锚点兜底，再兜底归入 '#'

var TABLE = {
  A: '阿艾安敖',
  B: '白柏班包鲍贝毕卞边别步保薄',
  C: '蔡曹岑柴陈成程崔常池储楚',
  D: '邓丁董杜段窦戴单丹党',
  F: '范方房费冯傅符伏樊封',
  G: '高葛顾关郭甘龚谷耿宫甘辜桂',
  H: '韩何贺胡黄洪侯华郝霍扈花黄惠',
  J: '姜蒋金江贾纪简焦靳季景荆鞠吉纪居嵇',
  K: '孔柯阚况寇匡',
  L: '李刘林罗梁卢吕骆蓝黎雷廖陆柳凌芦鲁龙娄兰郎劳乐来黎连廉练林凌刘柳龙楼卢罗骆',
  M: '马毛孟莫梅米缪穆麦蒙苗闵茅闵莫',
  N: '倪聂牛宁南倪农诺',
  O: '欧欧阳区',
  P: '潘彭庞蒲裴皮平潘彭',
  Q: '钱秦邱齐乔屈强全权钱秦祁裘庆邱曲',
  R: '任饶阮荣芮任茹阮',
  S: '沈孙宋石施苏史沙申盛尚商佘师水松隋舒宋宿',
  T: '唐陶滕田童谈谭汤拓覃谭汤唐陶佟童',
  W: '王吴魏万汪卫温韦闻文翁巫伍邬沃',
  X: '徐许肖谢薛席奚向项萧夏鲜解邢幸熊西门徐许',
  Y: '杨叶严姚尤于余袁尹应雍闫阎燕颜易殷俞虞郁元岳云于余禹俞袁岳云',
  Z: '张赵周郑朱邹曾詹翟甄钟仲祝庄卓左臧宗祖曾翟张赵章赵'
};

var MAP = {};
Object.keys(TABLE).forEach(function (L) {
  TABLE[L].split('').forEach(function (ch) { if (!MAP[ch]) MAP[ch] = L; });
});

// 中文排序锚点：每个字母用一个代表字，localeCompare 支持中文时按此兜底
var ANCHORS = [
  ['A', '阿'], ['B', '八'], ['C', '擦'], ['D', '搭'], ['E', '蛾'], ['F', '发'],
  ['G', '嘎'], ['H', '哈'], ['J', '鸡'], ['K', '喀'], ['L', '垃'], ['M', '妈'],
  ['N', '拿'], ['O', '哦'], ['P', '啪'], ['Q', '期'], ['R', '然'], ['S', '撒'],
  ['T', '塌'], ['W', '挖'], ['X', '西'], ['Y', '压'], ['Z', '匝']
];

function firstLetter(name) {
  var ch = (name || ' ')[0];
  if (MAP[ch]) return MAP[ch];
  if (/[a-zA-Z]/.test(ch)) return ch.toUpperCase();
  // localeCompare 中文排序兜底（开发者工具/多数真机支持）
  try {
    for (var i = 0; i < ANCHORS.length; i++) {
      if (ch.localeCompare(ANCHORS[i][1], 'zh-Hans-CN') < 0) return ANCHORS[i][0];
    }
    return 'Z';
  } catch (e) { /* 引擎不支持时归入 # */ }
  return '#';
}

// 学生按姓氏首字母 A→Z 排序，同姓保持原顺序（稳定）
function sortStudents(list) {
  return list.slice().sort(function (a, b) {
    var la = firstLetter(a.name), lb = firstLetter(b.name);
    if (la !== lb) return la < lb ? -1 : 1;
    return 0;
  });
}

module.exports = { firstLetter: firstLetter, sortStudents: sortStudents };
