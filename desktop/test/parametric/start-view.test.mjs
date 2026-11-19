/**
 * `electron/parametric-start-view.ts` 的单测：启动失败分类透传。
 *
 * 守三件事：
 *   1) 6 个证据字段（code/elapsedMs/exitCode/signal/stderrClass/stderrTail）逐项搬到公开结果，
 *      而 `port` / `token` 绝不出现在 payload 里（旧 `publicStart()` 的 Omit 语义不变）；
 *   2) message 文案逐字不变 —— 分类只作为**额外**一段（`describeStartFailure`），旧路径不追加；
 *   3) token 脱敏的最后一道闸：含 token 的 stderr 经这一层后仍然是 `[REDACTED]`。
 *
 * 场景与 `parametric.ts` 的三条真实失败路径对齐：早退（argparse）、健康检查超时、spawn ENOENT。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { describeStartFailure, toPublicStartResult } from '../../electron/parametric-start-view.ts';

const TOKEN = 's3cr3t-token-should-never-leak-0123456789';
const PORT = 7431;

/** payload 里不许出现 token / port：连键名都不许有。 */
function assertNoSecretKeys(result) {
  assert.equal('token' in result, false, 'payload 不许带 token 键');
  assert.equal('port' in result, false, 'payload 不许带 port 键');
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(TOKEN), false, `payload 里出现 token 原文：${serialized}`);
  assert.equal(serialized.includes('"token"'), false, 'payload 序列化后出现 token 键名');
  assert.equal(serialized.includes('"port"'), false, 'payload 序列化后出现 port 键名');
  assert.equal(serialized.includes(String(PORT)), false, `payload 里出现端口号 ${PORT}`);
}

test('早退 + argparse：6 个字段逐项透传，message 逐字不变，token/port 剥掉', () => {
  const message = '建模内核不可用：子进程已退出（code=2 signal=无，启动后 96 ms）；stderr：usage: app.py';
  const result = toPublicStartResult({
    ok: false,
    status: 'unavailable',
    message,
    code: 'PROCESS_EXITED',
    port: PORT,
    token: TOKEN,
    elapsedMs: 96,
    exitCode: 2,
    signal: null,
    stderrClass: 'argparse',
    stderrTail: 'usage: app.py [-h] [--port PORT]\napp.py: error: unrecognized arguments: --bogus'
  });

  assertNoSecretKeys(result);
  assert.equal(result.code, 'PROCESS_EXITED');
  assert.equal(result.elapsedMs, 96);
  assert.equal(result.exitCode, 2);
  assert.equal(result.signal, null);
  assert.equal(result.stderrClass, 'argparse');
  assert.match(result.stderrTail, /unrecognized arguments/);
  assert.equal(result.message, message, 'message 必须零变化（分类只能作为额外后缀）');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unavailable');

  assert.equal(describeStartFailure(result), '分类=argparse · 实测 96 ms · exit=2');
});

test('健康检查超时：exitCode=null 不编造 exit=，只报分类与实测耗时', () => {
  const message = '建模内核不可用：健康检查在 15 秒（15000 ms）内未通过，实测 15000 ms';
  const result = toPublicStartResult({
    ok: false,
    status: 'unavailable',
    message,
    code: 'HEALTH_TIMEOUT',
    port: PORT,
    token: TOKEN,
    elapsedMs: 15_000,
    exitCode: null,
    signal: null,
    stderrClass: 'empty',
    stderrTail: ''
  });

  assertNoSecretKeys(result);
  assert.equal(result.code, 'HEALTH_TIMEOUT');
  assert.equal(result.elapsedMs, 15_000);
  assert.equal(result.exitCode, null);
  assert.equal(result.stderrClass, 'empty');
  assert.equal(result.stderrTail, '');
  assert.equal(result.message, message);

  const suffix = describeStartFailure(result);
  assert.equal(suffix, '分类=empty · 实测 15000 ms');
  assert.equal(suffix.includes('exit='), false, 'null exit 不能渲染成 exit=null');
});

