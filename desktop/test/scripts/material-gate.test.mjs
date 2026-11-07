// 材质色闸门的自测：PNG 解码 → 按 ΔE76 数色 → GLB 材质解析。
// 这些是「3D 截图全灰」这类问题的最后一道判据，判错了会一直绿/一直红，所以单独锁住。
import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { countColorPixels, decodePng, deltaE76, hexToLab } from '../../scripts/lib/png-pixels.mjs';
import { checkMaterialPixels, materialTargets } from '../../scripts/lib/material-gate.mjs';
import { checkGlbMaterials, glbMaterials, expectedLinearColors } from '../../scripts/lib/glb-inspect.mjs';

/** 极简 PNG 编码器（8bit RGBA，filter 0）：只给测试造图用，不追求体积。 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy ? rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
      : Buffer.from(rgba.subarray(y * stride, y * stride + stride)).copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return crc ^ 0xffffffff;
}

function solid(width, height, hex) {
  const value = hex.replace('#', '');
  const color = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16));
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = color[0];
    rgba[index * 4 + 1] = color[1];
    rgba[index * 4 + 2] = color[2];
    rgba[index * 4 + 3] = 255;
  }
  return { rgba, color };
}

test('decodePng 还原 8bit RGBA 像素', () => {
  const width = 7;
  const height = 5;
  const rgba = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    rgba[index * 4] = index * 7 % 256;
    rgba[index * 4 + 1] = 255 - (index * 11 % 256);
    rgba[index * 4 + 2] = index * 3 % 256;
    rgba[index * 4 + 3] = 255;
  }
  const png = encodePng(width, height, rgba);
  const image = decodePng(png);
  assert.equal(image.width, width);
  assert.equal(image.height, height);
  assert.deepEqual(Array.from(image.pixels), Array.from(rgba));
});

test('decodePng 拒绝 16bit / 隔行', () => {
  const png = encodePng(2, 2, solid(2, 2, '#112233').rgba);
  const broken = Buffer.from(png);
  broken[24] = 16; // IHDR bitDepth
  assert.throws(() => decodePng(broken), /只支持 8bit/);
});

test('countColorPixels 按 ΔE76 只数目标色', () => {
  const target = materialTargets();
  const width = 40;
  const height = 10;
  const rgba = Buffer.alloc(width * height * 4);
  const colors = ['#7fb2e5', '#b0553a', '#d9c24a', '#2f7d4f', '#808080'];
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const hex = colors[Math.min(4, Math.floor(column / 8))];
      const value = hex.replace('#', '');
      const offset = (row * width + column) * 4;
      rgba[offset] = parseInt(value.slice(0, 2), 16);
      rgba[offset + 1] = parseInt(value.slice(2, 4), 16);
      rgba[offset + 2] = parseInt(value.slice(4, 6), 16);
      rgba[offset + 3] = 255;
    }
  }
  const image = decodePng(encodePng(width, height, rgba));
  const result = countColorPixels(image, target, { tolerance: 12 });
  // 每色 8 列 × 10 行 = 80 px；灰块哪一色都不该命中
  assert.deepEqual(result.counts, [80, 80, 80, 80]);
});

test('checkMaterialPixels：够 3000px 才通过，缺色给出实际像素数', () => {
  const width = 100;
  const height = 100;
  const rgba = Buffer.alloc(width * height * 4);
  // 上半 #7fb2e5，下半 #b0553a：每色 5000px
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const hex = y < 50 ? '7fb2e5' : 'b0553a';
      const offset = (y * width + x) * 4;
      rgba[offset] = parseInt(hex.slice(0, 2), 16);
      rgba[offset + 1] = parseInt(hex.slice(2, 4), 16);
      rgba[offset + 2] = parseInt(hex.slice(4, 6), 16);
      rgba[offset + 3] = 255;
    }
  }
  const png = encodePng(width, height, rgba);
  const result = checkMaterialPixels(png, null, { minPixels: 3000, minTotal: 0 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.rows.map((row) => row.material), ['AL6063', 'Q235', 'PVC', 'STEEL45']);
  assert.equal(result.rows[0].pixels, 5000);
  assert.equal(result.rows[1].pixels, 5000);
  assert.equal(result.rows[2].pixels, 0);
  assert.equal(result.rows[3].pixels, 0);
  assert.equal(result.failures.length, 2);

  // 只数右半边：每色 2500px → 也失败（说明 rect 真的生效）
  const scoped = checkMaterialPixels(png, { x: 50, y: 0, width: 50, height: 100 }, { minPixels: 3000, minTotal: 0 });
  assert.equal(scoped.rows[0].pixels, 2500);

  // 默认门槛是分材质的：三个大件 3000，45# 1200（理由见 material-gate.mjs 的注释）
  const defaults = checkMaterialPixels(png, null);
  assert.deepEqual(defaults.rows.map((row) => row.floor), [3000, 3000, 3000, 1200]);
  // 四色合计 10000 < 25000：整张图只有两块彩色，等于「机器还是灰的」，必须红
  assert.equal(defaults.ok, false);
  assert.ok(defaults.failures.some((line) => line.includes('四色合计')));
  assert.equal(defaults.total, 10000);
  // 把合计门槛让开，四色各自的判定才独立生效（绿/黄 = 0px）
  const perMaterialOnly = checkMaterialPixels(png, null, { minTotal: 0 });
  assert.equal(perMaterialOnly.failures.length, 2);
});

test('hexToLab / deltaE76 与已知值同量级', () => {
  const blue = hexToLab('#7fb2e5');
  const red = hexToLab('#b0553a');
  assert.ok(deltaE76(blue, blue) === 0);
  // 四种材质色两两 ΔE76 ≥ 55（machine-geometry-colors.test.mjs 锁的是同一口径）
  const labs = materialTargets().map((target) => hexToLab(target.hex));
  for (let i = 0; i < labs.length; i += 1) {
    for (let j = i + 1; j < labs.length; j += 1) {
      assert.ok(deltaE76(labs[i], labs[j]) >= 55, `ΔE76 太小：${i}/${j}=${deltaE76(labs[i], labs[j]).toFixed(1)}`);
    }
  }
});

/** 造一个只有 JSON chunk 的 GLB（够 checkGlbMaterials 用）。 */
function makeGlb(json) {
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  const padded = Buffer.concat([body, Buffer.alloc((4 - body.length % 4) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + padded.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(padded.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4);
  return Buffer.concat([header, chunkHeader, padded]);
}

test('checkGlbMaterials：四色齐全才通过，单白色材质必须失败', () => {
  const expected = expectedLinearColors();
  const good = makeGlb({
    materials: expected.map((entry) => ({
      name: entry.material,
      pbrMetallicRoughness: { baseColorFactor: [...entry.linear, 1], metallicFactor: 0.06, roughnessFactor: 0.78 }
    })),
    meshes: [{ name: 'm' }],
    nodes: [{ name: 'n' }]
  });
  const parsed = glbMaterials(good);
  assert.equal(parsed.materials.length, 4);
  assert.equal(parsed.materials[0].hex, '#7fb2e5');
  const pass = checkGlbMaterials(good);
  assert.equal(pass.ok, true);
  assert.equal(pass.matched.filter((entry) => entry.found).length, 4);

  // 现状复现：1 个材质、没有 baseColorFactor（GLTFExporter 对纯白省略该字段）
  const bad = makeGlb({ materials: [{ pbrMetallicRoughness: { metallicFactor: 0.2, roughnessFactor: 0.62 } }], meshes: [{ name: 'm' }] });
  const fail = checkGlbMaterials(bad);
  assert.equal(fail.ok, false);
  assert.equal(fail.materials.length, 1);
  assert.equal(fail.materials[0].baseColorFactor, null);
  assert.ok(fail.failures.some((line) => line.includes('材质数 1 < 4')));

  // 近色不算命中：blue 差分 0.05 必须被容差 0.02 拒掉
  const near = makeGlb({
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [expected[0].linear[0] + 0.05, expected[0].linear[1], expected[0].linear[2], 1] } }]
  });
  assert.equal(checkGlbMaterials(near).matched[0].found, false);
});
