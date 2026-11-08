// utils/syncmerge.js —— 云端增量合并的纯函数（无 wx、无状态，单测直连）
//
// 【冲突规则】LWW：同一份文档比 updatedAt，服务器版本更新才覆盖；
// 时间戳相同时按「活着的优先」决胜（见 pickWinner 里的说明），不让一次时间撞车静默抹掉数据。
// 删除是软删（removed:true 是普通字段），所以"谁删的晚"同样按 updatedAt 决胜。
//
// 【为什么不做字段级合并】评语、分数是整段写的，字段级合并会把 A 老师的分数和 B 老师的评语
// 拼成一条谁都没写过的记录。整条覆盖 + 明确的更新时间，行为可预期得多。

// 取合并后胜出的一条：远端更新或本地缺失 → 用远端
//
// 【时间戳相同怎么办】旧实现是"远端一律胜"，包含远端是墓碑（removed）的情况。
// 那意味着：另一台设备在**同一毫秒**删掉一条、本机恰好也改过它，拉取后这条会凭空消失，
// 而本机看到的只是"记录少了一条"——没有报错、没有日志。11-05 那批数据消失
// 至今没能复现，但这条规则本身就有这个口子。
// 现在：同时间戳时**活着的优先**。代价是"删除可能要多删一次"，
// 收益是"数据不会因为一次时间撞车就静默不见" —— 这个方向与本项目其它取舍一致
// （宁可多留一条能再删的，也不要少一条找不回的）。
function pickWinner(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  const l = Number(local.updatedAt) || 0;
  const r = Number(remote.updatedAt) || 0;
  if (r !== l) return r > l ? remote : local;
  const lr = local.removed === true;
  const rr = remote.removed === true;
  if (lr !== rr) return lr ? remote : local;
  return remote;      // 同活/同删：取远端，避免两边各留一份"同一秒"的分叉
}

// 合并一个集合：按 id 索引，返回新数组与统计。
// 不修改入参（数据层要拿结果去 setColl，改原数组会让"回滚"失效）
//
// 【索引键必须带 orgId】本机是一个全量库，两家机构的数据躺在同一个数组里。
// 只按 id 索引时，A 家的「学生 173xxx」和 B 家恰好同 id 的那条会被认成同一份：
// 后到的把先到的顶掉 —— 表现是"另一个机构的孩子凭空变成我们班的了"，而且不报错。
// 跨设备用毫秒时间戳撞号本来极低，但一家机构一份 id 空间时它只影响自己，
// 多机构之后影响的是别人 —— 这个概率不值得赌，键上直接带上机构。
function docKey(d) {
  if (!d || d.id === undefined) return '';
  return (d.orgId ? String(d.orgId) : '') + '\u0000' + String(d.id);
}
function mergeList(localList, remoteList) {
  const list = (localList || []).slice();
  const idx = {};
  list.forEach((d, i) => { const k = docKey(d); if (k) idx[k] = i; });
  let added = 0, updated = 0;
  (remoteList || []).forEach(rd => {
    const k = docKey(rd);
    if (!k) return;
    const i = idx[k];
    if (i === undefined) { list.push(rd); idx[k] = list.length - 1; added++; return; }
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
