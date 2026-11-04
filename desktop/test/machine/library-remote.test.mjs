// 机型库远程目录 + 下载。
//
// 这套用例的重点不是「下载能跑通」，而是**边界**：一个外部目录可以指定任意 URL、
// 任意字节，所以每条断言都盯一个拒绝理由或一条下限（协议白名单、内网拒、50 MiB 上限、
// SHA-256 不符、同名不覆盖、失败不留半包、超时只重试一次）。
//
// 全部离线：成功路径走 `file:`（来源显式 allowFile），网络测试用本地 http 服务器
// 验证「被拒时一个请求都没发出去」，超时/重试用注入的 transport，不碰公网。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, existsSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { validateMachineDesign } from '../../src/machine/store.ts';
import {
  MACHINE_LIBRARY_LIMITS,
  MachineLibraryError,
  buildMachinePackage,
  machineLibraryDirectory,
  readLibraryPackage
} from '../../src/machine/library.ts';
import {
  MACHINE_REMOTE_LIMITS,
  downloadMachine,
  fetchMachineCatalog,
  listMachineSources,
  parseMachineCatalog,
  readMachineSources,
  writeMachineSources
} from '../../src/machine/library-remote.ts';

const BRIEF = '三工位锁螺丝机，节拍 18 件/分钟';
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'machine-library-remote-'));
  roots.push(root);
  return root;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertCode(code, fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof MachineLibraryError, `应当抛 MachineLibraryError，实际 ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.code, code, `错误码不对：${error.code} / ${error.message}`);
    assert.match(error.message, /[\u4e00-\u9fa5]/, '消息必须是中文');
    return error;
  }
  assert.fail(`应当抛 ${code}，但没有抛错`);
}

async function assertCodeAsync(code, fn) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof MachineLibraryError, `应当抛 MachineLibraryError，实际 ${error?.constructor?.name}: ${error?.message}`);
    assert.equal(error.code, code, `错误码不对：${error.code} / ${error.message}`);
    assert.match(error.message, /[\u4e00-\u9fa5]/, '消息必须是中文');
    return error;
  }
  assert.fail(`应当抛 ${code}，但没有抛错`);
}

/** 造一个带指定 id 的真实机型包（走 buildMachinePackage，等价于「用户自己导出」）。 */
function samplePackage(id) {
  const base = synthMachine(parseMachineBrief(BRIEF), {});
  const design = validateMachineDesign({
    ...base,
    config: { ...base.config, id, name: `远程机型 ${id}` }
  });
  return { design, bytes: buildMachinePackage(design, { appVersion: '0.6.4', version: '1.1.0' }) };
}

/** 把一个包 + 目录写进临时目录，返回 `file:` 目录 URL 与目录 JSON 路径。 */
function stageFileSource(machines) {
  const dir = mkdtempSync(join(tmpdir(), 'machine-source-'));
  roots.push(dir);
  const catalog = { schemaVersion: 1, machines };
  const catalogPath = join(dir, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify(catalog), 'utf8');
  return { dir, catalogPath, catalogUrl: pathToFileURL(catalogPath).toString(), catalog };
}

function machineEntry(dir, { id, bytes, name = '远程机型', sha }) {
  const fileName = `${id}.machine.zip`;
  if (bytes) writeFileSync(join(dir, fileName), bytes);
  return {
    id,
    name,
    version: '1.1.0',
    sizeBytes: bytes ? bytes.byteLength : 1024,
    sha256: sha ?? (bytes ? sha256(bytes) : '0'.repeat(64)),
    downloadUrl: pathToFileURL(join(dir, fileName)).toString()
  };
}

function writeRawSourcesWith(root, payload) {
  const dir = machineLibraryDirectory(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sources.json'), JSON.stringify(payload), 'utf8');
}

/* ------------------------------------------------------------------ */
/* 1) 目录解析与强校验                                                 */
/* ------------------------------------------------------------------ */

test('目录解析：schemaVersion 1 的合法目录逐字段保留（含 tags / minAppVersion）', () => {
  const catalogUrl = 'https://machines.example.com/v1/catalog.json';
  const parsed = parseMachineCatalog(
    {
      schemaVersion: 1,
      machines: [
        {
          id: 'remote-screw-3st',
          name: '三工位锁螺丝机',
          version: '1.1.0',
          sizeBytes: 4096,
          sha256: 'a'.repeat(64),
          downloadUrl: 'https://machines.example.com/v1/remote-screw-3st.machine.zip',
          minAppVersion: '0.6.0',
          tags: ['锁螺丝', '三工位']
        }
      ]
    },
    { catalogUrl }
  );
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.machines.length, 1);
  const machine = parsed.machines[0];
  assert.equal(machine.id, 'remote-screw-3st');
  assert.equal(machine.sizeBytes, 4096);
  assert.equal(machine.sha256, 'a'.repeat(64));
  assert.equal(machine.allowCrossOrigin, false);
  assert.equal(machine.minAppVersion, '0.6.0');
  assert.deepEqual(machine.tags, ['锁螺丝', '三工位']);
});

test('目录非法 schemaVersion 拒；sha256 非 64 位 hex、机型数超 500 也拒', () => {
  const catalogUrl = 'https://machines.example.com/catalog.json';
  const baseMachine = {
    id: 'remote-a',
    name: 'A',
    version: '1.0.0',
    sizeBytes: 1024,
    sha256: 'b'.repeat(64),
    downloadUrl: 'https://machines.example.com/a.machine.zip'
  };
  assertCode('LIBRARY_UNSUPPORTED_SCHEMA', () =>
    parseMachineCatalog({ schemaVersion: 2, machines: [baseMachine] }, { catalogUrl })
  );
  assertCode('LIBRARY_CATALOG_INVALID', () =>
    parseMachineCatalog({ schemaVersion: 1, machines: [{ ...baseMachine, sha256: 'abc123' }] }, { catalogUrl })
  );
  // 32 位 hex 也不行：短摘要无法逐字节比对，给了也验不了完整性
  assertCode('LIBRARY_CATALOG_INVALID', () =>
    parseMachineCatalog({ schemaVersion: 1, machines: [{ ...baseMachine, sha256: 'c'.repeat(32) }] }, { catalogUrl })
  );
  const many = Array.from({ length: MACHINE_REMOTE_LIMITS.maxMachines + 1 }, (_unused, index) => ({
    ...baseMachine,
    id: `remote-${index}`
  }));
  assertCode('LIBRARY_CATALOG_INVALID', () => parseMachineCatalog({ schemaVersion: 1, machines: many }, { catalogUrl }));
});

test('目录 downloadUrl 跨源：默认拒，显式 allowCrossOrigin: true 才放行（且仍必须 https）', () => {
  const catalogUrl = 'https://machines.example.com/v1/catalog.json';
  const machine = {
    id: 'remote-a',
    name: 'A',
    version: '1.0.0',
    sizeBytes: 1024,
    sha256: 'b'.repeat(64),
    downloadUrl: 'https://cdn.evil.example.net/a.machine.zip'
  };
  assertCode('LIBRARY_CATALOG_INVALID', () =>
    parseMachineCatalog({ schemaVersion: 1, machines: [machine] }, { catalogUrl })
  );
  const allowed = parseMachineCatalog(
    { schemaVersion: 1, machines: [{ ...machine, allowCrossOrigin: true }] },
    { catalogUrl }
  );
  assert.equal(allowed.machines[0].allowCrossOrigin, true);
  // 跨源也不许降级成 http
  assertCode('LIBRARY_URL_REJECTED', () =>
    parseMachineCatalog(
      { schemaVersion: 1, machines: [{ ...machine, allowCrossOrigin: true, downloadUrl: 'http://cdn.evil.example.net/a.zip' }] },
      { catalogUrl }
    )
  );
});

/* ------------------------------------------------------------------ */
/* 2) 地址白名单：http / 内网 / file 未授权                            */
/* ------------------------------------------------------------------ */

test('http 与内网地址拒，且本地 http 服务器一个请求都没收到', async () => {
  const root = freshRoot();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ schemaVersion: 1, machines: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    // 用户手写 sources.json：明文 http + 内网 https 都必须被拒
    writeRawSourcesWith(root, {
      schemaVersion: 1,
      sources: [{ id: 'plain', name: '明文', url: `http://127.0.0.1:${port}/catalog.json`, enabled: true }]
    });
    assertCode('LIBRARY_URL_REJECTED', () => readMachineSources(root));

    writeRawSourcesWith(root, {
      schemaVersion: 1,
      sources: [{ id: 'lan', name: '内网', url: 'https://192.168.1.20/catalog.json', enabled: true }]
    });
    assertCode('LIBRARY_URL_REJECTED', () => readMachineSources(root));

    // 内网 / 回环 / 链路本地（云元数据）/ IPv4 映射 全覆盖
    for (const url of [
      'https://10.0.0.5/catalog.json',
      'https://172.20.3.4/catalog.json',
      'https://169.254.169.254/latest/meta-data',
      'https://127.0.0.1/catalog.json',
      'https://localhost/catalog.json',
      'https://[::1]/catalog.json',
      'https://[::ffff:127.0.0.1]/catalog.json'
    ]) {
      writeRawSourcesWith(root, { schemaVersion: 1, sources: [{ id: 'x', name: 'x', url, enabled: true }] });
      assertCode('LIBRARY_URL_REJECTED', () => readMachineSources(root));
    }
    assert.equal(requests, 0, '被拒的地址不该向服务器发出任何请求');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('file 协议只在该来源显式 allowFile: true 时可用', async () => {
  const root = freshRoot();
  const staged = stageFileSource([]);
  writeRawSourcesWith(root, {
    schemaVersion: 1,
    sources: [{ id: 'dev', name: '本地开发源', url: staged.catalogUrl, enabled: true }]
  });
  assertCode('LIBRARY_URL_REJECTED', () => readMachineSources(root));
  const source = { id: 'dev', name: '本地开发源', url: staged.catalogUrl, enabled: true, allowFile: true };
  writeMachineSources(root, [source]);
  const listed = await listMachineSources(root);
  assert.equal(listed.sources.length, 1);
  assert.equal(listed.sources[0].online, true);
  assert.equal(listed.machines.length, 0);
});

