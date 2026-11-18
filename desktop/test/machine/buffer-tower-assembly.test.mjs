/**
 * 缓存塔几何（buffer-tower-assembly）测试。
 *
 * 这批用例锁的是「16 个货位的静态几何存在」这件事的**可复核数字**：
 * 146 件 / 包络 / 15 件托板 / slots 16 与可用 15 / 导柱到顶 / 截面升级 / 静态重叠类不新增。
 * 它们**不**证明结构安全、动态干涉、消防合规或吞吐 —— 那些结论没有用例，也不该被写进回执。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BufferTowerConfigError,
  MAX_BUFFER_TOWER_LEVELS,
  bufferTowerInboundParams,
  bufferTowerParamsFromConfig,
  bufferTowerSlots,
  buildBufferTowerParts
} from '../../src/machine/buffer-tower-assembly.ts';
import { buildConveyorParts, conveyorEnvelope } from '../../src/machine/conveyor-assembly.ts';
import {
  assertTowerAboveGround,
  conveyorJointReason,
  conveyorJoints,
  partWorldBounds,
  resolveMachineGeometry
} from '../../src/machine/machine-geometry.ts';
import { runInterferenceStates } from '../../src/machine/interference-states.ts';
import { buildLinkage } from '../../src/machine/linkage.ts';
import { formatLinkageView } from '../../src/machine/linkage-view.ts';
import { validateDesign } from '../../src/machine/validate.ts';
import { AgentTools } from '../../src/agent/tools.ts';

/** 探针实测的 16 位最小解（单塔 / 16 层 / 每层 1 位）。 */
const TOWER16 = Object.freeze({
  kind: 'tower',
  towers: 1,
  slotsPerTower: 16,
  levels: 16,
  slotsPerLevel: 1,
  layerPitchMm: 180,
  panel: { lengthMm: 2278, widthMm: 1134, thicknessMm: 35, massKg: 32 },
  inbound: { lengthMm: 2400, widthMm: 1200, beltHeightMm: 900 },
  frame: { material: 'AL6063', sectionMm: 40 }
});

const params16 = () => bufferTowerParamsFromConfig({ bufferTower: TOWER16 });
const parts16 = () => buildBufferTowerParts(params16());

/** 整机 config：塔的 formId 仍是 belt-line（第 1 层就是那条输送线）。 */
function towerMachineConfig(overrides = {}) {
  return {
    id: 'design-conveyor-1st',
    name: '光伏组件单塔缓存机（方案草案）',
    stations: ['进出料'],
    actuators: [],
    sensors: [],
    formId: 'belt-line',
    conveyor: { lengthMm: 2400, widthMm: 1200, beltHeightMm: 900, layers: 1, layerPitchMm: 180 },
    bufferTower: { ...TOWER16, ...overrides }
  };
}

/** 件号归一族：层号/左右前后→占位符，用来比对「重叠类集合」而不是逐件坐标。 */
function family(id) {
  return id
    .replace(/-(fl|fr|bl|br)$/, '')
    .replace(/-(left|right|front|back|in|out)$/, '')
    .replace(/-\d+-/g, '-#-')
    .replace(/-\d+$/, '');
}

/** AABB 真重叠（三轴都 > 0.5 mm，与干涉初筛同一口径）的件对，按「族 × 族」归类。 */
function overlapClasses(parts) {
  const boxes = parts.map(partWorldBounds);
  const classes = new Map();
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      let overlapping = true;
      for (let axis = 0; axis < 3; axis += 1) {
        const overlap = Math.min(boxes[i].max[axis], boxes[j].max[axis]) - Math.max(boxes[i].min[axis], boxes[j].min[axis]);
        if (overlap <= 0.5) {
          overlapping = false;
          break;
        }
      }
      if (!overlapping) continue;
      const key = [family(parts[i].id), family(parts[j].id)].sort().join(' × ');
      classes.set(key, (classes.get(key) ?? 0) + 1);
    }
  }
  return classes;
}

test('16 位最小解：146 件 / 包络 2430×1790×3840 / 15 件托板 / 货位 16', () => {
  const params = params16();
  const parts = buildBufferTowerParts(params);
  assert.equal(parts.length, 146);
  assert.deepEqual(conveyorEnvelope(parts), [2430, 1790, 3840]);
  assert.equal(parts.filter((part) => /^tray-\d+$/.test(part.id)).length, 15);
  const slots = bufferTowerSlots(params, parts);
  assert.equal(slots.fromGeometry, 16);
  assert.equal(slots.claimed, 16);
  assert.equal(slots.aligned, true);
  assert.equal(slots.usableStorage, 15, '第 1 层是进出料位，可用储位必须比货位少 1');
  assert.equal(slots.transferLevels, 1);
  // 8 层旧语义不变：同一套件号规则下 8 层塔仍是 90 件（与 conveyor-assembly 的 8 层同件数）
  const legacy8 = buildConveyorParts({ lengthMm: 2400, widthMm: 1200, beltHeightMm: 900, layers: 8, layerPitchMm: 180 });
  assert.equal(legacy8.length, 90);
  assert.deepEqual(conveyorEnvelope(legacy8), [2430, 1690, 2400], '8 层参数化路径零回归（包络不变）');
  const tower8 = buildBufferTowerParts(bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, slotsPerTower: 8, levels: 8 } }));
  assert.equal(tower8.length, 90, '塔身建造器在 8 层也应给出 90 件（件号规则一致）');
});

