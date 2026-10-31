// 云函数：sync —— 记录与资料的统一读写入口
// 数据库集合：records（课后记录）、profiles（学生资料）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const records = db.collection('records');
  const profiles = db.collection('profiles');

  try {
    if (event.action === 'push') {
      const doc = event.doc || {};
      if (doc.type === 'profile') {
        // 学生资料：按 sid upsert
        const q = await profiles.where({ sid: doc.sid }).get();
        if (q.data.length) await profiles.doc(q.data[0]._id).update({ data: { profile: doc.profile, updatedAt: Date.now() } });
        else await profiles.add({ data: { sid: doc.sid, owner: OPENID, profile: doc.profile, updatedAt: Date.now() } });
        return { ok: true };
      }
      // 普通记录：按 id upsert，打上归属 openid
      const q = await records.where({ id: doc.id }).get();
      doc.owner = OPENID;
      if (q.data.length) await records.doc(q.data[0]._id).update({ data: doc });
      else await records.add({ data: doc });
      return { ok: true };
    }

    if (event.action === 'pull') {
      // 拉取该老师的全部记录与学生资料，由小程序端按 id 合并
      const recs = await records.where({ owner: OPENID }).limit(1000).get();
      const profs = await profiles.where({ owner: OPENID }).limit(1000).get();
      return {
        ok: true,
        db: {
          records: recs.data.map(d => ({ id: d.id, sid: d.sid, cid: d.cid, course: d.course, score: d.score, note: d.note, tag: d.tag, audio: d.audio, photos: d.photos, sent: d.sent, date: d.date, updatedAt: d.updatedAt }))
        },
        profiles: profs.data.map(d => ({ sid: d.sid, profile: d.profile }))
      };
    }

    if (event.action === 'delRecord') {
      await records.where({ id: event.id, owner: OPENID }).remove();
      return { ok: true };
    }

    return { ok: false, msg: 'unknown action' };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
};
