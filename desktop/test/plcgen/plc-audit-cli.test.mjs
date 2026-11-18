import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const { convertLinkagePerStation } = await import('../../src/plcgen/per-station.ts');
const { planPlcGaps, repairPlcConfig } = await import('../../src/plcgen/machine-gaps.ts');

// CI「Qt client build」plc-audit-selftest 用的就是这个 brief（ci.yml: BRIEF=四工位点胶机）
const CI_BRIEF = '四工位点胶机，节拍 25 件/分钟';

const runAudit = (brief) => JSON.parse(execFileSync(process.execPath,
  ['scripts/machine-design-cli.mjs', '--brief', brief, '--with-geometry', '--plc-audit'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })).plcAudit;

// 端到端态一：CLI 真的生成出来了。多工位并行时间线**不被**当成一条串行程序，
// 而是按工位切片；聚合后每站的点位都有驱动、有到位等待，对账 0 缺口。
test('CLI --plc-audit：四工位并行联动按工位切片生成，逐站对账 0 缺口', () => {
  const audit = runAudit(CI_BRIEF);
  assert.equal(audit.conversionScope, 'per-station', '必须如实标注分工位转换，不得宣称整机时序等价');
  assert.equal(audit.stations, 4);
  assert.equal(audit.parallelStations, true);
  assert.equal(audit.projects, 4, '4 个工位 = 4 个分工位工程');
  assert.equal(audit.generated, true);
  assert.deepEqual(audit.generateErrors, []);
  assert.equal(audit.sequenceSteps, 4, '每站 1 步，合计 4 步（不是把 4 条并行时间线串成一条长程序）');
  assert.equal(audit.stationAudits.length, 4);
  for (const station of audit.stationAudits) {
    assert.equal(station.ok, true, `${station.stationId} 应生成成功`);
    assert.equal(station.steps, 1);
    assert.equal(station.pointsDriven, station.linkagePoints);
    assert.equal(station.pointsWithWait, station.linkagePoints, '每个点位都要有到位等待，不能立即转移');
    assert.equal(station.gaps, 0);
  }
  assert.equal(audit.audit.ok, true);
  assert.equal(audit.audit.linkagePoints, 4);
  assert.equal(audit.audit.pointsDriven, 4);
  assert.equal(audit.audit.pointsWithWait, 4);
  assert.equal(audit.audit.gaps.length, 0);
  assert.equal(audit.audit.safetyGate, true);
  assert.ok(audit.audit.limitations.some((line) => /per-station/i.test(line)), '聚合结论必须写明分工位口径');
  assert.equal(audit.files, 44, '11 个文件 × 4 个工位工程');
});

// 端到端态二：有一站转不出来时，CLI 必须给出 generated=false + 具体哪一站、为什么，
// 并且**不**输出半截 audit（否则 Qt 侧看到的对账数字会像是整机结论）。
test('CLI --plc-audit：任一站转换被拒 → generated=false、原因点名到工位、不给半截对账', () => {
  // 六工位 brief 里 st1 的气爪绑了两个都没有方向语义的传感器（工位检测 + 安全光栅），
  // 生成器拒绝猜方向 —— 这是「拒绝编造」，不是重叠守卫
  const audit = runAudit('六工位锁螺丝机，节拍 20 件/分钟，每工位 1 套汇川 750W 伺服 + 1 个 SMC 气爪 + 1 个到位检测 + 安全光栅');
  assert.equal(audit.generated, false);
  assert.equal(audit.conversionScope, 'per-station');
  assert.equal(audit.stations, 6);
  assert.equal(audit.generateErrors[0].code, 'UNSUPPORTED_LINKAGE_CONVERSION');
  assert.match(audit.generateErrors[0].message, /st1/, '原因必须点名到工位');
  assert.match(audit.generateErrors[0].message, /Ambiguous wait sensors/);
  assert.equal(audit.audit, undefined, '有站失败时不能给出聚合对账结果');
  const failed = audit.stationAudits.filter((station) => !station.ok);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].stationId, 'st1');
  assert.equal(failed[0].steps, 0);
  assert.equal(audit.stationAudits.filter((station) => station.ok).length, 5, '其余 5 站仍然照常生成（不因一站失败就整体放弃）');
});

