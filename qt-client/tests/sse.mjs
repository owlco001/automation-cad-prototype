// SSE 验收：起契约服务 → 起 Qt（--sse-selftest，轮询被调到 30s）→ 外部改树 →
// 客户端必须在 2 秒内收到事件并刷新（轮询 30s 不可能这么快，所以只可能是 SSE）。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const binaryIndex = process.argv.indexOf('--binary');
const binary = binaryIndex >= 0 && process.argv[binaryIndex + 1]
  ? resolve(process.argv[binaryIndex + 1])
  : resolve(repoRoot, 'build-qt', 'automationcad-qt');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
if (!existsSync(binary)) {
  console.error(`SSE_FAIL 找不到 Qt 可执行文件：${binary}`);
  process.exit(1);
}

const service = spawn(process.execPath, [resolve(repoRoot, 'featuretree-service', 'server.mjs')], {
  env: { ...process.env, FT_PORT: '0' },
  stdio: ['ignore', 'pipe', 'inherit']
});
let log = '';
service.stdout.setEncoding('utf8');
service.stdout.on('data', (chunk) => { log += chunk; });
let base = '';
for (let attempt = 0; attempt < 100 && !base; attempt += 1) {
  const match = log.match(/http:\/\/127\.0\.0\.1:(\d+)/);
  if (match) base = `http://127.0.0.1:${match[1]}`;
  else await sleep(100);
}
if (!base) {
  console.error('SSE_FAIL 契约服务未起来');
  service.kill('SIGKILL');
  process.exit(1);
}

const qt = spawn(binary, ['--sse-selftest', '--base', base], {
  env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let qtLog = '';
let qtExit = null;
qt.stdout.setEncoding('utf8');
qt.stderr.setEncoding('utf8');
qt.stdout.on('data', (chunk) => { qtLog += chunk; });
qt.stderr.on('data', (chunk) => { qtLog += chunk; });
qt.on('exit', (code) => { qtExit = code ?? -1; });

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { console.log(`PASS: ${label}`); return; }
  failures += 1;
  console.error(`FAIL: ${label} ${extra}`);
};

try {
  // 给 SSE 连接留出时间（Qt 侧先 GET 一次再订阅）
  await sleep(2500);
  const started = Date.now();
  const edited = await fetch(`${base}/v1/operations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentId: 'demo-adapter', expectedRevision: 0, actor: 'manual',
      operation: 'updateFeatureParams', featureId: 'f-body', patch: { height: 17 }
    })
  });
  ok(edited.status === 200, '外部改树成功', `status=${edited.status}`);

  for (let attempt = 0; attempt < 60 && qtExit === null; attempt += 1) await sleep(100);
  const latency = Date.now() - started;
  ok(qtLog.includes('FT_QT_SSE_OK revision=1'), 'Qt 通过 SSE 收到变更', qtLog.slice(-200));
  ok(qtExit === 0, 'Qt 自检正常退出', `exit=${qtExit}`);
  ok(latency < 2000, '刷新延迟 < 2s（轮询被设成 30s，只能是 SSE）', `latency=${latency}ms`);
  console.log(`SSE_LATENCY ${latency}ms`);
} catch (error) {
  failures += 1;
  console.error('SSE_FAIL', error);
} finally {
  qt.kill('SIGKILL');
  service.kill('SIGTERM');
}

if (failures > 0) {
  console.error(`失败 ${failures} 条`);
  process.exit(1);
}
console.log('QT_SSE_OK SSE 推送链路通过');
