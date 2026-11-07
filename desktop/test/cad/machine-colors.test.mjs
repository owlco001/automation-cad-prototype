// 材质标识色 → 线性 RGB 的守卫：
// 视口材质（three.Color.r/g/b）与 glTF baseColorFactor 都是**线性**值，
// 把 sRGB 分量直接塞进去会让颜色偏亮偏白（正是「看起来还是灰的」的一个成因）。
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { MATERIAL_COLORS } from '../../src/machine/machine-geometry.ts';
import { hexToLinear, linearToHex, machineMaterialColor } from '../../src/cad/machine-colors.ts';

test('hexToLinear 与 three 的颜色空间转换逐位一致', () => {
  for (const hex of Object.values(MATERIAL_COLORS)) {
    const expected = new THREE.Color(hex);
    const actual = hexToLinear(hex);
    assert.ok(Math.abs(actual[0] - expected.r) < 1e-9, `${hex} r`);
    assert.ok(Math.abs(actual[1] - expected.g) < 1e-9, `${hex} g`);
    assert.ok(Math.abs(actual[2] - expected.b) < 1e-9, `${hex} b`);
  }
});

test('linearToHex 往返回到原色', () => {
  for (const hex of Object.values(MATERIAL_COLORS)) {
    assert.equal(linearToHex(hexToLinear(hex)), hex.toLowerCase());
  }
});

test('machineMaterialColor 覆盖四种材质、未知材质返回 undefined', () => {
  const seen = new Set();
  for (const material of ['AL6063', 'Q235', 'STEEL45', 'PVC']) {
    const entry = machineMaterialColor(material);
    assert.ok(entry, `${material} 没有标识色`);
    assert.equal(entry.hex, MATERIAL_COLORS[material]);
    seen.add(entry.hex.toLowerCase());
  }
  assert.equal(seen.size, 4);
  assert.equal(machineMaterialColor('PV-GLASS'), undefined);
  assert.equal(machineMaterialColor(undefined), undefined);
});
