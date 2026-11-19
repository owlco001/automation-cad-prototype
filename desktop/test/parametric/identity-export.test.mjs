import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import occtimportjs from 'occt-import-js';
import { ParametricManager } from '../../electron/parametric.ts';

/**
 * R12/P1：身份伴随 STEP（identity.step）的行为测试。
 *
 * 边界（写清，别当成验收）：identity.step 是内核在同一个 /build 里**另做一次**的导出，
 * 不是制造 STEP 的替代，也不证明两者内部拓扑/形状等价。本文件只证明「导出侧行为」：
 * 默认不发、只认布尔 true、前置条件违规 400、导出失败不许假成功、打标签只落在复制体上。
 * 真塔的逐实体回读门禁在 P2（verify-step-tower），这里不跑真塔。
 */

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, '../../../spike/build123d/app.py');
const FIXTURES = resolve(here, '../fixtures');
// 纯前置条件测试只需要任一 python（app.py 顶层不 import build123d）；Windows runner 上 `python3` 未必存在。
const PYTHON =
  [process.env.PYTHON, 'python3', 'python']
    .map((value) => value?.trim())
    .filter(Boolean)
    .find((candidate) => spawnSync(candidate, ['-c', 'import importlib.util'], { timeout: 60_000 }).status === 0) ??
  null;
const pythonSkip = PYTHON ? false : '没有可用的 python（PYTHON 可显式指定），内核前置条件未验证';

