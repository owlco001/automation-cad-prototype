// 真实几何重建验收（契约 §14.1）：build123d sidecar + 契约服务。
// - 种子树重建后体积/包围盒/质量必须与手算一致（体积误差 ≤1 mm³）
// - 改板厚后体积按手算变化（证明是真重建，不是缓存指纹）
// - sidecar 配了但连不上时必须 REBUILD_FAILED（fail-closed，不发布假几何）
//
// 依赖：带 build123d 的 Python（默认用仓库内 spike/sketch/.venv），缺失则打印 SKIP 退出 0。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const python = process.env.FT_PYTHON || resolve(repoRoot, 'spike', 'sketch', '.venv', 'bin', 'python');

if (!existsSync(python)) {
  console.log(`FT_BUILD_TEST_SKIP 找不到带 build123d 的 Python：${python}（可用 FT_PYTHON 指定）`);
  process.exit(0);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { console.log(`PASS: ${label}`); return; }
  failures += 1;
  console.error(`FAIL: ${label} ${extra}`);
};

// 手算（mm³）：板体 − 4×沉头/通孔 − 4×角圆角
const analytic = ({ l = 90, w = 90, h = 12, d = 5.5, cbD = 8.5, cbDepth = 5, r = 3 } = {}) => {
  const plate = l * w * h;
  const holes = 4 * Math.PI * (d / 2) ** 2 * h;
  const counterbores = 4 * (Math.PI * (d / 2) ** 2 * h + Math.PI * ((cbD / 2) ** 2 - (d / 2) ** 2) * cbDepth);
  const fillets = 4 * (r * r - Math.PI * r * r / 4) * h;
  return plate - holes - counterbores - fillets;
};

const sidecar = spawn(python, [resolve(here, 'rebuild-sidecar.py')], {
  env: { ...process.env, FT_BUILD_PORT: '0' },
  stdio: ['ignore', 'pipe', 'pipe']
});
sidecar.stderr.setEncoding('utf8');
sidecar.stderr.on('data', (chunk) => process.stderr.write(`[sidecar] ${chunk}`));
let sidecarOut = '';
sidecar.stdout.setEncoding('utf8');
sidecar.stdout.on('data', (chunk) => { sidecarOut += chunk; });
let buildBase = '';
for (let attempt = 0; attempt < 100 && !buildBase; attempt += 1) {
  const match = sidecarOut.match(/http:\/\/127\.0\.0\.1:(\d+)/);
  if (match) buildBase = match[1];
  else await sleep(150);
}
if (!buildBase) {
  console.error('FT_BUILD_TEST_FAIL sidecar 未起来', sidecarOut.slice(0, 300));
  sidecar.kill('SIGKILL');
  process.exit(1);
}

