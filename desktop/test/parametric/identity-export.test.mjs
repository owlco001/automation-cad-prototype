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

// 件号渲染是纯字符串逻辑（不碰 build123d），所以「不许伪造 part-N」这条也能在无内核下钉住。
const LABELS_PROBE = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('app_under_test', sys.argv[1])
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)
cases = json.loads(sys.stdin.read())
out = []
for case in cases:
    try:
        out.append({"labels": app._identity_labels(case)})
    except Exception as exc:
        out.append({"error": str(exc)})
print(json.dumps(out, ensure_ascii=False))
`;

function identityLabels(cases) {
  assert.ok(PYTHON, 'identityLabels 在无 python 时不应被调用');
  const run = spawnSync(PYTHON, ['-c', LABELS_PROBE, APP], {
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

test('identity_request_error：identityStep=true 时件号为空/空白/非串/重号 → 点名 instances[i]', { skip: pythonSkip }, () => {
  const errors = identityRequestErrors([
    { ...VALID, identityStep: true, instances: [{ id: '' }] },
    { ...VALID, identityStep: true, instances: [{ id: ' ' }] },
    { ...VALID, identityStep: true, instances: [{ id: '\t' }] },
    { ...VALID, identityStep: true, instances: [{ id: 42 }] },
    { ...VALID, identityStep: true, instances: [{ id: 'p1' }, { id: 'p1' }] }
  ]);
  for (const index of [0, 1, 2, 3]) {
    assert.match(errors[index], /instances\[0\]/, `case ${index} 必须点名 instances[0]`);
  }
  assert.match(errors[4], /instances\[1\]/, '重号要点名后出现的那一个');
  assert.doesNotMatch(errors.join('\n'), /part-\d/, '错误文案里不许编造 part-N 件号');
});

test('identity_request_error：首尾填充空白直接拒绝并点名，合法件号（内部空格/非 ASCII/字面 part-1）原样放行', { skip: pythonSkip }, () => {
  const errors = identityRequestErrors([
    { ...VALID, identityStep: true, instances: [{ id: 'p1' }, { id: ' p2 ' }] },
    { ...VALID, identityStep: true, instances: [{ id: 'tray-1 ' }] },
    { ...VALID, identityStep: true, instances: [{ id: 'part-1' }] },
    { ...VALID, identityStep: true, instances: [{ id: 'tray 1' }] },
    { ...VALID, identityStep: true, instances: [{ id: '托板-01' }] }
  ]);
  // 追加裁定：**不自动 trim**。首尾填充空白是源件号的问题，直接 400 点名位置并要求调用方修源件号，
  // 否则「文档里的件号」与「回执/label 里的件号」会变成两个字符串（按精确串 join 的下游就断）。
  assert.match(errors[0], /instances\[1\]/, '填充空白的件号必须点名到具体位置');
  assert.match(errors[0], /首尾无空白/, '文案要说清是首尾空白而不是「空件号」');
  assert.match(errors[0], /源件号/, '文案要提示修源件号，不能让调用方以为内核会替他归一化');
  assert.match(errors[1], /instances\[0\]/, '尾部空白同样拒绝（不是只查前导）');
  // 合法件号逐字放行：trim 只针对首尾，内部空格 / 非 ASCII / 字面 part-1 都不改写。
  assert.deepEqual(errors.slice(2), [null, null, null], '内部空格、非 ASCII、字面 part-1 都必须放行');
  assert.doesNotMatch(errors.join('\n'), /part-\d/, '错误文案里不许编造 part-N 件号');
});

test('_identity_labels：非法件号直接抛错（与入口同口径），合法件号逐字原样', { skip: pythonSkip }, () => {
  const results = identityLabels([
    [],
    [{ id: '' }],
    [{ id: ' ' }],
    [{ id: 42 }],
    [{ id: '  tray-1  ' }],
    [{ id: 'tray-1 ' }],
    [{ id: 'part-1' }],
    [{ id: 'tray 1' }],
    [{ id: '托板-01' }]
  ]);
  assert.deepEqual(results[0], { labels: [] });
  // 防御口径与 identity_request_error 逐条一致：非串 / 空或纯空白 / 首尾填充空白 都抛，
  // 且都不许把件号编造成 part-N（入口被绕过时这里是最后一道）。
  for (const index of [1, 2, 3, 4, 5]) {
    assert.equal(typeof results[index].error, 'string', `非法件号必须抛错（case ${index}）`);
    assert.doesNotMatch(results[index].error, /part-\d/, '不许把空件号编造成 part-N');
  }
  assert.match(results[4].error, /源件号/, '填充空白的件号要指出让调用方修源件号（不自动 trim）');
  // 导出侧不改写字符：内部空格 / 非 ASCII / 字面 part-1 逐字进 label。
  assert.deepEqual(results[6], { labels: ['part-1'] }, '真件号就叫 part-1 时照原样（所以伪造值无法区分）');
  assert.deepEqual(results[7], { labels: ['tray 1'] }, '内部空格不是首尾空白，不许被顺手归并');
  assert.deepEqual(results[8], { labels: ['托板-01'] }, '非 ASCII 件号原样（OCCT 自己写 \\X2\\ 转义）');
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


def build_dirs():
    """本次构建在 TMPDIR 里留下的目录（测试用隔离 TMPDIR 起进程，只看前缀）。"""
    return sorted(name for name in os.listdir(tempfile.gettempdir()) if name.startswith("b123d-build-"))


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
    dirs_before = build_dirs()
    try:
        status, body = post(port, dict(BASE, identityStep=True))
    finally:
        app.bd.export_step = real_export
    dirs_after = build_dirs()
    out["scenarios"]["identityExportFailure"] = {
        "status": status,
        "ok": body.get("ok"),
        "error": body.get("error", ""),
        "hasFiles": bool(body.get("files")),
        # 失败路径必须自己 rmtree：响应里没有 files，客户端不会来取这半份产物。
        "tmpRoot": tempfile.gettempdir(),
        "dirsBefore": len(dirs_before),
        "dirsAfter": len(dirs_after),
        "leftover": [name for name in dirs_after if name not in dirs_before],
    }

    # 6b) 逐个**真实失败点**定点注入：制造 part.step / 制造 part.stl / 逐件 STL /
    #     identity.step 抛错 / identity.step 写 0 字节。每个场景都记录**调用轨迹**
    #     （kind:basename，命中失败的那一刻后面打 !），断言据此确认失败真的到达目标路径。
    #     这条轨迹是防止「全局 export_step 报错」冒充 identity 阶段失败的唯一证据。
    real_step = app.bd.export_step
    real_stl = app.bd.export_stl

    def fail_point(label, kind, matcher, message, payload, write_empty=False):
        """两个导出函数都要包一层：只包被测的那个，轨迹里就看不见另一个阶段的成功导出。"""
        calls = []

        def make(this_kind):
            real = real_step if this_kind == "export_step" else real_stl

            def wrapped(shape, path, *args, **kwargs):
                name = os.path.basename(str(path))
                hit = this_kind == kind and bool(matcher(name))
                calls.append(this_kind + ":" + name + ("!" if hit else ""))
                if hit:
                    if write_empty:
                        open(path, "w").close()  # 写 0 字节但**不抛**：复现「导出成功但文件为空」
                        return None
                    raise RuntimeError(message)
                return real(shape, path, *args, **kwargs)

            return wrapped

        app.bd.export_step = make("export_step")
        app.bd.export_stl = make("export_stl")
        before = build_dirs()
        try:
            status, body = post(port, dict(payload))
        finally:
            app.bd.export_step = real_step
            app.bd.export_stl = real_stl
        after = build_dirs()
        out["scenarios"][label] = {
            "status": status,
            "ok": body.get("ok"),
            "error": body.get("error", ""),
            "hasFiles": bool(body.get("files")),
            "stepBytes": ((body.get("files") or {}).get("step") or {}).get("bytes"),
            "calls": calls,
            "hitAt": calls[-1] if calls and calls[-1].endswith("!") else None,
            "newDirs": [name for name in after if name not in before],
        }

    def is_part_step(name):
        return name == "part.step"

    def is_part_stl(name):
        return name == "part.stl"

    def is_per_part_stl(name):
        return name != "part.stl" and re.fullmatch(r"\d{2}-.*\.stl", name) is not None

    def is_identity(name):
        return name == "identity.step"

    IDENTITY_BASE = dict(BASE, identityStep=True)
    fail_point("manufacturedStepFail", "export_step", is_part_step, "注入：制造 part.step 导出失败", IDENTITY_BASE)
    fail_point("manufacturedStlFail", "export_stl", is_part_stl, "注入：制造 part.stl 导出失败", IDENTITY_BASE)
    fail_point("perPartStlFail", "export_stl", is_per_part_stl, "注入：逐件 STL 导出失败", IDENTITY_BASE)
    fail_point("identityStepRaise", "export_step", is_identity, "注入：identity.step 导出失败", IDENTITY_BASE)
    fail_point("identityZeroByte", "export_step", is_identity, "注入：identity.step 写 0 字节", IDENTITY_BASE, write_empty=True)
    # 登记项（**本轮不改**，只记录现状）：制造侧 0 字节仍返回 200 ok:true。断言里会把它钉成
    # 「已知缺口」，防止它被读成「已验证」；真要修的时候连那条断言一起改。
    fail_point("manufacturedZeroByteNoIdentity", "export_step", is_part_step, "注入：制造 STEP 写 0 字节", dict(BASE), write_empty=True)

    # 6c) 成功路径：响应之后客户端仍能读到 files 里的每个路径（清理只覆盖失败分支）。
    before_ok = build_dirs()
    status, body = post(port, IDENTITY_BASE)
    after_ok = build_dirs()
    files = body.get("files") or {}
    readable = []
    for key, path in (
        [("step", (files.get("step") or {}).get("path")), ("identity", (files.get("identity") or {}).get("path"))]
        + [("parts[%d].stl" % i, (part.get("stl") or {}).get("path")) for i, part in enumerate(files.get("parts") or [])]
    ):
        readable.append({
            "key": key,
            "path": path,
            "isfile": bool(path) and os.path.isfile(path),
            "readable": bool(path) and os.access(path, os.R_OK),
            "bytes": os.path.getsize(path) if path and os.path.exists(path) else 0,
        })
    out["scenarios"]["happyPathReadable"] = {
        "status": status,
        "ok": body.get("ok"),
        "files": readable,
        # 成功路径**不清理**目录（协议层需要客户端来 copy）：既有行为，独立登记项，本轮不改。
        "newDirs": [name for name in after_ok if name not in before_ok],
    }

    # 7) 件号入口校验（只对 identityStep === true 生效）：空串 / 纯空白 / 非串 / 重号 / 首尾填充空白
    #    都必须 400，并且报错点名 instances[i]；回执不许有 files（也就没有伪造出来的 part-N）。
    BOX = [{"op": "box", "length": 10, "width": 10, "height": 10}]

    def inst(part_id, name):
        return {"id": part_id, "name": name, "transform": {"x": 0, "y": 0, "z": 0, "rz": 0}, "ops": BOX}

    bad_cases = {
        "empty": [inst("", "空件号")],
        "space": [inst(" ", "空格件号")],
        "tab": [inst("\t", "制表件号")],
        "number": [inst(42, "数字件号")],
        "duplicate": [inst("tower-post-01", "立柱"), inst("tower-post-01", "立柱副本")],
        # 追加裁定：首尾填充空白**不自动 trim**，直接 400 点名，让调用方修源件号。
        "padded": [inst("  tray-1  ", "填充件号")],
        "paddedSecond": [inst("tower-post-01", "立柱"), inst("tray-1 ", "尾随空白")],
    }
    for label, case_instances in bad_cases.items():
        before = build_dirs()
        status, body = post(port, {"instances": case_instances, "perPart": True, "exports": ["step"], "identityStep": True})
        after = build_dirs()
        out["scenarios"]["badId:" + label] = {
            "status": status,
            "ok": body.get("ok"),
            "error": body.get("error", ""),
            "hasFiles": bool(body.get("files")),
            # 入口校验早于 mkdtemp：不合法请求连一个构建目录都不许留。
            "newDirs": [name for name in after if name not in before],
        }

    # 8) B② 只对 identityStep === true 生效：默认路径的件号透传口径没被顺手改掉
    #    （带空格的件号照原样进 files.parts[].id，不新增 400）。
    status, body = post(port, {"instances": [inst("  tray-1  ", "托板")], "perPart": True, "exports": ["step"]})
    out["scenarios"]["defaultPaddedId"] = {
        "status": status,
        "ok": body.get("ok"),
        "partIds": [p.get("id") for p in (body.get("files") or {}).get("parts", [])],
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
  // 子进程用**隔离的 TMPDIR**：驱动里要数 `b123d-build-*` 目录数（失败路径清理），
  // 只有独占一个 temp 根，这个计数才不被本机其他构建残留污染（本机曾积 145 个目录）。
  const kernelTemp = tempDir('r12-identity-tmp-');
  const run = spawnSync(KERNEL_PYTHON, [driver, APP], {
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, TMPDIR: kernelTemp, TEMP: kernelTemp, TMP: kernelTemp }
  });
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

test('内核：件号为 \'\' / 空白 / 42 / 重号 / 首尾填充空白 → 400 点名 instances[i]，回执无 files、无伪造件号', { skip: kernelSkip }, () => {
  const report = kernelReport();
  const cases = [
    ['empty', /instances\[0\]/],
    ['space', /instances\[0\]/],
    ['tab', /instances\[0\]/],
    ['number', /instances\[0\]/],
    ['duplicate', /instances\[1\]/],
    ['padded', /instances\[0\]/],
    ['paddedSecond', /instances\[1\]/]
  ];
  for (const [name, pattern] of cases) {
    const scenario = report[`badId:${name}`];
    assert.equal(scenario.status, 400, `${name} 必须 400`);
    assert.equal(scenario.ok, false, name);
    assert.match(scenario.error, pattern, `${name} 必须点名出错位置`);
    assert.equal(scenario.hasFiles, false, `${name}：件号不合法时不许回半份 files`);
    assert.doesNotMatch(scenario.error, /part-\d/, `${name}：不许伪造 part-N 件号`);
    assert.deepEqual(scenario.newDirs, [], `${name}：入口校验早于 mkdtemp，不许留构建目录`);
  }
  // 填充空白不是「空件号」：文案必须指向源件号（内核不替调用方 trim）。
  assert.match(report['badId:padded'].error, /源件号/);
  assert.match(report['badId:paddedSecond'].error, /源件号/);
});

test('内核：identity 导出失败时 rmtree 本次构建目录（隔离 TMPDIR 目录数不增）', { skip: kernelSkip }, () => {
  const scenario = kernelReport().identityExportFailure;
  assert.match(scenario.tmpRoot, /r12-identity-tmp-/, '驱动必须跑在隔离 TMPDIR 里，否则这条断言没有意义');
  assert.equal(scenario.dirsAfter, scenario.dirsBefore, '失败请求不许在 TMPDIR 里留下 b123d-build-* 目录');
  assert.deepEqual(scenario.leftover, []);
});

test('内核：不带 identityStep 时件号原样透传（B② 只对 identityStep 生效，默认路径不多 400）', { skip: kernelSkip }, () => {
  const scenario = kernelReport().defaultPaddedId;
  assert.equal(scenario.status, 200);
  assert.equal(scenario.ok, true);
  assert.deepEqual(scenario.partIds, ['  tray-1  '], '默认路径的件号透传口径没被顺手 trim 掉');
});

// ------------------------------------------- 逐失败点回归（真实注入，带调用轨迹证据）
// 说明：下面 5 条按**真实导出路径**分别注入，用 `calls` 轨迹确认失败确实发生在目标路径，
// 而不是「全局 export_step 报错」在制造阶段就替 identity 档了红。

test('内核：制造 part.step 导出失败 → 400 无 files，且失败就落在制造 STEP（不是 identity）', { skip: kernelSkip }, () => {
  const scenario = kernelReport().manufacturedStepFail;
  assert.equal(scenario.status, 400);
  assert.equal(scenario.ok, false);
  assert.match(scenario.error, /制造 part\.step/, '错误必须来自制造 STEP 那次注入');
  assert.equal(scenario.hasFiles, false, '失败时不许返回半份 files');
  assert.deepEqual(scenario.calls, ['export_step:part.step!'], '制造 STEP 是第一个导出，失败后不许再有任何一次导出');
  assert.equal(scenario.hitAt, 'export_step:part.step!');
  assert.deepEqual(scenario.newDirs, [], '失败路径必须 rmtree 本次构建目录（隔离 TMPDIR 目录数不增）');
});

test('内核：制造 part.stl 导出失败 → 400 无 files，STEP 已成功、STL 命中、目录被清', { skip: kernelSkip }, () => {
  const scenario = kernelReport().manufacturedStlFail;
  assert.equal(scenario.status, 400);
  assert.equal(scenario.ok, false);
  assert.match(scenario.error, /制造 part\.stl/);
  assert.equal(scenario.hasFiles, false);
  assert.deepEqual(scenario.calls, ['export_step:part.step', 'export_stl:part.stl!'], 'STEP 先成功，失败点必须是制造 STL');
  assert.equal(scenario.hitAt, 'export_stl:part.stl!');
  assert.deepEqual(scenario.newDirs, []);
});

test('内核：逐件 STL 导出失败 → 400 无 files，命中逐件文件而不是制造 part.stl', { skip: kernelSkip }, () => {
  const scenario = kernelReport().perPartStlFail;
  assert.equal(scenario.status, 400);
  assert.equal(scenario.ok, false);
  assert.match(scenario.error, /逐件 STL/);
  assert.equal(scenario.hasFiles, false, '逐件导出失败时不许返回半份 files');
  assert.deepEqual(scenario.calls.slice(0, 2), ['export_step:part.step', 'export_stl:part.stl'], '制造 STEP/STL 必须已成功');
  assert.equal(scenario.calls.length, 3, '失败就在第一个逐件 STL，后面不许再有导出');
  assert.match(scenario.calls[2], /^export_stl:01-tower-post-01\.stl!$/, '失败点必须是逐件 STL 文件名');
  assert.equal(scenario.hitAt, scenario.calls[2]);
  assert.deepEqual(scenario.newDirs, []);
});

test('内核：identity.step 导出抛错 → 400 无 files，且制造与逐件导出确实先成功过', { skip: kernelSkip }, () => {
  const scenario = kernelReport().identityStepRaise;
  assert.equal(scenario.status, 400);
  assert.equal(scenario.ok, false);
  assert.match(scenario.error, /identity\.step/, '错误必须来自 identity.step 那次注入');
  assert.equal(scenario.hasFiles, false, 'identity 失败时不许返回半份 files');
  assert.deepEqual(scenario.calls.slice(0, 2), ['export_step:part.step', 'export_stl:part.stl'], 'identity 阶段失败前制造导出必须真的成功过');
  assert.equal(
    scenario.calls.filter((call) => call.startsWith('export_stl:') && call !== 'export_stl:part.stl').length,
    3,
    '三件逐件 STL 都要成功导出，才能证明红点是 identity 而不是更早的阶段'
  );
  assert.equal(scenario.calls.filter((call) => call.endsWith('!')).length, 1, '只有一次注入命中');
  assert.equal(scenario.hitAt, 'export_step:identity.step!');
  assert.deepEqual(scenario.newDirs, [], 'identity 失败路径必须 rmtree 本次构建目录');
});

test('内核：identity.step 写 0 字节 → 400 无 files；制造侧 0 字节仍 200（既有缺口，只登记）', { skip: kernelSkip }, () => {
  const report = kernelReport();
  const scenario = report.identityZeroByte;
  assert.equal(scenario.status, 400, 'identity.step 是空文件时必须 400');
  assert.equal(scenario.ok, false);
  assert.match(scenario.error, /空文件/, '文案要说清是「导出失败或为空文件」');
  assert.equal(scenario.hasFiles, false);
  assert.equal(scenario.hitAt, 'export_step:identity.step!', '命中点必须是 identity.step 本身');
  assert.deepEqual(scenario.newDirs, [], '空文件也走同一条清理路径');

  // 登记项：**制造** STEP 写 0 字节仍是 200 ok:true（本轮按合同不改默认语义，只钉住现状）。
  // 修的时候要连这条断言一起改；在那之前它只能被读成「已知缺口」。
  const manufactured = report.manufacturedZeroByteNoIdentity;
  assert.equal(manufactured.status, 200, '制造 0 字节仍 200 —— 登记项，未修');
  assert.equal(manufactured.ok, true);
  assert.equal(manufactured.stepBytes, 0, '回执自报 0 字节却仍 ok:true，这就是待修的语义缺口');
});

test('内核：成功路径响应之后 files 里每个路径仍可读（清理只覆盖失败分支）', { skip: kernelSkip }, () => {
  const scenario = kernelReport().happyPathReadable;
  assert.equal(scenario.status, 200);
  assert.equal(scenario.ok, true);
  assert.equal(scenario.files.length, 5, 'step + identity + 3 个逐件 STL');
  for (const file of scenario.files) {
    assert.equal(file.isfile, true, `${file.key} 必须还在磁盘上`);
    assert.equal(file.readable, true, `${file.key} 必须可读（客户端要 copy 走）`);
    assert.ok(file.bytes > 0, `${file.key} 不许是空文件`);
  }
  // 登记项：成功路径**不清理**目录（协议层要客户端来取），本轮数据只作登记，不当验收。
  assert.equal(scenario.newDirs.length, 1, '成功请求会留下一个构建目录 —— 已知未解项');
});
