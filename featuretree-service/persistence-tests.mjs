// 落盘验收（FT_DATA_DIR，契约 §15.1 的可选实现，不影响默认内存态）：
// 改一次 → 杀进程 → 重启 → 版本/参数还在；undo 快照也一起持久化；不设 FT_DATA_DIR 时不写任何文件。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { console.log(`PASS: ${label}`); return; }
  failures += 1;
  console.error(`FAIL: ${label} ${extra}`);
};

const startService = async (env) => {
  const child = spawn(process.execPath, [resolve(here, 'server.mjs')], {
    env: { ...process.env, FT_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  let base = '';
  for (let attempt = 0; attempt < 100 && !base; attempt += 1) {
    const match = log.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) base = `http://127.0.0.1:${match[1]}`;
    else await sleep(100);
  }
  if (!base) throw new Error(`服务未起来：${log.slice(0, 200)}`);
  return { child, base, log: () => log };
};

const stop = async (child) => {
  child.kill('SIGTERM');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) return;
    await sleep(50);
  }
  child.kill('SIGKILL');
};

const tree = async (base) => (await fetch(`${base}/v1/tree`)).json();
const editHeight = async (base, revision, height) => {
  const response = await fetch(`${base}/v1/operations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentId: 'demo-adapter', expectedRevision: revision, actor: 'manual',
      operation: 'updateFeatureParams', featureId: 'f-body', patch: { height }
    })
  });
  return { status: response.status, json: await response.json() };
};
const heightOf = (envelope) => envelope.doc.features.find((f) => f.id === 'f-body').params.height;

const dir = await mkdtemp(join(tmpdir(), 'ft-persist-'));

try {
  // 1. 不设 FT_DATA_DIR：默认内存态，不应该写文件
  {
    const memory = await startService({});
    await stop(memory.child);
    ok(!existsSync(join(dir, 'demo-adapter.json')), '默认（不设 FT_DATA_DIR）不落盘');
  }

  // 2. 设了 FT_DATA_DIR：改一次 → 落盘
  let service = await startService({ FT_DATA_DIR: dir });
  const first = await editHeight(service.base, 0, 19);
  ok(first.status === 200 && first.json.revision === 1, '写入成功（r1）', `status=${first.status}`);
  const file = join(dir, 'demo-adapter.json');
  ok(existsSync(file), '存档文件已生成');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  ok(saved.revision === 1 && heightOf(saved) === 19, '存档里版本与参数都对', `r=${saved.revision} h=${heightOf(saved)}`);
  await stop(service.child);

  // 3. 重启：版本与参数都还在
  service = await startService({ FT_DATA_DIR: dir });
  const restored = await tree(service.base);
  ok(restored.revision === 1, '重启后版本仍是 r1', `r=${restored.revision}`);
  ok(heightOf(restored) === 19, '重启后高度仍是 19', `h=${heightOf(restored)}`);
  ok(/已从存档恢复/.test(service.log()), '启动日志明确写了从存档恢复');

  // 4. 存档里的快照可用于 undo（否则重启后撤销就是空的）
  const undone = await fetch(`${service.base}/v1/undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 1, actor: 'manual', steps: 1 })
  }).then(async (r) => ({ status: r.status, json: await r.json() }));
  ok(undone.status === 200 && heightOf(undone.json) === 12, '重启后 undo 能回到 12（快照也持久化了）', JSON.stringify(undone.json).slice(0, 120));
  ok(undone.json.revision === 2, 'undo 推进到 r2', `r=${undone.json.revision}`);
  await stop(service.child);

  // 5. 再重启：撤销后的状态也保住了
  service = await startService({ FT_DATA_DIR: dir });
  const afterUndo = await tree(service.base);
  ok(afterUndo.revision === 2 && heightOf(afterUndo) === 12, '重启后仍是 r2 / 高度 12', `r=${afterUndo.revision} h=${heightOf(afterUndo)}`);
  await stop(service.child);
} catch (error) {
  failures += 1;
  console.error('PERSISTENCE_FAIL', error);
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`失败 ${failures} 条`);
  process.exit(1);
}
console.log('FT_PERSISTENCE_OK 落盘 / 恢复 / 快照 / 默认不写盘 全部通过');
