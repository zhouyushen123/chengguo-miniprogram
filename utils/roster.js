// utils/roster.js —— 名单导入的前端辅助（纯函数，无 wx 依赖，测试可直接 require）
// 云端 parse.js 负责解析；这里只做「预览层」的事：班内重名标记。
function markDupes(list, existingNames) {
  const have = {};
  (existingNames || []).forEach(n => { have[n] = 1; });
  return (list || []).map(it => Object.assign({}, it, { dupe: !!have[it.name] }));
}

// 批量建档结果描述（页面 toast / 完成页文案共用一份口径）
function resultText(r) {
  if (!r) return '';
  let t = '已导入 ' + r.added + ' 名学生';
  if (r.dupes) t += '；' + r.dupes + ' 名班内重名已默认跳过';
  if (r.failed) t += '；' + r.failed + ' 名建档失败（' + (r.failMsg || '未知原因') + '）';
  return t;
}

module.exports = { markDupes, resultText };