test('货位数从件表逐层派生：缺层/多件/多余层号一律抛错，slotsPerLevel 不是回声', () => {
  const params = params16();
  const parts = buildBufferTowerParts(params);
  const slots = bufferTowerSlots(params, parts);
  assert.equal(slots.trayCount, 15);
  assert.equal(slots.levelsFromGeometry, 16);
  assert.equal(slots.slotsPerLevelFromGeometry, 1, '每层托板件数 = 每层储位数（几何派生）');
  assert.equal(slots.towersFromGeometry, 1, '4 根立柱 = 1 塔（几何派生）');
  // 1) 单块托板缺失：托板族缺第 9 层 → 抛错
  assert.throws(() => bufferTowerSlots(params, parts.filter((part) => part.id !== 'tray-9')), /缺第 9 层/);
  // 2) **整层丢件**（P1-1 的原漏洞）：托板/托条/挡停/光电/辊一起删。
  //    旧实现只比「托板件数 vs 层光电件数」，两边同时 −1 校验恒相等 → 返回 15 位 + aligned:false 的 ok。
  const wholeLayerGone = parts.filter((part) => !/^(tray|tray-rail|tray-roller|stop|layer-sensor)-9(-|$)/.test(part.id));
  assert.throws(
    () => bufferTowerSlots(params, wholeLayerGone),
    (error) => {
      assert.equal(error.name, 'BufferTowerGeometryError', '几何与参数矛盾属建造器缺陷，不是调用方参数问题');
      assert.ok(!(error instanceof RangeError), '不能继承 RangeError：否则 design_machine 会误报 INVALID_ARGUMENT');
      assert.match(error.message, /缺第 9 层/);
      return true;
    }
  );
  // 3) 只删一个独立件族（托条）：旧实现完全看不见，现在抛错
  assert.throws(() => bufferTowerSlots(params, parts.filter((part) => !/^tray-rail-9-/.test(part.id))), /托条 tray-rail-\* 缺第 9 层/);
  assert.throws(() => bufferTowerSlots(params, parts.filter((part) => part.id !== 'stop-9')), /挡停 stop-\* 缺第 9 层/);
  // 4) 多件：同一层两块托板 / 多出一个层号
  assert.throws(
    () => bufferTowerSlots(params, [...parts, parts.find((part) => part.id === 'tray-9')]),
    /每层应 1 件，第 9 层（2 件）/
  );
  assert.throws(
    () => bufferTowerSlots(params, [...parts, { ...parts.find((part) => part.id === 'tray-9'), id: 'tray-99' }]),
    /多出第 99 层/
  );
  // 5) 塔数也对不上就抛错（4 根立柱一塔）
  assert.throws(() => bufferTowerSlots(params, parts.filter((part) => part.id !== 'column-fl')), /立柱 3 根/);
  // 6) slotsPerLevel 不是回声：把它改成 3，派生值仍只认「每层托板件数」= 1
  const echoThree = bufferTowerSlots({ ...params, slotsPerLevel: 3 }, parts);
  assert.equal(echoThree.slotsPerLevelFromGeometry, 1);
  assert.equal(echoThree.fromGeometry, 16, '旧实现会算成 16 × 3 = 48（凭空多一倍以上）');
  // 7) 反过来：参数层数（levels）与件表不一致时必须抛错 —— 这是「配置 8 层 / 几何 16 层」的唯一出口
  assert.throws(
    () => bufferTowerSlots({ ...params, levels: 8 }, parts),
    /多出第 9、10、11、12、13、14、15、16 层/
  );
});

test('容量不变量：levels × slotsPerLevel ≠ slotsPerTower 抛错并带算式', () => {
  assert.throws(
    () => bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, slotsPerTower: 15 } }),
    (error) => {
      assert.ok(error instanceof RangeError, '必须是 RangeError（design_machine 用它区分参数问题与内部缺陷）');
      assert.ok(error instanceof BufferTowerConfigError);
      assert.equal(error.code, 'CONFIG_CAPACITY_MISMATCH');
      assert.match(error.message, /levels 16 × slotsPerLevel 1 = 16 ≠ slotsPerTower 15/);
      return true;
    }
  );
});

test('拒夹紧：16 不会被静默改成 8；超 64 层直接抛错', () => {
  // 17 层 + 17 位：容量自洽，就必须真的建 17 层（而不是夹到 16 或 8）
  const p17 = bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, levels: 17, slotsPerTower: 17 } });
  assert.equal(p17.levels, 17);
  assert.equal(buildBufferTowerParts(p17).filter((part) => /^tray-\d+$/.test(part.id)).length, 16);
  // 层数 1：不构成塔
  assert.throws(() => bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, levels: 1, slotsPerTower: 1 } }), /不构成缓存塔/);
  // 层数 65：超上限，不许「按 64 处理」
  assert.throws(
    () => bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, levels: 65, slotsPerTower: 65 } }),
    new RegExp(`超过 ${MAX_BUFFER_TOWER_LEVELS} 层`)
  );
});

test('本期几何不支持的组合回 NOT_IMPLEMENTED，不按 1 位/单塔静默建', () => {
  assert.throws(
    () => bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, slotsPerLevel: 2, slotsPerTower: 32 } }),
    (error) => error.code === 'NOT_IMPLEMENTED' && /slotsPerLevel=2 未实现/.test(error.message)
  );
  assert.throws(
    () => bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, towers: 2 } }),
    (error) => error.code === 'NOT_IMPLEMENTED' && /towers=2/.test(error.message)
  );
});

test('层距 / 进料长度 / 板宽不变量全部 fail-loud', () => {
  assert.throws(() => bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, layerPitchMm: 150 } }), /超出 165~600 mm/);
  assert.throws(() => bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, layerPitchMm: 700 } }), /超出 165~600 mm/);
  assert.throws(
    () => bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, inbound: { ...TOWER16.inbound, lengthMm: 2300 } } }),
    /短于板材长 2278 \+ 余量 120 = 2398/
  );
  assert.throws(
    () => bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, inbound: { ...TOWER16.inbound, widthMm: 1100 } } }),
    /小于板材宽 1134/
  );
});

