import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildConveyorParts,
  conveyorAssembly,
  conveyorBom,
  conveyorEnvelope,
  DEFAULT_CONVEYOR,
  MATERIAL_LABEL
} from '../../src/machine/conveyor-assembly.ts';
import { validateFeatures } from '../../src/parametric/features.ts';

const parts = buildConveyorParts(DEFAULT_CONVEYOR);

test('输送机零件表：28 个真实零件，全部是合法参数化特征', () => {
  assert.equal(parts.length, 28);
  const doc = conveyorAssembly(parts);
  assert.equal(doc.schemaVersion, 2);
  assert.equal(doc.instances.length, 28);
  assert.deepEqual(validateFeatures(doc), [], '每个零件的特征树都必须通过校验');
});

test('零件覆盖：纵梁/横撑/支腿/地脚/滚筒/皮带/挡边/电机/张紧/光电', () => {
  const ids = parts.map((part) => part.id);
  for (const expected of ['rail-left', 'rail-right', 'pulley-drive', 'pulley-tail', 'belt-top', 'belt-return', 'gearmotor', 'tension-left', 'sensor-inlet', 'foot-1', 'leg-1']) {
    assert.ok(ids.includes(expected), `缺少零件 ${expected}`);
  }
  // 横撑数量随长度变化，2 m 时 5 根
  assert.equal(parts.filter((part) => part.id.startsWith('cross-')).length, 5);
});

test('滚筒是横轴圆柱（axis=y），支架孔落在板的 Y 向范围内', () => {
  const pulley = parts.find((part) => part.id === 'pulley-drive');
  const body = pulley?.features.find((node) => node.id === 'pulley-drive-body');
  assert.equal(body?.params.axis, 'y');
  const plate = parts.find((part) => part.id === 'endplate-head');
  const holes = plate?.features.find((node) => node.type === 'holes');
  for (const [x, y] of holes?.params.positions ?? []) {
    assert.equal(x, 0, '孔应沿板厚中心线');
    assert.ok(Math.abs(y) > 100, '孔应在板的宽度方向两端');
  }
});

test('几何关系：滚筒中心 = 皮带面高 - 半径；支腿顶到侧梁下沿', () => {
  const pulley = parts.find((part) => part.id === 'pulley-drive');
  const belt = parts.find((part) => part.id === 'belt-top');
  const rail = parts.find((part) => part.id === 'rail-left');
  const leg = parts.find((part) => part.id === 'leg-1');
  assert.equal(pulley?.transform.z, DEFAULT_CONVEYOR.beltHeightMm - DEFAULT_CONVEYOR.pulleyDiameterMm / 2);
  assert.ok((belt?.transform.z ?? 0) > (rail?.transform.z ?? 0), '皮带在侧梁之上');
  assert.ok((leg?.transform.z ?? 0) < (rail?.transform.z ?? 0), '支腿在侧梁之下');
});

test('BOM：左右件合并成一行，目录件用样本质量覆盖', () => {
  const bom = conveyorBom(parts);
  const rail = bom.find((row) => row.name === '侧纵梁');
  assert.equal(rail?.qty, 2, '操作侧与驱动侧应合并为 2 件');
  assert.equal(bom.filter((row) => row.name.includes('操作侧')).length, 0);
  const motor = bom.find((row) => row.name === '减速电机');
  assert.equal(motor?.massKg, 2.8, '电机用样本质量，不用实心体积');
  const pulley = bom.find((row) => row.name === '主动滚筒');
  assert.equal(pulley?.massKg, 3.2);
  assert.ok(bom.every((row) => Object.values(MATERIAL_LABEL).includes(row.material)), '材质列必须是中文标签');
});

test('BOM：传入内核体积时按密度算质量', () => {
  const volumes = Object.fromEntries(parts.map((part) => [part.id, 1_000_000])); // 1e6 mm³ = 1 L
  const bom = conveyorBom(parts, volumes);
  const rail = bom.find((row) => row.name === '侧纵梁');
  assert.equal(rail?.massKg, 2.7, '铝 2700 kg/m³ × 1 L = 2.7 kg');
  const belt = bom.find((row) => row.name === '皮带上行程');
  assert.equal(belt?.massKg, 1.4, 'PVC 1400 kg/m³ × 1 L = 1.4 kg');
});

test('包络按零件实际外形求并集（电机外挂会撑宽，不是公式估的）', () => {
  const [length, width, height] = conveyorEnvelope(parts);
  // 电机改为外挂在纵梁外侧后，不再向 X 伸出，长度就是线体长；宽度由电机/轴头撑开
  assert.equal(length, 2000, '长度等于线体长（电机不再向 X 伸出）');
  assert.ok(width > DEFAULT_CONVEYOR.widthMm + 100, '宽度应包含外挂电机');
  assert.ok(height >= DEFAULT_CONVEYOR.beltHeightMm, '高度至少到皮带面');
});

test('180 mm 缓存层距不会在装配生成时被二次夹紧', () => {
  const tightLayers = buildConveyorParts({ ...DEFAULT_CONVEYOR, layers: 2, layerPitchMm: 180 });
  const lift = tightLayers.find((part) => part.id === 'lift-platform');
  assert.ok(lift, '两层缓存应包含升降台');
  assert.equal(lift.transform.z, DEFAULT_CONVEYOR.beltHeightMm + 180 * 0.5);
});

test('参数越界被夹紧，不会生成负尺寸零件', () => {
  const weird = buildConveyorParts({ ...DEFAULT_CONVEYOR, lengthMm: 10, widthMm: 5, beltHeightMm: 1 });
  assert.ok(weird.length > 0);
  for (const part of weird) {
    for (const node of part.features) {
      if (node.type !== 'box' && node.type !== 'cylinder') continue;
      const value = Number(node.type === 'cylinder' ? node.params.diameter : node.params.length);
      const height = Number(node.params.height);
      assert.ok(Number.isFinite(value) && value > 0, `${part.id} 出现非正截面`);
      assert.ok(Number.isFinite(height) && height > 0, `${part.id} 出现非正高度`);
    }
  }
  assert.deepEqual(validateFeatures(conveyorAssembly(weird)), []);
});
