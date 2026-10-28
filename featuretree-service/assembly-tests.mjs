// 装配验收：两个零件按偏移组成装配，几何由 sidecar fuse 出来（不是把体积相加）。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const python = process.env.FT_PYTHON || resolve(repoRoot, 'spike', 'sketch', '.venv', 'bin', 'python');
if (!existsSync(python)) {
  console.log(`ASSEMBLY_TEST_SKIP 找不到带 build123d 的 Python：${python}`);
  process.exit(0);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { console.log(`PASS: ${label}`); return; }
  failures += 1;
  console.error(`FAIL: ${label} ${extra}`);
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
let sidecarPort = '';
for (let attempt = 0; attempt < 120 && !sidecarPort; attempt += 1) {
  const match = sidecarOut.match(/http:\/\/127\.0\.0\.1:(\d+)/);
  if (match) sidecarPort = match[1];
  else await sleep(200);
}
if (!sidecarPort) {
  console.error('ASSEMBLY_TEST_FAIL sidecar 未起来', sidecarOut.slice(0, 200));
  sidecar.kill('SIGKILL');
  process.exit(1);
}

const service = spawn(process.execPath, [resolve(here, 'server.mjs')], {
  env: { ...process.env, FT_PORT: '0', FT_BUILD_URL: `http://127.0.0.1:${sidecarPort}` },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serviceLog = '';
service.stdout.setEncoding('utf8');
service.stdout.on('data', (chunk) => { serviceLog += chunk; });
let base = '';
for (let attempt = 0; attempt < 120 && !base; attempt += 1) {
  const match = serviceLog.match(/http:\/\/127\.0\.0\.1:(\d+)/);
  if (match) base = `http://127.0.0.1:${match[1]}`;
  else await sleep(150);
}
if (!base) {
  console.error('ASSEMBLY_TEST_FAIL 服务未起来', serviceLog.slice(0, 200));
  service.kill('SIGKILL'); sidecar.kill('SIGKILL');
  process.exit(1);
}

const http = async (method, path, body) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: await response.json().catch(() => null) };
};

try {
  // 两块板：默认（12 厚）与 doc-asm-b（30 厚）
  const created = await http('POST', '/v1/documents', { documentId: 'doc-asm-b' });
  ok(created.status === 201, '建第二块板 doc-asm-b', `status=${created.status}`);
  const wrote = await http('POST', '/v1/operations', {
    documentId: 'doc-asm-b', expectedRevision: created.json.revision, actor: 'manual',
    operation: 'updateFeatureParams', featureId: 'f-body', patch: { height: 30 }
  });
  ok(wrote.status === 200, 'doc-asm-b 改成 30 厚', `status=${wrote.status}`);

  const volA = (await http('GET', '/v1/tree')).json.geometry.volumeMm3;
  const volB = (await http('GET', '/v1/tree?documentId=doc-asm-b')).json.geometry.volumeMm3;

  // 1) 叠放：z 方向偏移 20，两块不重叠 → 体积应为两块之和
  const stacked = await http('POST', '/v1/assemblies', {
    documentId: 'asm-stacked',
    members: [
      { documentId: 'demo-adapter', offset: [0, 0, 0] },
      { documentId: 'doc-asm-b', offset: [0, 0, 20] }
    ]
  });
  ok(stacked.status === 201 && stacked.json.geometry, '装配创建成功（叠放）', JSON.stringify(stacked.json).slice(0, 160));
  const stackedVolume = stacked.json.geometry?.volumeMm3 ?? 0;
  ok(Math.abs(stackedVolume - (volA + volB)) <= 2,
    '不重叠时体积 = 两块之和（fuse 没丢体积）', `actual=${stackedVolume} expected=${(volA + volB).toFixed(1)}`);
  ok(Math.abs(stacked.json.geometry.bboxMm.z - (20 + 30)) <= 1,
    '包围盒高度 = 偏移 20 + 板厚 30', JSON.stringify(stacked.json.geometry.bboxMm));

  // 2) 同位置叠放：真实布尔并集，体积应显著小于两块之和
  const overlap = await http('POST', '/v1/assemblies', {
    documentId: 'asm-overlap',
    members: [
      { documentId: 'demo-adapter', offset: [0, 0, 0] },
      { documentId: 'doc-asm-b', offset: [0, 0, 0] }
    ]
  });
  ok(overlap.status === 201, '装配创建成功（同位置）');
  const overlapVolume = overlap.json.geometry?.volumeMm3 ?? 0;
  ok(overlapVolume < stackedVolume - 1000,
    '同位置叠放是布尔并集，不是体积相加', `overlap=${overlapVolume} stacked=${stackedVolume}`);
  ok(Math.abs(overlapVolume - Math.max(volA, volB)) <= 5,
    '并集体积 = 较大那块（小件完全被包住）', `actual=${overlapVolume} expect≈${Math.max(volA, volB)}`);

  // 3) 装配 STL 能取到
  const stl = await fetch(`${base}/v1/assemblies/asm-stacked/geometry.stl`);
  const bytes = Buffer.from(await stl.arrayBuffer());
  ok(stl.status === 200 && bytes.length > 1000, '装配 STL 可取', `status=${stl.status} bytes=${bytes.length}`);
  const tris = bytes.length >= 84 ? bytes.readUInt32LE(80) : 0;
  ok(tris > 10 && 84 + tris * 50 === bytes.length, '装配 STL 三角面数自洽', `tris=${tris}`);

  // 3.5) 装配级干涉：真实布尔交集，不是 AABB 初筛
  const interferenceOverlap = await http('POST', '/v1/assemblies/asm-overlap/interference', {});
  ok(interferenceOverlap.status === 200, '同位置装配能跑干涉检查', `status=${interferenceOverlap.status}`);
  const pairs = interferenceOverlap.json?.pairs ?? [];
  ok(pairs.length === 1, '同位置两块板检出 1 对干涉', JSON.stringify(interferenceOverlap.json).slice(0, 160));
  ok(pairs[0] && Math.abs(pairs[0].overlapMm3 - volA) <= 2,
    '干涉体积 = 被完全包住那块（12 厚板 94,166.8）', `actual=${pairs[0]?.overlapMm3} expected=${volA}`);
  ok(pairs[0]?.aId === 'demo-adapter' && pairs[0]?.bId === 'doc-asm-b', '干涉结果带成员 id，能定位到具体两块');

  const interferenceStacked = await http('POST', '/v1/assemblies/asm-stacked/interference', {});
  ok(interferenceStacked.status === 200 && (interferenceStacked.json?.pairs ?? []).length === 0,
    '不重叠的装配判为无干涉', JSON.stringify(interferenceStacked.json).slice(0, 120));
  ok(/未发现/.test(interferenceStacked.json?.summary || ''), '无干涉时给的是「未发现实体干涉」而不是空数组');

  // 4) 错误路径
  const tooFew = await http('POST', '/v1/assemblies', { documentId: 'asm-bad', members: [{ documentId: 'demo-adapter' }] });
  ok(tooFew.status === 422, '单成员装配被拒（422）', `status=${tooFew.status}`);
  const unknown = await http('POST', '/v1/assemblies', {
    documentId: 'asm-bad2', members: [{ documentId: 'demo-adapter' }, { documentId: 'nope' }]
  });
  ok(unknown.status === 422 && /不存在/.test(unknown.json?.message || ''), '未知成员被拒且说明原因', JSON.stringify(unknown.json).slice(0, 100));
  const list = await http('GET', '/v1/assemblies');
  ok(list.status === 200 && list.json.assemblies.length >= 2, '装配列表可查', `count=${list.json.assemblies?.length}`);
} catch (error) {
  failures += 1;
  console.error('ASSEMBLY_TEST_FAIL', error);
} finally {
  service.kill('SIGTERM');
  sidecar.kill('SIGTERM');
}

if (failures > 0) {
  console.error(`失败 ${failures} 条`);
  process.exit(1);
}
console.log('ASSEMBLY_OK 装配（并集/包围盒/STL/错误路径）全部通过');
