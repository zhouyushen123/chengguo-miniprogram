// tests/run.js —— 回归总入口：node tests/run.js
//
// 多套断言各管一层，缺一不可：
//   verify_db      数据层：迁移、字段约束、软删除、重启后数据是否还在
//   verify_perm    权限：角色×范围、fail-closed、跨机构隔离
//   verify_term    学期与课时：结转、报名账本、消课
//   verify_p0      P0 止血：关键回归点
//   verify_pages   页面级：把真实页面模块加载起来跑，能抓到"数据层没问题但页面会崩"的情况
//   verify_arch    架构守卫：依赖无环且严格下行、页面不绕过数据层、API 面完整、文件规模
//
// 退出码非 0 表示有套件失败，可直接用于 CI 卡点。
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['verify_db.js', '数据层'],
  ['verify_perm.js', '权限'],
  ['verify_term.js', '学期与课时'],
  ['verify_p0.js', 'P0 止血'],
  ['verify_pages.js', '页面级'],
  ['verify_phone.js', '手机号'],
  ['verify_session.js', '课次结清'],
  ['verify_batch.js', '批量录入成绩单'],
  ['verify_sec.js', '安全与触达'],
  ['verify_photocloud.js', '照片上云'],
  ['verify_sync.js', '记录上云'],
  ['verify_pull.js', '云端拉取分页'],
  ['verify_invite.js', '邀请码加入'],
  ['verify_admin.js', '电脑端后台'],
  ['verify_ava.js', '头像统一'],
  ['verify_import.js', '批量导入'],
  ['verify_onboard.js', '新手引导'],
  ['verify_voice.js', '语音输入'],
  ['verify_course.js', '课程与多班开设'],
  ['verify_layout.js', '页面左右对齐'],
  ['verify_ai.js', 'AI 评超时重试'],
  ['verify_student_form.js', '学生表单 F-04 / F-08'],
  ['verify_feedback_round.js', '真机反馈 G/H 五项'],
  ['verify_demo.js', '演示隔离'],
  ['verify_hardening.js', '加固'],
  ['verify_backup.js', '备份与恢复'],
  ['verify_cloudbackup.js', '云端每日备份'],
  ['verify_protect.js', '数据保护机制'],
  ['verify_review.js', '审查机制'],
  ['verify_datamodel.js', '数据模型'],
  ['verify_integrity.js', '地基体检'],
  ['verify_arch.js', '架构守卫'],
  ['verify_manual.js', '手册与用例'],
  ['verify_journey.js', '用户旅程'],
  ['verify_teacher.js', '老师角色旅程'],
];

let failed = 0;
const rows = [];

SUITES.forEach(([file, name]) => {
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { encoding: 'utf8', timeout: 120000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  const ok = r.status === 0;
  if (!ok) failed++;
  const lines = out ? out.split('\n') : [];
  // 各脚本最后都会打印「全部 N 项…通过」，取它作为摘要（不能用最后一行：
  // 降级路径会打印 warn 日志，可能落在末尾）
  const summary = (lines.filter(l => /全部.*通过|有 \d+ 项失败/.test(l)).pop() || lines[lines.length - 1] || '').trim();
  rows.push({ name, ok, summary, out });
});

console.log('');
rows.forEach(row => {
  console.log((row.ok ? '✔' : '✘') + '  ' + row.name + '  ' + row.summary);
  if (!row.ok) {
    console.log('--- 失败详情 ---');
    console.log(row.out.split('\n').slice(-30).join('\n'));
    console.log('---------------');
  }
});
console.log('');
console.log(failed ? '有 ' + failed + ' 个套件失败' : '全部套件通过');
process.exit(failed ? 1 : 0);
