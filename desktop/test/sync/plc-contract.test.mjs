import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { buildMachineIoMap } from '../../src/machine/io-map.ts';
import { demoMachineConfig } from '../../src/commission/machine-config.ts';
import { buildDesignPackage, parseDesignPackage, sha256Hex } from '../../src/sync/package.ts';
import { SyncClient } from '../../src/sync/client.ts';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const PLC_PATHS = [
  'src/OB1_Main.st', 'src/DB_IO.st', 'src/FB_Cylinder.st', 'src/FB_Gripper.st',
  'src/FB_RotaryAxis.st', 'src/FC_AutoSequence.st', 'src/FC_Alarms.st',
  'src/FC_Safety.st', 'io-tags.csv', 'mapping.json'
];
const config = {
  baseUrl: 'http://127.0.0.1:1', apiKey: 'mock-design-key', deviceId: 'DEV-MOCK-1',
  projectId: 'mock-project', enabled: true
};

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function multipartPart(body, boundary, fieldName) {
  const sections = body.toString('latin1').split(`--${boundary}`);
  for (const section of sections) {
    const splitAt = section.indexOf('\r\n\r\n');
    if (splitAt < 0 || !section.includes(`name="${fieldName}"`)) continue;
    const headers = section.slice(0, splitAt);
    let content = section.slice(splitAt + 4);
    if (content.endsWith('\r\n')) content = content.slice(0, -2);
    return {
      headers,
      content: Buffer.from(content, 'latin1')
    };
  }
  throw new Error(`multipart 字段缺失：${fieldName}`);
}
async function startMockServer(handler) {
  const sockets = new Set();
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(String(error));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
function plcDesignPackage() {
  const machine = demoMachineConfig();
  const plc = {
    target: 's7-1200',
    generatedVersion: '1.0.0',
    machineId: machine.id,
    programFiles: PLC_PATHS.map((path) => ({
      path,
      content: path.endsWith('.json') ? JSON.stringify({ machineId: machine.id, target: 's7-1200' }) : `${path}\nmock ST contract\n`
    })),
    mappingCsv: buildMachineIoMap(machine).csv
  };
  const built = buildDesignPackage({
    projectId: 'mock-project', projectName: '本地 PLC 合同测试', appVersion: '0.3.0',
    createdAt: '2026-10-24T10:00:00.000Z',
    bom: [{ no: 1, name: '底板', spec: 'BASE-01', qty: 1, mat: 'AL6061' }],
    bomCsv: '序号,名称\r\n1,底板\r\n', pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46]), dxf: '0\nSECTION\n0\nENDSEC\n', plc
  });
  return { machine, built };
}

test('本机 mock PLC 契约：上传 multipart 中 manifest.plc 与 ZIP plc/ 内容一致，并可列出、比对、下载为只读候选', async () => {
  const { machine, built } = plcDesignPackage();
  const seen = { upload: 0, list: 0, diff: 0, download: 0 };
  let downloadedZip;
  const server = await startMockServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/v1/design-sync/packages') {
      seen.upload += 1;
      assert.equal(request.headers['x-design-key'], config.apiKey);
      const idempotencyKey = request.headers['idempotency-key'];
      const contentType = request.headers['content-type'];
      const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1];
      assert.ok(boundary, 'multipart boundary 应存在');
      const body = await readBody(request);
      const manifestPart = multipartPart(body, boundary, 'manifest');
      const zipPart = multipartPart(body, boundary, 'file');
      const multipartManifest = JSON.parse(manifestPart.content.toString('utf8'));
      downloadedZip = new Uint8Array(zipPart.content);
      assert.equal(idempotencyKey, sha256Hex(downloadedZip));
      assert.deepEqual(multipartManifest.plc, built.manifest.plc);
      const zip = new AdmZip(Buffer.from(downloadedZip));
      const zipManifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
      assert.deepEqual(zipManifest, multipartManifest);
      const plcEntries = zip.getEntries().map((entry) => entry.entryName).filter((name) => name.startsWith('plc/')).sort();
      const declared = [...multipartManifest.plc.programFiles.map((file) => file.path), multipartManifest.plc.mapping.path].sort();
      assert.deepEqual(plcEntries, declared);
      const parsed = parseDesignPackage(downloadedZip, machine);
      assert.equal(parsed.machineContextStatus, 'matched');
      assert.equal(parsed.requiresExplicitApply, true);
      assert.equal(parsed.plc.programFiles.length, 10);
      response.writeHead(201);
      response.end(JSON.stringify({ packageId: 'PKG-MOCK-1', version: 1, duplicated: false }));
      return;
    }
    if (request.method === 'GET' && request.url.startsWith('/api/v1/design-sync/packages?')) {
      seen.list += 1;
      const url = new URL(request.url, 'http://localhost');
      assert.equal(url.searchParams.get('deviceId'), config.deviceId);
      assert.equal(url.searchParams.get('projectId'), config.projectId);
      response.writeHead(200);
      response.end(JSON.stringify({ items: [{ packageId: 'PKG-MOCK-1', projectId: config.projectId, version: 1, bomSha256: built.manifest.bomSha256, createdAt: '2026-10-24T10:00:00Z' }] }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/design-sync/packages/PKG-MOCK-1/diff?against=latest') {
      seen.diff += 1;
      response.writeHead(200);
      response.end(JSON.stringify({ base: { packageId: 'PKG-MOCK-0', version: 0 }, bomAdded: [], bomRemoved: [], bomChanged: [], filesAdded: ['plc/src/OB1_Main.st'], filesChanged: [], filesRemoved: [] }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/design-sync/packages/PKG-MOCK-1/download') {
      seen.download += 1;
      response.writeHead(200, { 'content-type': 'application/zip', etag: `"${sha256Hex(downloadedZip)}"` });
      response.end(Buffer.from(downloadedZip));
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ detail: 'unknown mock route' }));
  });
  try {
    const client = new SyncClient({ ...config, baseUrl: server.url });
    const uploaded = await client.uploadPackage(built.zip, built.manifest);
    assert.equal(uploaded.ok, true);
    assert.equal(uploaded.packageId, 'PKG-MOCK-1');
    const listed = await client.listPackages();
    assert.equal(listed.ok, true);
    assert.equal(listed.items[0].packageId, 'PKG-MOCK-1');
    const diff = await client.diff('PKG-MOCK-1');
    assert.equal(diff.ok, true);
    assert.deepEqual(diff.diff.filesAdded, ['plc/src/OB1_Main.st']);
    const downloaded = await client.downloadPackage('PKG-MOCK-1');
    assert.equal(downloaded.ok, true);
    assert.equal(downloaded.sha256, sha256Hex(built.zip));
    assert.equal(downloaded.etag, sha256Hex(built.zip));
    const candidate = parseDesignPackage(downloaded.zip, machine);
    assert.equal(candidate.plc.machineId, machine.id);
    assert.equal(candidate.requiresExplicitApply, true);
    assert.deepEqual(seen, { upload: 1, list: 1, diff: 1, download: 1 });
  } finally {
    await server.close();
  }
});
