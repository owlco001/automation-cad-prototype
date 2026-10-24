// 临时假 sidecar：验证 SMOKE_PARAMETRIC_SIDECAR_OK / SMOKE_PARAMETRIC_UI_OK
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const get = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const port = Number(get('--port') ?? 7430);
const token = get('--token') ?? '';
const version = '0.0.0-fake';
const workDir = mkdtempSync(join(tmpdir(), 'automationcad-fake-parametric-'));
const stlPath = join(workDir, 'model.stl');
const stepPath = join(workDir, 'model.step');

function cubeStl() {
  const corners = [
    [-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0],
    [-10, -10, 20], [10, -10, 20], [10, 10, 20], [-10, 10, 20]
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7]
  ];
  const buffer = Buffer.alloc(84 + faces.length * 50);
  buffer.write('AutomationCAD fake parametric cube', 0, 'utf8');
  buffer.writeUInt32LE(faces.length, 80);
  let offset = 84;
  for (const face of faces) {
    for (const index of face) {
      const point = corners[index];
      buffer.writeFloatLE(point[0], offset);
      buffer.writeFloatLE(point[1], offset + 4);
      buffer.writeFloatLE(point[2], offset + 8);
      offset += 12;
    }
    buffer.writeUInt16LE(0, offset);
    offset += 2;
  }
  return buffer;
}

writeFileSync(stlPath, cubeStl());
writeFileSync(stepPath, 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n', 'utf8');
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    rmSync(workDir, { recursive: true, force: true });
    process.exit(0);
  });
}

const server = http.createServer((req, res) => {
  const send = (code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };
  if (req.method === 'GET' && req.url === '/health') {
    return send(200, { ok: true, kernel: 'build123d', version, pid: process.pid });
  }
  if (req.method === 'POST' && req.url === '/build') {
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { ok: false, error: 'unauthorized' });
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let payload = {};
      try {
        payload = JSON.parse(raw || '{}');
      } catch {
        return send(400, { ok: false, error: 'JSON 解析失败' });
      }
      const instances = Array.isArray(payload.instances) ? payload.instances : null;
      const allOps = [
        ...(Array.isArray(payload.ops) ? payload.ops : []),
        ...(instances ?? []).flatMap((instance) => Array.isArray(instance.ops) ? instance.ops : [])
      ];
      if (allOps.some((op) => op && op.op === 'box' && op.length === 999)) {
        return send(200, { ok: false, error: 'smoke requested deterministic build failure' });
      }
      const stats = instances && instances.length > 1
        ? {
            volumeMm3: 214487.1,
            bbox: [220, 120, 40],
            faces: 38,
            edges: 96,
            solids: 2,
            instances: instances.map((instance) => ({
              id: instance.id,
              name: instance.name,
              volumeMm3: 71495.7
            }))
          }
        : {
            volumeMm3: 71495.7,
            bbox: [120, 80, 8],
            faces: 19,
            edges: 48,
            solids: 1,
            ...(instances ? { instances: instances.map((instance) => ({
              id: instance.id,
              name: instance.name,
              volumeMm3: 71495.7
            })) } : {})
          };
      send(200, {
        ok: true,
        kernel: 'build123d',
        stats,
        buildMs: 12,
        files: {
          step: { path: stepPath, bytes: 64, ms: 11.1 },
          stl: { path: stlPath, bytes: 684, ms: 19 }
        }
      });
    });
    return;
  }
  send(404, { ok: false, error: 'not found' });
});

server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ok: true, port, token, version })));
