// 云函数：sync —— 记录与资料的统一读写入口
//
// 【安全模型】openid 只从 getWXContext 取，不接受客户端传入。
// 【主键设计】用 确定性 _id = `${openid}_${业务 id}`，而不是"先 where({id}) 查到再 update"：
//   - 老写法 where({ id: doc.id }) 不带 owner，任何人 push 一个别人用过的 id 就能覆盖别人的记录
//   - 先查后写还有并发窗口：同一秒推两次会 add 出两条
//   - 确定性 _id 让 set() 天然是 upsert，越权在数据结构上就不可能
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const PAGE = 100;          // 单次查询上限（云开发小程序端上限 20，云函数端 100）
const MAX_ROWS = 5000;     // 单次 pull 的硬上限，超过就分多次拉

// 分页取全量：以前 limit(1000) 一把梭，记录超过 1000 条就静默截断，
// 表现为"老记录在另一台手机上不见了"
async function fetchAll(coll, where, max) {
  const out = [];
  for (let skip = 0; skip < max; skip += PAGE) {
    const r = await coll.where(where).skip(skip).limit(PAGE).get();
    out.push.apply(out, r.data);
    if (r.data.length < PAGE) break;
  }
  return out;
}

// 只回传业务字段：把 owner / _id 这类存储细节挡在客户端之外
function pick(d) {
  return {
    id: d.id, type: d.type, sid: d.sid, cid: d.cid,
    courseId: d.courseId, course: d.course, score: d.score,
    tag: d.tag, note: d.note, date: d.date, sent: d.sent, tid: d.tid,
    photos: d.photos || [], videos: d.videos || [], audio: d.audio || null,
    createdAt: d.createdAt, updatedAt: d.updatedAt
  };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, msg: '未登录' };

  const records = db.collection('records');
  const profiles = db.collection('profiles');
  const key = id => OPENID + '_' + String(id);

  try {
    if (event.action === 'push') {
      const doc = event.doc || {};
      if (doc.type === 'profile') {
        if (!doc.sid) return { ok: false, msg: '缺少学生 id' };
        // 资料按 sid upsert；_id 带 openid，不同老师的同一个 sid 互不覆盖
        await profiles.doc(key(doc.sid)).set({
          data: { sid: doc.sid, owner: OPENID, profile: doc.profile || {}, updatedAt: Date.now() }
        });
        return { ok: true };
      }
      if (!doc.id) return { ok: false, msg: '缺少记录 id' };
      const data = pick(doc);
      data.owner = OPENID;
      data.updatedAt = Date.now();
      await records.doc(key(doc.id)).set({ data });
      return { ok: true };
    }

    if (event.action === 'pull') {
      const recs = await fetchAll(records, { owner: OPENID }, MAX_ROWS);
      const profs = await fetchAll(profiles, { owner: OPENID }, MAX_ROWS);
      return {
        ok: true,
        db: { records: recs.map(pick) },
        profiles: profs.map(d => ({ sid: d.sid, profile: d.profile })),
        truncated: recs.length >= MAX_ROWS   // 让客户端知道"还有没拉完的"
      };
    }

    if (event.action === 'delRecord') {
      if (!event.id) return { ok: false, msg: '缺少记录 id' };
      // doc() 只能操作自己的那个 _id：别人的 id 拼出来的 key 里带着别人的 openid，删不到
      await records.doc(key(event.id)).remove();
      return { ok: true };
    }

    return { ok: false, msg: 'unknown action' };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
};
