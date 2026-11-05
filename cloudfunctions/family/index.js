// family —— 家长订阅消息（唯一官方免费触达）
// 模板 ID 走环境变量 NOTIFY_TEMPLATE_ID（备案通过后在 mp 后台申请教育类目模板，把 ID 配到这里，代码零改动）。
// 链路：家长端点「开启成绩通知」→ requestSubscribeMessage 授权 → bind 登记 openid + 授权次数；
// 老师结清发布 → send 按学生找到家长 openid → subscribeMessage.send。
// openid_map 集合：{ _openid, sids:[学生id], name, grants:剩余可发条数, updatedAt }
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const COL = 'openid_map';

const tplId = () => (process.env.NOTIFY_TEMPLATE_ID || '').trim();

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, msg: '未登录，拒绝调用' };
  const action = event && event.action;

  // 前端取模板 ID（requestSubscribeMessage 需要它；未配置时前端隐藏入口）
  if (action === 'tpl') {
    const tpl = tplId();
    return { ok: true, tpl, ready: !!tpl };
  }

  // 家长绑定：授权成功后登记 openid → 孩子列表，grants = 本次授权可收到的推送条数（一次性订阅按条计）
  if (action === 'bind') {
    const sids = (Array.isArray(event.sids) ? event.sids : []).map(Number).filter(n => n > 0).slice(0, 20);
    const grants = Math.max(0, Number(event.grants) || 0);
    if (!sids.length) return { ok: false, msg: '缺少孩子信息' };
    const col = db.collection(COL);
    const prev = await col.where({ _openid: OPENID }).limit(1).get().catch(() => ({ data: [] }));
    if (prev.data.length) {
      const doc = prev.data[0];
      await col.doc(doc._id).update({
        data: {
          sids: Array.from(new Set((doc.sids || []).concat(sids))),
          grants: (Number(doc.grants) || 0) + grants,
          updatedAt: db.serverDate()
        }
      });
    } else {
      await col.add({ data: { _openid: OPENID, sids, name: String(event.name || '').slice(0, 20), grants, updatedAt: db.serverDate() } });
    }
    return { ok: true };
  }

  // 老师结清发布后触达：items = [{sid, name, score, tag, note, clsName, date}]
  if (action === 'send') {
    const tpl = tplId();
    if (!tpl) return { ok: false, code: 'NO_TPL', msg: '未配置 NOTIFY_TEMPLATE_ID，家长通知跳过（不影响发布）' };
    const items = Array.isArray(event.items) ? event.items.slice(0, 100) : [];
    if (!items.length) return { ok: true, sent: 0 };
    const sids = Array.from(new Set(items.map(x => Number(x.sid)).filter(n => n > 0)));
    if (!sids.length) return { ok: true, sent: 0 };
    // 找到所有绑定了这些孩子的家长 openid
    const docs = await db.collection(COL).where({ sids: db.command.elemMatch(db.command.in(sids)) })
      .limit(100).get().catch(() => ({ data: [] }));
    if (!docs.data.length) return { ok: true, sent: 0, nobind: true };
    let sent = 0, refused = 0;
    for (const doc of docs.data) {
      const my = items.filter(x => (doc.sids || []).indexOf(Number(x.sid)) > -1);
      for (const it of my) {
        if ((Number(doc.grants) || 0) <= 0) { refused++; continue; } // 授权额度用完，不发（发也必失败）
        // 模板字段按申请到的模板定死结构；这里给的是教育成绩通知常用三段式，
        // 模板字段名不同时只需改 data 里的 key（value 结构 thing/character_string 不变）
        try {
          await cloud.openapi.subscribeMessage.send({
            touser: doc._openid,
            templateId: tpl,
            page: 'pages/index/index',
            data: {
              thing1: { value: String(it.clsName || '课后成果').slice(0, 20) },
              character_string1: { value: String(it.date || '').slice(0, 32) },
              thing2: { value: ('等第' + (it.tag || '—') + ' ' + String(it.note || '')).slice(0, 20) }
            }
          });
          sent++;
          await db.collection(COL).doc(doc._id).update({ data: { grants: db.command.inc(-1) } });
        } catch (e) {
          // 43101 = 用户未订阅/已拒收：额度清零，别再浪费下一次尝试
          if (e && (e.errCode === 43101 || String(e.errMsg || '').indexOf('43101') > -1)) {
            refused++;
            await db.collection(COL).doc(doc._id).update({ data: { grants: 0 } }).catch(() => {});
          }
        }
      }
    }
    return { ok: true, sent, refused, parents: docs.data.length };
  }

  return { ok: false, msg: '未知 action' };
};