/* ------------------------------------------------------------------ */
/* 3) 下载：上限 / 哈希 / 同名 / 未启用 / 重试                          */
/* ------------------------------------------------------------------ */

test('超过 50 MiB 立即 abort：LIBRARY_TOO_LARGE，且没有入库、没有残留', async () => {
  const root = freshRoot();
  const staged = stageFileSource([]);
  const id = 'remote-huge';
  const bigPath = join(staged.dir, `${id}.machine.zip`);
  writeFileSync(bigPath, Buffer.alloc(0));
  truncateSync(bigPath, MACHINE_REMOTE_LIMITS.maxDownloadBytes + 1024 * 1024);
  const catalog = {
    schemaVersion: 1,
    machines: [machineEntry(staged.dir, { id, sha: '0'.repeat(64) })]
  };
  writeFileSync(staged.catalogPath, JSON.stringify(catalog), 'utf8');
  writeMachineSources(root, [
    { id: 'dev', name: '本地开发源', url: staged.catalogUrl, enabled: true, allowFile: true }
  ]);
  const error = await assertCodeAsync('LIBRARY_TOO_LARGE', () => downloadMachine(root, 'dev', id));
  assert.equal(error.code, 'LIBRARY_TOO_LARGE');
  assert.equal(MACHINE_REMOTE_LIMITS.maxDownloadBytes, MACHINE_LIBRARY_LIMITS.maxPackageBytes);
  assert.equal(existsSync(join(machineLibraryDirectory(root), id)), false, '超限的下载不该落进机型库');
  const leftovers = existsSync(machineLibraryDirectory(root))
    ? readdirSync(machineLibraryDirectory(root)).filter((name) => name.startsWith('.tmp-') || name.startsWith('.download-'))
    : [];
  assert.deepEqual(leftovers, [], `库目录里残留了临时文件：${leftovers.join('、')}`);
});

