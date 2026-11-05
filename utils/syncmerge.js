// utils/syncmerge.js —— 云端增量合并的纯函数（无 wx、无状态，单测直连）
//
// 【冲突规则】LWW：同一份文档比 updatedAt，服务器版本不旧于本地才覆盖；
// 相同时间戳时以服务器为准（多设备同时对同一秒写入的概率极低，取一边即可，不必制造分叉）。
// 删除是软删（removed:true 是普通字段），所以"谁删的晚"同样按 updatedAt 决胜。
//
// 【为什么不做字段级合并】评语、分数是整段写的，字段级合并会把 A 老师的分数和 B 老师的评语
// 拼成一条谁都没写过的记录。整条覆盖 + 明确的更新时间，行为可预期得多。

// 取合并后胜出的一条：远端更新或本地缺失 → 用远端
function pickWinner(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  const l = Number(local.updatedAt) || 0;
  const r = Number(remote.updatedAt) || 0;
  return r >= l ? remote : local;
}

// 合并一个集合：按 id 索引，返回新数组与统计。
// 不修改入参（数据层要拿结果去 setColl，改原数组会让"回滚"失效）
function mergeList(localList, remoteList) {
  const list = (localList || []).slice();
  const idx = {};
  list.forEach((d, i) => { if (d && d.id !== undefined) idx[d.id] = i; });
  let added = 0, updated = 0;
  (remoteList || []).forEach(rd => {
    if (!rd || rd.id === undefined) return;
    const i = idx[rd.id];
    if (i === undefined) { list.push(rd); idx[rd.id] = list.length - 1; added++; return; }
    const win = pickWinner(list[i], rd);
    if (win !== list[i]) { list[i] = win; updated++; }
  });
  return { list, added, updated };
}

// 把推送批次切成每包 n 条（云函数入参有大小上限，记录多了要分批）
function chunk(arr, n) {
  const size = Math.max(1, Number(n) || 50);
  const out = [];
  for (let i = 0; i < (arr || []).length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// 游标推进：取条目上最大的 srvAt（服务器写入时间），只增不减
function cursorOf(docs, prev) {
  let cur = Number(prev) || 0;
  (docs || []).forEach(it => {
    const t = Number(it && (it.srvAt !== undefined ? it.srvAt : (it.d && it.d.srvAt))) || 0;
    if (t > cur) cur = t;
  });
  return cur;
}

module.exports = { pickWinner, mergeList, chunk, cursorOf };