test('spawn ENOENT：无 exit/signal 时后缀只有分类与耗时', () => {
  const message = '建模内核不可用：进程启动失败（spawn python3 ENOENT），实测 5 ms';
  const result = toPublicStartResult({
    ok: false,
    status: 'unavailable',
    message,
    code: 'SPAWN_FAILED',
    port: PORT,
    token: TOKEN,
    elapsedMs: 5,
    exitCode: null,
    signal: null,
    stderrClass: 'unknown'
  });

  assertNoSecretKeys(result);
  assert.equal(result.code, 'SPAWN_FAILED');
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null);
  assert.equal('stderrTail' in result, false, '没有 stderrTail 证据就不许凭空造一个空串字段');
  assert.equal(result.message, message);
  assert.equal(describeStartFailure(result), '分类=unknown · 实测 5 ms');
});

test('token 脱敏是最后一道闸：已脱敏的保持 [REDACTED]，裸 token 被就地替换', () => {
  const alreadyRedacted = toPublicStartResult({
    ok: false,
    status: 'unavailable',
    message: '建模内核不可用：子进程已退出（code=1 signal=无，启动后 12 ms）',
    code: 'PROCESS_EXITED',
    port: PORT,
    token: TOKEN,
    elapsedMs: 12,
    exitCode: 1,
    signal: null,
    stderrClass: 'traceback',
    stderrTail: 'auth failed for [REDACTED] (tail of the token)'
  });
  assertNoSecretKeys(alreadyRedacted);
  assert.match(alreadyRedacted.stderrTail, /\[REDACTED\]/);
  assert.equal(alreadyRedacted.stderrTail.includes(TOKEN), false);

  // 防御：万一路径变了、上游没替换，这一层也要拦住。
  const rawLeak = toPublicStartResult({
    ok: false,
    status: 'unavailable',
    message: `建模内核不可用：子进程已退出（code=1 signal=无，启动后 12 ms）；token=${TOKEN}`,
    code: 'PROCESS_EXITED',
    port: PORT,
    token: TOKEN,
    elapsedMs: 12,
    exitCode: 1,
    signal: null,
    stderrClass: 'traceback',
    stderrTail: `Traceback ...\nheader Authorization: Bearer ${TOKEN}`
  });
  assertNoSecretKeys(rawLeak);
  assert.equal(rawLeak.stderrTail.includes(TOKEN), false);
  assert.equal(rawLeak.message.includes(TOKEN), false);
  assert.match(rawLeak.stderrTail, /\[REDACTED\]/);
});

test('无证据 / 成功：6 字段一个都不出现，describeStartFailure 返回空串（旧文案零变化）', () => {
  const ready = toPublicStartResult({ ok: true, status: 'ready', message: '参数化建模内核就绪', version: '1.2.3', port: PORT, token: TOKEN });
  assertNoSecretKeys(ready);
  assert.deepEqual(Object.keys(ready).sort(), ['message', 'ok', 'status', 'version']);
  assert.equal(describeStartFailure(ready), '');

  // 失败但还没拿到任何证据（例如 MODULE_DISABLED 之类）：同样不追加后缀。
  const bare = toPublicStartResult({ ok: false, status: 'unavailable', message: '参数化建模内核不可用', code: 'MODULE_DISABLED' });
  assert.deepEqual(Object.keys(bare).sort(), ['code', 'message', 'ok', 'status']);
  assert.equal(describeStartFailure(bare), '');

  // 信号杀死的场景：有 signal 时优先报 signal，不与 exit 混写。
  const killed = toPublicStartResult({
    ok: false,
    status: 'crashed',
    message: '建模内核已崩溃',
    code: 'PROCESS_EXITED',
    elapsedMs: 4_200,
    exitCode: null,
    signal: 'SIGKILL',
    stderrClass: 'out-of-memory'
  });
  assert.equal(describeStartFailure(killed), '分类=out-of-memory · 实测 4200 ms · signal=SIGKILL');
});

