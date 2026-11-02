import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  buildCrashReport,
  buildDiagnosisReport,
  clearDiagnosticErrors,
  formatDiagnosisReport,
  recentDiagnosticErrors,
  recordDiagnosticError,
  redactSensitiveText,
  sanitizeForDiagnostics,
  setDiagnosticOperation
} from '../../src/shared/diagnostics.ts';
import { lastCrashPath, writeLastCrash } from '../../electron/crash-report.ts';

const roots = [];
after(() => {
  clearDiagnosticErrors();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'cad-diagnostics-'));
  roots.push(root);
  return root;
}

function quiet(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

function diagnosisInput(overrides = {}) {
  return {
    generatedAt: '2026-10-24T05:00:00.000Z',
    appVersion: '0.3.0',
    electronVersion: '45.0.0',
    nodeVersion: '24.7.0',
    chromeVersion: '140.0.0.0',
    platform: 'win32',
    arch: 'x64',
    userDataPath: 'C:\\Users\\tester\\AppData\\Roaming\\AutomationCAD',
    webgl: { available: true, version: 'WebGL 2.0', renderer: 'ANGLE' },
    dataPackVersion: 'iec-cn@1.2.3',
    packCount: 3,
    kbDocs: 42,
    kbChunks: 512,
    kbBytes: 4096,
    auditPath: 'C:\\Users\\tester\\audit.jsonl',
    auditBytes: 1234,
    errors: [],
    ...overrides
  };
}

test('诊断：报告包含环境、WebGL、userData、数据包、KB、审计与最近错误字段', () => {
  const report = buildDiagnosisReport(diagnosisInput({
    errors: [{
      at: '2026-10-24T04:59:00.000Z',
      code: 'STEP_READ_FAILED',
      operation: 'import',
      message: '读取失败'
    }]
  }));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.kind, 'automation-cad-diagnosis');
  assert.equal(report.app.version, '0.3.0');
  assert.equal(report.app.electron, '45.0.0');
  assert.equal(report.app.node, '24.7.0');
  assert.equal(report.app.chrome, '140.0.0.0');
  assert.equal(report.webgl.available, true);
  assert.equal(report.webgl.version, 'WebGL 2.0');
  assert.match(report.userDataPath, /AutomationCAD/);
  assert.deepEqual(report.dataPack, { version: 'iec-cn@1.2.3', count: 3 });
  assert.deepEqual(report.kb, { docs: 42, chunks: 512, bytes: 4096 });
  assert.equal(report.audit.bytes, 1234);
  assert.equal(report.recentErrors.length, 1);
});

test('诊断：最近错误最多 20 条，环形缓冲最多保留 100 条', () => {
  clearDiagnosticErrors();
  quiet(() => {
    for (let index = 0; index < 125; index += 1) {
      recordDiagnosticError(`E${index}`, new Error(`failure ${index}`));
    }
  });
  const recent = recentDiagnosticErrors(20);
  assert.equal(recent.length, 20);
  assert.equal(recent[0].code, 'E105');
  assert.equal(recent[19].code, 'E124');
  assert.equal(recentDiagnosticErrors(500).length, 100);
  const report = buildDiagnosisReport(diagnosisInput({ errors: recentDiagnosticErrors(500) }));
  assert.equal(report.recentErrors.length, 20);
});

test('诊断：错误码、操作类型、消息、堆栈与上下文字段脱敏', () => {
  clearDiagnosticErrors();
  setDiagnosticOperation('import_step');
  const error = new Error('request failed password=hunter2');
  error.stack = 'Error: request failed\nAuthorization: Bearer top-secret-token';
  const record = quiet(() => recordDiagnosticError(
    'STEP_READ_FAILED',
    error,
    { apiKey: 'sk-live-1234567890', designKey: 'abc', file: 'assembly.step', nested: { token: 'xyz' } }
  ));
  const serialized = JSON.stringify(record);
  assert.equal(record.code, 'STEP_READ_FAILED');
  assert.equal(record.operation, 'import_step');
  assert.match(serialized, /\*\*\*\*/);
  assert.doesNotMatch(serialized, /live-1234567890/);
  assert.doesNotMatch(serialized, /top-secret-token/);
  assert.doesNotMatch(serialized, /"abc"/);
  assert.equal(record.context.file, 'assembly.step');
  assert.equal(redactSensitiveText('sk-abcdef123456'), 'sk-abc****');
});

test('诊断：任意对象上下文按密钥字段脱敏并限制数组长度', () => {
  const sanitized = sanitizeForDiagnostics({
    authorization: 'Bearer abc',
    nested: { password: 'p@ss', token: 'tkn' },
    values: Array.from({ length: 25 }, (_, index) => `v${index}`)
  });
  assert.equal(sanitized.authorization, '****');
  assert.equal(sanitized.nested.password, '****');
  assert.equal(sanitized.nested.token, '****');
  assert.equal(sanitized.values.length, 21);
  assert.match(sanitized.values[20], /其余 5 项省略/);
});

