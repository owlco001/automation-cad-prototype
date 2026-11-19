// optional-json.ts 的用例：首启缺文件必须静音（ENOENT 是正常路径），但坏 JSON / 其他 fs 错误一律不许吞。
//
// 为什么要有这个模块：PLC 生成历史文件首启本来就不存在，旧实现把 ENOENT 也记成
// PLC_HISTORY_READ_FAILED，首启日志永远有一屏假错误 —— 真损坏反而被淹没在里面。
// 最后一组用例直接跑 ipc.ts 里 readPlcGenHistory 的真实正文（剥掉类型注解后用桩自由变量执行），
// 不是复制一份调用方逻辑来测：正文一改成「missing 也记诊断」，用例立刻红。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { readOptionalJson } from '../../src/shared/optional-json.ts';
import { parsePlcHistory } from '../../src/plcgen/history.ts';

const dirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cad-optional-json-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const IPC_SOURCE = readFileSync(new URL('../../electron/ipc.ts', import.meta.url), 'utf8');

/** 从 ipc.ts 里截出 readPlcGenHistory 的完整声明（大括号配平，不靠行号）。 */
function readPlcGenHistorySource() {
  const start = IPC_SOURCE.indexOf('function readPlcGenHistory(): PlcHistoryEntry[] {');
  assert.ok(start >= 0, 'ipc.ts 里必须还有 readPlcGenHistory');
  let depth = 0;
  for (let index = IPC_SOURCE.indexOf('{', start); index < IPC_SOURCE.length; index += 1) {
    const char = IPC_SOURCE[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return IPC_SOURCE.slice(start, index + 1);
    }
  }
  throw new Error('readPlcGenHistory 的大括号没有配平');
}

/** 用真实正文 + 桩自由变量造一个调用方：执行的是仓库里的代码，不是测试里的副本。 */
function makeReadPlcGenHistory({ file, diagnostics }) {
  const declaration = stripTypeScriptTypes(readPlcGenHistorySource());
  const body = declaration.slice(declaration.indexOf('{') + 1, declaration.lastIndexOf('}'));
  const factory = new Function(
    'plcHistoryFile',
    'parsePlcHistory',
    'recordDiagnosticError',
    'readOptionalJson',
    `return function readPlcGenHistory() {${body}};`
  );
  return factory(
    () => file,
    parsePlcHistory,
    (code, error, context) => diagnostics.push({ code, error, context }),
    readOptionalJson
  );
}

test('文件不存在 → reason=missing，value 为 null，且不带错误对象（首启静音）', () => {
  const file = join(tempDir(), 'plc-gen-history.json');
  const result = readOptionalJson(file, parsePlcHistory);

  assert.equal(result.reason, 'missing');
  assert.equal(result.value, null);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'error'), false, 'missing 不应携带 error，调用方无从记堆栈');
  assert.deepEqual(Object.keys(result).sort(), ['reason', 'value'], 'missing 的形状必须是 {value,reason}');
});

test('坏 JSON → reason=invalid 且带原 SyntaxError（真损坏必须留痕）', () => {
  const file = join(tempDir(), 'plc-gen-history.json');
  writeFileSync(file, 'not json{', 'utf8');

  const result = readOptionalJson(file, parsePlcHistory);
  assert.equal(result.reason, 'invalid');
  assert.equal(result.value, null);
  assert.ok(result.error instanceof SyntaxError, '坏 JSON 要保留原 SyntaxError，别包成字符串');
});

test('JSON 合法但 schema 解析抛错 → reason=invalid，错误对象原样保留', () => {
  const file = join(tempDir(), 'plc-gen-history.json');
  writeFileSync(file, '{"version":2}', 'utf8');
  const boom = new Error('schema 不兼容');

  const result = readOptionalJson(file, () => {
    throw boom;
  });
  assert.equal(result.reason, 'invalid');
  assert.equal(result.error, boom);
});

