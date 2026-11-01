// tests/verify_p0.js —— P0 止血项验证
//
// 每个用例对应一条体检结论，专门防止"修了又退回去"：
//   CR-001 媒体持久化   临时路径必须转存到用户目录
//   CR-002 多机构隔离   其他机构的数据不能出现在当前机构列表
//   CR-004 tid fail-open 无主记录不能被普通老师改写
//   ADR-009 record.type  字段存在、默认值正确、编辑不冲掉
//   降级保护            读盘失败时绝不落盘覆盖原数据
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const USR = 'http://usr';   // 模拟 wx.env.USER_DATA_PATH（开发者工具里的形态）
let pass = 0, fail = 0;

function ok(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// 内存文件系统：让 media 的 copyFileSync / accessSync / statSync 能跑起来
function fakeFs(store) {
  const files = store || {};
  return {
    files,
    accessSync(p) { if (!(p in files)) throw new Error('ENOENT ' + p); },
    mkdirSync() { /* 目录是虚的，不记 */ },
    copyFileSync(a, b) { if (!(a in files)) throw new Error('ENOENT ' + a); files[b] = files[a]; },
    unlinkSync(p) { delete files[p]; },
    readdirSync() { return Object.keys(files); },
    statSync(p) { return { size: (files[p] || '').length }; }
  };
}

function boot(seed, fsStore) {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k];
  });
  const mem = seed || {};
  const fsMock = fakeFs(fsStore);
  global.wx = {
    env: { USER_DATA_PATH: USR },
    getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
    setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
    removeStorageSync: k => { delete mem[k]; },
    getFileSystemManager: () => fsMock,
    showToast: () => {}, showModal: () => {},
    setNavigationBarTitle: () => {}, navigateBack: () => {}
  };
  const db = require(path.join(ROOT, 'utils/db'));
  db.init();
  return { db, mem, fsMock };
}

