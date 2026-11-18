/**
 * M1「首层承托取放」概念件表夹具（**只给测试与 verify:channel 用**，不进生产件表）。
 *
 * 为什么要有这个文件：仓库里现成的塔件表是「整块托板 + 一块 320 台面」，它**不是** M1 机构
 * （没有分段带、没有叉指），所以拿真实件表既复现不出 82.5% 的静止承托，也复现不出 17% 的叉指承托。
 * M1 概念件表只在架构文档 §3 里定义过（探针里手搓），这里把它固化成一份**可复现**的夹具：
 *
 *   146 件基线 −1（lift-platform）+2（双叉指）+1（升降横梁）+4（进/回程各 3 段带） = 152 件
 *
 * 尺寸/位姿全部照文档 §3 的实测值，不许在这里「调参凑数」：
 * - 分段带：`y[-600,-485] / [-375,375] / [485,600]`（缝 110 @ y=±430）、顶面 900；
 * - 叉指：2000×100×40，竖板 850..890（停位顶面 890），`y=±430`；
 * - 横梁：40×1080×16 @ z 858（在回程带 850 之下、上行程带 896 之上），x −1095..−1055；
 * - 板：2278×1134×35，静止底面 900（第 1 层承托面），随轴走 + 拾取空行程 10。
 *
 * 口径：`parts` 是机台件（152 件，不含板）；板作为 `workpiece-plate` **普通几何件**追加到
 * `geometry.parts`（M1 的 sweep 必须把板扫进去，所以这里是 153 个刚体 / 152 个装配件）。
 */
import { buildBufferTowerParts, bufferTowerParamsFromConfig, bufferTowerInboundParams } from '../src/machine/buffer-tower-assembly.ts';
import { conveyorGeometryFromParts } from '../src/machine/machine-geometry.ts';

/** 板规格（与缓存塔 config.panel 同一组数）。 */
export const M1_PANEL = { lengthMm: 2278, widthMm: 1134, thicknessMm: 35, massKg: 32 };

/** 塔配置（16 层 / 180 层距 / 2400×1200 进料线 / 板 2278×1134×35）。 */
export function m1TowerConfig(levels = 16) {
  return {
    id: 'm1-channel',
    name: 'M1 首层承托取放',
    stations: [],
    actuators: [],
    sensors: [],
    formId: 'belt-line',
    conveyor: { lengthMm: 2400, widthMm: 1200, beltHeightMm: 900, layers: 1, layerPitchMm: 180 },
    bufferTower: {
      kind: 'tower',
      towers: 1,
      slotsPerTower: levels,
      levels,
      slotsPerLevel: 1,
      layerPitchMm: 180,
      panel: { ...M1_PANEL },
      inbound: { lengthMm: 2400, widthMm: 1200, beltHeightMm: 900 },
      frame: { material: 'AL6063', sectionMm: 40 }
    }
  };
}

function boxPart(id, name, material, length, width, height, x, y, z) {
  return {
    id,
    name,
    material,
    spec: `${length}×${width}×${height}`,
    features: [{ id: `${id}-body`, type: 'box', name: 'body', params: { length, width, height } }],
    transform: { x, y, z, rz: 0 }
  };
}

/**
 * M1 件表 + 几何。
 *
 * @param {object} [options]
 * @param {number} [options.levels]          层数（缺省 16）
 * @param {number} [options.fingerWidthMm]   叉指宽（缺省 100；负例 120 > 缝 110）
 * @param {number} [options.fingerYMm]       叉指中心 y（缺省 430；A2 负例 622 = 板外）
 * @param {number} [options.fingerTopZmm]    叉指停位顶面（缺省 890）
 * @param {number} [options.travelMm]        轴行程（缺省 20 = M1 段；负例 40 = 超行程；2700 = 满行程）
 * @param {boolean} [options.withPanel]      是否把板追加进几何（缺省 true）
 */