const temps = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function productNames(text) {
  return [...text.matchAll(/PRODUCT\('([^']*)'/g)].map((match) => match[1]);
}

function collectLeaves(node, path = [], leaves = []) {
  const here2 = node.name ? [...path, node.name] : path;
  if (node.meshes.length > 0 || node.children.length === 0) {
    leaves.push({ name: node.name, pathLeaf: here2[here2.length - 1], meshes: node.meshes.length });
    return leaves;
  }
  for (const child of node.children) collectLeaves(child, here2, leaves);
  return leaves;
}

let occtPromise = null;
async function readStep(path) {
  if (!occtPromise) occtPromise = occtimportjs();
  const occt = await occtPromise;
  const data = readFileSync(path);
  return occt.ReadStepFile(new Uint8Array(data), null);
}

// ---------------------------------------------------------------- fixtures

test('fixture：step-identity-3parts 有 3 个件号，被完全包住的件仍是独立 PRODUCT/网格', async () => {
  const path = join(FIXTURES, 'step-identity-3parts.step');
  const text = readFileSync(path, 'utf8');
  assert.deepEqual(
    productNames(text).sort(),
    ['assembly', 'lift-chain-01', 'tower-post-01', 'tray-01'].sort(),
    '夹具必须是一个 root + 三个件号，不含别的自报名字'
  );
  assert.equal(text.match(/MANIFOLD_SOLID_BREP/g)?.length, 3);
  assert.match(text, /build123d/, 'FILE_DESCRIPTION 要写清生成方式');

  const result = await readStep(path);
  assert.equal(result.success, true);
  const leaves = collectLeaves(result.root).filter((leaf) => leaf.name);
  assert.deepEqual(leaves.map((leaf) => leaf.pathLeaf).sort(), ['lift-chain-01', 'tower-post-01', 'tray-01']);
  const chain = leaves.find((leaf) => leaf.pathLeaf === 'lift-chain-01');
  assert.equal(chain?.meshes, 1, '被包住件必须独立成网格 —— 笛卡尔顶点判据看不见它');
});

test('fixture：step-identity-multisolid 双实体件 1 个 PRODUCT、回读 1 产品 2 网格', async () => {
  const path = join(FIXTURES, 'step-identity-multisolid.step');
  const text = readFileSync(path, 'utf8');
  assert.deepEqual(productNames(text).sort(), ['assembly', 'dual-solid-part', 'single-solid-part'].sort());
  assert.equal(text.match(/MANIFOLD_SOLID_BREP/g)?.length, 3, '双实体件 2 + 单实体件 1');

  const result = await readStep(path);
  const leaves = collectLeaves(result.root).filter((leaf) => leaf.name);
  const dual = leaves.find((leaf) => leaf.pathLeaf === 'dual-solid-part');
  assert.equal(dual?.meshes, 2, '多实体件：2 个网格挂在同一个产品下（网格名可能为空）');
  assert.equal(leaves.find((leaf) => leaf.pathLeaf === 'single-solid-part')?.meshes, 1);
});

// ------------------------------------------------- 内核侧纯函数（无需 build123d）

const PURE_PROBE = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('app_under_test', sys.argv[1])
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
cases = json.loads(sys.stdin.read())
print(json.dumps([app.identity_request_error(case) for case in cases], ensure_ascii=False))
`;

function identityRequestErrors(cases) {
  assert.ok(PYTHON, 'identityRequestErrors 在无 python 时不应被调用');
  const run = spawnSync(PYTHON, ['-c', PURE_PROBE, APP], {
    input: JSON.stringify(cases),
    encoding: 'utf8',
    timeout: 60_000
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

const VALID = { instances: [{ id: 'p1' }], perPart: true, exports: ['step', 'stl'] };

test('identity_request_error：缺省 / false / 非布尔 true 一律按「未要求」，既有路径不变', { skip: pythonSkip }, () => {
  assert.deepEqual(
    identityRequestErrors([
      {},
      { instances: [{ id: 'p1' }] },
      { ...VALID, identityStep: false },
      { ...VALID, identityStep: 1 },
      { ...VALID, identityStep: 'true' },
      [],
      { ...VALID, identityStep: true }
    ]),
    [null, null, null, null, null, null, null]
  );
});

test('identity_request_error：identityStep=true 缺 instances / perPart / step 导出 → 各自点名', { skip: pythonSkip }, () => {
  const errors = identityRequestErrors([
    { identityStep: true, perPart: true, exports: ['step'] },
    { identityStep: true, instances: [], perPart: true, exports: ['step'] },
    { identityStep: true, instances: [{ id: 'p1' }], exports: ['step'] },
    { identityStep: true, instances: [{ id: 'p1' }], perPart: true, exports: ['stl'] }
  ]);
  assert.match(errors[0], /instances/);
  assert.match(errors[1], /instances/);
  assert.match(errors[2], /perPart/);
  assert.match(errors[3], /step/);
});

// ------------------------------------------- ParametricManager 请求体（无内核）

const RECORDER = String.raw`
import http from 'node:http';
import { appendFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const at = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const port = Number(at('--port'));
const dump = process.env.IDENTITY_EXPORT_BODY_DUMP;
const server = http.createServer((req, res) => {
  const send = (code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };
  if (req.method === 'GET' && req.url === '/health') {
    return send(200, { ok: true, kernel: 'build123d', version: '0.0.0-recorder' });
  }
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    appendFileSync(dump, raw + '\n');
    send(200, {
      ok: true, kernel: 'build123d', buildMs: 1,
      stats: { solids: 3, partSolids: 3 },
      files: { step: { path: '/nonexistent/part.step', bytes: 1, ms: 1 } }
    });
  });
});
server.listen(port, '127.0.0.1');
`;

function assemblyDoc() {
  return {
    schemaVersion: 2,
    updatedAt: '2026-11-19T12:00:00+08:00',
    instances: [
      {
        id: 'tower-post-01',
        name: '立柱',
        transform: { x: 0, y: 0, z: 0, rz: 0 },
        features: [{ id: 'f1', type: 'box', name: '柱', params: { length: 100, width: 100, height: 400 } }]
      },
      {
        id: 'lift-chain-01',
        name: '链条',
        transform: { x: 0, y: 0, z: 0, rz: 0 },
        features: [{ id: 'f1', type: 'box', name: '链', params: { length: 20, width: 20, height: 20 } }]
      }
    ]
  };
}

async function recordRequestBodies(calls) {
  const dir = tempDir('r12-identity-recorder-');
  const recorder = join(dir, 'recorder-sidecar.mjs');
  const dump = join(dir, 'bodies.jsonl');
  writeFileSync(recorder, RECORDER, 'utf8');
  const instance = new ParametricManager({
    command: recorder,
    healthTimeoutMs: 5_000,
    healthIntervalMs: 50,
    env: { ...process.env, IDENTITY_EXPORT_BODY_DUMP: dump }
  });
  try {
    const started = await instance.start();
    assert.equal(started.ok, true, started.message);
    for (const call of calls) {
      const result = await instance.build(assemblyDoc(), call.options);
      assert.equal(result.ok, true, result.message);
    }
  } finally {
    await instance.stop().catch(() => undefined);
  }
  return readFileSync(dump, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('parametric.ts：默认与 perPart 请求体不含 identityStep 键', async () => {
  const bodies = await recordRequestBodies([
    { options: {} },
    { options: { perPart: true } },
    { options: { identityStep: false } },
    { options: { identityStep: 'yes' } }
  ]);
  for (const body of bodies.slice(0, 1).concat(bodies.slice(2))) {
    assert.equal('identityStep' in body, false, '只有 === true 才能进请求体');
  }
  assert.equal('perPart' in bodies[0], false, '默认不发送 perPart');
  assert.equal(bodies[0].exports.includes('step'), true);
  assert.equal(bodies[1].perPart, true);
  assert.equal('identityStep' in bodies[1], false);
});

test('parametric.ts：identityStep === true 才透传 true（与 perPart 同形）', async () => {
  const [body] = await recordRequestBodies([{ options: { perPart: true, identityStep: true } }]);
  assert.equal(body.identityStep, true);
  assert.equal(body.perPart, true);
});

// ------------------------------------------------------- 真内核（b123d sidecar）

const KERNEL_PYTHON =
  [process.env.AUTOMATIONCAD_PYTHON, '/root/.venvs/b123d/bin/python', 'python3']
    .map((value) => value?.trim())
    .filter(Boolean)
    .find((candidate) => spawnSync(candidate, ['-c', 'import build123d'], { timeout: 120_000 }).status === 0) ?? null;

const kernelSkip = KERNEL_PYTHON
  ? false
  : '内核不可用：找不到能 import build123d 的 python（可用 AUTOMATIONCAD_PYTHON 指定），身份导出未验证';

const DRIVER = String.raw`"""R12/P1 内核侧驱动（测试用，与 identity-export.test.mjs 内联脚本同源）。

直接 import app.py 起真 HTTP 服务，用三角色小型装配跑场景；断言结果以 JSON 打到 stdout。
不写仓库、不跑真塔；临时产物都在 tempfile 目录里。
"""
import importlib.util
import json
import os
import re
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