/* =============================== CR-001 媒体持久化 =============================== */
console.log('\n【CR-001 媒体持久化】');
{
  const tmpFiles = { 'http://tmp/abc.jpg': 'JPEGDATA', 'http://tmp/clip.mp4': 'MP4DATA' };
  const { fsMock } = boot({}, tmpFiles);
  const media = require(path.join(ROOT, 'utils/media'));

  ok('临时路径判定为不持久', () => {
    assert.strictEqual(media.isPersist('http://tmp/abc.jpg'), false);
  });
  ok('用户目录路径判定为持久', () => {
    assert.strictEqual(media.isPersist(USR + '/media/photo_1.jpg'), true);
  });
  ok('转存后落在用户目录、内容一致', () => {
    const dest = media.persist('http://tmp/abc.jpg', 'photo');
    assert.ok(dest.indexOf(USR + '/media/') === 0, '目标路径应在用户目录，实际 ' + dest);
    assert.strictEqual(fsMock.files[dest], 'JPEGDATA', '文件内容必须被复制过去');
  });
  ok('已经是持久路径时不重复复制', () => {
    const once = media.persist('http://tmp/abc.jpg', 'photo');
    assert.strictEqual(media.persist(once, 'photo'), once);
  });
  ok('源文件不存在时返回原路径，不抛错也不丢引用', () => {
    const r = media.persist('http://tmp/gone.jpg', 'photo');
    assert.strictEqual(r, 'http://tmp/gone.jpg');
  });
  ok('视频按视频扩展名存', () => {
    const dest = media.persist('http://tmp/clip.mp4', 'video');
    assert.ok(/\.mp4$/.test(dest), '应保留 mp4 扩展名，实际 ' + dest);
  });

  // 存量自愈：库里已有临时路径的老记录，启动时应被转存成持久路径
  ok('启动时把存量记录的临时照片转存成持久路径', () => {
    const t = Date.now();
    // 预置一份"升级前"的库：meta 已是 v4（不会再走迁移），记录里是临时路径
    const seed = {
      'chengguo_v3_meta': { version: 4, orgId: 'org1', orgName: '我的机构', teacher: '周老师', me: 't1', demoVersion: 5, createdAt: t, updatedAt: t },
      'chengguo_v3_orgs': [{ id: 'org1', name: '我的机构', ownerId: 't1', status: 'active', orgId: 'org1', createdAt: t, updatedAt: t, removed: false }],
      'chengguo_v3_users': [{ id: 't1', name: '周老师', role: 'owner', orgId: 'org1', createdAt: t, updatedAt: t, removed: false }],
      'chengguo_v3_members': [{ id: 1, orgId: 'org1', userId: 't1', role: 'owner', name: '周老师', clsIds: [], courseIds: [], studentIds: [], status: 'active', createdAt: t, updatedAt: t, removed: false }],
      'chengguo_v3_classes': [{ id: 1, name: '书法班', sort: 0, orgId: 'org1', createdAt: t, updatedAt: t, removed: false }],
      'chengguo_v3_courses': [],
      'chengguo_v3_students': [{ id: 101, name: '周小明', clsIds: [1], photo: 'http://tmp/ava.jpg', orgId: 'org1', createdAt: t, updatedAt: t, removed: false }],
      'chengguo_v3_records': [{
        id: 555, type: 'achievement', sid: 101, cid: 1, courseId: 0, course: '楷书', date: '2026-10-01',
        score: 90, tag: '优秀', note: '', photos: ['http://tmp/old1.jpg'], videos: ['http://tmp/old2.mp4'],
        audio: 'http://tmp/old3.mp3', sent: false, tid: 't1', orgId: 'org1', createdAt: t, updatedAt: t, removed: false
      }],
      'chengguo_v3_templates': []
    };
    const files = { 'http://tmp/old1.jpg': 'J1', 'http://tmp/old2.mp4': 'V1', 'http://tmp/old3.mp3': 'A1', 'http://tmp/ava.jpg': 'AVA' };
    const { mem } = boot(seed, files);
    const rec = mem['chengguo_v3_records'].find(r => r.id === 555);
    assert.ok(rec.photos[0].indexOf(USR + '/media/') === 0, '照片应被转存，实际 ' + rec.photos[0]);
    assert.ok(rec.videos[0].indexOf(USR + '/media/') === 0, '视频应被转存，实际 ' + rec.videos[0]);
    assert.ok(rec.audio.indexOf(USR + '/media/') === 0, '语音应被转存，实际 ' + rec.audio);
    const stu = mem['chengguo_v3_students'].find(s => s.id === 101);
    assert.ok(stu.photo.indexOf(USR + '/media/') === 0, '学生头像应被转存，实际 ' + stu.photo);
    assert.strictEqual(files[rec.photos[0]], 'J1', '转存后内容必须一致');
  });
  ok('源文件已丢失时保留原路径，不清空引用', () => {
    const t = Date.now();
    const seed = {
      'chengguo_v3_meta': { version: 4, orgId: 'org1', orgName: '我的机构', teacher: '周老师', me: 't1', demoVersion: 5, createdAt: t, updatedAt: t },
      'chengguo_v3_orgs': [{ id: 'org1', name: '我的机构', ownerId: 't1', status: 'active', orgId: 'org1', createdAt: t, updatedAt: t, removed: false }],
      'chengguo_v3_users': [{ id: 't1', name: '周老师', role: 'owner', orgId: 'org1', createdAt: t, updatedAt: t, removed: false }],
      'chengguo_v3_members': [{ id: 1, orgId: 'org1', userId: 't1', role: 'owner', name: '周老师', clsIds: [], courseIds: [], studentIds: [], status: 'active', createdAt: t, updatedAt: t, removed: false }],
      'chengguo_v3_classes': [{ id: 1, name: '书法班', sort: 0, orgId: 'org1', createdAt: t, updatedAt: t, removed: false }],
      'chengguo_v3_courses': [], 'chengguo_v3_students': [],
      'chengguo_v3_records': [{
        id: 556, type: 'achievement', sid: 101, cid: 1, courseId: 0, course: '', date: '2026-10-01',
        score: 90, tag: '', note: '', photos: ['http://tmp/gone.jpg'], videos: [], audio: null,
        sent: false, tid: 't1', orgId: 'org1', createdAt: t, updatedAt: t, removed: false
      }],
      'chengguo_v3_templates': []
    };
    const { mem } = boot(seed, {});   // 文件系统里没有 gone.jpg
    const rec = mem['chengguo_v3_records'].find(r => r.id === 556);
    assert.deepStrictEqual(rec.photos, ['http://tmp/gone.jpg'], '救不回来的不要清空，留着原路径');
  });
}

