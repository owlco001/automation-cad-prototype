// 真实布尔复核：零件翻译成 sidecar 成员的口径，以及「AABB 说撞、布尔说不撞」的实证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { partToMember, recheckPairs } from '../../src/machine/recheck.ts';

const here = dirname(fileURLToPath(import.meta.url));

const part = (overrides) => ({
  id: 'p1',
  name: '零件',
  role: 'structure',
  shape: { type: 'box', size: [90, 90, 12] },
  center: [45, 45, 6],
  rotationZDeg: 0,
  color: '#888888',
  material: 'Q235',
  bomGroup: 'structure',
  ...overrides
});

test('box 的中心要换成 sidecar 的「原点角」口径（offset 减半个尺寸）', () => {
  const result = partToMember(part());
  assert.equal(result.ok, true);
  assert.deepEqual(result.member.offset, [0, 0, 0]);
  assert.deepEqual(result.member.ops, [{ op: 'box', length: 90, width: 90, height: 12 }]);
});

test('沿 Z 的圆柱：offset 就是中心，直径 = 2×半径', () => {
  const result = partToMember(part({ shape: { type: 'cylinder', radius: 5, length: 40, axis: 'z' }, center: [10, 20, 30] }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.member.offset, [10, 20, 30]);
  assert.deepEqual(result.member.ops, [{ op: 'cylinder', diameter: 10, height: 40 }]);
});

test('沿 X 的圆柱：如实说复核不了，不假装复核过', () => {
  const alongX = partToMember(part({ shape: { type: 'cylinder', radius: 5, length: 40, axis: 'x' } }));
  assert.equal(alongX.ok, false);
  assert.match(alongX.reason, /X/);
});

test('带转角的方块：现在能复核（居中 → 绕自身转 Z → 平移），不再说复核不了', () => {
  const rotated = partToMember(part({ rotationZDeg: 90 }));
  assert.equal(rotated.ok, true);
  assert.equal(rotated.member.ops.at(-1).op, 'move');
  assert.equal(rotated.member.ops.at(-2).deg, 90);
});

test('连不上 sidecar 时必须报「不可用」，不能把每对都记成误报', async () => {
  const result = await recheckPairs(
    [part({ id: 'a' }), part({ id: 'b', center: [46, 45, 6] })],
    [{ a: 'a', b: 'b' }],
    { buildUrl: 'http://127.0.0.1:1', timeoutMs: 1500 }
  );
  assert.equal(result.available, false);
  assert.equal(result.misreported, 0, '连不上不等于没问题');
  assert.equal(result.checked, 0);
  assert.match(result.message, /不可用/);
});

// —— 需要 build123d 的那条：AABB 报 12 mm³，真实布尔是 0 ——
const python = process.env.FT_PYTHON || resolve(here, '..', '..', '..', 'spike', 'sketch', '.venv', 'bin', 'python');
const hasPython = existsSync(python);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

test('AABB 说撞、真实布尔说不撞：圆柱贴着板角，AABB 12 mm³ → 布尔 0', { skip: hasPython ? false : '没有带 build123d 的 Python' }, async () => {
  const sidecar = spawn(python, [resolve(here, '..', '..', '..', 'featuretree-service', 'rebuild-sidecar.py')], {
    env: { ...process.env, FT_BUILD_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let port = '';
  sidecar.stdout.setEncoding('utf8');
  sidecar.stdout.on('data', (chunk) => {
    const match = chunk.match(/127\.0\.0\.1:(\d+)/);
    if (match && !port) port = match[1];
  });
  try {
    for (let attempt = 0; attempt < 200 && !port; attempt += 1) await sleep(500);
    assert.ok(port, 'sidecar 未起来');

    // 板 0..90 的 x/y、0..12 的 z；圆柱 φ10 在 (94,94)：包围盒 89..99 压到板角 1×1，
    // 但圆心到板最近点 (90,90) 距离 5.66 > 半径 5，真实不相交。
    const plate = part({ id: 'plate', shape: { type: 'box', size: [90, 90, 12] }, center: [45, 45, 6] });
    const pin = part({
      id: 'pin',
      shape: { type: 'cylinder', radius: 5, length: 40, axis: 'z' },
      center: [94, 94, 20]
    });
    const result = await recheckPairs([plate, pin], [{ a: 'plate', b: 'pin' }], {
      buildUrl: `http://127.0.0.1:${port}`
    });
    assert.equal(result.available, true);
    assert.equal(result.confirmed, 0, '真实布尔不该说撞');
    assert.equal(result.misreported, 1);
    assert.equal(result.pairs[0].overlapMm3, 0);
  } finally {
    sidecar.kill('SIGKILL');
  }
});
