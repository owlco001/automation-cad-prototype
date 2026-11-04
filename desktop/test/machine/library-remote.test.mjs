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
  nodeRemoteTransport,
  parseMachineCatalog,
  readMachineSources,
  writeMachineSources
} from '../../src/machine/library-remote.ts';

const BRIEF = '三工位锁螺丝机，节拍 18 件/分钟';
const roots = [];
const recordingClocks = [];

after(() => {
  for (const clock of recordingClocks) clock.release();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * 假时钟：`setTimeout` 只登记，必须显式 `advanceBy()` 才会触发。
 *
 * 为什么必须这样：超时/重试用例原来用 `totalTimeoutMs: 30` 这类真实小超时，在 CI 上既可能
 * 「断言先跑到、定时器还没到」也可能「事件循环先空、定时器永远不到」——后者会让被测 Promise
 * 永远 pending，node:test 报 "Promise resolution is still pending but the event loop has
 * already resolved"，整个文件剩下的用例一起 cancelledByParent。时间由测试推进，就没有这个窗口。
 */
function createFakeClock(start = Date.UTC(2026, 0, 1, 0, 0, 0)) {
  let current = start;
  let seq = 0;
  const timers = new Map();
  const due = () =>
    [...timers.values()].filter((timer) => timer.at <= current).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
  return {
    now: () => current,
    setTimeout(callback, ms) {
      seq += 1;
      timers.set(seq, { at: current + ms, callback, seq });
      return seq;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    /** 还挂着几个定时器；正常路径结算后必须是 0 */
    pending: () => timers.size,
    /** 推进时间并触发所有到点的定时器，返回触发次数 */
    advanceBy(ms) {
      current += ms;
      let fired = 0;
      for (;;) {
        const next = due();
        if (!next) return fired;
        timers.delete(next.seq);
        next.callback();
        fired += 1;
      }
    }
  };
}

/** 真实时钟的记账版：统计「借出未归还」的定时器，并能在不 sleep 的情况下让它们「到点」。 */
function createRecordingClock() {
  const borrowed = new Map();
  const clock = {
    now: () => Date.now(),
    setTimeout(callback, ms) {
      const handle = setTimeout(() => {
        borrowed.delete(handle);
        callback();
      }, ms);
      borrowed.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) {
      if (handle === undefined) return;
      clearTimeout(handle);
      borrowed.delete(handle);
    },
    /** 还挂着几个（借出未归还） */
    outstanding: () => borrowed.size,
    /** 其中几个是 **ref 着** 的：unref 的定时器撑不住事件循环 */
    refed: () => [...borrowed.keys()].filter((handle) => handle.hasRef?.() ?? true).length,
    /** 手动「到点」：不推进真实时间，直接把回调放出来 */
    fireAll() {
      for (const [handle, callback] of [...borrowed]) {
        clearTimeout(handle);
        borrowed.delete(handle);
        callback();
      }
    },
    release() {
      for (const handle of borrowed.keys()) clearTimeout(handle);
      borrowed.clear();
    }
  };
  recordingClocks.push(clock);
  return clock;
}

/** 只让事件循环转过若干轮宏任务，不推进任何时间。 */
async function flushTurns(rounds = 20) {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** 轮询等待某个条件成立（不用真实时间，只转宏任务），超轮次即失败。 */
async function waitFor(label, predicate, rounds = 200) {
  for (let index = 0; index < rounds; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`等待超时：${label}`);
}

/** 一个永不产出数据、也永不结束的流：只能靠总时长兜底。 */
function hangingStream() {
  const stream = new PassThrough();
  stream.on('error', () => {});
  return stream;
}

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

  // 目录走真实 file 流（立刻读完）；只有包的那一次 open 会挂住。
  // 旧写法对**所有** URL 都返回挂住的流，结果超时发生在拉目录那一步，`opens === 2` 数的是
  // 目录的两次尝试，下载路径一次都没被超时到——用例只是看起来在测下载超时。
  const clock = createFakeClock();
  let catalogOpens = 0;
  let packageOpens = 0;
  const transport = {
    open(url, request) {
      if (!String(url).endsWith('.machine.zip')) {
        catalogOpens += 1;
        return nodeRemoteTransport.open(url, request);
      }
      packageOpens += 1;
      return Promise.resolve(hangingStream());
    }
  };

  const settled = assertCodeAsync('LIBRARY_TIMEOUT', () =>
    downloadMachine(root, 'dev', id, { transport, clock, totalTimeoutMs: 5000 })
  );

  // 时间一格都没走：只等它把定时器挂上，不该有任何结果。
  await waitFor('第一次下载尝试发出', () => packageOpens === 1);
  await waitFor('第一次尝试挂上总时长定时器', () => clock.pending() === 1);
  assert.equal(catalogOpens, 1, '目录只该拉一次（下载重试不该重复拉目录）');

  // 第一次超时：必须在这个时刻结算，而不是留一个永远 pending 的链
  assert.equal(clock.advanceBy(5000), 1, '应当有且只有一个总时长定时器到点');
  await waitFor('第二次下载尝试发出', () => packageOpens === 2);
  assert.equal(clock.pending(), 1, '重试后应当重新挂上总时长定时器');

  assert.equal(clock.advanceBy(5000), 1);
  const error = await settled;
  assert.match(error.message, /超时/);
  assert.equal(packageOpens, 2, `网络错误应只重试 1 次（共 2 次尝试），实际 ${packageOpens} 次`);
  assert.equal(catalogOpens, 1);
  // 结算即清账：不留定时器，也不留 pending 的链
  assert.equal(clock.pending(), 0, '超时结算后不该残留任何定时器');
  assert.equal(existsSync(join(machineLibraryDirectory(root), id)), false);
});

test('超时守卫：时间不推进就绝不出结果，推进后必须立刻结算且不留定时器', async () => {
  const root = freshRoot();
  const staged = stageFileSource([]);
  const id = 'remote-guard-slow';
  writeFileSync(
    staged.catalogPath,
    JSON.stringify({ schemaVersion: 1, machines: [machineEntry(staged.dir, { id })] }),
    'utf8'
  );
  writeMachineSources(root, [
    { id: 'dev', name: '本地开发源', url: staged.catalogUrl, enabled: true, allowFile: true }
  ]);

  const clock = createFakeClock();
  let packageOpens = 0;
  const transport = {
    open(url, request) {
      if (!String(url).endsWith('.machine.zip')) return nodeRemoteTransport.open(url, request);
      packageOpens += 1;
      return Promise.resolve(hangingStream());
    }
  };

  let state = 'pending';
  const task = downloadMachine(root, 'dev', id, { transport, clock, totalTimeoutMs: 5000 }).then(
    () => {
      state = 'resolved';
    },
    (error) => {
      state = `rejected:${error.code}`;
    }
  );
  await waitFor('第一次下载尝试发出', () => packageOpens === 1);
  await flushTurns();
  assert.equal(state, 'pending', '时间没推进就不该出结果——否则说明还有真实定时器在偷偷兜底');
  assert.equal(clock.pending(), 1);

  for (let round = 0; round < 4 && state === 'pending'; round += 1) {
    clock.advanceBy(5000);
    await flushTurns();
  }
  await task;
  assert.equal(state, 'rejected:LIBRARY_TIMEOUT');
  assert.equal(packageOpens, 2, '两次尝试都必须由假时钟的超时结算');
  assert.equal(clock.pending(), 0, '假时钟里还剩定时器 = 泄漏；测试结束时会把事件循环一起卡住');
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
  const clock = createRecordingClock();
  let catalogOpens = 0;
  let packageOpens = 0;
  const flakyTransport = {
    async open(url, request) {
      if (String(url).endsWith('.machine.zip')) {
        packageOpens += 1;
        if (packageOpens === 1) {
          throw new MachineLibraryError('LIBRARY_NETWORK_FAILED', '模拟抖动：连接被重置');
        }
      } else {
        catalogOpens += 1;
      }
      return nodeRemoteTransport.open(url, request);
    }
  };
  const result = await downloadMachine(root, 'dev', design.config.id, { transport: flakyTransport, clock });
  assert.equal(packageOpens, 2, '网络错误必须重试一次');
  assert.equal(catalogOpens, 1, '重试只重试包，不重复拉目录');
  assert.equal(result.attempts, 2);
  assert.equal(result.bytes, bytes.byteLength);
  assert.equal(result.sha256, sha256(bytes));
  assert.equal(result.entry.id, design.config.id);
  // 重试路径同样不许把总时长定时器留在事件循环里
  assert.equal(clock.outstanding(), 0, '下载结算后不该残留总时长定时器');
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

  const clock = createRecordingClock();
  const result = await downloadMachine(root, 'dev', design.config.id, { clock });
  assert.equal(result.source.id, 'dev');
  assert.equal(result.stale, false);
  assert.equal(result.overwritten, false);
  assert.equal(result.attempts, 1, '目录命中 + 一次下载成功：只该有一次下载尝试');
  assert.equal(clock.outstanding(), 0, '成功路径同样必须归还总时长定时器');
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

test('目录缓存：10 分钟内不重复拉取；过期后重拉；网络失败回退旧缓存并标 stale:true', async () => {
  const root = freshRoot();
  const { design, bytes } = samplePackage('remote-cache-1');
  const staged = stageFileSource([]);
  const entry = machineEntry(staged.dir, { id: design.config.id, bytes });
  writeFileSync(staged.catalogPath, JSON.stringify({ schemaVersion: 1, machines: [entry] }), 'utf8');
  writeMachineSources(root, [
    { id: 'dev', name: '本地开发源', url: staged.catalogUrl, enabled: true, allowFile: true }
  ]);

  // 缓存新鲜度由假时钟决定：TTL 边界不靠 sleep，也不会因为机器慢就误判「过期」
  const clock = createFakeClock();
  let opens = 0;
  const countingTransport = {
    async open(url, request) {
      opens += 1;
      return nodeRemoteTransport.open(url, request);
    }
  };
  const source = readMachineSources(root)[0];
  const first = await fetchMachineCatalog(root, source, { transport: countingTransport, clock });
  assert.equal(first.fromCache, false);
  assert.equal(first.stale, false);
  assert.equal(opens, 1);
  assert.equal(first.attempts, 1);
  assert.equal(first.fetchedAt, new Date(clock.now()).toISOString(), '缓存时间戳必须取自注入的时钟');

  // 9 分钟后：仍在 10 分钟 TTL 内，走缓存，不再打开任何流
  clock.advanceBy(9 * 60 * 1000);
  const second = await fetchMachineCatalog(root, source, { transport: countingTransport, clock });
  assert.equal(second.fromCache, true);
  assert.equal(second.stale, false);
  assert.equal(second.attempts, 0, '命中缓存不该有任何网络尝试');
  assert.equal(opens, 1, '10 分钟内应当命中缓存');
  assert.equal(second.fetchedAt, first.fetchedAt);

  // 11 分钟后：过期，必须重新拉（旧写法换个空目录冒充「过期」，其实没验到 TTL）
  clock.advanceBy(2 * 60 * 1000);
  const third = await fetchMachineCatalog(root, source, { transport: countingTransport, clock });
  assert.equal(third.fromCache, false);
  assert.equal(third.stale, false);
  assert.equal(opens, 2, '超过 TTL 必须重新拉目录');
  assert.equal(third.fetchedAt, new Date(clock.now()).toISOString());

  // 强制走网络 + 运输层失败：必须回退到缓存并标 stale
  const failingTransport = {
    open() {
      throw new MachineLibraryError('LIBRARY_NETWORK_FAILED', '模拟断网');
    }
  };
  const fallback = await fetchMachineCatalog(root, source, { transport: failingTransport, clock, useCache: false });
  assert.equal(fallback.stale, true);
  assert.equal(fallback.fromCache, true);
  assert.equal(fallback.catalog.machines.length, 1);
  assert.equal(fallback.catalog.machines[0].id, design.config.id);
  assert.equal(fallback.fetchedAt, third.fetchedAt, 'stale 回退必须给出旧缓存的抓取时间');
  assert.equal(fallback.attempts, 2, '网络错误重试 1 次：回退前恰好 2 次尝试');

  // 缓存过期（超过 10 分钟）且网络失败、又没有旧缓存可用时：如实报错而不是空目录
  const expiredRoot = freshRoot();
  writeMachineSources(expiredRoot, [
    { id: 'dev', name: '本地开发源', url: staged.catalogUrl, enabled: true, allowFile: true }
  ]);
  await assertCodeAsync('LIBRARY_NETWORK_FAILED', () =>
    fetchMachineCatalog(expiredRoot, readMachineSources(expiredRoot)[0], { transport: failingTransport, clock })
  );
  assert.equal(clock.pending(), 0, '目录/下载路径都跑完后假时钟里不该还挂着定时器');
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

  const clock = createRecordingClock();
  const listed = await listMachineSources(root, { clock });
  assert.deepEqual(listed.sources.map((source) => source.id), ['broken', 'dev']);
  const broken = listed.sources[0];
  assert.equal(broken.online, false);
  assert.equal(broken.machineCount, 0);
  assert.ok(broken.errorCode, '坏源必须带上错误码，便于界面显示原因');
  assert.ok(
    ['LIBRARY_NETWORK_FAILED', 'LIBRARY_IO_FAILED'].includes(broken.errorCode),
    `坏源应当是读取/网络类错误，实际 ${broken.errorCode}`
  );
  assert.equal(broken.fetchedAt, null, '坏源不该有抓取时间');
  const good = listed.sources[1];
  assert.equal(good.online, true);
  assert.equal(good.machineCount, 1);
  assert.equal(listed.machines.length, 1);
  assert.equal(listed.machines[0].sourceId, 'dev');
  assert.equal(listed.machines[0].installed, false);
  assert.equal(listed.stale, false);
  assert.equal(clock.outstanding(), 0, '坏源的重试路径也不许把总时长定时器留在事件循环里');
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

/* ------------------------------------------------------------------ */
/* 8) 守卫：不许把定时器/事件循环留在测试里                             */
/* ------------------------------------------------------------------ */

/**
 * 这条守的是**测试自身**不出漏定时器。
 *
 * 背景：`readCapped` 的总时长定时器一度是 `unref()` 的，事件循环只靠它撑着时就会先空掉，
 * 超时回调永不到来、被测 Promise 永远 pending；Windows 上表现为 2226「超时」，随后同文件
 * 2227–2230 全部 `cancelledByParent`。这里从两个方向钉住：
 *   1. 假时钟：跑完必须 `pending() === 0`（上面几条用例已逐条断言，这里再做一次收口）；
 *   2. 真实时钟：借出的 `setTimeout` 必须全部归还，且进程的活动 Timeout 资源数不得增加。
 *
 * 注意 Node ≥11 的 `process._getActiveHandles()` 不再列定时器（实测返回 []），
 * 要查定时器得用 `process.getActiveResourcesInfo()`。
 */
test('守卫：跑完不残留真实定时器，进程能自然退出', async () => {
  const activeTimeouts = () => process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length;
  const before = activeTimeouts();

  // 1) 真实时钟 + 成功下载：借出的定时器必须归还
  const root = freshRoot();
  const { design, bytes } = samplePackage('remote-guard-clean');
  const staged = stageFileSource([]);
  const entry = machineEntry(staged.dir, { id: design.config.id, bytes });
  writeFileSync(staged.catalogPath, JSON.stringify({ schemaVersion: 1, machines: [entry] }), 'utf8');
  writeMachineSources(root, [
    { id: 'dev', name: '本地开发源', url: staged.catalogUrl, enabled: true, allowFile: true }
  ]);

  const recording = createRecordingClock();
  const result = await downloadMachine(root, 'dev', design.config.id, { clock: recording });
  assert.equal(result.entry.id, design.config.id);
  assert.equal(recording.outstanding(), 0, '成功的下载必须把总时长定时器还回来');

  // 2) 假时钟 + 挂住的下载：整条链跑完后假时钟里不能还剩定时器
  const hangRoot = freshRoot();
  const hangStaged = stageFileSource([]);
  const hangId = 'remote-guard-hang';
  writeFileSync(
    hangStaged.catalogPath,
    JSON.stringify({ schemaVersion: 1, machines: [machineEntry(hangStaged.dir, { id: hangId })] }),
    'utf8'
  );
  writeMachineSources(hangRoot, [
    { id: 'dev', name: '本地开发源', url: hangStaged.catalogUrl, enabled: true, allowFile: true }
  ]);
  const fakeClock = createFakeClock();
  const transport = {
    open(url, request) {
      if (!String(url).endsWith('.machine.zip')) return nodeRemoteTransport.open(url, request);
      return Promise.resolve(hangingStream());
    }
  };
  const settled = assertCodeAsync('LIBRARY_TIMEOUT', () =>
    downloadMachine(hangRoot, 'dev', hangId, { transport, clock: fakeClock, totalTimeoutMs: 5000 })
  );
  await waitFor('第一次尝试挂上定时器', () => fakeClock.pending() > 0);
  for (let round = 0; round < 4; round += 1) {
    fakeClock.advanceBy(5000);
    await flushTurns();
  }
  await settled;
  assert.equal(fakeClock.pending(), 0, '假时钟里还剩定时器 = 测试自己漏了定时器');

  // 3) 真实时钟 + 挂住的下载：总时长定时器必须**ref 着**。
  //    这条直接钉住本次 Windows 红的根因：`readCapped` 的定时器一旦 unref，事件循环只靠它
  //    撑着时就会先空掉，超时永远不到、Promise 永远 pending。用记账时钟手动「到点」，
  //    既不 sleep，也不留 pending 链。
  const refRoot = freshRoot();
  const refStaged = stageFileSource([]);
  const refId = 'remote-guard-ref';
  writeFileSync(
    refStaged.catalogPath,
    JSON.stringify({ schemaVersion: 1, machines: [machineEntry(refStaged.dir, { id: refId })] }),
    'utf8'
  );
  writeMachineSources(refRoot, [
    { id: 'dev', name: '本地开发源', url: refStaged.catalogUrl, enabled: true, allowFile: true }
  ]);
  const realClock = createRecordingClock();
  const hangTransport = {
    open(url, request) {
      if (!String(url).endsWith('.machine.zip')) return nodeRemoteTransport.open(url, request);
      return Promise.resolve(hangingStream());
    }
  };
  const refSettled = assertCodeAsync('LIBRARY_TIMEOUT', () =>
    downloadMachine(refRoot, 'dev', refId, { transport: hangTransport, clock: realClock, totalTimeoutMs: 120000 })
  );
  await waitFor('真实定时器挂上', () => realClock.outstanding() === 1);
  assert.equal(realClock.refed(), 1, '总时长定时器必须是 ref 的；unref 的定时器撑不住事件循环，超时永远不会到');
  for (let round = 0; round < 4; round += 1) {
    realClock.fireAll();
    await flushTurns();
  }
  assert.match((await refSettled).message, /超时/);
  assert.equal(realClock.outstanding(), 0, '手动到点后也不该有借出未还的定时器');

  // 4) 进程层面：活动 Timeout 数量不能因为跑完这些路径而增加
  await flushTurns(5);
  assert.equal(
    activeTimeouts(),
    before,
    `事件循环里多出 ${activeTimeouts() - before} 个真实定时器，会让进程/后续用例被挂住`
  );
});