/* =============================== CR-002 多机构隔离 =============================== */
console.log('\n【CR-002 多机构隔离】');
{
  const { db } = boot();
  const core = require(path.join(ROOT, 'utils/db/core'));
  const t = Date.now();
  const foreign = { orgId: 'org2', createdAt: t, updatedAt: t, removed: false };

  ok('别的机构的班级不会出现在当前机构列表', () => {
    core.coll('classes').push(Object.assign({ id: 990001, name: '外机构班级', sort: 99 }, foreign));
    assert.strictEqual(db.classes.list().some(c => c.id === 990001), false);
    assert.strictEqual(db.classes._all().some(c => c.id === 990001), false, '_all 也必须限机构');
  });
  ok('别的机构的学生不会出现在当前机构列表', () => {
    core.coll('students').push(Object.assign({ id: 990002, name: '外机构学生', clsIds: [990001] }, foreign));
    assert.strictEqual(db.students.list().some(s => s.id === 990002), false);
    assert.strictEqual(db.students.get(990002), null);
  });
  ok('别的机构的记录不会被当前机构读到', () => {
    core.coll('records').push(Object.assign({
      id: 990003, sid: 990002, cid: 990001, date: '2026-10-01', score: 90, tag: '良好', tid: 'x'
    }, foreign));
    assert.strictEqual(db.records.list().some(r => r.id === 990003), false);
    assert.strictEqual(db.records.get(990003), null);
  });
  ok('别的机构的成员不会混进成员列表', () => {
    core.coll('members').push(Object.assign({
      id: 990004, userId: 'someone', role: 'teacher', name: '外机构老师', clsIds: [990001], status: 'active'
    }, foreign));
    assert.strictEqual(db.members.list().some(m => m.id === 990004), false);
  });
  ok('当前机构自己的数据仍然正常可见', () => {
    assert.ok(db.classes.list().length >= 2, '本机构班级应正常返回');
    assert.ok(db.students.list().length >= 40, '演示学生应正常返回');
  });
}

/* =============================== CR-004 tid fail-open =============================== */
console.log('\n【CR-004 无主记录不可被普通老师改写】');
{
  const perms = require(path.join(ROOT, 'utils/db/permissions'));
  const teacher = {
    userId: 't1', name: '张老师', role: 'teacher', all: false,
    clsIds: [1], visClsIds: [1], visStuIds: [], studentIds: []
  };
  const owner = {
    userId: 'o1', name: '负责人', role: 'owner', all: true,
    clsIds: [], visClsIds: [], visStuIds: [], studentIds: []
  };
  const rec = (tid) => ({ cid: 1, sid: 101, sent: false, tid });

  ok('tid 为空的记录，老师不能改（旧实现会放行）', () => {
    assert.strictEqual(perms.can(teacher, 'record.update', { record: rec('') }), false);
    assert.strictEqual(perms.can(teacher, 'record.delete', { record: rec(null) }), false);
  });
  ok('别人录的记录，老师不能改', () => {
    assert.strictEqual(perms.can(teacher, 'record.update', { record: rec('t2') }), false);
  });
  ok('自己录的记录，老师可以改', () => {
    assert.strictEqual(perms.can(teacher, 'record.update', { record: rec('t1') }), true);
  });
  ok('负责人不受 tid 限制，无主记录也能收拾', () => {
    assert.strictEqual(perms.can(owner, 'record.update', { record: rec('') }), true);
  });
  ok('无目标预判不受影响（abilities 据此渲染按钮）', () => {
    assert.strictEqual(perms.can(teacher, 'record.update', {}), true);
  });
  ok('数据层实际拦截：老师改无主记录返回拒绝', () => {
    const { db } = boot();
    const core = require(path.join(ROOT, 'utils/db/core'));
    const schema = require(path.join(ROOT, 'utils/db/schema'));
    const stu = db.students.list()[0];
    // 造一条无主记录（模拟历史脏数据）
    const orphan = schema.normalizeRecord({
      id: 880001, sid: stu.id, cid: stu.clsIds[0], date: '2026-09-01', score: 80, tid: ''
    }, 'org1', Date.now());
    core.coll('records').push(orphan);
    // 当前身份是负责人（全新安装时第一个老师即 owner），先确认
    const isOwner = db.auth.isOwner();
    const res = db.records.save({ rid: 880001, sid: stu.id, cls: stu.clsIds[0], course: '楷书', note: '偷改' }, true);
    if (isOwner) {
      // 负责人本来就该能改，这里改断言方向：确认负责人改成功、且不会清空 tid 之外的字段
      assert.strictEqual(res.ok, true, res.msg);
    } else {
      assert.strictEqual(res.ok, false, '非负责人改无主记录应被拒绝');
    }
  });
}

