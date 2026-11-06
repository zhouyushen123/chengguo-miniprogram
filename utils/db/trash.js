// utils/db/trash.js —— 回收站
//
// 【为什么要有】删除在业务上是"不再出现在列表里"，不是"数据消失"。
// 老师手滑删掉一个学生，连带几十条记录一起没了，如果没有还原入口，
// 唯一的补救就是翻备份 —— 而备份最多回退到昨天，中间录的全丢。
//
// 【一批是什么】一次删除会牵连多个集合（删学生 → 记录/报名；删班级 → 课程/报名/名单关联）。
// 这些行被同一个 removedAt 打上标记，还原时按 (外键指向 + removedAt 相同) 认批，
// 所以「删学生→单独删了另一条记录→还原学生」不会把那条单独删的记录顺手复活。
const core = require('./core');
const { ocAll, memberCurrent, actor } = require('./ctx');
const perms = require('./permissions');
const students = require('./students');
const classes = require('./classes');
const courses = require('./courses');
const records = require('./records');
const identity = require('./identity');

const KEEP = 60;          // 每类最多列 60 条：回收站是应急入口，不是归档系统
const KINDS = ['students', 'classes', 'courses', 'records', 'members'];

function whoName(id) {
  const n = Number(id) || 0;
  if (!n) return '';
  const m = core.coll('members').find(x => x.id === n);
  return m ? (m.name || '') : '';
}

function tsOf(doc) {
  return Number(doc.removedAt) || Number(doc.updatedAt) || 0;
}

// 最近删除（只读）。
// 可见性必须跟正常列表一致：回收站里是姓名、学号、评语正文——比列表还敏感。
// 2026-11-06 实测漏了：老师能看到别的班删掉的学生（姓名 + 连带记录条数），
// 等于从回收站绕过了班级范围。这里逐类按 perms 判可见性。
// 家长整块看不到：里面全是别人家孩子的信息。
function list(kind) {
  const me = memberCurrent();
  if (!me) return { ok: false, msg: '还没有身份' };
  if (me.role === 'parent') return { ok: false, msg: '家长看不到回收站' };
  const a = actor();

  const want = KINDS.indexOf(kind) > -1 ? [kind] : KINDS;
  const out = [];
  const push = (k, coll, doc, title, sub, extra) => {
    out.push(Object.assign({
      kind: k, coll, id: doc.id, title, sub,
      at: tsOf(doc), by: whoName(doc.removedBy)
    }, extra || {}));
  };

  if (want.indexOf('students') > -1) {
    ocAll('students').filter(x => x.removed && perms.canSeeStudent(a, x)).forEach(s => {
      // 这一批带走了多少条记录：还原时会一起回来，得让人看见"恢复的是什么规模"
      const n = ocAll('records').filter(r => r.sid === s.id && r.removed && r.removedAt === s.removedAt).length;
      push('students', 'students', s, s.name || '未命名学生',
        '学号 ' + (s.no || '—') + (n ? ' · 连带 ' + n + ' 条记录' : ''));
    });
  }
  if (want.indexOf('classes') > -1) {
    ocAll('classes').filter(x => x.removed && perms.canSeeClass(a, x.id)).forEach(c => {
      const d = c.detached || { students: [] };
      push('classes', 'classes', c, c.name || '未命名班级',
        (d.students || []).length ? '名单 ' + d.students.length + ' 人会一起恢复' : '空班');
    });
  }
  if (want.indexOf('courses') > -1) {
    ocAll('courses').filter(x => x.removed && perms.canSeeClass(a, x.clsId)).forEach(c => {
      push('courses', 'courses', c, c.name || '未命名课程', '归属：' + ((core.coll('classes').find(y => y.id === c.clsId) || {}).name || '已删班级'));
    });
  }
  if (want.indexOf('records') > -1) {
    ocAll('records').filter(x => x.removed && perms.canSeeRecord(a, x)).forEach(r => {
      const s = core.coll('students').find(x => x.id === r.sid);
      push('records', 'records', r, (s ? s.name : '已删除学生') + ' · ' + (r.date || ''),
        String(r.note || '').slice(0, 30));
    });
  }
  // 成员（人员变动）属管理级信息，老师不看
  if (want.indexOf('members') > -1 && a && a.all) {
    ocAll('members').filter(x => x.removed).forEach(m => {
      push('members', 'members', m, m.name || '未命名成员', m.role === 'parent' ? '家长' : '老师');
    });
  }

  out.sort((a, b) => b.at - a.at);
  return { ok: true, items: out.slice(0, KEEP), total: out.length, more: out.length > KEEP };
}

const FN = {
  students: students.studentRestore,
  classes: classes.classRestore,
  courses: courses.courseRestore,
  records: records.recordRestore,
  members: identity.memberRestore
};

// 还原。kind 必须显式给：同名的学生和班级 id 可能撞在一起，靠猜一定会猜错。
function restore(kind, id) {
  const fn = FN[kind];
  if (!fn) return { ok: false, msg: '不支持这类数据' };
  return fn(id);
}

module.exports = { list, restore, KINDS };
