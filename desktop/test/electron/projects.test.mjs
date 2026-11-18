import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { deleteProject, listProjects, openProject, projectsRoot, saveProject, saveProjectLayout } from '../../electron/projects.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { parseMachineBrief } from '../../src/machine/spec.ts';

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'cad-projects-'));
  roots.push(root);
  const step = join(root, 'model.step');
  const stl = join(root, 'model.stl');
  writeFileSync(step, 'STEP-BYTES');
  writeFileSync(stl, 'STL-BYTES');
  const partA = join(root, '01-rail.stl');
  const partB = join(root, '02-cross.stl');
  writeFileSync(partA, 'A');
  writeFileSync(partB, 'B');
  return { root, step, stl, partA, partB };
}

function save(root, extra = {}) {
  const files = workspaceFiles.get(root);
  return saveProject(root, {
    name: '皮带输送线 2400×400',
    process: 'conveyor',
    params: { lengthMm: 2400, widthMm: 400 },
    parts: 2,
    massKg: 85.41,
    envelope: [2450, 695, 930],
    material: ['铝型材 6063-T5'],
    stepPath: files.step,
    stlPath: files.stl,
    partPaths: [
      { name: '侧纵梁（操作侧）', path: files.partA },
      { name: '横撑 1', path: files.partB }
    ],
    ...extra
  });
}

const workspaceFiles = new Map();

function setup() {
  const files = workspace();
  workspaceFiles.set(files.root, files);
  return files;
}

test('保存后出现在列表里，STEP/STL/逐件网格都落到工程目录', () => {
  const { root } = setup();
  const saved = save(root);
  assert.equal(saved.ok, true);
  assert.equal(saved.record?.parts, 2);
  assert.equal(saved.record?.massKg, 85.41);
  assert.ok(existsSync(join(projectsRoot(root), saved.record.id, 'model.step')));
  assert.ok(existsSync(join(projectsRoot(root), saved.record.id, 'model.stl')));
  assert.equal(saved.record.partsList.length, 2);
  assert.equal(saved.record.hasStep, true);

  const list = listProjects(root);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, '皮带输送线 2400×400');
});

test('同名保存覆盖，不堆副本；零件数变小后旧网格被清掉', () => {
  const { root } = setup();
  save(root);
  save(root, { parts: 1, partPaths: [{ name: '只有一个', path: workspaceFiles.get(root).partA }] });
  const list = listProjects(root);
  assert.equal(list.length, 1, '同名应覆盖');
  assert.equal(list[0].parts, 1);
  assert.equal(list[0].partsList.length, 1);

  const opened = openProject(root, list[0].id);
  assert.equal(opened.ok, true);
  assert.equal(opened.partPaths.length, 1, '残留的逐件网格必须清掉');
});

test('重新打开按零件序返回路径与中文零件名', () => {
  const { root } = setup();
  const saved = save(root);
  const opened = openProject(root, saved.record.id);
  assert.equal(opened.ok, true);
  assert.equal(opened.record.name, '皮带输送线 2400×400');
  assert.deepEqual(opened.partPaths.map((item) => item.name), ['侧纵梁（操作侧）', '横撑 1']);
  for (const item of opened.partPaths) assert.ok(existsSync(item.path));
  assert.ok(opened.stepPath && existsSync(opened.stepPath));
});

test('工程名里的路径分隔符等非法字符被清理，不会写到目录外', () => {
  const { root } = setup();
  const saved = save(root, { name: '../../逃逸/皮带线' });
  assert.equal(saved.ok, true);
  const dir = join(projectsRoot(root), saved.record.id);
  assert.ok(dir.startsWith(projectsRoot(root)), '工程目录必须在 projects 根目录下');
  assert.ok(!saved.record.id.includes('/'));
});

test('空名字被拒绝；不存在的工程打开/删除给出原因', () => {
  const { root } = setup();
  assert.equal(save(root, { name: '   ' }).ok, false);
  assert.equal(openProject(root, '不存在').ok, false);
  assert.match(openProject(root, '不存在').message ?? '', /不存在/);
  assert.equal(deleteProject(root, '不存在').ok, false);
});