APP = sys.argv[1]
TOKEN = "r12-identity-token"

spec = importlib.util.spec_from_file_location("b123d_app_under_test", APP)
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
app.TOKEN = TOKEN


def read(path):
    return open(path, encoding="utf-8", errors="replace").read()


def products(text):
    return re.findall(r"PRODUCT\('([^']*)'", text)


def post(port, payload):
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/build",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {TOKEN}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


IDS = ["tower-post-01", "lift-chain-01", "tray-01"]
INSTANCES = [
    {
        "id": "tower-post-01",
        "name": "立柱",
        "transform": {"x": 0, "y": 0, "z": 0, "rz": 0},
        "ops": [{"op": "box", "length": 100, "width": 100, "height": 400}],
    },
    {
        "id": "lift-chain-01",
        "name": "链条",
        "transform": {"x": 0, "y": 0, "z": 0, "rz": 0},
        "ops": [{"op": "box", "length": 20, "width": 20, "height": 20}],
    },
    {
        "id": "tray-01",
        "name": "托板",
        "transform": {"x": 0, "y": 0, "z": 250, "rz": 0},
        "ops": [{"op": "box", "length": 300, "width": 60, "height": 3}],
    },
]
BASE = {"instances": INSTANCES, "perPart": True, "exports": ["step", "stl"]}

out = {"kernel": None, "scenarios": {}}
if not app.load_kernel():
    out["kernel"] = "unavailable"
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)
out["kernel"] = str(app.VERSION)

server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()