test('几何尺寸入参必须为正：负值/零值/非有限一律报错，不夹紧', () => {
  const withPanel = (patch) => bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, panel: { ...TOWER16.panel, ...patch } } });
  const withInbound = (patch) => bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, inbound: { ...TOWER16.inbound, ...patch } } });
  const withFrame = (frame) => bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, frame } });
  // P1-2 的原漏洞：这些输入以前全部被接受，其中 beltHeightMm=-900 会让整机落到地面以下 0.98 m 还回 ok:true
  for (const [label, run] of [
    ['inbound.beltHeightMm=-900', () => withInbound({ beltHeightMm: -900 })],
    ['inbound.beltHeightMm=0', () => withInbound({ beltHeightMm: 0 })],
    ['inbound.lengthMm=-500', () => withInbound({ lengthMm: -500 })],
    ['inbound.widthMm=0', () => withInbound({ widthMm: 0 })],
    ['panel.thicknessMm=-10', () => withPanel({ thicknessMm: -10 })],
    ['panel.lengthMm=-500', () => withPanel({ lengthMm: -500 })],
    ['panel.widthMm=-100', () => withPanel({ widthMm: -100 })],
    ['panel.massKg=-5', () => withPanel({ massKg: -5 })],
    ['frame.sectionMm=-40', () => withFrame({ material: 'AL6063', sectionMm: -40 })],
    ['frame.columnSectionMm=0', () => withFrame({ material: 'AL6063', sectionMm: 40, columnSectionMm: 0 })]
  ]) {
    assert.throws(
      run,
      (error) => {
        assert.equal(error.code, 'CONFIG_RANGE', `${label} 必须是 CONFIG_RANGE（带区间），不能静默接受`);
        assert.match(error.message, /一律不接受/, `${label} 的 message 必须说清「负值/零值不接受」`);
        return true;
      },
      `${label} 必须报错`
    );
  }
  // 非有限数属「形状/类型」而不是「范围」：错误码分开（CONFIG_SHAPE vs CONFIG_RANGE），但同样 fail-loud
  for (const [label, run] of [
    ['panel.lengthMm=Infinity', () => withPanel({ lengthMm: Number.POSITIVE_INFINITY })],
    ['panel.widthMm=NaN', () => withPanel({ widthMm: Number.NaN })]
  ]) {
    assert.throws(
      run,
      (error) => {
        assert.equal(error.code, 'CONFIG_SHAPE', `${label} 必须报错（非有限数）`);
        assert.match(error.message, /有限数字/);
        return true;
      },
      `${label} 必须报错`
    );
  }
  // 非数字形状仍是 CONFIG_SHAPE（与范围问题分开）
  assert.throws(() => withPanel({ massKg: '32' }), (error) => error.code === 'CONFIG_SHAPE');
  // 边界内侧必须仍然接受：beltHeight=100 是实测地面线（最低件 z=0），massKg=0 合法
  const edge = bufferTowerParamsFromConfig({
    bufferTower: { ...TOWER16, panel: { ...TOWER16.panel, massKg: 0 }, inbound: { ...TOWER16.inbound, beltHeightMm: 100 } }
  });
  const edgeParts = buildBufferTowerParts(edge);
  const minZ = Math.min(...edgeParts.map((part) => partWorldBounds(part).min[2]));
  assert.equal(minZ, 0, 'beltHeight=100 时最低件正好贴地面（再低就落到地面以下，故下限取 100）');
});

test('地面线守卫：零件落到地面以下必须抛错（运行时守卫，不是只在测试里验一次好参数）', () => {
  const params = params16();
  const parts = buildBufferTowerParts(params);
  assert.equal(assertTowerAboveGround(parts, params), 0, '16 层塔最低件贴地 z=0');
  // 建造器基准错位（整体下移 100 mm）必须被守卫咬住
  const sunken = parts.map((part) => ({ ...part, transform: { ...part.transform, z: part.transform.z - 100 } }));
  assert.throws(
    () => assertTowerAboveGround(sunken, params),
    (error) => {
      assert.equal(error.name, 'BufferTowerGeometryError');
      assert.match(error.message, /落到地面以下/);
      return true;
    }
  );
  // 参数层也挡住「皮带面太低」：beltHeight<100 时支腿/地脚会落到 z<0
  assert.throws(
    () => resolveMachineGeometry({ ...towerMachineConfig(), bufferTower: { ...TOWER16, inbound: { ...TOWER16.inbound, beltHeightMm: 50 } } }),
    (error) => error.code === 'CONFIG_RANGE'
  );
});

test('塔升降轴接入状态化干涉：rest/lift 都能跑，行程来源标 geometry（不再是 STATE_UNAVAILABLE）', () => {
  const config = towerMachineConfig();
  const geometry = resolveMachineGeometry(config).geometry;
  const axis = geometry.moving[0];
  assert.equal(axis.strokeSource, 'geometry', '塔轴行程由几何标注，不是 config 的 travelMm');
  assert.equal(axis.point, 'DI-TOWER-LIFT-LEVEL', '轴必须有点位（联动视图按它判能不能播放）');
  const outcome = runInterferenceStates({ states: ['rest', 'lift'], config, geometry });
  assert.equal(outcome.ok, true, 'P1-4 之前这里是 STATE_UNAVAILABLE（config.actuators 为空，找不到顶升轴）');
  assert.equal(outcome.lift.actuatorId, 'tower-lift');
  assert.equal(outcome.lift.strokeMm, 2700);
  assert.equal(outcome.lift.strokeSource, 'geometry', '回执必须能看出行程不是工程师给的伺服参数');
  assert.deepEqual(outcome.lift.partIds, ['lift-platform']);
  // lift 终点位姿：台面在顶层平面之上 90 mm（台面建模基准在层间中间位），不撞任何件
  assert.equal(outcome.states.lift.confirmedHits, 0, 'lift 终点位姿不该有确认命中');
  assert.equal(outcome.states.lift.screenHits, 0);
  // push 仍然不可用，但原因是「没有移载轴」，不是整次检查失败
  const push = runInterferenceStates({ states: ['push'], config, geometry });
  assert.equal(push.ok, true);
  assert.match(push.unavailable.push, /没有可移载的轴/);
});

test('塔升降轴 sweep：台面扫过各层托板会报命中（无升降通道，真实缺口，不许静默吞掉）', () => {
  const config = towerMachineConfig();
  const geometry = resolveMachineGeometry(config).geometry;
  const outcome = runInterferenceStates({ states: ['sweep'], config, geometry });
  assert.equal(outcome.ok, true);
  const sweep = outcome.states.sweep;
  assert.ok(sweep.confirmedHits > 0, '台面在托板投影内且层托板是整块板：sweep 必然命中，吞掉就是不诚实');
  const pairs = new Set(sweep.items.map((item) => `${item.a}|${item.b}`));
  assert.ok([...pairs].some((pair) => /tray-\d+/.test(pair)), '命中对里必须有 lift-platform × tray-*');
  assert.equal(outcome.reviewStatus, 'fail', '确认命中就判 fail：这是机构缺口，不是可放行的待复核');
  // 缺口必须在 note 里明说，读数字的人才知道它意味着什么
  assert.match(outcome.note, /没有升降通道/);
  assert.match(outcome.note, /strokeSource=geometry/);
});

