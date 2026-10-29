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


test('--clearance 20 输出间距初筛，且按间隙升序、count 与数组一致', { timeout: 120_000 }, () => {
  const stdout = execFileSync(process.execPath,
    [script, '--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--clearance', '20'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const clearance = JSON.parse(stdout).geometry.clearance;
  assert.equal(clearance.thresholdMm, 20);
  assert.equal(clearance.count, clearance.pairs.length);
  for (let index = 1; index < clearance.pairs.length; index += 1) {
    assert.ok(clearance.pairs[index - 1].gapMm <= clearance.pairs[index].gapMm, '必须按间隙升序');
  }
  for (const pair of clearance.pairs) {
    assert.ok(pair.gapMm > 0.5 && pair.gapMm < 20, `间隙必须在 (0.5, 20) 内：${pair.gapMm}`);
  }
});

test('--clearance 取值不合法时退出码 2（不带 --with-geometry 也不能静默吞掉）', { timeout: 120_000 }, () => {
  for (const value of ['0', '-5', 'abc']) {
    let status = 0;
    try {
      execFileSync(process.execPath, [script, '--brief', '四工位点胶机', '--clearance', value],
        { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (error) {
      status = error.status;
    }
    assert.equal(status, 2, `--clearance ${value} 应当退出 2`);
  }
});


test('--resolve-clearance 20 把间距推到阈值之上（不是只算建议，要真的合规）', { timeout: 180_000 }, () => {
  const stdout = execFileSync(process.execPath,
    [script, '--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry',
     '--resolve-clearance', '20', '--clearance', '20'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const geometry = JSON.parse(stdout).geometry;
  const resolution = geometry.clearanceResolution;
  assert.equal(resolution.converged, true, `未收敛：${resolution.stopReason}`);
  assert.ok(resolution.before > 0, '这个案例本来就有间距问题');
  assert.equal(resolution.after, 0);
  assert.equal(geometry.clearance.count, 0, '重算后的间距初筛必须为 0');
  // 注意：不能断言「每条 move 的 gapAfter 都 ≥ 阈值」——单轴推开只增加一个轴的距离，
  // 而距离是各分离轴的平方和；后续 move 还会改变这一对的距离（实测某条当时 19.6 mm，
  // 再经过后续微调才到 20 以上）。能守住的是「整轮跑完 count=0」。
  assert.ok(resolution.moves.length > 0);
  for (const move of resolution.moves) {
    assert.ok(move.gapAfter > 0.5, `${move.partId} 挪完是接触状态 ${move.gapAfter} mm`);
  }
});


test('--layout-compliance 20 交替跑完必须两类都清零（不是只清一类）', { timeout: 240_000 }, () => {
  const stdout = execFileSync(process.execPath,
    [script, '--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry',
     '--layout-compliance', '20', '--clearance', '20'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const geometry = JSON.parse(stdout).geometry;
  const layout = geometry.layoutCompliance;
  assert.equal(layout.converged, true, `未收敛：${layout.stopReason}`);
  assert.equal(layout.suspects, 0);
  assert.equal(layout.clearance, 0);
  assert.equal(geometry.interference.suspects, 0, '重算后的干涉初筛也必须为 0');
  assert.equal(geometry.clearance.count, 0, '重算后的间距初筛也必须为 0');
  assert.ok(layout.rounds.length >= 1);
  // 轮次记录必须能看出「推间距会撞出新重叠」这件事发生过
  const last = layout.rounds[layout.rounds.length - 1];
  assert.equal(last.suspectsAfter, 0);
  assert.equal(last.clearanceAfter, 0);
  assert.ok(layout.moves.length > 0);
});
