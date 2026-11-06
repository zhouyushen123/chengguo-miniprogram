// utils/db/settle.js —— 结转向导的落地动作（学期结束 → 新学期开班的整件事）
//
// 【为什么单独一个模块】terms 只管学期本身、classes 管班级、enrollments 管课时账，
// 结转是"把这些串起来"的跨领域动作。放在 terms 里会让 terms 反过来依赖 classes/courses，
// 与 classes → terms 形成 require 环；放在页面里则会让页面持有十几处写操作的顺序与错误处理
// （原来的实现就是这样，任何一步失败都留下半成品）。
//
// 【为什么必须是一个事务】结转要连写六个集合：学期、班级、课程、学生班级归属、报名、旧学期归档。
// 中途失败（空间不足、数据异常、用户切后台被杀）以前会留下"新班建了一半、旧学期已归档"的现场，
// 而旧学期一旦归档就只读，老师连重来一次都做不到。
//
// 依赖：ctx（底座）+ classes/courses/students/enrollments/terms（全部下行）。
const { deny } = require('./ctx');
const core = require('./core');
const schema = require('./schema');
const terms = require('./terms');
const classes = require('./classes');
const courses = require('./courses');
const students = require('./students');
const enrollments = require('./enrollments');

// plan = {
//   termId,                                  要结束的学期
//   newTerm: { name, startDate },            新学期（没有要延续的班时可以只归档）
//   classes: [{ name, teacherId, decision, courses: [{name, sel}], students: [{sid, act, enId, remain}] }]
// }
// decision: carry 延续到新学期 / end 随学期结束
// students[].act: re 续报 / churn 流失
function settle(plan) {
  const err = deny('term.manage');
  if (err) return { ok: false, msg: err };

  const p = plan || {};
  const t = terms.termRaw(p.termId);
  if (!t) return { ok: false, msg: '学期不存在' };
  if (t.builtIn) return { ok: false, msg: '内置长期班不参与结转' };
  if (t.status === 'archived') return { ok: false, msg: '该学期已归档' };

  const carry = (p.classes || []).filter(c => c.decision === 'carry');
  const name = schema.str((p.newTerm || {}).name).trim();
  if (carry.length && !name) return { ok: false, msg: '请填写新学期名称' };
  if (carry.length && carry.some(c => !c.teacherId)) return { ok: false, msg: '有延续班级未指派老师' };

  return core.tx(() => {
    let nt = null;
    if (carry.length) {
      // 已有同名且未归档的学期就直接复用，避免连点两次生成两个"2027 春季班"
      nt = terms.termList().find(x => x.name === name && x.status !== 'archived');
      if (!nt) {
        // 显式 active：termCreate 的默认逻辑是"已有进行中学期就建为未开始"，
        // 而结转的语义是"旧学期结束、新学期开始"——旧学期此刻还 active，靠默认会把新学期建成 upcoming，
        // 结果结转完成后一个进行中的学期都没有，录入页只能兜底展示所有班级。
        const r = terms.termCreate({ name, startDate: (p.newTerm || {}).startDate, status: 'active' });
        if (!r.ok) return r;
        nt = r.item;
      }
    }

    let clsN = 0, reN = 0, churnN = 0;
    carry.forEach(c => {
      const rc = classes.classCreate({ name: c.name, termId: nt.id, mode: 'carry', teacherId: c.teacherId });
      if (!rc.ok) throw new Error(rc.msg);
      clsN++;
      const newId = rc.item.id;
      // 勾选的课程开到新班。V10 起课程可跨班复用，这里直接绑同一门课，
      // 不再复制出一条同名课程——否则连年结转会让课程库里堆满"楷书 × N"。
      (c.courses || []).filter(x => x.sel).forEach(x => {
        const br = x.id
          ? courses.courseBind(newId, x.id)
          : courses.courseCreate({ name: x.name, clsId: newId });
        if (!br.ok) throw new Error(br.msg);
      });
      (c.students || []).forEach(s => {
        if (s.act === 're') {
          // 续报：加入新班 + 剩余课时带入 + 溯源旧报名
          const stu = students.studentRaw(s.sid);
          if (stu && stu.clsIds.indexOf(newId) < 0) {
            const ur = students.studentUpdate(s.sid, { clsIds: stu.clsIds.concat([newId]) });
            if (!ur.ok) throw new Error(ur.msg);
          }
          const er = enrollments.enrollmentCreate({
            studentId: s.sid, clsId: newId,
            totalHours: s.remain, usedHours: 0, carriedFrom: s.enId || 0
          });
          if (!er.ok) throw new Error(er.msg);
          reN++;
          if (s.enId) {
            const ar = enrollments.enrollmentUpdate(s.enId, { status: 'carried' });
            if (!ar.ok) throw new Error(ar.msg);
          }
        } else {
          churnN++;
          if (s.enId) {
            const ar = enrollments.enrollmentUpdate(s.enId, { status: 'churned' });
            if (!ar.ok) throw new Error(ar.msg);
          }
        }
      });
    });

    // 旧学期归档（只读）。放最后：前面任何一步失败，旧学期都还没动，用户可以直接重来。
    const ar = terms.termArchive(t.id);
    if (!ar.ok) return ar;

    return {
      ok: true,
      termId: nt ? nt.id : 0,
      termName: nt ? nt.name : '',
      clsN, reN, churnN
    };
  });
}

module.exports = { settle };