test('删除工程连同文件一起移除', () => {
  const { root } = setup();
  const saved = save(root);
  const dir = join(projectsRoot(root), saved.record.id);
  assert.ok(existsSync(dir));
  assert.equal(deleteProject(root, saved.record.id).ok, true);
  assert.ok(!existsSync(dir));
  assert.equal(listProjects(root).length, 0);
});

test('损坏的 project.json 不会让列表崩掉，也不冒充工程', () => {
  const { root } = setup();
  const saved = save(root);
  writeFileSync(join(projectsRoot(root), saved.record.id, 'project.json'), '{ 坏掉的 json');
  assert.deepEqual(listProjects(root), []);
});

test('列表按创建时间倒序，新的在最前', () => {
  const { root } = setup();
  const first = save(root, { name: '老工程' });
  // 直接改时间，避免依赖真实时钟
  const path = join(projectsRoot(root), first.record.id, 'project.json');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  record.createdAt = '2026-01-01T00:00:00.000Z';
  writeFileSync(path, JSON.stringify(record));
  save(root, { name: '新工程' });
  const list = listProjects(root);
  assert.equal(list[0].name, '新工程');
  assert.equal(list[1].name, '老工程');
});

test('重新打开设计工程会恢复二维 placements 且 design.json schema 保持兼容', () => {
  const { root } = setup();
  const design = synthMachine(parseMachineBrief('三工位锁螺丝机，10 件/分钟'));
  const placements = [{ id: 'station:station-1', partId: 'station:station-1', model: '上料工位', x: 123, y: 456, w: 280, h: 140, tag: '工位', note: '进料' }];
  const saved = save(root, { design, config: design.config, placements });
  assert.equal(saved.ok, true, saved.message);
  const path = join(projectsRoot(root), saved.record.id, 'design.json');
  const designFile = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(designFile).sort(), ['design', 'placements']);

  const opened = openProject(root, saved.record.id);
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.placements, placements);
});

test('已保存布局可只改坐标并写回，design.json schema 与机器设计保持不变', () => {
  const { root } = setup();
  const design = synthMachine(parseMachineBrief('三工位锁螺丝机，10 件/分钟'));
  const placements = [{ id: 'station:station-1', partId: 'station:station-1', model: '上料工位', x: 123, y: 456, w: 280, h: 140, tag: '工位', note: '进料' }];
  const saved = save(root, { design, config: design.config, placements });
  const path = join(projectsRoot(root), saved.record.id, 'design.json');
  const beforeBytes = readFileSync(path, 'utf8');
  const before = JSON.parse(beforeBytes);
  const opened = openProject(root, saved.record.id);
  assert.equal(opened.layoutEditable, true);
  assert.match(opened.layoutFingerprint, /^[a-f0-9]{64}$/);

  const invalid = opened.placements.map((item) => ({ ...item, x: 1_000_000 }));
  const refused = saveProjectLayout(root, saved.record.id, opened.layoutFingerprint, invalid);
  assert.equal(refused.ok, false);
  assert.equal(readFileSync(path, 'utf8'), beforeBytes, '非法坐标不能触碰原工程文件');
  const outsideEnvelope = opened.placements.map((item) => ({ ...item, x: 2_400 }));
  const outsideRefused = saveProjectLayout(root, saved.record.id, opened.layoutFingerprint, outsideEnvelope);
  assert.equal(outsideRefused.ok, false);
  assert.match(outsideRefused.message ?? '', /超出项目包络/);
  assert.equal(readFileSync(path, 'utf8'), beforeBytes, '越出项目包络的布局不能触碰原工程文件');
  const metadataEdit = opened.placements.map((item) => ({ ...item, model: '不允许改名' }));
  assert.equal(saveProjectLayout(root, saved.record.id, opened.layoutFingerprint, metadataEdit).ok, false);
  assert.equal(readFileSync(path, 'utf8'), beforeBytes, '布局写回接口只能改变现有项目的坐标');

  const edited = opened.placements.map((item) => ({ ...item, x: 333.5, y: 500.25 }));
  const result = saveProjectLayout(root, saved.record.id, opened.layoutFingerprint, edited);
  assert.equal(result.ok, true, result.message);
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
  const reopened = openProject(root, saved.record.id);
  assert.deepEqual(reopened.placements, edited);
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(after).sort(), ['design', 'placements']);
  assert.deepEqual(after.design, before.design);
  assert.deepEqual(after.placements, edited);
});