// 重叠拒绝：站内时间线真重叠时仍然硬拒（linkage-program.ts 的守卫一个字没改）。
// 真实 brief 走不到这里 —— buildLinkage 站内本来就是串行；所以直接喂给 CLI 调用的同一个入口，
// 证明「切片」没有把守卫绕过去。
test('切片不绕过重叠守卫：站内重叠仍然拒绝转换', () => {
  const raw = {
    id: 'overlap', name: '重叠站',
    stations: ['工位1'],
    actuators: [{ id: 'st1-push', name: '工位1推料', station: '工位1', kind: 'cylinder', point: 'ST1-PUSH-A1', durationMs: 400 }],
    sensors: [{ point: 'ST1-PUSH-S1', part: 'st1-push', station: '工位1', role: 'extend' }]
  };
  // 与 CLI 同一条路径：先补缺口（急停/安全门），再做转换
  const config = repairPlcConfig(raw, planPlcGaps(raw)).config;
  const overlapping = {
    cycleMs: 1000,
    steps: [
      { actuatorId: 'st1-push', stationId: 'st1', kind: 'cylinder', startMs: 0, endMs: 600, io: ['ST1-PUSH-A1'], amount: 50, direction: 'extend' },
      { actuatorId: 'st1-push', stationId: 'st1', kind: 'cylinder', startMs: 400, endMs: 900, io: ['ST1-PUSH-A1'], amount: 50, direction: 'extend' }
    ]
  };
  const conversion = convertLinkagePerStation(overlapping, config);
  assert.equal(conversion.generated, false);
  assert.equal(conversion.sequenceSteps, 0);
  assert.equal(conversion.audit, undefined);
  assert.equal(conversion.stationAudits[0].ok, false);
  assert.equal(conversion.generateErrors[0].code, 'UNSUPPORTED_LINKAGE_CONVERSION');
  assert.match(conversion.generateErrors[0].message, /Overlapping linkage timeline|parallel scheduler/i);
  assert.match(conversion.generateErrors[0].message, /st1/, '拒绝原因要能定位到工位');
});

// 跨站并行不算重叠：把同一份时间线按站切开后，站与站之间时间重叠是正常的
test('跨站并行不触发重叠守卫：同一时刻两站各自动作仍能各自生成', () => {
  const raw = {
    id: 'parallel', name: '并行两站',
    stations: ['工位1', '工位2'],
    actuators: [
      { id: 'st1-push', name: '工位1推料', station: '工位1', kind: 'cylinder', point: 'ST1-PUSH-A1', durationMs: 400 },
      { id: 'st2-push', name: '工位2推料', station: '工位2', kind: 'cylinder', point: 'ST2-PUSH-A1', durationMs: 400 }
    ],
    sensors: [
      { point: 'ST1-PUSH-S1', part: 'st1-push', station: '工位1', role: 'extend' },
      { point: 'ST2-PUSH-S1', part: 'st2-push', station: '工位2', role: 'extend' }
    ]
  };
  const config = repairPlcConfig(raw, planPlcGaps(raw)).config;
  const parallel = {
    cycleMs: 900,
    steps: [
      { actuatorId: 'st1-push', stationId: 'st1', kind: 'cylinder', startMs: 0, endMs: 400, io: ['ST1-PUSH-A1'], amount: 50, direction: 'extend' },
      { actuatorId: 'st2-push', stationId: 'st2', kind: 'cylinder', startMs: 100, endMs: 500, io: ['ST2-PUSH-A1'], amount: 50, direction: 'extend' }
    ]
  };
  const conversion = convertLinkagePerStation(parallel, config);
  assert.equal(conversion.generated, true, JSON.stringify(conversion.generateErrors));
  assert.equal(conversion.stations, 2);
  assert.equal(conversion.sequenceSteps, 2);
  assert.equal(conversion.audit.linkagePoints, 2);
  assert.equal(conversion.audit.pointsDriven, 2);
  assert.equal(conversion.audit.gaps.length, 0);
});