export function m1ChannelFixture(options = {}) {
  const {
    levels = 16,
    fingerWidthMm = 100,
    fingerYMm = 430,
    fingerTopZmm = 890,
    travelMm = 20,
    withPanel = true
  } = options;
  const config = m1TowerConfig(levels);
  const params = bufferTowerParamsFromConfig(config);
  const base = buildBufferTowerParts(params);
  const halfL = config.bufferTower.inbound.lengthMm / 2;

  const parts = [];
  for (const part of base) {
    // 台面：M1 用「横梁 + 双叉指」替代（台面 AABB z 970..1010 跨过带面 900，不能承托板）
    if (part.id === 'lift-platform') continue;
    // 皮带：整条拆成 3 段（左/中/右），缝 110 @ y=±430 —— 叉指从缝里竖着穿上来
    if (part.id === 'belt-top' || part.id === 'belt-return') {
      const z = part.id === 'belt-top' ? 898 : 848;
      for (const [label, y, width] of [['l', -542.5, 115], ['m', 0, 750], ['r', 542.5, 115]]) {
        parts.push(boxPart(`${part.id}-${label}`, `${part.name}（分段 ${label}）`, part.material, 2360, width, 4, 0, y, z));
      }
      continue;
    }
    parts.push(part);
  }
  // 升降横梁：在上行程带（896）之下、回程带（850）之上 —— 超行程 40 就会进带上行程带（实测 3 对命中）
  parts.push(boxPart('lift-carriage', '升降横梁', 'Q235', 40, 1080, 16, -(halfL - 125), 0, 858));
  for (const [label, sign] of [['left', -1], ['right', 1]]) {
    parts.push(boxPart(
      `lift-finger-${label}`,
      `升降叉指（${label === 'left' ? '左' : '右'}）`,
      'Q235',
      2000,
      fingerWidthMm,
      40,
      0,
      sign * fingerYMm,
      fingerTopZmm - 20
    ));
  }

  const geometryBase = conveyorGeometryFromParts(parts, config, bufferTowerInboundParams(params), {
    geometrySource: 'buffer-tower-assembly'
  });

  // 分段带绕包滚筒：仓库的 JOINT_RULES 只认整条 belt-top，分段后要显式声明（否则 rest 报待复核）
  const joints = [...(geometryBase.joints ?? [])];
  for (const part of parts) {
    if (!/^belt-top-/.test(part.id)) continue;
    for (const candidate of parts) {
      if (!/^pulley-/.test(candidate.id)) continue;
      joints.push({ a: part.id, b: candidate.id, reason: '分段皮带绕包端滚筒（同一包角，切向接触）' });
    }
  }

  const panel = {
    id: 'workpiece-plate',
    name: '工件（板件占位体）',
    role: 'workpiece',
    shape: { type: 'box', size: [M1_PANEL.lengthMm, M1_PANEL.widthMm, M1_PANEL.thicknessMm] },
    // 静止：底面贴第 1 层承托面 900
    center: [0, 0, 900 + M1_PANEL.thicknessMm / 2],
    rotationZDeg: 0,
    color: '#0ea5e9',
    material: 'PV-GLASS',
    bomGroup: 'structure',
    estimated: true,
    moving: true
  };

  const axis = {
    actuatorId: 'tower-lift',
    stationId: '',
    kind: 'linear',
    partIds: ['lift-carriage', 'lift-finger-left', 'lift-finger-right', 'workpiece-plate'],
    axis: [0, 0, 1],
    pivot: [0, 0, 866],
    strokeMm: travelMm,
    rangeDeg: 0,
    home: 'retracted',
    durationMs: 2000,
    points: { extend: '抬起到位', retract: '回落' },
    point: 'DI-TOWER-LIFT-LEVEL',
    strokeSource: 'geometry',
    // 叉指顶 890 → 带面 900：前 10 mm 只是空行程，板不动
    partPickupGapMm: { 'workpiece-plate': 10 }
  };

  const geometry = {
    ...geometryBase,
    parts: withPanel ? [...geometryBase.parts, panel] : [...geometryBase.parts],
    joints,
    moving: [axis],
    // 装配件数 = 机台件（不含板）；partCount = 几何刚体数（含板）
    assemblyPartCount: parts.length
  };

  return { config, params, parts, panel, axis, geometry };
}
