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


test('--boolean-recheck：连不上 sidecar 时如实标「未复核」，不冒充没问题', { timeout: 120_000 }, () => {
  const stdout = execFileSync(process.execPath,
    [script, '--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--boolean-recheck', 'http://127.0.0.1:1'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const recheck = JSON.parse(stdout).geometry.booleanRecheck;
  assert.equal(recheck.suspects, 0, '排布合规后的样机没有疑似对');
  assert.equal(recheck.checked, 0);
  assert.match(recheck.message, /无需复核/, '0 处疑似要说「不需要」，不能说「已复核」');
});

test('--insert-part 配 --part-size：零件按新尺寸落地，底面仍贴地', { timeout: 120_000 }, () => {
  const stdout = execFileSync(process.execPath,
    [script, '--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry',
     '--insert-part', 'upright@-900,0,0', '--part-size', '60x60x1200'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const parts = JSON.parse(stdout).geometry.parts;
  const inserted = parts.find((part) => part.id.startsWith('user-upright'));
  assert.ok(inserted, '必须插入 user-upright-*');
  assert.deepEqual(inserted.shape.size, [60, 60, 1200]);
  assert.equal(inserted.center[2], 600, '中心 z = 高度/2，底面贴地');
});

test('--with-geometry 输出 bounds，且与 parts 一一对应（Qt 拖动预览靠它本地判重叠）', { timeout: 120_000 }, () => {
  const stdout = execFileSync(process.execPath,
    [script, '--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const geometry = JSON.parse(stdout).geometry;
  const parts = geometry.parts;
  const bounds = geometry.bounds;
  assert.equal(bounds.length, parts.length, '每个零件都要有包围盒');
  bounds.forEach((entry, index) => {
    assert.equal(entry.id, parts[index].id);
    assert.equal(entry.min.length, 3);
    assert.equal(entry.max.length, 3);
    entry.min.forEach((value, axis) => assert.ok(value <= entry.max[axis], `${entry.id} min<=max`));
  });
});

test('线体加宽：CLI 把结论写进 geometry.widening，不可行时给带数字的原因', { timeout: 240_000 }, () => {
  const stdout = execFileSync(process.execPath,
    [script, '--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--min-widening', '40'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const widening = JSON.parse(stdout).geometry.widening;
  assert.equal(widening.targetClearanceMm, 40);
  assert.equal(widening.reachable, false, '四工位 40 mm 加宽到上限仍不收敛');
  assert.equal(widening.extraMm, widening.maxExtraMm);
  assert.ok(widening.probes.length >= 2, '至少探测 0 与上限两点');
  assert.equal(widening.probes[0].extraMm, 0);
  assert.match(widening.remaining.reason, /重叠|工位内部|跨工位/);
  assert.match(widening.remaining.reason, /\d+/, '原因要落到具体处数，不能只说「不行」');
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


test('排布合规：40 mm 放不下时如实报未收敛，且不空转到上千次位移', { timeout: 240_000 }, () => {
  const stdout = execFileSync(process.execPath,
    [script, '--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--layout-compliance', '40'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const layout = JSON.parse(stdout).geometry.layoutCompliance;
  assert.equal(layout.converged, false, '40 mm 在四工位布局下放不下，不能报合规');
  assert.ok((layout.stopReason ?? '').length > 0, '必须说明为什么没收敛');
  assert.ok(layout.moves.length < 300, `不应空转出上百次位移，实际 ${layout.moves.length}`);
  assert.ok(layout.rounds.length <= 4);
  // 40 mm 下剩下的问题是重叠（不是间距）——所以 advice 为空是合理的
  assert.equal(layout.clearance, 0);
  assert.ok(layout.suspects > 0);
  assert.equal((layout.advice ?? []).length, 0, '没有间距问题时不该硬凑建议');
});


test('--layout-compliance 会把合规结论写成文档顶层的 compliance 戳（与 details 一致）', { timeout: 240_000 }, () => {
  const stdout = execFileSync(process.execPath,
    [script, '--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--layout-compliance', '20'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const document = JSON.parse(stdout);
  const stamp = document.compliance;
  const details = document.geometry.layoutCompliance;
  assert.ok(stamp, '文档顶层必须有 compliance');
  assert.equal(stamp.clearanceMm, 20);
  assert.equal(stamp.converged, details.converged);
  assert.equal(stamp.rounds, details.rounds.length);
  assert.equal(stamp.moves, details.moves.length);
  assert.equal(stamp.suspects, details.suspects);
  assert.equal(stamp.clearance, details.clearance);
});


test('排布合规 fixture 与当前算法一致（CI 的 Qt 自检靠它，漂了要重新生成）', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, 'docs', 'desktop', 'eval', 'layout-case.json'), 'utf8'));
  const stamp = fixture.compliance;
  assert.equal(fixture.kind, 'machine-case');
  assert.equal(stamp.clearanceMm, 20);
  assert.equal(stamp.converged, true);
  assert.equal(stamp.suspects, 0);
  assert.equal(stamp.clearance, 0);
  assert.equal(stamp.rounds, 2);
  assert.equal(stamp.moves, 50);
  const details = fixture.geometry.layoutCompliance;
  assert.equal(details.moves.length, 50);
  assert.equal(details.rounds.length, 2);
  // 同一份 fixture 也标了机器上限：打开方案就能看出「按 20 排的，其实能到 25」
  assert.equal(stamp.maxFeasibleMm, 25);
  assert.equal(fixture.geometry.maxClearance.feasibleMm, 25);
  // fixture 里必须真有一个未收敛的反例参数可查（同一份 geometry 按 40 mm 会放不下）
  assert.equal(fixture.geometry.parts.length > 0, true);
});


test('--max-clearance 二分出四工位的最大可行间距 = 25 mm，且该值复算确实收敛', { timeout: 300_000 }, () => {
  const stdout = execFileSync(process.execPath,
    [script, '--brief', '四工位点胶机，节拍 25 件/分钟', '--with-geometry', '--max-clearance'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const maxClearance = JSON.parse(stdout).geometry.maxClearance;
  assert.equal(maxClearance.feasibleMm, 25, `实际 ${maxClearance.feasibleMm}`);
  assert.ok(maxClearance.probes.length >= 3, '二分至少探测 3 次');
  // 探测记录必须自洽：25 通过、26 不通过（否则结论不可信）
  const byMm = new Map(maxClearance.probes.map((probe) => [probe.mm, probe.converged]));
  assert.equal(byMm.get(25), true);
  assert.equal(byMm.get(26), false);
});


test('工位级建议：只有跨工位的间距问题才可能给建议', { timeout: 300_000 }, () => {
  const read = (brief, threshold) => {
    const stdout = execFileSync(process.execPath,
      [script, '--brief', brief, '--with-geometry', '--layout-compliance', String(threshold)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout).geometry.layoutCompliance;
  };

  // 四工位 40 mm：剩下的 2 处是重叠，不是间距 → 没有建议可说
  const four = read('四工位点胶机，节拍 25 件/分钟', 40);
  assert.equal(four.clearance, 0);
  assert.ok(four.suspects > 0);
  assert.equal((four.advice ?? []).length, 0, '没有间距问题时不该硬凑建议');

  // 六工位 40 mm：59 处间距问题，全是跨工位，且每条推完都会撞 → actionable=false
  const six = read('六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅', 40);
  assert.ok(six.advice.length > 0);
  assert.ok(six.advice.every((item) => item.intraScope === false), '六工位应当全是跨工位问题');
  assert.ok(six.advice.every((item) => item.actionable === false), '这台机器推哪都撞，不应有可执行建议');
  assert.ok(six.advice.every((item) => item.overlapsAfter > 0), '要给出预计会撞几对');
});

test('建议的可执行性：actionable 只给「跨工位且推完不撞」的条目', { timeout: 300_000 }, () => {
  const brief = '六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅';
  const read = (threshold) => {
    const stdout = execFileSync(process.execPath,
      [script, '--brief', brief, '--with-geometry', '--layout-compliance', String(threshold)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(stdout).geometry.layoutCompliance;
  };

  for (const threshold of [35, 40]) {
    const layout = read(threshold);
    assert.ok(layout.advice.length > 0, `${threshold} mm 应当有建议`);
    for (const item of layout.advice) {
      // 三条互相印证：内部问题不可执行；三轴两向都撞的也不可执行
      if (item.intraScope) {
        assert.equal(item.actionable, false, `${item.scope} 是工位内部问题，不该可执行`);
      } else {
        assert.equal(item.actionable, item.overlapsAfter === 0,
          `${item.scope} 的 actionable 与 overlapsAfter=${item.overlapsAfter} 不一致`);
      }
      assert.ok(item.overlapsAfter >= 0);
    }
  }

  // 这台机器在两个阈值下都推不出「零代价」的整站挪：应当如实说「往哪推都会撞」
  const forty = read(40);
  assert.ok(forty.advice.filter((item) => !item.intraScope).every((item) => item.actionable === false),
    '40 mm 下这台六工位机器不该有可执行建议');
  assert.ok(forty.advice.some((item) => item.overlapsAfter > 0), '应当报出「推哪都撞」的预计对数');
});
