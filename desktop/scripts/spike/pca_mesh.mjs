#!/usr/bin/env node
// 网格 PCA 与 B-Rep 面法的对照取样：对同一个 STEP 用 occt-import-js（App 内同一个解析器）
// 取三角网格，按 vertices 做协方差 PCA，得到「主轴 / 三个方向长度 / 等效半径」。
//
// 目的不是复刻 kinematics-auto.ts，而是量化两条路线的信息上限：
//   - 网格 PCA 只能看到零件的外轮廓点云，看不到内孔；半径估计会被棱角撑大。
//   - 解析 B-Rep 直接给出圆柱面的轴线与半径。
//
// 用法：node pca_mesh.mjs <file.stp> [--json]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../package.json', import.meta.url));
const occtimportjs = require('occt-import-js');
const wasmPath = require.resolve('occt-import-js/dist/occt-import-js.wasm');
const occt = await occtimportjs({ locateFile: (p) => (p.endsWith('.wasm') ? wasmPath : p) });

/** 3x3 对称矩阵 Jacobi 特征分解，返回按特征值降序的 {value, vector}。 */
function eigenSym3(a) {
  let m = a.map((row) => row.slice());
  let v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ];
  for (let sweep = 0; sweep < 32; sweep += 1) {
    let off = 0;
    for (let i = 0; i < 3; i += 1) for (let j = i + 1; j < 3; j += 1) off += m[i][j] * m[i][j];
    if (off < 1e-18) break;
    for (let p = 0; p < 3; p += 1) {
      for (let q = p + 1; q < 3; q += 1) {
        if (Math.abs(m[p][q]) < 1e-15) continue;
        const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k += 1) {
          const mkp = m[k][p];
          const mkq = m[k][q];
          m[k][p] = c * mkp - s * mkq;
          m[k][q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < 3; k += 1) {
          const mpk = m[p][k];
          const mqk = m[q][k];
          m[p][k] = c * mpk - s * mqk;
          m[q][k] = s * mpk + c * mqk;
        }
        for (let k = 0; k < 3; k += 1) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const out = [0, 1, 2].map((i) => ({ value: m[i][i], vector: [v[0][i], v[1][i], v[2][i]] }));
  out.sort((x, y) => y.value - x.value);
  return out.map((e) => ({ value: e.value, vector: normalize(e.vector) }));
}

const normalize = (p) => {
  const n = Math.hypot(p[0], p[1], p[2]) || 1;
  return [p[0] / n, p[1] / n, p[2] / n];
};

function analyze(points) {
  const n = points.length / 3;
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i += 1) {
    mean[0] += points[i * 3];
    mean[1] += points[i * 3 + 1];
    mean[2] += points[i * 3 + 2];
  }
  for (let k = 0; k < 3; k += 1) mean[k] /= n;
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  for (let i = 0; i < n; i += 1) {
    const d = [points[i * 3] - mean[0], points[i * 3 + 1] - mean[1], points[i * 3 + 2] - mean[2]];
    for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) cov[r][c] += d[r] * d[c];
  }
  for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) cov[r][c] /= n;
  const eig = eigenSym3(cov);

  // 沿每条主轴投影，取长度；绕最长轴算「最大半径」与「中位半径」——这就是 PCA 能给出的圆柱证据
  const spans = eig.map(({ vector }) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const t = (points[i * 3] - mean[0]) * vector[0] + (points[i * 3 + 1] - mean[1]) * vector[1] + (points[i * 3 + 2] - mean[2]) * vector[2];
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    return hi - lo;
  });
  const axis = eig[0].vector;
  const radii = [];
  for (let i = 0; i < n; i += 1) {
    const d = [points[i * 3] - mean[0], points[i * 3 + 1] - mean[1], points[i * 3 + 2] - mean[2]];
    const along = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
    const perp = [d[0] - along * axis[0], d[1] - along * axis[1], d[2] - along * axis[2]];
    radii.push(Math.hypot(perp[0], perp[1], perp[2]));
  }
  radii.sort((x, y) => x - y);
  const median = radii[Math.floor(radii.length / 2)];
  const p90 = radii[Math.floor(radii.length * 0.9)];
  const max = radii[radii.length - 1];
  return { axes: eig.map((e) => e.vector), spans, radiusMedian: median, radiusP90: p90, radiusMax: max };
}

const file = process.argv[2];
const json = process.argv.includes('--json');
const bytes = new Uint8Array(readFileSync(file));
const started = Date.now();
const result = occt.ReadStepFile(bytes, {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.5
});
const parseMs = Date.now() - started;
if (!result.success) {
  console.error('parse failed');
  process.exit(1);
}

const rows = result.meshes.map((mesh) => {
  const pos = mesh.attributes.position.array;
  const a = analyze(pos);
  return {
    name: mesh.name || '(无名)',
    vertices: pos.length / 3,
    triangles: mesh.index.array.length ? mesh.index.array.length / 3 : pos.length / 9,
    axis: a.axes[0].map((v) => +v.toFixed(3)),
    spans: a.spans.map((v) => +v.toFixed(2)),
    radiusMedian: +a.radiusMedian.toFixed(2),
    radiusP90: +a.radiusP90.toFixed(2),
    radiusMax: +a.radiusMax.toFixed(2)
  };
});

if (json) {
  console.log(JSON.stringify({ file, parseMs, meshes: rows.length, rows }, null, 2));
} else {
  console.log(`== ${file} ==`);
  console.log(`meshes=${rows.length} parse=${parseMs}ms`);
  console.log('name                          verts  tris  PCA-axis              spans(mm)          rMed  rP90  rMax');
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(28).slice(0, 28)}  ${String(r.vertices).padStart(5)} ${String(Math.round(r.triangles)).padStart(5)}  ` +
        `${r.axis.map((v) => v.toFixed(2).padStart(5)).join(',')}  ${r.spans.map((v) => v.toFixed(1).padStart(6)).join(' ')}  ` +
        `${r.radiusMedian.toFixed(2).padStart(5)} ${r.radiusP90.toFixed(2).padStart(5)} ${r.radiusMax.toFixed(2).padStart(5)}`
    );
  }
}
