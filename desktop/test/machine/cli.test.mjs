// 守住「CLI 出来的数字」和「案例文件里的数字」一致。
// 为什么要有这条：Qt 客户端走 CLI 生成方案，文档/评估里的数字来自 machine-case.json，
// 两边一旦漂移，界面会显示一套、文档写另一套，而且都不会报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..', '..');
const repoRoot = resolve(desktopRoot, '..');
const script = join(desktopRoot, 'scripts', 'machine-design-cli.mjs');
const caseFile = join(repoRoot, 'docs', 'desktop', 'eval', 'machine-case.json');

const BRIEF = '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅';

test('machine-design-cli 输出的方案与 machine-case.json 一致', { timeout: 120_000 }, () => {
  const stdout = execFileSync(process.execPath, [script, '--brief', BRIEF], {
    cwd: desktopRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  });
  const fromCli = JSON.parse(stdout);
  const reference = JSON.parse(readFileSync(caseFile, 'utf8'));

  assert.equal(fromCli.kind, 'machine-case');
  assert.equal(fromCli.schemaVersion, 1);
  assert.equal(fromCli.brief, reference.brief);
  // 结构化结果必须逐字一致（assumptions 文本允许不同：CLI 会说明没读 userData 定价）
  assert.deepEqual(fromCli.parsed, reference.parsed);
  assert.deepEqual(fromCli.stations, reference.stations);
  assert.deepEqual(fromCli.bom, reference.bom);
  assert.deepEqual(fromCli.ioMap, reference.ioMap);
  assert.deepEqual(fromCli.electrical, reference.electrical);
  assert.deepEqual(fromCli.cycleAnalysis, reference.cycleAnalysis);
  assert.equal(fromCli.cost.total, reference.cost.total);
  assert.equal(fromCli.cost.missingCount, reference.cost.missingCount);
});

test('--move 改中心点并带出 moves，未知零件/格式错误都退出 2', { timeout: 120_000 }, () => {
  const stdout = execFileSync(
    process.execPath,
    [script, '--brief', BRIEF, '--with-geometry', '--move', 'frame-stringer-front:0,0,-1000'],
    { cwd: desktopRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.geometry.moves, [{ id: 'frame-stringer-front', delta: [0, 0, -1000] }]);
  const moved = parsed.geometry.parts.find((part) => part.id === 'frame-stringer-front');
  const reference = JSON.parse(readFileSync(caseFile, 'utf8'));
  assert.ok(moved, '挪动的零件应还在 parts 里');
  assert.deepEqual(moved.movedBy, [0, 0, -1000]);
  assert.ok(reference.brief.length > 0);

  const run = (extra) => {
    try {
      execFileSync(process.execPath, [script, '--brief', BRIEF, '--with-geometry', ...extra], {
        cwd: desktopRoot,
        encoding: 'utf8',
        stdio: 'pipe'
      });
      return { status: 0, stderr: '' };
    } catch (error) {
      return { status: error.status, stderr: String(error.stderr) };
    }
  };
  const unknown = run(['--move', 'no-such-part:10,0,0']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /FT_MACHINE_CLI_UNKNOWN_PART/);

  const malformed = run(['--move', 'frame-top:10,0']);
  assert.equal(malformed.status, 2);
  assert.match(malformed.stderr, /FT_MACHINE_CLI_BAD_MOVE/);
});

test('挪开横梁后对应重叠消失（试摆位闭环）', { timeout: 180_000 }, () => {
  // 用四工位 brief：这台机器只有「立柱插横梁」两处重叠，挪走后应当真的归零，
  // 六工位机还有立柱×转台这类 AABB 保守重叠，数量不会归零（那是初筛的固有噪声，不该拿来当零基线）
  const brief = '四工位点胶机，节拍 25 件/分钟，每工位 1 套步进 + 1 个气爪 + 1 个到位检测';
  const run = (extra) => JSON.parse(execFileSync(process.execPath, [script, '--brief', brief, '--with-geometry', ...extra], {
    cwd: desktopRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  }));
  const before = run([]).geometry.interference;
  const after = run(['--move', 'frame-stringer-front:0,0,-1000', '--move', 'frame-stringer-back:0,0,-1000']).geometry.interference;
  assert.ok(before.count > 0, `挪之前应当有重叠，实际 ${before.count}`);
  assert.equal(after.count, 0, `挪开之后应当没有重叠，实际 ${after.count}（${after.pairs.map((p) => `${p.a}×${p.b}`).join(',')}）`);
});

test('machine-design-cli 缺少 --brief 时退出码 2 且不输出 JSON', { timeout: 60_000 }, () => {
  let failed = null;
  try {
    execFileSync(process.execPath, [script], { cwd: desktopRoot, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    failed = error;
  }
  assert.ok(failed, '应当非零退出');
  assert.equal(failed.status, 2);
  assert.match(String(failed.stderr), /FT_MACHINE_CLI_USAGE/);
});