test('工程包络缺失时布局可以读取但不能写回', () => {
  const { root } = setup();
  const design = synthMachine(parseMachineBrief('三工位锁螺丝机，10 件/分钟'));
  const placements = [{ id: 'station:station-1', partId: 'station:station-1', model: '上料工位', x: 123, y: 456, w: 280, h: 140 }];
  const saved = save(root, { design, config: design.config, placements, envelope: null });
  assert.equal(saved.ok, true);
  const opened = openProject(root, saved.record.id);
  assert.equal(opened.layoutEditable, true);
  const path = join(projectsRoot(root), saved.record.id, 'design.json');
  const beforeBytes = readFileSync(path, 'utf8');
  const refused = saveProjectLayout(root, saved.record.id, opened.layoutFingerprint, opened.placements.map((item) => ({ ...item, x: 124 })));
  assert.equal(refused.ok, false);
  assert.match(refused.message ?? '', /包络尺寸缺失/);
  assert.equal(readFileSync(path, 'utf8'), beforeBytes);
});

test('基于旧指纹的布局保存被拒绝，且不覆盖另一窗口已保存的修改', () => {
  const { root } = setup();
  const design = synthMachine(parseMachineBrief('三工位锁螺丝机，10 件/分钟'));
  const placements = [{ id: 'station:station-1', partId: 'station:station-1', model: '上料工位', x: 123, y: 456, w: 280, h: 140 }];
  const saved = save(root, { design, config: design.config, placements });
  const path = join(projectsRoot(root), saved.record.id, 'design.json');
  const firstWindow = openProject(root, saved.record.id);
  const secondWindow = openProject(root, saved.record.id);
  const newer = secondWindow.placements.map((item) => ({ ...item, x: 400, y: 500 }));
  const newerSave = saveProjectLayout(root, saved.record.id, secondWindow.layoutFingerprint, newer);
  assert.equal(newerSave.ok, true, newerSave.message);
  const latestBytes = readFileSync(path, 'utf8');

  const stale = firstWindow.placements.map((item) => ({ ...item, x: 700, y: 800 }));
  const rejected = saveProjectLayout(root, saved.record.id, firstWindow.layoutFingerprint, stale);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.conflict, true);
  assert.match(rejected.message, /已被其他操作修改/);
  assert.equal(readFileSync(path, 'utf8'), latestBytes);
  assert.deepEqual(openProject(root, saved.record.id).placements, newer);
});