test('塔升降轴进联动：buildLinkage 排出两步，轴有点位 → 联动视图不再报「没点位」', () => {
  const geometry = resolveMachineGeometry(towerMachineConfig()).geometry;
  const linkage = buildLinkage(geometry);
  assert.equal(linkage.steps.length, 2, 'extend + retract 两步');
  assert.deepEqual(linkage.steps.map((step) => step.actuatorId), ['tower-lift', 'tower-lift']);
  assert.deepEqual(linkage.steps.map((step) => step.direction), ['extend', 'retract']);
  assert.equal(linkage.steps[0].amount, 2700);
  const view = formatLinkageView(linkage);
  assert.equal(view.warnings.filter((warning) => /没有点位/.test(warning)).length, 0, '轴有点位就不该再报「联动播放不会驱动它们」');
});

test('两层「层数」不许并存：conveyor.layers>1 与 bufferTower 同时出现必须在 validate 层报错', () => {
  const config = towerMachineConfig();
  const bad = validateDesign({ ...config, conveyor: { ...config.conveyor, layers: 8 } });
  assert.equal(bad.ok, false, 'P1-5 之前这里 ok:true / issues 0，几何却出 16 层');
  assert.equal(bad.issues[0].code, 'BUFFER_TOWER_INVALID');
  assert.equal(bad.issues[0].path, 'config.conveyor.layers');
  assert.match(bad.issues[0].message, /layers=8，config\.bufferTower\.levels=16/);
  assert.match(bad.issues[0].hint, /必须是 1/);
  // layers=1 是唯一合法写法（塔的第 1 层就是那条输送线）
  assert.equal(validateDesign(config).ok, true);
  // 没有 bufferTower 时 conveyor.layers=8 照旧合法（旧语义不受影响）
  const legacy = { ...config };
  delete legacy.bufferTower;
  legacy.conveyor = { ...config.conveyor, layers: 8 };
  assert.equal(validateDesign(legacy).ok, true);
});

test('导柱够到顶层：postTop = 柱高 = 顶层托板 + 240（旧 8 层路径仍是 −560）', () => {
  const params = params16();
  assert.equal(params.topLayerZMm, 3600);
  assert.equal(params.postTopZMm, 3840);
  assert.ok(params.postTopZMm >= params.topLayerZMm + 240, '导柱顶必须 ≥ 顶层托板 + 240');
  const parts = buildBufferTowerParts(params);
  const post = parts.find((part) => part.id === 'lift-post-left');
  const postTop = post.transform.z + Number(post.features[0].params.height) / 2;
  assert.equal(postTop, 3840);
  // 旧路径零改动自证：conveyor-assembly 的 8 层导柱顶仍是 1600（比顶层 2160 低 560）
  const legacy = buildConveyorParts({ lengthMm: 2400, widthMm: 1200, beltHeightMm: 900, layers: 8, layerPitchMm: 180 });
  const legacyPost = legacy.find((part) => part.id === 'lift-post-left');
  const legacyTop = legacyPost.transform.z + Number(legacyPost.features[0].params.height) / 2;
  assert.equal(legacyTop, 1600, '旧 8 层建造器的导柱缺口本次不动');
  const legacyTray16 = legacy.find((part) => part.id === 'tray-8');
  assert.ok(legacyTop < legacyTray16.transform.z, '旧 8 层：导柱顶低于顶层托板（既有缺陷，如实保留）');
});

test('截面按柱高反算：3840→80、2400→50；显式更小直接抛错', () => {
  const p16 = params16();
  assert.equal(p16.columnHeightMm, 3840);
  assert.equal(p16.columnSectionMm, 80);
  assert.equal(p16.requiredColumnSectionMm, 80);
  assert.equal(p16.columnSectionSource, 'derived');
  const p8 = bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, slotsPerTower: 8, levels: 8 } });
  assert.equal(p8.columnHeightMm, 2400);
  assert.equal(p8.columnSectionMm, 50, 'max(40, ceil5(2400/48)) = 50');
  // 显式 40：出图不是出机器 —— 不夹到 80，直接拒绝
  assert.throws(
    () => bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, frame: { material: 'AL6063', sectionMm: 40, columnSectionMm: 40 } } }),
    /屈曲临界不足/
  );
  // 显式更大：接受并回显来源
  const p100 = bufferTowerParamsFromConfig({ bufferTower: { ...TOWER16, frame: { material: 'AL6063', sectionMm: 40, columnSectionMm: 100 } } });
  assert.equal(p100.columnSectionMm, 100);
  assert.equal(p100.columnSectionSource, 'explicit');
});

test('件号唯一；连接语义（JOINT_RULES）与真实相接（conveyorJoints）分开验', () => {
  const parts = parts16();
  const ids = parts.map((part) => part.id);
  assert.equal(new Set(ids).size, ids.length, '146 个件号必须唯一');
  // 规则表认识这些件对（这是**连接语义**：件号族该怎么搭）
  assert.ok(conveyorJointReason('column-fl', 'top-beam-front'), '立柱×顶部横梁必须有 joint 理由');
  assert.ok(conveyorJointReason('tray-rail-16-left', 'tray-16'), '托条×托板必须有 joint 理由');
  const joints = conveyorJoints(parts);
  assert.ok(joints.length > 0);
  assert.ok(joints.some((joint) => /^column-/.test(joint.a) && /^top-beam-/.test(joint.b)));
  // 导柱×链条是真实相接的一对（8 层建造器同款），塔里必须同样命中（件对顺序不固定）
  assert.ok(joints.some((joint) => /^lift-(chain|post)-/.test(joint.a) && /^lift-(chain|post)-/.test(joint.b)));
  // 反向断言：托条/托板与立柱**没有**实体相接（塔身没有层间横梁，间隙 325 mm）。
  // 旧用例只问「规则认识这一对吗」，等于用「规则存在」冒充「已连接」——这里按实际相接验。
  const railColumn = joints.filter((joint) => {
    const a = String(joint.a);
    const b = String(joint.b);
    return (/^tray-/.test(a) && /^column-/.test(b)) || (/^column-/.test(a) && /^tray-/.test(b));
  });
  assert.equal(railColumn.length, 0, '托条/托板与立柱在几何上不相接：必须由回执显式声明「无层间横梁」，不能用 JOINT_RULES 冒充已连接');
});

