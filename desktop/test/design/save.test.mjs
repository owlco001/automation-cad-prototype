import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveDesignProject } from '../../src/design/save-service.ts';
import { writeDesignDraft, readDesignDraft, clearDesignDraft } from '../../src/design/draft-store.ts';
import { saveProject, openProject } from '../../electron/projects.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';
test('projects:save 参数含 design/config，成功后草稿清理', async () => {
  const design = synthMachine(parseMachineBrief('三工位锁螺丝机，10 件/分钟'));
  let payload;
  let cleared = 0;
  const result = await saveDesignProject(async (value) => { payload = value; return { ok: true, record: { id: 'design-1' } }; }, async () => { cleared += 1; }, { name: '设计一', process: 'screw', params: {}, parts: 1, massKg: null, envelope: [100,100,100], material: [], design, config: design.config });
  assert.equal(result.ok, true);
  assert.equal(payload.design, design);
  assert.equal(payload.config, design.config);
  assert.equal(cleared, 1);
});

test('真实工程保存保留旋转分度角及工程师输入来源', () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-rotary-range-test-'));
  const design = synthMachine(parseMachineBrief('四工位装配机，2 个气缸 2 个夹爪 4 个旋转轴'));
  const rotary = design.config.actuators.find((item) => item.kind === 'rotary');
  assert.ok(rotary);
  rotary.rotationRangeDeg = 123.5;
  rotary.rotationRangeSource = 'engineer-input';
  const saved = saveProject(dir, {
    name: '旋转角保存测试', process: 'assembly', parts: 1, design, config: design.config
  });
  assert.equal(saved.ok, true, saved.message);
  const project = JSON.parse(readFileSync(join(dir, 'projects', '旋转角保存测试', 'project.json'), 'utf8'));
  const stored = project.design.config.actuators.find((item) => item.id === rotary.id);
  assert.equal(stored.rotationRangeDeg, 123.5);
  assert.equal(stored.rotationRangeSource, 'engineer-input');
});

test('保存失败不清草稿', async () => {
  let cleared = 0;
  const result = await saveDesignProject(async () => ({ ok: false, message: '磁盘满' }), async () => { cleared += 1; }, {});
  assert.equal(result.ok, false);
  assert.equal(cleared, 0);
});
test('草稿0600原子写、损坏恢复与删除', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'design-draft-test-'));
  writeDesignDraft(dir, { version: 1, step: 1 });
  if (process.platform === 'win32') {
    // Windows 无 POSIX 模式位：stat().mode 恒为 0o666，0600 断言不可移植。
    // 只跳过权限位这一条，下面的读写往返/存在性/删除断言照跑；POSIX 权限语义由 Linux unit job 覆盖。
    t.diagnostic('Windows 无 POSIX 模式位，跳过 0600 断言（Linux unit job 覆盖）');
  } else {
    assert.equal(statSync(join(dir, 'design-draft.json')).mode & 0o777, 0o600);
  }
  assert.equal(readDesignDraft(dir).draft.version, 1);
  assert.equal(existsSync(join(dir, 'design-draft.json')), true);
  clearDesignDraft(dir);
  assert.equal(existsSync(join(dir, 'design-draft.json')), false);
});
test('真实工程库写入 design/config 和 STL，打开可恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-project-test-'));
  const design = synthMachine(parseMachineBrief('三工位锁螺丝机，10 件/分钟'));
  const stlData = new Uint8Array(84);
  new DataView(stlData.buffer).setUint32(80, 0, true);
  const placements = [{ id: 'station:station-1', partId: 'station:station-1', model: '上料', x: 123, y: 456, w: 280, h: 140, tag: 'station', note: '工位' }];
  const saved = saveProject(dir, { name: '整机测试', process: 'screw', parts: 1, design, config: design.config, stlData, placements });
  assert.equal(saved.ok, true, saved.message);
  const record = JSON.parse(readFileSync(join(dir, 'projects', '整机测试', 'project.json'), 'utf8'));
  const designFile = JSON.parse(readFileSync(join(dir, 'projects', '整机测试', 'design.json'), 'utf8'));
  assert.equal(record.design.config.id, design.config.id);
  assert.deepEqual(designFile.placements, placements, '手工二维坐标应单独写入工程设计数据');
  assert.equal(existsSync(join(dir, 'projects', '整机测试', 'model.stl')), true);
  assert.equal(openProject(dir, saved.record.id).ok, true);
});

test('项目保存后导入会重新校验 engineer-input 的公共时间确认字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'design-cycle-import-test-'));
  const design = synthMachine(parseMachineBrief('三工位锁螺丝机，10 件/分钟'));
  design.cycle.source = 'engineer-input';
  design.cycle.stationCycleInputs = design.config.stations.map((stationName, index) => ({
    stationId: `station-${index + 1}`,
    stationName,
    seconds: 2 + index,
    sharedTimeConfirmed: true,
    source: 'engineer-input',
    verification: 'pending-measurement'
  }));
  const saved = saveProject(dir, {
    name: '周期口径导入测试',
    process: 'screw',
    parts: 1,
    design,
    config: design.config,
    placements: [{ id: 'station-1', partId: 'station-1', model: '工位 1', x: 0, y: 0, w: 100, h: 100 }]
  });
  assert.equal(saved.ok, true, saved.message);

  const designPath = join(dir, 'projects', '周期口径导入测试', 'design.json');
  const projectDocument = JSON.parse(readFileSync(designPath, 'utf8'));
  delete projectDocument.design.cycle.stationCycleInputs[0].sharedTimeConfirmed;
  writeFileSync(designPath, JSON.stringify(projectDocument));

  const opened = openProject(dir, saved.record.id);
  assert.equal(opened.ok, true);
  assert.equal(opened.layoutEditable, false);
  assert.match(opened.layoutMessage, /机器设计数据无效/);
});