test('旧工程、损坏 design.json 与无效坐标都不能被布局保存覆盖', () => {
  const { root } = setup();
  const legacy = save(root);
  const legacyPath = join(projectsRoot(root), legacy.record.id, 'design.json');
  const legacyProjectBytes = readFileSync(join(projectsRoot(root), legacy.record.id, 'project.json'), 'utf8');
  const legacyOpened = openProject(root, legacy.record.id);
  assert.equal(legacyOpened.layoutEditable, false);
  assert.equal(existsSync(legacyPath), false);
  const legacySave = saveProjectLayout(root, legacy.record.id, 'a'.repeat(64), []);
  assert.equal(legacySave.ok, false);
  assert.equal(existsSync(legacyPath), false);
  assert.equal(readFileSync(join(projectsRoot(root), legacy.record.id, 'project.json'), 'utf8'), legacyProjectBytes);

  const design = synthMachine(parseMachineBrief('三工位锁螺丝机，10 件/分钟'));
  const placements = [{ id: 'station:station-1', partId: 'station:station-1', model: '上料工位', x: 123, y: 456, w: 280, h: 140 }];
  const bad = save(root, { name: '坏布局工程', design, config: design.config, placements });
  const badPath = join(projectsRoot(root), bad.record.id, 'design.json');
  writeFileSync(badPath, '{坏 JSON');
  const damagedBytes = readFileSync(badPath, 'utf8');
  const damagedOpen = openProject(root, bad.record.id);
  assert.equal(damagedOpen.ok, true, '坏布局不应阻止工程重新打开');
  assert.equal(damagedOpen.layoutEditable, false);
  assert.equal(saveProjectLayout(root, bad.record.id, 'b'.repeat(64), placements).ok, false);
  assert.equal(readFileSync(badPath, 'utf8'), damagedBytes);

  const invalid = { design, placements: [{ ...placements[0], x: 1_000_000 }] };
  writeFileSync(badPath, JSON.stringify(invalid));
  const invalidBytes = readFileSync(badPath, 'utf8');
  const invalidOpen = openProject(root, bad.record.id);
  assert.equal(invalidOpen.layoutEditable, false);
  assert.deepEqual(invalidOpen.placements, []);
  assert.equal(saveProjectLayout(root, bad.record.id, 'c'.repeat(64), placements).ok, false);
  assert.equal(readFileSync(badPath, 'utf8'), invalidBytes);
});

test('旧工程或损坏的 design.json 以空布局打开，不影响三维工程', () => {
  const { root } = setup();
  const saved = save(root);
  assert.deepEqual(openProject(root, saved.record.id).placements, []);
  assert.equal(openProject(root, saved.record.id).layoutEditable, false);
  writeFileSync(join(projectsRoot(root), saved.record.id, 'design.json'), '{坏 JSON');
  const opened = openProject(root, saved.record.id);
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.placements, []);
  assert.equal(opened.layoutEditable, false);
});

test('saveProject：partData 带装配层级路径时写进 partsList，脏数据被清洗', () => {
  const root = mkdtempSync(join(tmpdir(), 'cad-projects-path-'));
  roots.push(root);
  const stl = new Uint8Array([1, 2, 3, 4]);
  const result = saveProject(root, {
    name: '层级工程',
    process: 'cad-import',
    parts: 2,
    partData: [
      { name: '立柱-左前', data: stl, path: ['光伏缓存堆叠单元', '机架'] },
      { name: '托条-01', data: stl, path: ['光伏缓存堆叠单元', '', 42, '堆叠单元'] }
    ]
  });
  assert.equal(result.ok, true);
  const list = result.record.partsList;
  assert.deepEqual(list[0].path, ['光伏缓存堆叠单元', '机架']);
  assert.deepEqual(list[1].path, ['光伏缓存堆叠单元', '堆叠单元'], '空段与非字符串被剔除');
});

test('saveProject：没有 path 时不写该字段（旧工程结构不变）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cad-projects-nopath-'));
  roots.push(root);
  const result = saveProject(root, {
    name: '无层级工程',
    process: 'cad-import',
    parts: 1,
    partData: [{ name: '件', data: new Uint8Array([9]) }]
  });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.record.partsList[0], 'path'), false);
});