test('静态重叠类不得新增：16 层的重叠类集合与 8 层参数化路径完全一致', () => {
  const legacy = buildConveyorParts({ lengthMm: 2400, widthMm: 1200, beltHeightMm: 900, layers: 8, layerPitchMm: 180 });
  const legacyClasses = overlapClasses(legacy);
  const towerClasses = overlapClasses(parts16());
  assert.deepEqual([...towerClasses.keys()].sort(), [...legacyClasses.keys()].sort(), '16 层不得引入新的重叠类');
  // 每一类都必须有声明过的 joint 理由（没有 = 真互穿，必须修几何而不是放行）
  const parts = parts16();
  for (const [key] of towerClasses) {
    const [a, b] = key.split(' × ');
    const sampleA = parts.find((part) => family(part.id) === a);
    const sampleB = parts.find((part) => family(part.id) === b);
    assert.ok(sampleA && sampleB, `重叠类 ${key} 找不到样本件`);
    assert.ok(conveyorJointReason(sampleA.id, sampleB.id), `重叠类 ${key} 没有 joint 理由（真互穿）`);
  }
});

test('层 Z 单调、步距 = 层距、最低件不低于地面', () => {
  const parts = parts16();
  const trayZ = [2, 3, 4, 16].map((level) => parts.find((part) => part.id === `tray-${level}`).transform.z);
  assert.deepEqual(trayZ, [1085, 1265, 1445, 3605]);
  for (let level = 3; level <= 16; level += 1) {
    const previous = parts.find((part) => part.id === `tray-${level - 1}`).transform.z;
    const current = parts.find((part) => part.id === `tray-${level}`).transform.z;
    assert.equal(Math.round(current - previous), 180, `第 ${level} 层层距必须是 180`);
  }
  const minZ = Math.min(...parts.map((part) => partWorldBounds(part).min[2]));
  assert.ok(minZ >= 0, `最低件 z=${minZ} 不得低于地面`);
});

test('塔身不复制底层输送线：底层件数 29、layers 恒为 1', () => {
  const params = params16();
  const inbound = bufferTowerInboundParams(params);
  assert.equal(inbound.layers, 1);
  assert.equal(buildConveyorParts(inbound).length, 29);
  const parts = parts16();
  assert.equal(parts.filter((part) => part.id === 'gearmotor').length, 1, '皮带/驱动只允许一份');
  assert.equal(parts.filter((part) => /^belt-top$/.test(part.id)).length, 1);
});

test('几何分派：config.bufferTower 走塔身建造器，movingAxes=1、台面随动', () => {
  const resolved = resolveMachineGeometry(towerMachineConfig());
  assert.equal(resolved.source, 'buffer-tower-assembly');
  assert.equal(resolved.geometry.geometrySource, 'buffer-tower-assembly');
  assert.equal(resolved.partCount, 146);
  assert.equal(resolved.assemblyPartCount, 146);
  assert.match(resolved.reason, /缓存塔/);
  assert.equal(resolved.geometry.moving.length, 1);
  const axis = resolved.geometry.moving[0];
  assert.equal(axis.actuatorId, 'tower-lift');
  assert.deepEqual(axis.partIds, ['lift-platform']);
  assert.equal(axis.strokeMm, 2700, '行程 = (16-1)×180');
  const platform = resolved.geometry.parts.find((part) => part.id === 'lift-platform');
  assert.equal(platform.moving, true);
  assert.equal(platform.actuatorId, 'tower-lift');
});

test('几何分派不误道：没有 bufferTower 时 layers=8 仍走 conveyor-assembly', () => {
  const config = towerMachineConfig();
  delete config.bufferTower;
  config.conveyor = { lengthMm: 2400, widthMm: 1200, beltHeightMm: 900, layers: 8, layerPitchMm: 180 };
  const resolved = resolveMachineGeometry(config);
  assert.equal(resolved.source, 'conveyor-assembly');
  assert.equal(resolved.assemblyPartCount, 90);
  assert.equal(resolved.geometry.moving.length, 0, '8 层参数化路径本来就没有运动轴');
});

test('塔参数不完整时抛错，不回落代理体', () => {
  const config = towerMachineConfig();
  config.bufferTower = { ...TOWER16, slotsPerTower: 15 }; // 容量与几何不一致
  assert.throws(() => resolveMachineGeometry(config), /levels 16 × slotsPerLevel 1 = 16 ≠ slotsPerTower 15/);
});

test('三态干涉透传新来源：geometrySource=buffer-tower-assembly（不会被标成代理体）', () => {
  const config = towerMachineConfig();
  const geometry = resolveMachineGeometry(config).geometry;
  const outcome = runInterferenceStates({ states: ['rest'], config, geometry });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.geometrySource, 'buffer-tower-assembly');
  assert.equal(outcome.precision.geometry, 'buffer-tower-assembly');
  // 静态 AABB 与 joint 声明一致：rest 态不应把已声明的装配连接算成 FAIL
  assert.notEqual(outcome.reviewStatus, 'fail');
});