test('合法文件 → reason=ok，值来自真实 parsePlcHistory', () => {
  const file = join(tempDir(), 'plc-gen-history.json');
  writeFileSync(file, JSON.stringify([{ at: '2026-11-19T00:00:00.000Z', inputHash: 'abc', files: 2, target: 'siemens', namePrefix: 'FC_', fileList: [{ path: 'a.st', lines: 10, bytes: 200 }] }]), 'utf8');

  const result = readOptionalJson(file, parsePlcHistory);
  assert.equal(result.reason, 'ok');
  assert.equal(result.value.length, 1);
  assert.equal(result.value[0].inputHash, 'abc');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'error'), false);
});

test('其他 fs 错误（EISDIR 等）抛出，不映射成 missing/invalid —— 权限类错误不许被静音', () => {
  const dir = tempDir();
  assert.throws(() => readOptionalJson(dir, parsePlcHistory), (error) => {
    assert.notEqual(error.code, 'ENOENT');
    assert.equal(error.code, 'EISDIR');
    return true;
  });
});

test('接线：首启缺文件不记 PLC_HISTORY_READ_FAILED（真损坏仍记），跑的是 ipc.ts 的真实正文', () => {
  const dir = tempDir();
  const file = join(dir, 'plc-gen-history.json');

  // 首启：文件还不存在
  const firstBootDiagnostics = [];
  const firstBoot = makeReadPlcGenHistory({ file, diagnostics: firstBootDiagnostics });
  assert.deepEqual(firstBoot(), [], '首启没有历史时返回空数组');
  assert.deepEqual(firstBootDiagnostics, [], '首启 ENOENT 不许记任何诊断错误');

  // 真损坏：坏 JSON 仍然要留 PLC_HISTORY_READ_FAILED
  writeFileSync(file, 'not json{', 'utf8');
  const brokenDiagnostics = [];
  const broken = makeReadPlcGenHistory({ file, diagnostics: brokenDiagnostics });
  assert.deepEqual(broken(), [], '损坏时回退空数组，不炸调用方');
  assert.equal(brokenDiagnostics.length, 1, '真损坏必须留一条诊断');
  assert.equal(brokenDiagnostics[0].code, 'PLC_HISTORY_READ_FAILED');
  assert.equal(brokenDiagnostics[0].context.site, 'desktop/electron/ipc.ts');

  // 正常：读得到且不记诊断
  writeFileSync(file, JSON.stringify([{ at: '2026-11-19T00:00:00.000Z', inputHash: 'h1', files: 1 }]), 'utf8');
  const okDiagnostics = [];
  const ok = makeReadPlcGenHistory({ file, diagnostics: okDiagnostics });
  assert.equal(ok().length, 1);
  assert.deepEqual(okDiagnostics, []);
});

test('接线：fs 层非 ENOENT 错误（EISDIR）在调用方仍被记为 PLC_HISTORY_READ_FAILED，不静默吞掉', () => {
  const dir = tempDir();
  const diagnostics = [];
  const read = makeReadPlcGenHistory({ file: dir, diagnostics });

  assert.deepEqual(read(), [], '读失败时仍回退空数组');
  assert.equal(diagnostics.length, 1, '非 ENOENT 的读失败必须留痕');
  assert.equal(diagnostics[0].code, 'PLC_HISTORY_READ_FAILED');
  assert.equal(diagnostics[0].error.code, 'EISDIR');
});

test('接线正文不许再手写 ENOENT 判断、不许用 existsSync 当守卫（会漏掉权限错误）', () => {
  const body = readPlcGenHistorySource();
  assert.ok(body.includes('readOptionalJson('), '必须委托给 optional-json 模块');
  assert.equal(body.includes('ENOENT'), false, 'ENOENT 判断只允许在 src/shared/optional-json.ts 一处');
  assert.equal(body.includes('existsSync'), false, 'existsSync 当守卫会把 EACCES 当成「文件不存在」');
  assert.equal(body.includes('JSON.parse('), false, '解析必须走注入的 parse，不许在调用方再 parse 一遍');
});