try:
    # 1) 默认路径：既有响应形状不变，且制造 STEP 里没有任何件号
    status, body = post(port, dict(BASE))
    files = body.get("files") or {}
    step_text = read(files["step"]["path"]) if "step" in files else ""
    out["scenarios"]["default"] = {
        "status": status,
        "ok": body.get("ok"),
        "hasIdentity": "identity" in files,
        "partIds": [p.get("id") for p in files.get("parts", [])],
        "partSolids": (body.get("stats") or {}).get("partSolids"),
        "mergedProductNames": products(step_text),
        "mergedHasPartIds": [i in step_text for i in IDS],
        "mergeMode": (body.get("stats") or {}).get("merge", {}).get("mode"),
    }

    # 2) identityStep === true：伴随文件存在、同目录、件号齐、实体数等于逐件合计
    status, body = post(port, dict(BASE, identityStep=True))
    files = body.get("files") or {}
    identity = files.get("identity") or {}
    identity_text = read(identity["path"]) if identity.get("path") else ""
    out["scenarios"]["identity"] = {
        "status": status,
        "ok": body.get("ok"),
        "identityKeys": sorted(identity.keys()),
        "sameDir": bool(identity.get("path")) and os.path.dirname(identity["path"]) == os.path.dirname(files["step"]["path"]),
        "bytes": identity.get("bytes"),
        "fileBytes": os.path.getsize(identity["path"]) if identity.get("path") else 0,
        "msIsNumber": isinstance(identity.get("ms"), (int, float)),
        "products": products(identity_text),
        "solids": identity_text.count("MANIFOLD_SOLID_BREP"),
        "partSolids": (body.get("stats") or {}).get("partSolids"),
        "partIds": [p.get("id") for p in files.get("parts", [])],
        "mergedProductNames": products(read(files["step"]["path"])),
    }

    # 3) 前置条件：identityStep 要求 perPart / 非空 instances / exports 含 step
    status, body = post(port, {"instances": INSTANCES, "exports": ["step", "stl"], "identityStep": True})
    out["scenarios"]["missingPerPart"] = {"status": status, "ok": body.get("ok"), "error": body.get("error", "")}
    status, body = post(port, {"instances": [], "perPart": True, "exports": ["step"], "identityStep": True})
    out["scenarios"]["emptyInstances"] = {"status": status, "ok": body.get("ok"), "error": body.get("error", "")}
    status, body = post(port, {"instances": INSTANCES, "perPart": True, "exports": ["stl"], "identityStep": True})
    out["scenarios"]["noStepExport"] = {"status": status, "ok": body.get("ok"), "error": body.get("error", "")}

    # 4) 只认布尔 true：false / 1 / "true" 一律按「未要求」处理（失败方向 = 没有 identity 文件）
    for label, value in (("false", False), ("one", 1), ("string", "true")):
        status, body = post(port, dict(BASE, identityStep=value))
        out["scenarios"][f"notTrue:{label}"] = {
            "status": status,
            "ok": body.get("ok"),
            "hasIdentity": "identity" in (body.get("files") or {}),
        }

    # 5) label 污染：只给复制体打标签，原始逐件形状与制造 STEP 都不许出现件号
    combined, volumes, shapes, merge_meta = app.build_assembly(INSTANCES)
    unit_dir = tempfile.mkdtemp(prefix="r12-identity-unit-")
    merged_path = os.path.join(unit_dir, "part.step")
    app.bd.export_step(combined, merged_path)
    entry = app.write_identity_step(unit_dir, shapes, app._identity_labels(INSTANCES))
    out["scenarios"]["noLabelPollution"] = {
        "originalLabels": [getattr(shape, "label", None) for shape in shapes],
        "mergedHasPartIds": [i in read(merged_path) for i in IDS],
        "identityProducts": products(read(entry["path"])),
        "labelsAfter": [getattr(shape, "label", None) for shape in shapes],
        "bytes": entry["bytes"],
    }

    # 6) 导出失败不许假成功：只让 identity.step 这次导出抛错，必须 400（不能 ok:true 缺文件）
    real_export = app.bd.export_step

    def failing_export(shape, path, *args, **kwargs):
        if str(path).endswith("identity.step"):
            raise RuntimeError("注入：identity.step 导出失败")
        return real_export(shape, path, *args, **kwargs)

    app.bd.export_step = failing_export
    try:
        status, body = post(port, dict(BASE, identityStep=True))
    finally:
        app.bd.export_step = real_export
    out["scenarios"]["identityExportFailure"] = {
        "status": status,
        "ok": body.get("ok"),
        "error": body.get("error", ""),
        "hasFiles": bool(body.get("files")),
    }
finally:
    server.shutdown()
    server.server_close()