test('validate：bufferTower 往返不丢字段；旧 conveyor.layers 夹紧语义仍保留', () => {
  const config = towerMachineConfig();
  const ok = validateDesign(config);
  assert.equal(ok.ok, true, ok.ok ? '' : JSON.stringify(ok.issues));
  assert.deepEqual(ok.config.bufferTower, { ...TOWER16, frame: { material: 'AL6063', sectionMm: 40 }, transferLevel: 1 });
  // 旧语义回归（无塔时的输送线）：conveyor.layers 仍静默夹到 8（这块不动）
  const conveyorOnly = { ...config };
  delete conveyorOnly.bufferTower;
  const clamped = validateDesign({ ...conveyorOnly, conveyor: { ...conveyorOnly.conveyor, layers: 16 } });
  assert.equal(clamped.ok, true);
  assert.equal(clamped.config.conveyor.layers, 8);
  // 但塔在场时 layers>1 是**错误**（P1-5）：夹到 8 也不行，因为 8 仍然是「第二份层数」
  const conflict = validateDesign({ ...config, conveyor: { ...config.conveyor, layers: 16 } });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.issues[0].code, 'BUFFER_TOWER_INVALID');
  assert.match(conflict.issues[0].message, /layers=8/);
  // 塔这块不夹紧：容量算式不成立直接报 issue，不改写成 8 层
  const bad = validateDesign({ ...config, bufferTower: { ...TOWER16, levels: 16, slotsPerTower: 8 } });
  assert.equal(bad.ok, false);
  assert.equal(bad.issues[0].code, 'BUFFER_TOWER_INVALID');
  assert.match(bad.issues[0].message, /≠ slotsPerTower 8/);
  assert.equal(bad.issues[0].path, 'config.bufferTower');
});

test('validate：bufferTower 形状错报 CONFIG_SHAPE，NOT_IMPLEMENTED 单独一个 issue code', () => {
  const config = towerMachineConfig();
  const notObject = validateDesign({ ...config, bufferTower: '16 层' });
  assert.equal(notObject.ok, false);
  assert.equal(notObject.issues[0].code, 'CONFIG_SHAPE');
  const notImplemented = validateDesign({ ...config, bufferTower: { ...TOWER16, slotsPerLevel: 2, slotsPerTower: 32 } });
  assert.equal(notImplemented.ok, false);
  assert.equal(notImplemented.issues[0].code, 'BUFFER_TOWER_NOT_IMPLEMENTED');
});

/* ---------------------------------------------------------------- *
 * design_machine 回执
 * ---------------------------------------------------------------- */

const TOWER_ARGS = {
  brief: '光伏组件单塔缓存机',
  bufferTower: { towerCount: 1, slotsPerTower: 16 },
  bufferTowerGeometry: {
    levels: 16,
    slotsPerLevel: 1,
    layerPitchMm: 180,
    panel: { lengthMm: 2278, widthMm: 1134, thicknessMm: 35, massKg: 32 },
    inbound: { lengthMm: 2400, widthMm: 1200, beltHeightMm: 900 },
    frame: { material: 'AL6063', sectionMm: 40 }
  }
};

test('design_machine：schema 暴露 bufferTowerGeometry，且与 bufferTower 并列', () => {
  const tools = new AgentTools({ listParts: () => [] });
  const schema = tools.summaries().find((tool) => tool.name === 'design_machine')?.inputSchema;
  assert.ok(schema.properties.bufferTowerGeometry, '必须暴露 bufferTowerGeometry');
  assert.equal(schema.properties.bufferTowerGeometry.additionalProperties, false);
  assert.deepEqual(schema.properties.bufferTowerGeometry.required, ['levels', 'slotsPerLevel', 'panel', 'inbound']);
  // 不塞进 bufferTower：容量身份与几何是两块入参
  assert.deepEqual(schema.properties.bufferTower.required, ['towerCount', 'slotsPerTower']);
  assert.equal(schema.properties.bufferTowerGeometry.properties.levels.maximum, 64);
});

test('design_machine：正常回执给出 slots/geometry/structure/capabilityBoundary', async () => {
  const tools = new AgentTools({ listParts: () => [] });
  const result = await tools.call('design_machine', TOWER_ARGS);
  assert.equal(result.ok, true, result.message);
  const receipt = result.bufferTowerGeometry;
  assert.equal(receipt.slots.fromGeometry, 16);
  assert.equal(receipt.slots.claimed, 16);
  assert.equal(receipt.slots.aligned, true);
  assert.equal(receipt.slots.usableStorage, 15);
  assert.equal(receipt.slots.trayCount, 15);
  assert.equal(receipt.slots.slotsPerLevelFromGeometry, 1, '每层储位数是数托板件数得来的，不是 slotsPerLevel 回声');
  assert.equal(receipt.slots.towersFromGeometry, 1, '塔数是数立柱组数得来的');
  assert.match(receipt.slots.derivation, /托板 15 层/);
  assert.match(receipt.slots.derivation, /逐层核对托板 1 \/ 托条 2 \/ 挡停 1 \/ 光电 1/);
  assert.equal(receipt.slots.layerAudit.levelsChecked, 15);
  assert.equal(receipt.slots.layerAudit.rowsSample.length, 2);
  assert.deepEqual(receipt.slots.layerAudit.families, ['tray', 'tray-rail', 'stop', 'layer-sensor']);
  assert.equal(receipt.geometry.source, 'buffer-tower-assembly');
  assert.equal(receipt.geometry.partCount, 146);
  assert.deepEqual(receipt.geometry.envelopeMm, [2430, 1790, 3840]);
  assert.equal(receipt.geometry.movingAxes, 1);
  assert.equal(receipt.geometry.massKg, null, '只读工具不跑内核：不许给估算质量');
  assert.equal(receipt.geometry.massSource, 'not-measured');
  assert.equal(receipt.structure.columnSectionMm, 80);
  assert.equal(receipt.structure.columnSectionRecommendedMm, 80);
  assert.equal(receipt.structure.staticOnly, true);
  assert.equal(receipt.structure.accepted, false);
  // P2-1：导柱净余量按实体量（导柱顶 3840 − 顶层托板上表面 3606.5），不是 postTop−topLayerZ 的定义回声
  assert.equal(receipt.structure.postReachMm, 233.5);
  assert.equal(receipt.structure.postReachBasis, 'entity-bounds');
  assert.equal(receipt.structure.postReachPlaneMm, 240, '层平面口径仍留作对照');
  assert.equal(receipt.structure.postTopZMm, 3840);
  assert.equal(receipt.structure.topTrayTopZMm, 3606.5);
  assert.ok(receipt.structure.notes.some((note) => /屈曲/.test(note)));
  assert.ok(receipt.structure.notes.some((note) => /总高 3840/.test(note)));
  // §6 边界原文与全 false 能力项
  assert.match(receipt.capabilityBoundary.message, /静态概念模型/);
  assert.match(receipt.capabilityBoundary.message, /禁止宣称/);
  for (const key of [
    'dynamicInterferenceChecked',
    'structuralChecked',
    'fireComplianceChecked',
    'ioAddressesAssigned',
    'plcProgramIncluded',
    'safetyCircuitIncluded',
    'throughputVerified'
  ]) {
    assert.equal(receipt.capabilityBoundary[key], false, `${key} 必须是 false`);
  }
  assert.equal(receipt.capabilityBoundary.slotClaim.usable, 15);
  // 配置写回同一份：apply/干涉/3D 不需要重算
  assert.equal(result.design.config.bufferTower.kind, 'tower');
  assert.equal(result.design.config.bufferTower.levels, 16);
  assert.equal(result.design.config.conveyor.layers, 1, 'conveyor 收敛成第 1 层那条输送线');
  assert.equal(result.geometry.source, 'buffer-tower-assembly');
  // 只读：不产生文件路径/写入标记
  assert.equal(result.bufferTowerGeometry.readOnly, true);
});

