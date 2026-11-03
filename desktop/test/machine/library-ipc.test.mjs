// 机型库 IPC 的 id 闸门与错误出口（desktop/src/machine/library-ipc.ts）。
//
// 这几条是安全边界：`library:apply` / `library:export` / `library:remove` 的 id 会被拿去
// 拼 `userData/machine-library/<id>`，所以必须证明 `..`、斜杠、盘符、控制字符进不来；
// 另外失败结果里不能带堆栈（渲染层不该看到内部路径与调用栈）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MachineLibraryError } from '../../src/machine/library.ts';
import {
  MACHINE_LIBRARY_MAX_ID_LENGTH,
  isLibraryIdSafe,
  machineLibraryFailure,
  validateLibraryId
} from '../../src/machine/library-ipc.ts';

test('机型库 id：合法 id 原样放行', () => {
  for (const id of ['six-station', 'machine_1', '六工位锁螺丝机', 'a.b', 'A1', '0']) {
    assert.deepEqual(validateLibraryId(id), { ok: true, id }, `${id} 应放行`);
    assert.equal(isLibraryIdSafe(id), true);
  }
});

test('机型库 id：路径穿越/绝对路径/盘符/控制字符一律拒，错误码是 LIBRARY_BAD_PATH', () => {
  const bad = [
    '..',
    '../escape',
    '..\\escape',
    'a/../b',
    'a/b',
    'a\\b',
    '/etc/passwd',
    '\\\\server\\share',
    'C:',
    'C:\\Users',
    'c:/temp',
    'six\u0000station',
    'six\nstation',
    'six\u007fstation',
    ' six',
    'six ',
    '.hidden',
    'trailing-',
    'trailing.',
    'con',
    'COM1',
    'x'.repeat(MACHINE_LIBRARY_MAX_ID_LENGTH + 1),
    '',
    null,
    undefined,
    42,
    {}
  ];
  for (const id of bad) {
    const result = validateLibraryId(id);
    assert.equal(result.ok, false, `${JSON.stringify(id)} 必须被拒（否则会拼出越界路径）`);
    assert.equal(result.code, 'LIBRARY_BAD_PATH');
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message.length > 0);
    assert.equal(isLibraryIdSafe(id), false);
  }
});

test('机型库 id：伪装成相对路径的兄弟目录名不能靠净化蒙混过关', () => {
  // `sanitizeMachineId` 会把空格/控制字符改写成别的名字；改写后不等于原值即拒。
  assert.equal(validateLibraryId('six station').ok, false, '空格会被改写成 -，不是不动点');
  assert.equal(validateLibraryId('six/station').ok, false);
  assert.equal(validateLibraryId('six_station').ok, true);
  // 净化器不会碰连续 -：那是工程师自己起的合法 id，不能误伤
  assert.equal(validateLibraryId('six--station').ok, true);
});

test('机型库 id 校验：拒绝时带 hint，告诉调用方路径规则', () => {
  const result = validateLibraryId('../escape');
  assert.equal(result.ok, false);
  assert.match(String(result.hint ?? ''), /exports|\.\.|盘符/);
});

test('机型库错误出口：MachineLibraryError 保留 code/message/hint，语义不变', () => {
  const failure = machineLibraryFailure(new MachineLibraryError('LIBRARY_EXISTS', '库里已有 six-station'));
  assert.deepEqual(failure.ok, false);
  assert.equal(failure.code, 'LIBRARY_EXISTS');
  assert.equal(failure.message, '库里已有 six-station');
  assert.match(String(failure.hint ?? ''), /overwrite/);
});

test('机型库错误出口：非预期异常不把堆栈/原始错误文本丢给渲染层', () => {
  const failure = machineLibraryFailure(new Error('EACCES: open /root/secret/path'));
  assert.equal(failure.ok, false);
  assert.equal(failure.code, 'LIBRARY_IO_FAILED');
  // 原始 message 里带绝对路径，必须被吞掉（只进诊断日志）
  assert.equal(failure.message.includes('/root/secret'), false);
  assert.equal(failure.message.includes('EACCES'), false);
  assert.equal(failure.message.includes('at '), false);
  assert.match(failure.message, /机型库操作失败/);
});
