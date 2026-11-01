// 顶栏「Qt 工作台」按钮的提示文案映射（P1-1：按钮点完失败没提示）。
// 只测纯函数：payload → 文案，不碰 electron / DOM。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  QT_NOTICE_STDERR_LIMIT,
  qtExitNotice,
  qtLaunchNotice,
  truncateQtStderr
} from '../../src/ui/qt-exit-notice.ts';

test('启动失败：完整透传主进程 message，不截断成「启动失败」', () => {
  const message = '找不到 Qt 工作台（automationcad-qt.exe）：/opt/app/vendor/qt/automationcad-qt.exe（vendor）。开发态请先跑 node scripts/vendor-qt.mjs。';
  const notice = qtLaunchNotice({ ok: false, message });
  assert.equal(notice.error, true);
  assert.equal(notice.message, message);
});

test('启动失败但没有 message：给兜底文案，仍是错误样式', () => {
  const notice = qtLaunchNotice({ ok: false, message: '   ' });
  assert.equal(notice.error, true);
  assert.equal(notice.message, 'Qt 工作台没有启动');
  assert.equal(qtLaunchNotice(undefined).error, true);
});

test('已在运行：提示「已在运行」，不谎报新进程，也不是错误', () => {
  const notice = qtLaunchNotice({ ok: true, pid: 4321, alreadyRunning: true });
  assert.deepEqual(notice, { message: 'Qt 工作台已在运行', error: false });
});

test('正常启动：带上 PID', () => {
  assert.deepEqual(qtLaunchNotice({ ok: true, pid: 4321 }), {
    message: 'Qt 工作台已启动（PID 4321）',
    error: false
  });
  assert.deepEqual(qtLaunchNotice({ ok: true }), { message: 'Qt 工作台已启动', error: false });
});

test('非 0 退出：拼 code 与 stderr 尾巴，200 字处截断并补省略号', () => {
  const stderrTail = `${'错'.repeat(199)}尾${'巴'.repeat(50)}`;
  const notice = qtExitNotice({ pid: 1, code: 3, signal: null, stderrTail });
  assert.ok(notice);
  assert.equal(notice.error, true);
  assert.ok(notice.message.startsWith('Qt 工作台已退出（code=3）：'));
  const body = notice.message.slice('Qt 工作台已退出（code=3）：'.length);
  assert.equal(body, `${'错'.repeat(199)}尾…`);
  assert.equal(Array.from(body).length, QT_NOTICE_STDERR_LIMIT + 1);
  assert.ok(!body.includes('巴'), '第 201 字之后必须被截掉');
});

test('正常退出（code=0）不打扰用户；被信号杀掉算异常', () => {
  assert.equal(qtExitNotice({ code: 0, stderrTail: 'bye' }), null);
  assert.equal(qtExitNotice(undefined), null);
  const killed = qtExitNotice({ pid: 9, code: null, signal: 'SIGTERM', stderrTail: '' });
  assert.ok(killed);
  assert.equal(killed.error, true);
  assert.equal(killed.message, 'Qt 工作台已退出（code=null，signal=SIGTERM）：没有 stderr 输出');
});

test('truncateQtStderr：按码点截断，emoji 不劈半', () => {
  assert.equal(truncateQtStderr('  a\nb  '), 'a\nb');
  assert.equal(truncateQtStderr(''), '');
  const emoji = '🙂'.repeat(210);
  const cut = truncateQtStderr(emoji, 200);
  assert.equal(Array.from(cut).length, 201);
  assert.equal(cut, `${'🙂'.repeat(200)}…`);
});