test('P2-1/P2-2/P2-3：结构回执的数字与声明都能复算，缺口不含糊', async () => {
  const tools = new AgentTools({ listParts: () => [] });
  const result = await tools.call('design_machine', TOWER_ARGS);
  assert.equal(result.ok, true, result.message);
  const { structure, capabilityBoundary } = result.bufferTowerGeometry;
  const notes = structure.notes.join('\n');
  // P2-2：结构余量必须含板料（15×32=480 kg），否则缺口被说小 3 倍
  assert.match(notes, /15 个储位的板料（32 kg\/件，共 480 kg/);
  assert.match(notes, /0\.41 \+ 120\/1000 = 0\.53 t\/柱/);
  assert.match(notes, /超许用约 47%/);
  assert.match(notes, /只看自重差约 13%/);
  // P2-3：层间无横梁必须显式声明（含实测间隙与 joints 计数）
  assert.match(notes, /层间没有横梁\/支撑（显式声明）/);
  assert.match(notes, /间隙 325 mm/);
  assert.match(notes, /rail×column 为 0 对/);
  assert.deepEqual(structure.notModeled, [
    '层间横梁/托架挂耳（托条目前悬空，见 notes）',
    '升降通道（台面与层托板投影重叠，sweep 会命中）',
    '防坠/抱闸、层定位机构、拖链与线缆',
    '安全门/光幕/急停回路'
  ]);
  // P1-4：轴接入状态化干涉，但能力项仍然是「没做验收」
  assert.deepEqual(capabilityBoundary.dynamicInterference.statesAvailable, ['rest', 'lift', 'sweep']);
  assert.deepEqual(capabilityBoundary.dynamicInterference.statesUnavailable, ['push']);
  assert.equal(capabilityBoundary.dynamicInterference.liftStrokeSource, 'geometry');
  assert.equal(capabilityBoundary.dynamicInterference.checkedForAcceptance, false);
  assert.match(capabilityBoundary.message, /台面没有升降通道/);
  assert.match(capabilityBoundary.message, /strokeSource=geometry/);
});

test('P2-6：塔 BOM/成本覆盖度显式标注（146 件几何 vs 8 行 BOM 不能说成整机成本）', async () => {
  const tools = new AgentTools({ listParts: () => [] });
  const result = await tools.call('design_machine', TOWER_ARGS);
  assert.equal(result.ok, true, result.message);
  const coverage = result.bufferTowerGeometry.bomCoverage;
  assert.equal(coverage.machineBomRows, result.design.bomDraft.items.length);
  assert.equal(coverage.machineBomCoversTower, false);
  assert.equal(coverage.machineBomScope, '底层输送线（第 1 层）');
  assert.equal(coverage.geometryPartCount, 146);
  assert.equal(coverage.towerPartsNotInMachineBom, 117);
  assert.equal(coverage.costTotal, result.design.cost.total);
  assert.equal(coverage.costScope, 'base-conveyor-only');
  assert.ok(coverage.notApplicable.some((item) => /cost\.total/.test(item)));
  assert.match(coverage.note, /不含塔身 117 件/);
  // 同一事实必须在 design.warnings 里可读（不只看回执新字段）
  assert.ok(
    result.design.warnings.some((warning) => /BOM\/成本未含塔身 117 件/.test(warning)),
    'BOM 覆盖缺口必须有 warning，不能只在回执深处'
  );
});

test('P2-4：partBreakdown 每项都是真值（不是「逐项相加 == 总件数」的恒等式）', async () => {
  const tools = new AgentTools({ listParts: () => [] });
  const result = await tools.call('design_machine', TOWER_ARGS);
  const breakdown = result.bufferTowerGeometry.geometry.partBreakdown;
  // 底架 29 件是**另外再建一次** layers:1 输送线数出来的；旧实现用 parts.length − 塔身件数，
  // 那个式子在任何建造器改动下都恒成立，测不出东西。
  assert.equal(breakdown.baseConveyor, 29);
  assert.equal(breakdown.basePartsMatched, 29, '底架件号必须逐件在塔零件表里都找得到');
  assert.equal(breakdown.columns, 4);
  assert.equal(breakdown.topBeams, 2);
  assert.equal(breakdown.trayRails, 30, '15 层 × 2');
  assert.equal(breakdown.trays, 15);
  assert.equal(breakdown.trayRollers, 30, '15 层 × 2');
  assert.equal(breakdown.stops, 15);
  assert.equal(breakdown.layerSensors, 15);
  assert.equal(breakdown.liftPosts, 2);
  assert.equal(breakdown.liftChains, 2);
  assert.equal(breakdown.liftPlatforms, 1);
  assert.equal(breakdown.liftMotors, 1);
  assert.equal(breakdown.towerParts, 117);
  assert.equal(breakdown.sum, 146);
  assert.equal(breakdown.sum, result.bufferTowerGeometry.geometry.partCount);
});

