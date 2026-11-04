// capture_view 区域截图（region + scale）：先裁后缩、越界夹紧如实上报、不传 region 时字节级回归。
//
// 断言口径：
// - 走真实 AgentTools + CommandBus，截图通道注入**真 PNG 字节**（encodePng 生成），
//   落盘尺寸/sha256 都从磁盘复算，不用假字节蒙过去；
// - 「不传 region」必须与旧行为字节级一致：磁盘字节 === 截图通道给的字节；
// - 「先裁后缩」不是断言尺寸，而是比边缘能量：同一 region，先裁后放大的高频细节必须
//   明显高于「先整图缩到 1024 再裁再放大」——后者正是模型现在看到的糊图。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { AgentTools } from '../../src/agent/tools.ts';
import { AgentSession } from '../../src/agent/session.ts';
import { createAgentCommandBus } from '../../src/agent/commands.ts';
import { applyRegion, clampRegion, cropImage, parseRegionArgs } from '../../src/agent/capture-region.ts';
import {
  VISION_MAX_BYTES,
  VISION_MAX_EDGE,
  decodePng,
  encodePng,
  fitPng,
  resizeRgba
} from '../../src/agent/vision-image.ts';
import { visionPromptText, visionSkippedText } from '../../src/agent/vision.ts';

const roots = [];
const registry = { listParts: () => [] };

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function setup({ capture } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cad-capture-region-'));
  roots.push(root);
  const requests = [];
  const bus = createAgentCommandBus(registry, { async call() { return { ok: false, message: 'unused' }; } }, {
    userDataRoot: root,
    exportsRoot: join(root, 'exports'),
    ...(capture ? { captureView: capture(requests) } : {}),
    now: () => new Date('2026-11-04T08:09:10.123Z')
  });
  return { root, requests, tools: new AgentTools(registry, bus) };
}