test('saveProject：路径超过 8 级只保留前 8 级', () => {
  const root = mkdtempSync(join(tmpdir(), 'cad-projects-deep-'));
  roots.push(root);
  const deep = Array.from({ length: 12 }, (_, index) => `L${index + 1}`);
  const result = saveProject(root, {
    name: '深层级工程',
    process: 'cad-import',
    parts: 1,
    partData: [{ name: '件', data: new Uint8Array([7]), path: deep }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.record.partsList[0].path.length, 8);
  assert.equal(result.record.partsList[0].path[7], 'L8');
});

/* ---------------- 缓存塔：只给 config 的落库路径（config.bufferTower 三层对象不许丢） ---------------- */

/** 塔配置：panel/inbound/frame 三层对象正是 `params` 装不下、只能靠 design/config 落盘的部分。 */
const TOWER_BLOCK = {
  kind: 'tower',
  towers: 1,
  slotsPerTower: 2,
  levels: 2,
  slotsPerLevel: 1,
  layerPitchMm: 180,
  panel: { lengthMm: 2278, widthMm: 1134, thicknessMm: 35, massKg: 32 },
  inbound: { lengthMm: 2400, widthMm: 1200, beltHeightMm: 900 },
  frame: { material: 'AL6063', sectionMm: 40 }
};
/** 渲染层补齐机型级字段后的 config（`towerSaveConfigFor` 的产物形状）。 */
const TOWER_CONFIG = {
  id: 'buffer-tower-2l',
  name: '缓存塔 2 层',
  stations: ['进出料'],
  actuators: [],
  sensors: [],
  bufferTower: TOWER_BLOCK
};

test('只给 config 的塔工程：保存后用 openProject 拿回完整 config.bufferTower（panel/inbound/frame 都在）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cad-projects-tower-'));
  roots.push(root);
  const saved = saveProject(root, { name: '塔 config 工程', process: 'buffer-tower', parts: 48, config: TOWER_CONFIG });
  assert.equal(saved.ok, true, saved.message);

  const designFile = JSON.parse(readFileSync(join(projectsRoot(root), saved.record.id, 'design.json'), 'utf8'));
  assert.deepEqual(Object.keys(designFile).sort(), ['design', 'placements']);
  assert.deepEqual(designFile.design.config.bufferTower.panel, TOWER_BLOCK.panel, 'panel 不许被丢掉/改成数字列');
  assert.deepEqual(designFile.design.config.bufferTower.inbound, TOWER_BLOCK.inbound, 'inbound 不许丢');
  assert.deepEqual(designFile.design.config.bufferTower.frame, TOWER_BLOCK.frame, 'frame 不许丢');

  const opened = openProject(root, saved.record.id);
  assert.equal(opened.ok, true, opened.message);
  const tower = opened.record.design.config.bufferTower;
  assert.equal(tower.levels, TOWER_BLOCK.levels);
  assert.equal(tower.layerPitchMm, TOWER_BLOCK.layerPitchMm);
  assert.deepEqual(tower.panel, TOWER_BLOCK.panel);
  assert.deepEqual(tower.inbound, TOWER_BLOCK.inbound);
  assert.deepEqual(tower.frame, TOWER_BLOCK.frame);
  assert.equal(opened.record.process, 'buffer-tower');
});

/**
 * 边界（为什么渲染层必须先补齐机型级字段）：裸 `{ bufferTower }` 两条路都被拒。
 * - 当 design：`validateMachineDesign` 报「缺少必填参数：机型配置.stations」——
 *   这就是 `build_machine_model({config})` 曾出现的 `project.saved=false`；
 * - 直接当 config：`validateMachineConfig` 同一口径，也要 stations/actuators/sensors。
 */
test('裸 {bufferTower} 当 design 或当 config 都会被拒（参数没进库的原始缺陷形态）', () => {
  const root = mkdtempSync(join(tmpdir(), 'cad-projects-bare-tower-'));
  roots.push(root);
  const bare = { bufferTower: TOWER_BLOCK };
  const asDesign = saveProject(root, { name: '裸塔当 design', process: 'buffer-tower', parts: 48, design: { config: bare } });
  assert.equal(asDesign.ok, false);
  assert.match(asDesign.message ?? '', /缺少必填参数：机型配置\.stations/);
  const asConfig = saveProject(root, { name: '裸塔当 config', process: 'buffer-tower', parts: 48, config: bare });
  assert.equal(asConfig.ok, false);
  assert.match(asConfig.message ?? '', /缺少必填参数：机型配置\.stations/);
  assert.deepEqual(listProjects(root), [], '被拒的保存不许留下半个工程');
});