// FT_BUILD_PORT=0 时 sidecar 打印的是实际端口；这里为了简单直接读日志里的端口
const service = spawn(process.execPath, [resolve(here, 'server.mjs')], {
  env: { ...process.env, FT_PORT: '0', FT_BUILD_URL: `http://127.0.0.1:${buildBase}` },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serviceLog = '';
service.stdout.setEncoding('utf8');
service.stdout.on('data', (chunk) => { serviceLog += chunk; });
let base = '';
for (let attempt = 0; attempt < 100 && !base; attempt += 1) {
  const match = serviceLog.match(/http:\/\/127\.0\.0\.1:(\d+)/);
  if (match) base = `http://127.0.0.1:${match[1]}`;
  else await sleep(100);
}
if (!base) {
  console.error('FT_BUILD_TEST_FAIL 契约服务未起来', serviceLog.slice(0, 300));
  service.kill('SIGKILL');
  sidecar.kill('SIGKILL');
  process.exit(1);
}

const http = async (method, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: await response.json() };
};

try {
  const tree = await http('GET', '/v1/tree');
  const geometry = tree.json.geometry;
  ok(Boolean(geometry) && geometry.kernel === 'build123d', '包络带真实几何（kernel=build123d）', String(JSON.stringify(geometry)).slice(0, 120));
  const expected = analytic({});
  ok(Boolean(geometry) && Math.abs(geometry.volumeMm3 - expected) <= 1,
    '种子树体积与手算一致', `actual=${geometry?.volumeMm3} expected=${expected.toFixed(1)}`);
  ok(Boolean(geometry) && Math.abs(geometry.bboxMm.z - 12) <= 0.01 && Math.abs(geometry.bboxMm.x - 90) <= 0.01,
    '包围盒 90×90×12', String(JSON.stringify(geometry?.bboxMm)));
  const expectedMass = (expected / 1000) * 7.85 / 1000;
  ok(Boolean(geometry) && Math.abs(geometry.massKg - expectedMass) <= 0.002,
    '质量按密度算出（钢 7.85 g/cm³）', `actual=${geometry?.massKg} expected=${expectedMass.toFixed(4)}`);

  const edited = await http('POST', '/v1/operations', {
    documentId: 'demo-adapter', expectedRevision: tree.json.revision, actor: 'manual',
    operation: 'updateFeatureParams', featureId: 'f-body', patch: { height: 13 }
  });
  ok(edited.status === 200 && edited.json.geometry, '改板厚后仍返回几何', JSON.stringify(edited.json).slice(0, 140));
  const expected13 = analytic({ h: 13 });
  ok(edited.json.geometry && Math.abs(edited.json.geometry.volumeMm3 - expected13) <= 1,
    '改后体积与手算一致（h=13）', `actual=${edited.json.geometry?.volumeMm3} expected=${expected13.toFixed(1)}`);
  ok(edited.json.history?.at(-1)?.geometry?.volumeMm3 === edited.json.geometry?.volumeMm3,
    '历史记录里也留了体积（可追溯）');

  // STL 导出：客户端渲染的唯一几何来源（Qt/OCCT 直接读这份，不在客户端重算）
  const stl = await fetch(`${base}/v1/geometry.stl`);
  const stlBytes = Buffer.from(await stl.arrayBuffer());
  ok(stl.status === 200 && stl.headers.get('content-type')?.includes('stl'), 'GET /v1/geometry.stl 返回 STL', `status=${stl.status} type=${stl.headers.get('content-type')}`);
  ok(stlBytes.length > 1000, 'STL 有实际三角面数据', `bytes=${stlBytes.length}`);
  // 二进制 STL：前 80 字节是 header，随后 4 字节是三角面个数
  const triangleCount = stlBytes.length >= 84 ? stlBytes.readUInt32LE(80) : 0;
  ok(triangleCount > 10 && 84 + triangleCount * 50 === stlBytes.length, 'STL 三角面数与文件长度自洽', `tris=${triangleCount} bytes=${stlBytes.length}`);
  // 材料 → 质量：几何不变，质量按密度重算（铝 2.70 vs 钢 7.85）
  const beforeMat = await http('GET', '/v1/tree');
  const volume = beforeMat.json.geometry.volumeMm3;
  const aluminum = await http('POST', '/v1/operations', {
    documentId: 'demo-adapter', expectedRevision: beforeMat.json.revision, actor: 'manual',
    operation: 'setMaterial', material: 'aluminum'
  });
  ok(aluminum.status === 200 && aluminum.json.doc.material === 'aluminum', '切换到铝成功');
  ok(Math.abs(aluminum.json.geometry.volumeMm3 - volume) <= 0.5, '换材料几何不变（体积一致）',
    `${volume} → ${aluminum.json.geometry.volumeMm3}`);
  ok(Math.abs(aluminum.json.geometry.massKg - volume * 2.7 / 1e6) <= 0.002,
    '铝质量 = 体积 × 2.70', `mass=${aluminum.json.geometry.massKg} expected=${(volume * 2.7 / 1e6).toFixed(4)}`);
  ok(aluminum.json.geometry.materialLabel === '铝', '几何里带材料名');
  const steel = await http('POST', '/v1/operations', {
    documentId: 'demo-adapter', expectedRevision: aluminum.json.revision, actor: 'manual',
    operation: 'setMaterial', material: 'steel'
  });
  ok(Math.abs(steel.json.geometry.massKg - volume * 7.85 / 1e6) <= 0.002, '切回钢质量按 7.85 重算',
    `mass=${steel.json.geometry.massKg}`);
} catch (error) {
  failures += 1;
  console.error('FT_BUILD_TEST_FAIL', error);
} finally {
  service.kill('SIGTERM');
  sidecar.kill('SIGTERM');
}

// sidecar 配了但连不上 → 必须 REBUILD_FAILED（fail-closed）
{
  const deadService = spawn(process.execPath, [resolve(here, 'server.mjs')], {
    env: { ...process.env, FT_PORT: '0', FT_BUILD_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  deadService.stdout.setEncoding('utf8');
  deadService.stdout.on('data', (chunk) => { log += chunk; });
  let deadBase = '';
  for (let attempt = 0; attempt < 100 && !deadBase; attempt += 1) {
    const match = log.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) deadBase = `http://127.0.0.1:${match[1]}`;
    else await sleep(100);
  }
  if (deadBase) {
    const response = await fetch(`${deadBase}/v1/operations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documentId: 'demo-adapter', expectedRevision: 0, actor: 'manual',
        operation: 'updateFeatureParams', featureId: 'f-body', patch: { height: 15 }
      })
    });
    const payload = await response.json().catch(() => null);
    ok(response.status === 422 && payload?.error === 'REBUILD_FAILED' &&
       String(payload?.message || '').includes('sidecar'),
      'sidecar 不可用时 REBUILD_FAILED（不发布假几何）', JSON.stringify(payload).slice(0, 140));
  }
  deadService.kill('SIGTERM');
}

// sidecar 晚于服务起来（build123d 首次 import 慢）→ GET /v1/tree 应自动补几何
{
  const latePort = 17988;
  const lateService = spawn(process.execPath, [resolve(here, 'server.mjs')], {
    env: { ...process.env, FT_PORT: '0', FT_BUILD_URL: `http://127.0.0.1:${latePort}` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let lateLog = '';
  lateService.stdout.setEncoding('utf8');
  lateService.stdout.on('data', (chunk) => { lateLog += chunk; });
  let lateBase = '';
  for (let attempt = 0; attempt < 100 && !lateBase; attempt += 1) {
    const match = lateLog.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) lateBase = `http://127.0.0.1:${match[1]}`;
    else await sleep(100);
  }
  if (lateBase) {
    const before = await (await fetch(`${lateBase}/v1/tree`)).json();
    ok(!before.geometry, 'sidecar 未起时几何为空（不编造）');
    const lateSidecar = spawn(python, [resolve(here, 'rebuild-sidecar.py')], {
      env: { ...process.env, FT_BUILD_PORT: String(latePort) },
      stdio: ['ignore', 'ignore', 'ignore']
    });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const health = await fetch(`http://127.0.0.1:${latePort}/health`, { signal: AbortSignal.timeout(1000) });
        if (health.ok) break;
      } catch { /* 还没起来 */ }
      await sleep(250);
    }
    await sleep(5500); // 服务端 init 重试有 5s 节流
    const after = await (await fetch(`${lateBase}/v1/tree`)).json();
    ok(Boolean(after.geometry) && Math.abs(after.geometry.volumeMm3 - 94166.8) <= 1,
      'sidecar 起来后 GET /v1/tree 自动补上几何', `geometry=${JSON.stringify(after.geometry).slice(0, 90)}`);
    lateSidecar.kill('SIGTERM');
  }
  lateService.kill('SIGTERM');
}

if (failures > 0) {
  console.error(`失败 ${failures} 条`);
  process.exit(1);
}
console.log('FT_BUILD_OK 真实几何重建（体积/包围盒/质量/失败路径）通过');