test('SHA-256 与目录不符 → LIBRARY_HASH_MISMATCH，库里不留半包', async () => {
  const root = freshRoot();
  const { design, bytes } = samplePackage('remote-screw-3st');
  const staged = stageFileSource([]);
  const entry = machineEntry(staged.dir, { id: design.config.id, bytes, sha: 'f'.repeat(64) });
  writeFileSync(staged.catalogPath, JSON.stringify({ schemaVersion: 1, machines: [entry] }), 'utf8');
  writeMachineSources(root, [
    { id: 'dev', name: '本地开发源', url: staged.catalogUrl, enabled: true, allowFile: true }
  ]);
  await assertCodeAsync('LIBRARY_HASH_MISMATCH', () => downloadMachine(root, 'dev', design.config.id));
  assert.equal(existsSync(join(machineLibraryDirectory(root), design.config.id)), false);
  const leftovers = existsSync(machineLibraryDirectory(root))
    ? readdirSync(machineLibraryDirectory(root)).filter((name) => name.startsWith('.'))
    : [];
  // 允许存在 sources-cache 之外的隐藏项吗？不允许：下载路径不写任何临时文件。
  assert.deepEqual(leftovers.filter((name) => name !== 'sources-cache'), []);
});

test('同名机型已存在 → LIBRARY_EXISTS（带 hint），且完全不发起下载', async () => {
  const root = freshRoot();
  const { design, bytes } = samplePackage('remote-screw-3st');
  const staged = stageFileSource([]);
  const entry = machineEntry(staged.dir, { id: design.config.id, bytes });
  writeFileSync(staged.catalogPath, JSON.stringify({ schemaVersion: 1, machines: [entry] }), 'utf8');
  writeMachineSources(root, [
    { id: 'dev', name: '本地开发源', url: staged.catalogUrl, enabled: true, allowFile: true }
  ]);
  const first = await downloadMachine(root, 'dev', design.config.id);
  assert.equal(first.entry.id, design.config.id);
  assert.equal(first.entry.source, 'remote');

  // 第二次：同名必须拒，且 hint 明确说「不会自动覆盖」
  const error = await assertCodeAsync('LIBRARY_EXISTS', () => downloadMachine(root, 'dev', design.config.id));
  assert.match(error.hint ?? '', /不会自动覆盖|删除旧机型/);

  // 并发兜底：即使目录里换了新包，已存在的 id 仍在任何字节落地前被拒
  writeFileSync(
    staged.catalogPath,
    JSON.stringify({ schemaVersion: 1, machines: [{ ...entry, sha256: 'a'.repeat(64) }] }),
    'utf8'
  );
  await assertCodeAsync('LIBRARY_EXISTS', () => downloadMachine(root, 'dev', design.config.id, { useCache: false }));
});

