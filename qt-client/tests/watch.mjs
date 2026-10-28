// Qt 自动刷新验收：起契约服务 → 启动 Qt（--watch-selftest）→ 外部改树 →
// Qt 应在 1.5s 轮询周期内检测到 revision 变化并打印 FT_QT_REFRESH_OK。
// 用法：node qt-client/tests/watch.mjs [--binary build-qt/automationcad-qt]
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
  console.error(`QT_WATCH_FAIL 找不到 Qt 可执行文件：${binary}（先 cmake --build）`);
  process.exit(1);
}

const service = spawn(process.execPath, [resolve(repoRoot, 'featuretree-service', 'server.mjs')], {
  env: { ...process.env, FT_PORT: '0' },
  stdio: ['ignore', 'pipe', 'inherit']
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
  console.error('QT_WATCH_FAIL 契约服务未起来', serviceLog.slice(0, 300));
  service.kill('SIGKILL');
  process.exit(1);
}

const qt = spawn(binary, ['--watch-selftest', '--base', base], {
  env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let qtLog = '';
let qtExit = null;
qt.stdout.setEncoding('utf8');
qt.stderr.setEncoding('utf8');
qt.stdout.on('data', (chunk) => { qtLog += chunk; });
qt.stderr.on('data', (chunk) => { qtLog += chunk; });
qt.on('exit', (code, signal) => { qtExit = code ?? (signal ? -1 : 0); });

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { console.log(`PASS: ${label}`); return; }
  failures += 1;
  console.error(`FAIL: ${label} ${extra}`);
};

try {
  for (let attempt = 0; attempt < 100 && !qtLog.includes('FT_QT_WATCH_READY'); attempt += 1) await sleep(100);
  ok(qtLog.includes('FT_QT_WATCH_READY revision=0'), 'Qt 首屏读到 revision 0', qtLog.slice(-200));

  const edited = await fetch(`${base}/v1/operations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      documentId: 'demo-adapter', expectedRevision: 0, actor: 'manual',
      operation: 'updateFeatureParams', featureId: 'f-body', patch: { height: 21 }
    })
  });
  ok(edited.status === 200, '外部客户端改树成功', `status=${edited.status}`);

  for (let attempt = 0; attempt < 60 && !qtLog.includes('FT_QT_REFRESH_OK'); attempt += 1) await sleep(100);
  ok(/FT_QT_REFRESH_OK revision=1/.test(qtLog), 'Qt 在轮询周期内自动刷新到 revision 1', qtLog.slice(-200));

  for (let attempt = 0; attempt < 50 && qtExit === null; attempt += 1) await sleep(100);
  ok(qtExit === 0, 'Qt 自检进程正常退出', `exit=${qtExit}`);
} catch (error) {
  failures += 1;
  console.error('QT_WATCH_FAIL', error);
} finally {
  qt.kill('SIGKILL');
  service.kill('SIGTERM');
}

if (failures > 0) {
  console.error(`失败 ${failures} 条`);
  process.exit(1);
}
console.log('QT_WATCH_OK 自动刷新链路通过');