test('describeStartFailure 形态锁定：空/成功/exit-only/signal-only/signal 优先于 exit/字段顺序', () => {
  // ① 成功 → 空串（调用方据此决定不追加后缀，旧文案逐字不变）
  assert.equal(describeStartFailure({ ok: true, status: 'ready', message: '就绪' }), '');
  // ② 失败但零证据（MODULE_DISABLED 之类）→ 空串
  assert.equal(describeStartFailure({ ok: false, status: 'unavailable', message: '不可用' }), '');
  // ③ 只有 exit：不编造分类/耗时
  assert.equal(describeStartFailure({ ok: false, status: 'unavailable', message: 'm', exitCode: 2 }), 'exit=2');
  // ④ 只有 signal（SIGKILL/OOM：exit 缺失，见 parametric.ts 的 signal 分支）
  assert.equal(
    describeStartFailure({ ok: false, status: 'crashed', message: 'm', exitCode: null, signal: 'SIGKILL' }),
    'signal=SIGKILL'
  );
  // ⑤ 两者都在 → 只报 signal，不与 exit 混写（同一进程不会既收信号又有 exit code）
  assert.equal(
    describeStartFailure({ ok: false, status: 'crashed', message: 'm', exitCode: 137, signal: 'SIGKILL' }),
    'signal=SIGKILL'
  );
  // ⑥ null 与 undefined 一律不渲染（exit=null / signal=null 不许出现在文案里）
  const nulls = describeStartFailure({ ok: false, status: 'crashed', message: 'm', exitCode: null, signal: null });
  assert.equal(nulls, '');
  // ⑦ 字段顺序固定：分类 → 实测 → signal|exit
  assert.equal(
    describeStartFailure({
      ok: false,
      status: 'crashed',
      message: 'm',
      stderrClass: 'traceback',
      elapsedMs: 7,
      exitCode: null,
      signal: 'SIGKILL'
    }),
    '分类=traceback · 实测 7 ms · signal=SIGKILL'
  );
});

test('UI 副本锁形：ParametricUiStatus 收 signal，后缀优先级与 describeStartFailure 同形', () => {
  const ui = readFileSync(new URL('../../src/parametric/ui.ts', import.meta.url), 'utf8');
  // ① 入参里必须有 signal（否则 SIGKILL 崩溃在界面上只剩「分类 + 耗时」，exit= 也缺失）
  const statusStart = ui.indexOf('interface ParametricUiStatus {');
  assert.ok(statusStart >= 0, 'ui.ts 里找不到 ParametricUiStatus');
  const statusBlock = ui.slice(statusStart, ui.indexOf('}', statusStart));
  assert.match(statusBlock, /\n\s*signal\?: string \| null;/, 'ParametricUiStatus 必须声明 signal?: string | null');

  // ② 有字段还得有值：ensureStarted 必须逐项透传（不是只加类型）
  assert.match(ui, /\.\.\.\(started\.signal !== undefined \? \{ signal: started\.signal \} : \{\}\)/,
    'ensureStarted 必须把 started.signal 透传进 statusView（字段有、值永远没有 = 假字段）');

  // ③ 后缀优先级必须与主进程同形：signal 先于 exit，且都是 truthy 判断（null 不渲染）
  const suffixStart = ui.indexOf('function startFailureSuffix');
  assert.ok(suffixStart >= 0, 'ui.ts 里找不到 startFailureSuffix');
  const suffix = ui.slice(suffixStart, ui.indexOf('function refreshState', suffixStart));
  assert.match(suffix, /status\.signal !== undefined && status\.signal !== null/, '后缀必须判 signal 非空');
  assert.match(suffix, /else if \(status\.exitCode !== undefined && status\.exitCode !== null\)/,
    'exit 必须是 signal 的 else 分支（两者不可同时出现）');
  assert.ok(suffix.indexOf('signal=') < suffix.indexOf('exit='), 'signal 段必须排在 exit 段之前');
});

test('契约 meta：desktop-api.d.ts 的 DesktopParametricStartResult 必须声明 6 个字段（防手写契约漂移）', () => {
  const dts = readFileSync(new URL('../../src/desktop-api.d.ts', import.meta.url), 'utf8');
  const start = dts.indexOf('interface DesktopParametricStartResult');
  assert.ok(start >= 0, 'desktop-api.d.ts 里找不到 DesktopParametricStartResult');
  const block = dts.slice(start, dts.indexOf('}', start));
  for (const field of ['code', 'elapsedMs', 'exitCode', 'signal', 'stderrClass', 'stderrTail']) {
    assert.match(block, new RegExp(`\\n\\s*${field}\\?:`), `DesktopParametricStartResult 缺字段 ${field}?`);
  }
  // port / token 不许回到公开契约里。
  assert.equal(/\n\s*port\??:/.test(block), false, '公开启动结果不许声明 port');
  assert.equal(/\n\s*token\??:/.test(block), false, '公开启动结果不许声明 token');
  // 早退/超时/spawn 三类失败码必须在联合里，否则渲染层没法区分。
  for (const code of ['SPAWN_FAILED', 'PROCESS_EXITED', 'HEALTH_TIMEOUT']) {
    assert.ok(block.includes(`'${code}'`), `code 联合缺 ${code}`);
  }
});