test('未启用来源拒；来源不存在也拒（且都不联网）', async () => {
  const root = freshRoot();
  const staged = stageFileSource([]);
  writeMachineSources(root, [
    { id: 'off', name: '停用源', url: staged.catalogUrl, enabled: false, allowFile: true }
  ]);
  const disabled = await assertCodeAsync('LIBRARY_SOURCE_DISABLED', () => downloadMachine(root, 'off', 'remote-a'));
  assert.match(disabled.message, /未启用/);
  await assertCodeAsync('LIBRARY_SOURCE_INVALID', () => downloadMachine(root, 'nope', 'remote-a'));
  const listed = await listMachineSources(root);
  assert.equal(listed.sources[0].enabled, false);
  assert.equal(listed.sources[0].online, false);
  assert.equal(listed.machines.length, 0);
});

test('超时：只重试一次，第二次仍超时后报 LIBRARY_TIMEOUT（transport 恰好被调 2 次）', async () => {
  const root = freshRoot();
  const staged = stageFileSource([]);
  const id = 'remote-slow';
  writeFileSync(
    staged.catalogPath,
    JSON.stringify({ schemaVersion: 1, machines: [machineEntry(staged.dir, { id })] }),
    'utf8'
  );
  writeMachineSources(root, [
    { id: 'dev', name: '本地开发源', url: staged.catalogUrl, enabled: true, allowFile: true }
  ]);

  let opens = 0;
  const hangingTransport = {
    open() {
      opens += 1;
      // 永不产出数据、也永不结束：只能靠总时长兜底
      return Promise.resolve(new PassThrough());
    }
  };
  const error = await assertCodeAsync('LIBRARY_TIMEOUT', () =>
    downloadMachine(root, 'dev', id, { transport: hangingTransport, totalTimeoutMs: 30 })
  );
  assert.match(error.message, /超时/);
  assert.equal(opens, 2, `网络错误应只重试 1 次（共 2 次尝试），实际 ${opens} 次`);
  assert.equal(existsSync(join(machineLibraryDirectory(root), id)), false);
});

