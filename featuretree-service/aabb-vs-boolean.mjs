// AABB 初筛 vs 真实布尔：同一对几何，两种口径差多少？
//
// 为什么要做这件事：整机排布合规用的是 AABB（轴对齐包围盒）初筛，快但**看不见孔**，也把圆柱当方块。
// 这里拿 sidecar 的真实布尔交集（build123d `&`）当基准，量出两个方向的误差：
//   A. 板 + 实心圆柱相贯 —— AABB 把 φ10 圆柱当 10×10 方块 → **高估**（保守，多报不误报）
//   B. 板 + 通孔 + 螺栓穿过 —— AABB 看不见孔 → **整块误报**（这方向才危险）
//
// 跑法：node featuretree-service/aabb-vs-boolean.mjs（需要带 build123d 的 Python，缺了 SKIP 退出 0）

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const python = process.env.FT_PYTHON || resolve(repoRoot, 'spike', 'sketch', '.venv', 'bin', 'python');

if (!existsSync(python)) {
  console.log(`AABB_VS_BOOLEAN_SKIP 找不到带 build123d 的 Python：${python}（可用 FT_PYTHON 指定）`);
  process.exit(0);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const PLATE = { length: 90, width: 90, height: 12 };

// AABB 重叠：从参数推包围盒，不是猜
const plateBox = { x: [-45, 45], y: [-45, 45], z: [0, 12] };
const boxOfCylinder = (diameter, height, offsetZ) => {
  const r = diameter / 2;
  return { x: [-r, r], y: [-r, r], z: [-height / 2 + offsetZ, height / 2 + offsetZ] };
};
const span = (a, b) => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
const aabbOverlap = (a, b) => span(a.x, b.x) * span(a.y, b.y) * span(a.z, b.z);

const cases = [
  {
    id: 'A-实心圆柱相贯',
    note: 'AABB 把 φ10 圆柱当 10×10 方块 → 高估 4/π−1 ≈ 27.3%',
    members: [
      { ops: [{ op: 'box', ...PLATE }], offset: [0, 0, 0] },
      { ops: [{ op: 'cylinder', diameter: 10, height: 20 }], offset: [0, 0, 6] }
    ],
    aabbMm3: aabbOverlap(plateBox, boxOfCylinder(10, 20, 6)),
    // 真实交集体积的解析值：圆柱在板内的部分 = π r² × 板厚
    analyticMm3: Math.PI * 25 * PLATE.height
  },
  {
    id: 'B-螺栓穿孔',
    note: 'AABB 看不见孔 → 把「螺栓在孔里」报成整块干涉（误报）',
    members: [
      {
        ops: [
          { op: 'box', ...PLATE },
          { op: 'holes', diameter: 11, depth: 'through', positions: [[0, 0]] }
        ],
        offset: [0, 0, 0]
      },
      { ops: [{ op: 'cylinder', diameter: 10, height: 40 }], offset: [0, 0, 6] }
    ],
    aabbMm3: aabbOverlap(plateBox, boxOfCylinder(10, 40, 6)),
    analyticMm3: 0 // φ10 穿过 φ11 的孔：真实交集为 0
  },
  {
    // 回归用例：`anchor:'center'` 曾被实现成「把本来就居中的盒子再平移半个尺寸」，
    // 于是带转角的复核件整体偏了 (L/2,W/2,H/2)，凭空造出交集体积——
    // 我据此误报过「六工位 4 对真干涉 2928 mm³」。把小探针放在被测件几何中心：
    // 位置对 → 交集就是探针体积 1000 mm³；位置错 → 交集接近 0。
    id: 'C-转角件居中',
    note: 'anchor:center + rotate + move 必须把几何中心放到指定点（探针落在中心 = 1000 mm³）',
    members: [
      {
        ops: [
          { op: 'box', length: 50, width: 50, height: 300, anchor: 'center' },
          { op: 'rotate', deg: 60 },
          { op: 'move', x: 0, y: 0, z: 150 }
        ],
        offset: [0, 0, 0]
      },
      {
        ops: [{ op: 'box', length: 10, width: 10, height: 10, anchor: 'center' }],
        offset: [0, 0, 150]
      }
    ],
    aabbMm3: 1000,
    analyticMm3: 1000
  }
];

const sidecar = spawn(python, [resolve(here, 'rebuild-sidecar.py')], {
  env: { ...process.env, FT_BUILD_PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let port = '';
sidecar.stdout.setEncoding('utf8');
sidecar.stdout.on('data', (chunk) => {
  const match = chunk.match(/http:\/\/127\.0\.0\.1:(\d+)/);
  if (match && !port) port = match[1];
});
sidecar.stderr.setEncoding('utf8');

let failed = false;
const fail = (message) => {
  failed = true;
  console.error(`AABB_VS_BOOLEAN_FAIL ${message}`);
};

try {
  for (let attempt = 0; attempt < 200 && !port; attempt += 1) await sleep(500);
  if (!port) throw new Error('sidecar 未起来（打印端口超时）');

  for (const item of cases) {
    const response = await fetch(`http://127.0.0.1:${port}/interfere`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members: item.members })
    });
    const result = await response.json();
    if (!result.ok) throw new Error(`${item.id}：/interfere 失败：${result.message}`);

    const pair = (result.pairs || [])[0];
    const booleanMm3 = pair ? pair.overlapMm3 : 0;
    const analyticError = Math.abs(booleanMm3 - item.analyticMm3);
    if (analyticError > 1) {
      fail(`${item.id}：布尔体积 ${booleanMm3} 与解析值 ${item.analyticMm3.toFixed(2)} 差 ${analyticError.toFixed(2)} mm³`);
    }
    if (item.analyticMm3 === 0) {
      if (booleanMm3 !== 0) fail(`${item.id}：螺栓在孔里不该有交集体积，实际 ${booleanMm3}`);
      if (!(item.aabbMm3 > 0)) fail(`${item.id}：这个用例本来就是要暴露 AABB 误报，AABB 却是 0`);
      const falsePositive = item.aabbMm3;
      console.log(`AABB_VS_BOOLEAN_OK ${item.id} aabb=${falsePositive.toFixed(2)} boolean=${booleanMm3} → AABB 误报 ${(falsePositive).toFixed(0)} mm³（真实为 0）`);
    } else {
      if (!(item.aabbMm3 >= booleanMm3)) fail(`${item.id}：AABB ${item.aabbMm3} 不该小于真实布尔 ${booleanMm3}`);
      const ratio = item.aabbMm3 / booleanMm3;
      console.log(`AABB_VS_BOOLEAN_OK ${item.id} aabb=${item.aabbMm3.toFixed(2)} boolean=${booleanMm3} analytic=${item.analyticMm3.toFixed(2)} 高估=x${ratio.toFixed(3)}`);
    }
    console.log(`  ${item.note}`);
  }
} catch (error) {
  failed = true;
  console.error(`AABB_VS_BOOLEAN_FAIL ${error.message}`);
} finally {
  sidecar.kill('SIGKILL');
}

process.exit(failed ? 1 : 0);