test('design_machine 负例：缺 bufferTower / 容量不一致 → INVALID_ARGUMENT 带算式', async () => {
  const tools = new AgentTools({ listParts: () => [] });
  const noTower = await tools.call('design_machine', { brief: TOWER_ARGS.brief, bufferTowerGeometry: TOWER_ARGS.bufferTowerGeometry });
  assert.equal(noTower.code, 'INVALID_ARGUMENT');
  assert.match(noTower.message, /必须与 bufferTower 同时给出/);

  const mismatch = await tools.call('design_machine', {
    ...TOWER_ARGS,
    bufferTower: { towerCount: 1, slotsPerTower: 15 }
  });
  assert.equal(mismatch.code, 'INVALID_ARGUMENT');
  assert.match(mismatch.message, /levels 16 × slotsPerLevel 1 = 16 ≠ slotsPerTower 15/);
});

test('design_machine 负例：双塔 / 每层 2 位 → NOT_IMPLEMENTED（不是 INVALID_ARGUMENT）', async () => {
  const tools = new AgentTools({ listParts: () => [] });
  const twoTowers = await tools.call('design_machine', {
    ...TOWER_ARGS,
    bufferTower: { towerCount: 2, slotsPerTower: 16 }
  });
  assert.equal(twoTowers.code, 'NOT_IMPLEMENTED');
  const twoPerLevel = await tools.call('design_machine', {
    ...TOWER_ARGS,
    bufferTower: { towerCount: 1, slotsPerTower: 32 },
    bufferTowerGeometry: { ...TOWER_ARGS.bufferTowerGeometry, slotsPerLevel: 2 }
  });
  assert.equal(twoPerLevel.code, 'NOT_IMPLEMENTED');
  assert.match(twoPerLevel.message, /伸缩叉/);
});

test('P1-3：bufferTowerGeometry 不许越权覆盖 bufferTower 的容量身份（显式拒绝，不静默生效）', async () => {
  const tools = new AgentTools({ listParts: () => [] });
  // 旧行为：spread 把 geometry 的键放在容量身份之后 → slotsPerTower 2 覆盖 16，回执 claimed 2，无任何告警
  const overrideSlots = await tools.call('design_machine', {
    ...TOWER_ARGS,
    bufferTowerGeometry: { ...TOWER_ARGS.bufferTowerGeometry, slotsPerTower: 2 }
  });
  assert.equal(overrideSlots.ok, false, '越权覆盖必须失败，不能静默改容量');
  assert.equal(overrideSlots.code, 'INVALID_ARGUMENT');
  assert.match(overrideSlots.message, /不接受键 slotsPerTower/);
  assert.match(overrideSlots.message, /容量身份（塔数\/每塔储位）只能由 bufferTower 给/);
  // towers 同样不许从几何入参进来
  const overrideTowers = await tools.call('design_machine', {
    ...TOWER_ARGS,
    bufferTowerGeometry: { ...TOWER_ARGS.bufferTowerGeometry, towers: 1 }
  });
  assert.equal(overrideTowers.code, 'INVALID_ARGUMENT');
  assert.match(overrideTowers.message, /不接受键 towers/);
  // 子块里的未知键也要拒（不只顶层）
  const unknownPanelKey = await tools.call('design_machine', {
    ...TOWER_ARGS,
    bufferTowerGeometry: { ...TOWER_ARGS.bufferTowerGeometry, panel: { ...TOWER_ARGS.bufferTowerGeometry.panel, slots: 16 } }
  });
  assert.equal(unknownPanelKey.code, 'INVALID_ARGUMENT');
  assert.match(unknownPanelKey.message, /bufferTowerGeometry\.panel 不接受键 slots/);
  // 正常参数不受影响：容量身份只来自 bufferTower
  const ok = await tools.call('design_machine', TOWER_ARGS);
  assert.equal(ok.ok, true, ok.message);
  assert.equal(ok.design.config.bufferTower.slotsPerTower, 16);
  assert.equal(ok.design.config.bufferTower.towers, 1);
  assert.equal(ok.bufferTowerGeometry.slots.claimed, 16);
});

test('design_machine：内部异常回 INTERNAL_ERROR，不再误报 INVALID_ARGUMENT', async () => {
  const broken = new AgentTools({
    listParts: () => {
      throw new TypeError('registry exploded');
    }
  });
  const result = await broken.call('design_machine', { brief: '设计一台三工位锁螺丝机' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INTERNAL_ERROR', '程序缺陷必须与参数错误分开');
  assert.equal(result.message, 'registry exploded');
  assert.match(result.hint, /内部异常/);
});

test('design_machine：brief 推断的 8 层不会被静默丢掉——塔几何覆盖时给显式告警', async () => {
  const tools = new AgentTools({ listParts: () => [] });
  const result = await tools.call('design_machine', {
    ...TOWER_ARGS,
    brief: '设计一台 8 层缓存机，带宽 1200'
  });
  assert.equal(result.ok, true, result.message);
  // 两份「层数」不能并存：conveyor 收敛成第 1 层那条线（layers=1），层数只在 bufferTower.levels
  assert.equal(result.design.config.conveyor.layers, 1);
  assert.equal(result.design.config.bufferTower.levels, 16);
  assert.ok(
    result.design.warnings.some((warning) => /缓存塔几何覆盖了 brief\/方案推断的 conveyor\.layers=8/.test(warning)),
    '覆盖必须留下可读告警，不能静默改参数'
  );
  // 件数分解的真值断言在「P2-4」用例里（逐项真值）；这里只验回执仍与零件数一致
  assert.equal(result.bufferTowerGeometry.geometry.partBreakdown.sum, result.bufferTowerGeometry.geometry.partCount);
  // BOM 覆盖缺口必须在同一份 warnings 里（P2-6），而不是只在 bufferTowerGeometry 深处
  assert.ok(result.design.warnings.some((warning) => /BOM\/成本未含塔身 117 件/.test(warning)));
});