print(json.dumps(out, ensure_ascii=False))
`;

let driverCache = null;
function kernelReport() {
  if (driverCache) return driverCache;
  assert.ok(KERNEL_PYTHON, 'kernelReport 在无内核时不应被调用');
  const dir = tempDir('r12-identity-driver-');
  const driver = join(dir, 'driver.py');
  writeFileSync(driver, DRIVER, 'utf8');
  const run = spawnSync(KERNEL_PYTHON, [driver, APP], { encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(run.stdout);
  assert.notEqual(report.kernel, 'unavailable', '内核导入失败');
  driverCache = report.scenarios;
  return driverCache;
}

test('内核：默认路径不产生 identity 文件，制造 STEP 不含任何件号', { skip: kernelSkip }, () => {
  const scenario = kernelReport().default;
  assert.equal(scenario.status, 200);
  assert.equal(scenario.ok, true);
  assert.equal(scenario.hasIdentity, false, '默认/false 不许凭空多出 identity.step');
  assert.deepEqual(scenario.partIds, ['tower-post-01', 'lift-chain-01', 'tray-01']);
  assert.equal(scenario.partSolids, 3);
  assert.deepEqual(scenario.mergedHasPartIds, [false, false, false], 'manufacturing STEP 不得带件号（C8 正演）');
});

test('内核：identityStep=true 产出同目录 identity.step，件号/实体数与逐件一致', { skip: kernelSkip }, () => {
  const scenario = kernelReport().identity;
  assert.equal(scenario.status, 200);
  assert.equal(scenario.ok, true);
  assert.deepEqual(scenario.identityKeys.sort(), ['bytes', 'ms', 'path', 'products', 'solids']);
  assert.equal(scenario.sameDir, true, 'identity 与制造 STEP 必须同一构建目录');
  assert.ok(scenario.bytes > 0);
  assert.equal(scenario.bytes, scenario.fileBytes, '自报 bytes 必须等于文件实际字节');
  assert.equal(scenario.msIsNumber, true);
  assert.deepEqual(scenario.products.sort(), ['assembly', 'lift-chain-01', 'tower-post-01', 'tray-01'].sort());
  assert.deepEqual(
    scenario.products.filter((name) => name !== 'assembly').sort(),
    [...scenario.partIds].sort(),
    '件号集合必须与 files.parts[].id 严格相等（P2 交叉核对的前提）'
  );
  assert.equal(scenario.solids, scenario.partSolids, '非融合导出：实体数与逐件合计严格相等');
  assert.deepEqual(scenario.mergedProductNames.filter((name) => scenario.partIds.includes(name)), []);
});

test('内核：前置条件违规回 400（不是 ok:true，也不是 500）', { skip: kernelSkip }, () => {
  const report = kernelReport();
  for (const [name, pattern] of [['missingPerPart', /perPart/], ['emptyInstances', /instances/], ['noStepExport', /step/]]) {
    const scenario = report[name];
    assert.equal(scenario.status, 400, `${name} 必须 400`);
    assert.equal(scenario.ok, false);
    assert.match(scenario.error, pattern);
  }
});

test('内核：identityStep=false / 1 / "true" 都不产出 identity（失败方向是无文件）', { skip: kernelSkip }, () => {
  const report = kernelReport();
  for (const key of ['notTrue:false', 'notTrue:one', 'notTrue:string']) {
    assert.equal(report[key].status, 200, key);
    assert.equal(report[key].ok, true, key);
    assert.equal(report[key].hasIdentity, false, key);
  }
});

test('内核：件号只打在复制体上，原始逐件形状与制造 STEP 无标签污染', { skip: kernelSkip }, () => {
  const scenario = kernelReport().noLabelPollution;
  assert.deepEqual(scenario.originalLabels, ['', '', ''], 'placed 形状的 label 必须保持空');
  assert.deepEqual(scenario.labelsAfter, ['', '', ''], '导出后也不许被回写');
  assert.deepEqual(scenario.mergedHasPartIds, [false, false, false]);
  assert.equal(scenario.identityProducts.length, 4);
});

test('内核：identity 导出失败必须 400，不许 ok:true 缺 identity', { skip: kernelSkip }, () => {
  const scenario = kernelReport().identityExportFailure;
  assert.equal(scenario.status, 400);
  assert.equal(scenario.ok, false);
  assert.match(scenario.error, /identity\.step/);
  assert.equal(scenario.hasFiles, false, '失败时不许返回半份 files');
});