/** 纯色图（编码快，用来验证尺寸/裁剪坐标）。 */
function solid(width, height, rgba = [240, 240, 240, 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set(rgba, i * 4);
  return { width, height, data };
}

/** 确定性噪声：几乎不可压缩，用来验证「裁完放大后仍被压到 ≤1024 / ≤400 KB」。 */
function noise(width, height, seed = 11) {
  const data = new Uint8Array(width * height * 4);
  let state = seed >>> 0;
  for (let i = 0; i < width * height; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    data[i * 4] = state & 0xff;
    data[i * 4 + 1] = (state >>> 8) & 0xff;
    data[i * 4 + 2] = (state >>> 16) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** 1 px 黑白竖条纹：只有原像素才保留，任何面积平均都会把它抹成灰。 */
function stripes(width, height, box) {
  const image = solid(width, height, [255, 255, 255, 255]);
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      const dark = x % 2 === 0;
      const index = (y * width + x) * 4;
      image.data[index] = dark ? 0 : 255;
      image.data[index + 1] = dark ? 0 : 255;
      image.data[index + 2] = dark ? 0 : 255;
    }
  }
  return image;
}

const pngOf = (image) => encodePng(image);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function luma(image, x, y) {
  const index = (y * image.width + x) * 4;
  return 0.2126 * (image.data[index] ?? 0) + 0.7152 * (image.data[index + 1] ?? 0) + 0.0722 * (image.data[index + 2] ?? 0);
}

/** 平均边缘能量（相邻像素亮度差的绝对值）：文字/表格线越清楚，这个数越大。 */
function edgeEnergy(image) {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x + 1 < image.width; x += 1) {
      sum += Math.abs(luma(image, x, y) - luma(image, x + 1, y));
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

// ---------------------------------------------------------------------------
// 1) 不传 region：落盘字节必须与旧行为完全一致（同图同 sha）
// ---------------------------------------------------------------------------
test('不传 region 时输出与旧行为字节级一致（磁盘字节 === 截图通道字节）', async () => {
  const png = pngOf(solid(1600, 1000));
  const { tools, root } = setup({
    capture: (requests) => async (request) => {
      requests.push(request);
      return { ok: true, png, width: request.width, height: request.height };
    }
  });

  const result = await tools.call('capture_view', { view: '3d' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(existsSync(result.path), true);
  assert.equal(result.bytes, png.byteLength, '旧路径不能重新编码/裁剪');
  assert.equal(result.sha256, sha(png), 'sha256 必须等于原始截图字节的哈希');
  assert.deepEqual(readFileSync(result.path), Buffer.from(png), '磁盘字节必须与截图通道给的字节逐字节相同');
  assert.equal(result.width, 1600);
  assert.equal(result.height, 1000);
  assert.equal('region' in result, false, '没有 region 就不该多出 region 字段');
  assert.equal('clamped' in result, false);
  assert.match(result.path, /agent-shots[\\/]2026-11-04T08-09-10-123Z-3d\.png$/, '整窗截图文件名不带 -region');
  assert.match(result.note, /真实截取的当前界面/);
  assert.equal(existsSync(join(root, 'agent-shots')), true);
});

// ---------------------------------------------------------------------------
// 2) 合法 region：裁出来的尺寸就是取景框尺寸，坐标原样回传
// ---------------------------------------------------------------------------
test('合法 region 裁后尺寸正确，返回 region/clamped/scale/sourceSize', async () => {
  const png = pngOf(solid(1600, 1000));
  const { tools } = setup({
    capture: () => async (request) => ({ ok: true, png, width: request.width, height: request.height })
  });

  const result = await tools.call('capture_view', { view: 'library', region: { x: 100, y: 50, w: 400, h: 300 } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.width, 400);
  assert.equal(result.height, 300);
  assert.deepEqual(result.region, { x: 100, y: 50, w: 400, h: 300 });
  assert.equal(result.clamped, false);
  assert.equal(result.scale, 1);
  assert.deepEqual(result.sourceSize, { w: 1600, h: 1000 });

  const disk = readFileSync(result.path);
  const decoded = decodePng(new Uint8Array(disk));
  assert.equal(decoded.width, 400);
  assert.equal(decoded.height, 300);
  assert.equal(result.bytes, disk.length);
  assert.equal(result.sha256, sha(disk));
  assert.match(result.path, /-library-region\.png$/, '局部截图文件名带 -region，便于和整窗图区分');
  assert.match(result.note, /局部/);

  // 裁的确实是那一块：把原图该区域涂成标记色，裁出来的中心像素必须是标记色
  const marked = solid(1600, 1000);
  for (let y = 50; y < 350; y += 1) {
    for (let x = 100; x < 500; x += 1) marked.data.set([255, 0, 0, 255], (y * 1600 + x) * 4);
  }
  const cropped = cropImage(marked, { x: 100, y: 50, w: 400, h: 300 });
  const center = (150 * 400 + 200) * 4;
  assert.deepEqual([...cropped.image.data.slice(center, center + 4)], [255, 0, 0, 255]);
  assert.deepEqual([...cropped.image.data.slice(0, 4)], [255, 0, 0, 255], '左上角就是取景框原点，不能偏一像素');
});

// ---------------------------------------------------------------------------
// 3) 越界：夹紧到有效区域，clamped=true，回传最终 region（不静默换区域）
// ---------------------------------------------------------------------------
test('越界 region 被夹紧且 clamped=true，最终 region 与图上一致', async () => {
  const png = pngOf(solid(1600, 1000));
  const { tools } = setup({
    capture: () => async (request) => ({ ok: true, png, width: request.width, height: request.height })
  });

  const result = await tools.call('capture_view', {
    view: '3d',
    region: { x: 1400, y: 900, w: 400, h: 300 }
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.clamped, true);
  assert.deepEqual(result.region, { x: 1200, y: 700, w: 400, h: 300 }, '保留请求尺寸，把起点平移回边界内');
  assert.equal(result.width, 400);
  assert.equal(result.height, 300);

  // 负坐标：夹到 0
  const negative = await tools.call('capture_view', { view: '3d', region: { x: -40, y: -10, w: 200, h: 150 } });
  assert.equal(negative.ok, true, JSON.stringify(negative));
  assert.equal(negative.clamped, true);
  assert.deepEqual(negative.region, { x: 0, y: 0, w: 200, h: 150 });

  // 纯函数口径再钉一次：宽高超过原图时截到原图边界
  const huge = clampRegion({ x: 0, y: 0, w: 5000, h: 4000 });
  assert.deepEqual(huge.region, { x: 0, y: 0, w: 1600, h: 1000 });
  assert.equal(huge.clamped, true);
});

// ---------------------------------------------------------------------------
// 4) w/h < 32：明确拒绝（INVALID_ARGUMENT），既不截图也不落文件
// ---------------------------------------------------------------------------
test('region 的 w/h < 32 返回 INVALID_ARGUMENT，且不触发截图', async () => {
  const png = pngOf(solid(1600, 1000));
  const { tools, requests, root } = setup({
    capture: (calls) => async (request) => {
      calls.push(request);
      return { ok: true, png, width: request.width, height: request.height };
    }
  });

  for (const region of [{ x: 10, y: 10, w: 31, h: 100 }, { x: 10, y: 10, w: 100, h: 8 }]) {
    const result = await tools.call('capture_view', { view: '3d', region });
    assert.equal(result.ok, false, 'w/h 太小必须明确拒绝');
    assert.equal(result.code, 'INVALID_ARGUMENT');
    assert.match(result.message, /至少 32/);
  }
  assert.equal(requests.length, 0, '参数不合法时不该先截一张整窗');
  assert.equal(existsSync(join(root, 'agent-shots')), false, '拒绝时不能落任何截图');

  const badScale = await tools.call('capture_view', { view: '3d', scale: 'big' });
  assert.equal(badScale.ok, false);
  assert.equal(badScale.code, 'INVALID_ARGUMENT');

  // 非 PNG（旧行为里的假字节）配上 region 要如实失败，不产出坏图
  const fake = new Uint8Array(64);
  fake.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const broken = setup({ capture: () => async () => ({ ok: true, png: fake, width: 1600, height: 1000 }) });
  const failed = await broken.tools.call('capture_view', { view: '3d', region: { x: 0, y: 0, w: 100, h: 100 } });
  assert.equal(failed.ok, false);
  assert.match(String(failed.code), /VISION_UNSUPPORTED_FORMAT|SHOT_CROP_FAILED/);
});

// ---------------------------------------------------------------------------
// 5) scale：越界夹到 0.5–3，最终倍数如实回传，尺寸按倍数放大
// ---------------------------------------------------------------------------
test('scale 超出 0.5–3 被夹紧并如实回传最终倍数', async () => {
  const png = pngOf(solid(1600, 1000));
  const { tools } = setup({
    capture: () => async (request) => ({ ok: true, png, width: request.width, height: request.height })
  });

  const big = await tools.call('capture_view', { view: '3d', region: { x: 0, y: 0, w: 200, h: 100 }, scale: 9 });
  assert.equal(big.ok, true, JSON.stringify(big));
  assert.equal(big.scale, 3);
  assert.equal(big.width, 600);
  assert.equal(big.height, 300);

  const small = await tools.call('capture_view', { view: '3d', region: { x: 0, y: 0, w: 200, h: 100 }, scale: 0.1 });
  assert.equal(small.scale, 0.5);
  assert.equal(small.width, 100);
  assert.equal(small.height, 50);

  const parsed = parseRegionArgs({ region: { x: 0, y: 0, w: 64, h: 64 }, scale: 2.5 });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan.scale, 2.5);

  // 大区域再放大 3 倍会产出上千万像素，只用于 vision（长边 1024），按 400 万像素封顶；
  // 返回的 scale 是**实际生效倍数**，必须和 width/region.w 对得上，不能报 3 却说 1.78。
  const huge = await tools.call('capture_view', {
    view: '3d',
    region: { x: 0, y: 0, w: 1400, h: 900 },
    scale: 3
  });
  assert.equal(huge.ok, true, JSON.stringify(huge));
  assert.ok(huge.width * huge.height <= 4_100_000, `输出像素 ${huge.width}x${huge.height} 超过封顶`);
  assert.ok(huge.scale < 3, '封顶后实际倍数必须小于请求的 3');
  assert.ok(Math.abs(huge.scale - huge.width / 1400) < 0.01, 'scale 必须等于 width / region.w');
});

// ---------------------------------------------------------------------------
// 6) 裁完再放大仍受 vision 上限约束（长边 ≤1024、≤400 KB）
// ---------------------------------------------------------------------------
test('region + 放大后的 PNG 经 vision 压缩仍 ≤1024 且 ≤400 KB', async () => {
  const png = pngOf(noise(1600, 1000));
  let last = null;
  const { tools } = setup({
    capture: () => async (request) => {
      last = request;
      return { ok: true, png, width: request.width, height: request.height };
    }
  });

  const result = await tools.call('capture_view', {
    view: 'linkage',
    region: { x: 600, y: 400, w: 400, h: 300 },
    scale: 3
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(last.view, 'linkage', '裁剪在主进程截完整窗之后做，不额外改变视图');
  assert.equal(result.width, 1200, '落盘的是裁剪后放大 3 倍的图');
  assert.equal(result.height, 900);

  const disk = readFileSync(result.path);
  assert.ok(Math.max(result.width, result.height) > VISION_MAX_EDGE, '放大后落盘长边应超过 vision 上限，才会触发压缩');
  const fitted = fitPng(new Uint8Array(disk));
  assert.ok(fitted.data.length <= VISION_MAX_BYTES, `压缩后 ${fitted.data.length} 字节超限`);
  assert.ok(Math.max(fitted.width, fitted.height) <= VISION_MAX_EDGE, `长边 ${fitted.width}x${fitted.height} 超限`);
  const decoded = decodePng(fitted.data);
  assert.equal(decoded.width, fitted.width);
  assert.equal(decoded.height, fitted.height);
});

// ---------------------------------------------------------------------------
// 7) 顺序：先裁后缩 > 先缩后裁（像素级清晰度对比，不是只比尺寸）
// ---------------------------------------------------------------------------
test('同一 region：先裁后放的边缘能量显著高于先整图缩小再裁', () => {
  const region = { x: 600, y: 400, w: 400, h: 300 };
  const source = stripes(1600, 1000, region);

  // A：先裁后缩（本实现的顺序）
  const applied = applyRegion(pngOf(source), region, 2);
  const a = decodePng(applied.png);
  assert.equal(a.width, 800);
  assert.equal(a.height, 600);

  // B：先整图缩到长边 1024（vision 侧现在发生的事），再裁对应区域，再放大回同样的 800x600
  const shrunk = resizeRgba(source, 1024, 640);
  const ratio = 1024 / 1600;
  const b = resizeRgba(
    cropImage(shrunk, {
      x: Math.round(region.x * ratio),
      y: Math.round(region.y * ratio),
      w: Math.round(region.w * ratio),
      h: Math.round(region.h * ratio)
    }).image,
    800,
    600
  );

  const energyA = edgeEnergy(a);
  const energyB = edgeEnergy(b);
  assert.ok(energyA > 0, '裁出来的条纹不该是纯色');
  assert.ok(
    energyA > energyB * 1.5,
    `先裁后缩应保留更多高频细节：A=${energyA.toFixed(2)} B=${energyB.toFixed(2)}`
  );
});

// ---------------------------------------------------------------------------
// 8) 提示词：局部必须写明坐标与原图尺寸，整窗不许多嘴
// ---------------------------------------------------------------------------
test('视觉回灌提示词写明「这是局部（x,y,w×h）」，整窗提示词保持原样', () => {
  const attachment = {
    ok: true,
    path: '/tmp/x.png',
    view: 'library',
    mime: 'image/png',
    dataUrl: 'data:image/png;base64,AA==',
    bytes: 1024,
    width: 400,
    height: 300,
    sourceBytes: 4096,
    scaled: false
  };
  const shot = {
    path: '/tmp/x.png',
    view: 'library',
    width: 400,
    height: 300,
    region: { x: 120, y: 80, w: 400, h: 300 },
    clamped: true,
    scale: 2,
    sourceSize: { w: 1600, h: 1000 }
  };
  const text = visionPromptText(shot, attachment);
  assert.match(text, /局部/);
  assert.match(text, /x=120, y=80, 400x300/);
  assert.match(text, /原图 1600x1000/);
  assert.match(text, /放大 2x/);
  assert.match(text, /已夹紧/);
  assert.ok(text.includes('未看到图像'), '带图时也要保留「没收到图就说没看到」的兜底');

  const skipped = visionSkippedText(shot, 'VISION_DISABLED');
  assert.match(skipped, /局部/);

  const whole = visionPromptText({ path: '/tmp/y.png', view: '3d', width: 1600, height: 1000 }, attachment);
  assert.equal(whole.includes('局部'), false, '整窗提示词不能出现「局部」');
  assert.equal(
    whole,
    [
      '这是刚才请求的视图截图（3d，400x300）。请描述你看到的内容并判断是否与目标一致；看不到就说看不到。',
      '（截图已压缩：原图 1600x1000 / 4 KB → 400x300 / 1 KB）',
      '如果你实际没有收到图像（工具报错、模型不支持图片等），必须直接写「未看到图像」，只根据尺寸与哈希说明，不要描述画面、不要下「看起来没问题」的结论。'
    ].join('\n'),
    '不传 region 时提示词必须与旧版逐字一致'
  );
});

// ---------------------------------------------------------------------------
// 10) 高 DPI 坐标系：region 的上界是**本次截图的真实像素尺寸**，不是常量 1600×1000
//     （旧实现先按 1600×1000 夹一次，3200×2000 上请求右侧 x=2000 会被夹回左上）
// ---------------------------------------------------------------------------
test('高 DPI 3200×2000：请求右侧 x=2000 原样生效（不夹紧），sourceSize 如实回传', async () => {
  const sourceWidth = 3200;
  const sourceHeight = 2000;
  const marked = solid(sourceWidth, sourceHeight);
  for (let y = 1200; y < 1800; y += 1) {
    for (let x = 2000; x < 2800; x += 1) marked.data.set([0, 128, 255, 255], (y * sourceWidth + x) * 4);
  }
  const png = pngOf(marked);
  const { tools } = setup({
    // 通道回的是 capturePage 的真实像素（高 DPI 下与请求的 1600×1000 不同）
    capture: () => async () => ({ ok: true, png, width: sourceWidth, height: sourceHeight })
  });

  const result = await tools.call('capture_view', { view: '3d', region: { x: 2000, y: 1200, w: 800, h: 600 } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.region, { x: 2000, y: 1200, w: 800, h: 600 }, '真实尺寸下这块区域完全合法，一个像素都不该挪');
  assert.equal(result.clamped, false, '大图右半区域不是越界');
  assert.deepEqual(result.sourceSize, { w: 3200, h: 2000 });
  assert.equal(result.width, 800);
  assert.equal(result.height, 600);
  assert.match(result.note, /x=2000, y=1200/);

  // 像素级证明：裁出来的左上角就是原图 (2000,1200) 的标记色（左上角是纯白）
  const decoded = decodePng(new Uint8Array(readFileSync(result.path)));
  assert.equal(decoded.width, 800);
  assert.equal(decoded.height, 600);
  assert.deepEqual([...decoded.data.slice(0, 4)], [0, 128, 255, 255], '裁的必须是 (2000,1200) 那一块，不是被夹回左上');
  const bottomRight = ((600 - 1) * 800 + (800 - 1)) * 4;
  assert.deepEqual([...decoded.data.slice(bottomRight, bottomRight + 4)], [0, 128, 255, 255]);
});

// ---------------------------------------------------------------------------
// 11) 大图越界：仍按真实尺寸夹紧（3200 宽 → x=3000 平移回 2400）
// ---------------------------------------------------------------------------
test('高 DPI 大图越界按真实尺寸夹紧（3200×2000 → 平移回 2400,1400），clamped=true', async () => {
  const sourceWidth = 3200;
  const sourceHeight = 2000;
  const png = pngOf(solid(sourceWidth, sourceHeight));
  const { tools } = setup({
    capture: () => async () => ({ ok: true, png, width: sourceWidth, height: sourceHeight })
  });

  const result = await tools.call('capture_view', { view: 'library', region: { x: 3000, y: 1900, w: 800, h: 600 } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.clamped, true);
  assert.deepEqual(result.region, { x: 2400, y: 1400, w: 800, h: 600 }, '保留请求尺寸，起点按真实宽高平移回边界内');
  assert.deepEqual(result.sourceSize, { w: 3200, h: 2000 });
  assert.equal(result.width, 800);
  assert.equal(result.height, 600);

  // 纯函数口径再钉一次：同样的坐标，按 1600×1000 夹会得到 800,400（旧 bug），按真实尺寸得到 2400,1400
  const real = clampRegion({ x: 3000, y: 1900, w: 800, h: 600 }, { width: sourceWidth, height: sourceHeight });
  assert.deepEqual(real.region, { x: 2400, y: 1400, w: 800, h: 600 });
  assert.equal(real.clamped, true);
  const byDefaultWindow = clampRegion({ x: 3000, y: 1900, w: 800, h: 600 }, { width: 1600, height: 1000 });
  assert.deepEqual(byDefaultWindow.region, { x: 800, y: 400, w: 800, h: 600 }, '按 1600×1000 夹会把请求拉到左上（正是本 bug）');
});

// ---------------------------------------------------------------------------
// 12) 小图：请求宽度超过真实宽度时按真实尺寸截断，而不是按 1600 放行
// ---------------------------------------------------------------------------
test('小图 800×600：请求 1600 宽按真实宽度夹到 800，clamped=true', async () => {
  const png = pngOf(solid(800, 600));
  const { tools } = setup({
    capture: () => async () => ({ ok: true, png, width: 800, height: 600 })
  });

  const result = await tools.call('capture_view', { view: 'exports', region: { x: 0, y: 0, w: 1600, h: 400 } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.clamped, true);
  assert.deepEqual(result.region, { x: 0, y: 0, w: 800, h: 400 }, '宽度必须按真实 800 截断');
  assert.deepEqual(result.sourceSize, { w: 800, h: 600 });
  assert.equal(result.width, 800);
  assert.equal(result.height, 400);

  const decoded = decodePng(new Uint8Array(readFileSync(result.path)));
  assert.equal(decoded.width, 800, '落盘宽度不能是请求的 1600');
  assert.equal(decoded.height, 400);
});

// ---------------------------------------------------------------------------
// 13) 不传 region：高 DPI 大图也必须字节级原样落盘（不进任何像素处理）
// ---------------------------------------------------------------------------
test('高 DPI 3200×2000 不传 region：落盘字节与截图通道逐字节一致，不出现 region 字段', async () => {
  const png = pngOf(solid(3200, 2000));
  const { tools, root } = setup({
    capture: () => async () => ({ ok: true, png, width: 3200, height: 2000 })
  });

  const result = await tools.call('capture_view', { view: '3d' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.bytes, png.byteLength);
  assert.equal(result.sha256, sha(png));
  assert.deepEqual(readFileSync(result.path), Buffer.from(png), '整窗路径不能重新编码');
  assert.equal(result.width, 3200, '真实尺寸如实回传');
  assert.equal(result.height, 2000);
  assert.equal('region' in result, false);
  assert.equal('clamped' in result, false);
  assert.match(result.path, /2026-11-04T08-09-10-123Z-3d\.png$/);
  assert.equal(existsSync(join(root, 'agent-shots')), true);
});

// ---------------------------------------------------------------------------
// 14) 只传 scale 不传 region：语义是「整图放大」，按真实整图而不是默认窗口那一块
// ---------------------------------------------------------------------------
test('只传 scale 不传 region：按真实整图放大（2000×1000 源不会被截成左上 1600×1000）', async () => {
  const png = pngOf(solid(2000, 1000));
  const { tools } = setup({
    capture: () => async () => ({ ok: true, png, width: 2000, height: 1000 })
  });

  const result = await tools.call('capture_view', { view: '3d', scale: 1.4 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.region, { x: 0, y: 0, w: 2000, h: 1000 }, '没给 region 时 region 必须覆盖真实整图');
  assert.equal(result.clamped, false);
  assert.deepEqual(result.sourceSize, { w: 2000, h: 1000 });
  assert.equal(result.width, 2800, '2000×1.4；若仍按 1600 常量裁会是 2240');
  assert.equal(result.height, 1400);
  assert.ok(result.width * result.height <= 4_100_000);
});

// ---------------------------------------------------------------------------
// 9) 会话级回灌：region 元数据从工具回执一路进到「发给模型的那条消息」
// ---------------------------------------------------------------------------
test('会话回灌：region/clamped/scale/sourceSize 进入提示词，模型拿到图 + 局部说明', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cad-capture-region-session-'));
  roots.push(root);
  mkdirSync(join(root, 'agent-shots'), { recursive: true });
  const png = encodePng(solid(400, 300));
  const shotPath = join(root, 'agent-shots', '2026-11-04T08-09-10-123Z-library-region.png');
  writeFileSync(shotPath, Buffer.from(png));

  const calls = [];
  let turn = 0;
  const llm = {
    calls,
    async chat(messages) {
      calls.push(messages);
      turn += 1;
      if (turn === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'call-1',
            type: 'function',
            function: {
              name: 'capture_view',
              arguments: JSON.stringify({ view: 'library', region: { x: 120, y: 80, w: 400, h: 300 }, scale: 2 })
            }
          }]
        };
      }
      return { content: '局部里的数值我读到了。', toolCalls: [] };
    }
  };
  const bus = {
    async execute(name) {
      if (name !== 'capture_view') return { ok: true, data: {} };
      return {
        ok: true,
        data: {
          ok: true,
          view: 'library',
          path: shotPath,
          bytes: png.length,
          sha256: sha(png),
          width: 800,
          height: 600,
          region: { x: 120, y: 80, w: 400, h: 300 },
          clamped: false,
          scale: 2,
          sourceSize: { w: 1600, h: 1000 }
        }
      };
    },
    async undoLast() {
      return { ok: true, data: {} };
    }
  };
  const session = new AgentSession({
    llm,
    bus,
    confirmWrite: async () => true,
    maxIterations: 4,
    vision: { mode: 'on', userDataDir: root }
  });
  await session.run('放大看下机型库的方案卡');

  assert.equal(calls.length >= 2, true, '至少要发两轮：工具调用 + 带图回执');
  const feedback = calls[1].at(-1);
  assert.equal(feedback.role, 'user');
  assert.equal(Array.isArray(feedback.content), true, '带图回执必须是分段数组');
  const text = feedback.content[0].text;
  assert.match(text, /局部/);
  assert.match(text, /x=120, y=80, 400x300/);
  assert.match(text, /原图 1600x1000/);
  assert.match(text, /放大 2x/);
  assert.equal(feedback.content.some((part) => part.type === 'image_url'), true, '局部图必须真的发出去');
});