test('诊断：中文格式化输出可读且不泄露密钥', () => {
  const report = buildDiagnosisReport(diagnosisInput({
    userDataPath: '/tmp/token=supersecret/userData',
    errors: [{
      at: '2026-10-24T04:59:00.000Z',
      code: 'AUTH_FAILED',
      operation: 'agent',
      message: 'api_key=sk-hidden-123456'
    }]
  }));
  const text = formatDiagnosisReport(report);
  assert.match(text, /AutomationCAD 诊断报告/);
  assert.match(text, /WebGL：可用/);
  assert.match(text, /知识库：42 份文档/);
  assert.match(text, /最近错误：1 条/);
  assert.doesNotMatch(text, /supersecret/);
});

test('崩溃：报告只含堆栈、版本与操作类型，不含用户数据正文', () => {
  const report = buildCrashReport({
    error: new Error('装配读取失败 password=secret-pass'),
    operation: 'import_step',
    code: 'UNCAUGHT_EXCEPTION',
    appVersion: '0.3.0',
    electronVersion: '45.0.0',
    nodeVersion: '24.7.0',
    platform: 'win32',
    occurredAt: '2026-10-24T05:01:00.000Z'
  });
  assert.equal(report.kind, 'automation-cad-last-crash');
  assert.equal(report.operation, 'import_step');
  assert.equal(report.code, 'UNCAUGHT_EXCEPTION');
  assert.equal(report.appVersion, '0.3.0');
  assert.equal(report.electronVersion, '45.0.0');
  assert.equal(report.nodeVersion, '24.7.0');
  assert.equal(report.platform, 'win32');
  assert.match(report.message, /\*\*\*\*/);
  assert.doesNotMatch(report.message, /secret-pass/);
  assert.match(report.stack, /Error/);
  assert.deepEqual(Object.keys(report).sort(), [
    'appVersion', 'at', 'code', 'electronVersion', 'kind', 'message',
    'nodeVersion', 'operation', 'platform', 'schemaVersion', 'stack'
  ]);
});

test('崩溃：last-crash.json 原子写入 userData/diagnostics 且权限受限', () => {
  const root = tempRoot();
  const report = writeLastCrash(root, {
    error: new Error('boom'),
    operation: 'apply_machine_design',
    appVersion: '0.3.0',
    electronVersion: '45.0.0',
    nodeVersion: '24.7.0',
    platform: 'linux'
  });
  const target = join(root, 'diagnostics', 'last-crash.json');
  assert.equal(lastCrashPath(root), target);
  assert.ok(existsSync(target));
  assert.equal(existsSync(`${target}.tmp`), false);
  assert.deepEqual(readdirSync(join(root, 'diagnostics')), ['last-crash.json']);
  const parsed = JSON.parse(readFileSync(target, 'utf8'));
  assert.equal(parsed.kind, 'automation-cad-last-crash');
  assert.equal(parsed.operation, 'apply_machine_design');
  assert.equal(parsed.message, 'boom');
  assert.equal(parsed.at, report.at);
  if (process.platform !== 'win32') {
    assert.equal(statSync(target).mode & 0o777, 0o600);
  }
  const second = writeLastCrash(root, {
    error: new Error('second'),
    operation: 'agent_chat',
    appVersion: '0.3.0',
    electronVersion: '45.0.0',
    nodeVersion: '24.7.0',
    platform: 'linux'
  });
  const rewritten = JSON.parse(readFileSync(target, 'utf8'));
  assert.equal(rewritten.message, 'second');
  assert.equal(rewritten.operation, 'agent_chat');
  assert.equal(rewritten.at, second.at);
});

test('诊断：npm 脚本暴露 diagnose 与性能基线入口', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  // 不再写死 ELECTRON_DISABLE_SANDBOX：那会让「CI 也在无沙箱下跑」，实证过 CI 日志里
  // 打的是 SECURITY_NO_SANDBOX reason=env:ELECTRON_DISABLE_SANDBOX=1。现在统一走
  // scripts/electron-run.mjs，由它按 uid 决定要不要补 --no-sandbox。
  assert.match(pkg.scripts.diagnose, /xvfb-run -a node scripts\/electron-run\.mjs --diagnose$/);
  assert.doesNotMatch(pkg.scripts.diagnose, /ELECTRON_DISABLE_SANDBOX/);
  assert.match(pkg.scripts['perf:baseline'], /perf-baseline\.mjs/);
});