test('网络错误重试一次后成功：第二次尝试拿到的包正常入库', async () => {
  const root = freshRoot();
  const { design, bytes } = samplePackage('remote-retry-ok');
  const staged = stageFileSource([]);
  const entry = machineEntry(staged.dir, { id: design.config.id, bytes });
  writeFileSync(staged.catalogPath, JSON.stringify({ schemaVersion: 1, machines: [entry] }), 'utf8');
  writeMachineSources(root, [
    { id: 'dev', name: '本地开发源', url: staged.catalogUrl, enabled: true, allowFile: true }
  ]);
  // 目录用真实 file 通道；包第一次返回网络错误，第二次走真实 file 流
  let packageOpens = 0;
  const flakyTransport = {
    async open(url, request) {
      if (String(url).endsWith('.machine.zip')) {
        packageOpens += 1;
        if (packageOpens === 1) {
          throw new MachineLibraryError('LIBRARY_NETWORK_FAILED', '模拟抖动：连接被重置');
        }
      }
      const { nodeRemoteTransport } = await import('../../src/machine/library-remote.ts');
      return nodeRemoteTransport.open(url, request);
    }
  };
  const result = await downloadMachine(root, 'dev', design.config.id, { transport: flakyTransport });
  assert.equal(packageOpens, 2);
  assert.equal(result.bytes, bytes.byteLength);
  assert.equal(result.sha256, sha256(bytes));
  assert.equal(result.entry.id, design.config.id);
});

/* ------------------------------------------------------------------ */
/* 4) 成功入库：复用严格导入                                           */
/* ------------------------------------------------------------------ */

test('下载成功入库：config 逐字段相等、来源标 remote、目录哈希与本地一致', async () => {
  const root = freshRoot();
  const { design, bytes } = samplePackage('remote-screw-3st');
  const staged = stageFileSource([]);
  const entry = machineEntry(staged.dir, { id: design.config.id, bytes, name: '远程三工位锁螺丝机' });
  writeFileSync(staged.catalogPath, JSON.stringify({ schemaVersion: 1, machines: [entry] }), 'utf8');
  writeMachineSources(root, [
    { id: 'dev', name: '本地开发源', url: staged.catalogUrl, enabled: true, allowFile: true }
  ]);

  const result = await downloadMachine(root, 'dev', design.config.id);
  assert.equal(result.source.id, 'dev');
  assert.equal(result.stale, false);
  assert.equal(result.overwritten, false);
  assert.equal(result.entry.version, '1.1.0');
  assert.equal(result.entry.source, 'remote');
  assert.ok(result.entry.sizeBytes > 0);

  // 入库内容来自 importPackage 的严格校验，config 必须逐字段还原
  const stored = readLibraryPackage(root, design.config.id);
  assert.deepEqual(stored.pkg.config, design.config, '入库后的 config 必须与包内逐字段相等');
  assert.equal(stored.pkg.manifest.version, '1.1.0');
  assert.equal(stored.pkg.manifest.id, design.config.id);

  // 目录再列一遍：已安装标记生效（界面据此禁用下载按钮）
  const listed = await listMachineSources(root);
  const row = listed.machines.find((machine) => machine.id === design.config.id);
  assert.ok(row, '目录里应能看到该机型');
  assert.equal(row.installed, true);
  assert.equal(row.sourceId, 'dev');
  assert.equal(row.stale, false);
});

/* ------------------------------------------------------------------ */
/* 5) 缓存：10 分钟命中 + 失败回退 stale                               */
/* ------------------------------------------------------------------ */