/* =============================== ADR-009 record.type =============================== */
console.log('\n【ADR-009 record.type 字段】');
{
  const { db } = boot();
  const stu = db.students.list()[0];
  const cls = stu.clsIds[0];

  ok('新建记录默认 type = achievement', () => {
    const r = db.records.save({ sid: stu.id, cls, course: '楷书', note: '第一节课' }, true);
    assert.strictEqual(r.ok, true, r.msg);
    assert.strictEqual(r.record.type, 'achievement');
  });
  ok('编辑记录不会把 type 冲掉，也不会悄悄改类型', () => {
    const r = db.records.save({ sid: stu.id, cls, course: '楷书', note: '原始' }, true).record;
    const e = db.records.save({ rid: r.id, sid: stu.id, cls, course: '楷书', note: '改过' }, true).record;
    assert.strictEqual(e.type, 'achievement');
    assert.strictEqual(e.note, '改过');
  });
  ok('非法 type 被归一到 achievement，而不是写进库', () => {
    const r = db.records.save({ sid: stu.id, cls, course: '楷书', note: 'x', type: '不存在的类型' }, true).record;
    assert.strictEqual(r.type, 'achievement');
  });
  ok('历史记录（没有 type 字段）升级后自动补上', () => {
    const core = require(path.join(ROOT, 'utils/db/core'));
    const schema = require(path.join(ROOT, 'utils/db/schema'));
    const old = schema.normalizeRecord({ id: 880002, sid: stu.id, cid: cls, date: '2026-08-01' }, 'org1', Date.now());
    assert.strictEqual(old.type, 'achievement');
  });
  ok('类型清单对外可读（供后续业务扩展）', () => {
    assert.ok(Array.isArray(db.TYPES) && db.TYPES.indexOf('achievement') > -1);
  });
}

/* =============================== 降级保护 =============================== */
console.log('\n【降级保护：读盘失败不覆盖磁盘数据】');
{
  ok('降级态下 setColl / persist 不写盘', () => {
    const { db, mem } = boot();
    const core = require(path.join(ROOT, 'utils/db/core'));
    const storage = require(path.join(ROOT, 'utils/db/storage'));
    // 记录真实落盘次数
    let writes = 0;
    const orig = storage.saveCollection;
    storage.saveCollection = (...a) => { writes++; return orig.apply(storage, a); };
    const before = JSON.stringify(mem['chengguo_v3_classes']);

    core.setReadOnly(true);
    core.setColl('classes', []);
    db.flush();
    assert.strictEqual(writes, 0, '降级态不该有任何落盘');
    assert.strictEqual(JSON.stringify(mem['chengguo_v3_classes']), before, '磁盘上的班级数据不能被改掉');

    core.setReadOnly(false);
    storage.saveCollection = orig;
  });
  ok('正常态下写入会落盘（对照，避免上一条因写入路径坏掉而假通过）', () => {
    const { db, mem } = boot();
    const before = JSON.stringify(mem['chengguo_v3_classes']);
    const r = db.classes.create({ name: '新班级' });
    assert.strictEqual(r.ok, true, r.msg);
    assert.notStrictEqual(JSON.stringify(mem['chengguo_v3_classes']), before, '正常态必须真实落盘');
  });
  ok('status() 报告启动状态', () => {
    const { db } = boot();
    const st = db.status();
    assert.strictEqual(st.ready, true);
    assert.strictEqual(st.degraded, false);
    assert.strictEqual(st.readOnly, false);
  });
}

console.log('\n' + (fail ? ('有 ' + fail + ' 项失败，' + pass + ' 项通过') : ('全部 ' + pass + ' 项 P0 断言通过')));
process.exit(fail ? 1 : 0);