test('目录缓存：10 分钟内不重复拉取；网络失败回退旧缓存并标 stale:true', async () => {
  const root = freshRoot();
  const { design, bytes } = samplePackage('remote-cache-1');
  const staged = stageFileSource([]);
  const entry = machineEntry(staged.dir, { id: design.config.id, bytes });
  writeFileSync(staged.catalogPath, JSON.stringify({ schemaVersion: 1, machines: [entry] }), 'utf8');
  writeMachineSources(root, [
    { id: 'dev', name: '本地开发源', url: staged.catalogUrl, enabled: true, allowFile: true }
  ]);

  let opens = 0;
  const countingTransport = {
    async open(url, request) {
      opens += 1;
      const { nodeRemoteTransport } = await import('../../src/machine/library-remote.ts');
      return nodeRemoteTransport.open(url, request);
    }
  };
  const source = readMachineSources(root)[0];
  const first = await fetchMachineCatalog(root, source, { transport: countingTransport });
  assert.equal(first.fromCache, false);
  assert.equal(first.stale, false);
  assert.equal(opens, 1);

  // 第二次：走缓存，不再打开任何流
  const second = await fetchMachineCatalog(root, source, { transport: countingTransport });
  assert.equal(second.fromCache, true);
  assert.equal(second.stale, false);
  assert.equal(opens, 1, '10 分钟内应当命中缓存');

  // 强制走网络 + 运输层失败：必须回退到缓存并标 stale
  const failingTransport = {
    open() {
      throw new MachineLibraryError('LIBRARY_NETWORK_FAILED', '模拟断网');
    }
  };
  const fallback = await fetchMachineCatalog(root, source, { transport: failingTransport, useCache: false });
  assert.equal(fallback.stale, true);
  assert.equal(fallback.fromCache, true);
  assert.equal(fallback.catalog.machines.length, 1);
  assert.equal(fallback.catalog.machines[0].id, design.config.id);
  assert.equal(fallback.fetchedAt, first.fetchedAt);

  // 缓存过期（超过 10 分钟）且网络失败、又没有旧缓存可用时：如实报错而不是空目录
  const expiredRoot = freshRoot();
  writeMachineSources(expiredRoot, [
    { id: 'dev', name: '本地开发源', url: staged.catalogUrl, enabled: true, allowFile: true }
  ]);
  await assertCodeAsync('LIBRARY_NETWORK_FAILED', () =>
    fetchMachineCatalog(expiredRoot, readMachineSources(expiredRoot)[0], { transport: failingTransport })
  );
});

/* ------------------------------------------------------------------ */
/* 6) 来源列表：坏源不拖垮好源                                         */
/* ------------------------------------------------------------------ */

test('listMachineSources：一个源坏（目录缺失）只标该源 offline，好源仍列机型', async () => {
  const root = freshRoot();
  const { design, bytes } = samplePackage('remote-mixed-1');
  const staged = stageFileSource([]);
  const entry = machineEntry(staged.dir, { id: design.config.id, bytes });
  writeFileSync(staged.catalogPath, JSON.stringify({ schemaVersion: 1, machines: [entry] }), 'utf8');
  writeMachineSources(root, [
    {
      id: 'broken',
      name: '坏源',
      url: pathToFileURL(join(staged.dir, 'missing-catalog.json')).toString(),
      enabled: true,
      allowFile: true,
      priority: 1
    },
    { id: 'dev', name: '本地开发源', url: staged.catalogUrl, enabled: true, allowFile: true, priority: 2 }
  ]);

  const listed = await listMachineSources(root);
  assert.deepEqual(listed.sources.map((source) => source.id), ['broken', 'dev']);
  const broken = listed.sources[0];
  assert.equal(broken.online, false);
  assert.equal(broken.machineCount, 0);
  assert.ok(broken.errorCode, '坏源必须带上错误码，便于界面显示原因');
  const good = listed.sources[1];
  assert.equal(good.online, true);
  assert.equal(good.machineCount, 1);
  assert.equal(listed.machines.length, 1);
  assert.equal(listed.machines[0].sourceId, 'dev');
  assert.equal(listed.machines[0].installed, false);
  assert.equal(listed.stale, false);
});

/* ------------------------------------------------------------------ */
/* 7) 空配置                                                           */
/* ------------------------------------------------------------------ */

test('没有 sources.json：默认空清单（不预置任何外网地址），列表为空且不报错', async () => {
  const root = freshRoot();
  assert.deepEqual(readMachineSources(root), []);
  assert.equal(existsSync(join(machineLibraryDirectory(root), 'sources.json')), false, '读不该顺手创建配置文件');
  const listed = await listMachineSources(root);
  assert.deepEqual(listed.sources, []);
  assert.deepEqual(listed.machines, []);
  assert.equal(listed.stale, false);
});
