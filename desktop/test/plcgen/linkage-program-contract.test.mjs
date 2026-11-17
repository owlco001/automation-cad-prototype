import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSequenceFromLinkage, auditLinkageVsProgram, linkageFromConfig } from '../../src/plcgen/linkage-program.ts';

const config = { id: 'contract', name: 'contract', actuators: [{ id: 'a', name: 'A', extendPoint: 'EXT', retractPoint: 'RET' }], sensors: [] };
const step = (extra = {}) => ({ actuatorId: 'a', stationId: 's', kind: 'cylinder', startMs: 0, endMs: 100, io: ['EXT'], amount: 10, ...extra });
const linkage = (steps = [step()], extra = {}) => ({ cycleMs: 200, steps, ...extra });
const points = (usage = [{ stepNo: 1, usage: 'set' }]) => [{ point: 'EXT', variable: 'Extend', stepUsage: usage }];
const safeText = '"DB_IO".Extend := TRUE; IF SafeStop THEN "DB_IO".Extend := FALSE; END_IF;';

test('geometry with both opposed outputs must state a direction before conversion', () => {
  assert.throws(() => buildSequenceFromLinkage(linkage([step({ io: ['EXT', 'RET'] })]), config), /ambiguous|direction/i);
  const [extend] = buildSequenceFromLinkage(linkage([step({ io: ['EXT', 'RET'], direction: 'extend' })]), config);
  assert.deepEqual(extend.sets, ['EXT']);
  assert.deepEqual(extend.resets, ['RET']);
  const [retract] = buildSequenceFromLinkage(linkage([step({ io: ['EXT', 'RET'], action: 'retract' })]), config);
  assert.deepEqual(retract.sets, ['RET']);
  assert.deepEqual(retract.resets, ['EXT']);
});

test('single-direction steps reset the opposite latched coil on reversal', () => {
  const steps = buildSequenceFromLinkage(linkage([step(), step({ io: ['RET'], startMs: 100, endMs: 200 })]), config);
  assert.deepEqual(steps[0].resets, ['RET']);
  assert.deepEqual(steps[1].resets, ['EXT']);
});

test('unknown multiple outputs and contradictory direction fail explicitly', () => {
  assert.throws(() => buildSequenceFromLinkage(linkage([step({ io: ['X', 'Y'] })]), config), /ambiguous/i);
  assert.throws(() => buildSequenceFromLinkage(linkage([step({ action: 'extend', direction: 'retract' })]), config), /conflict|contradict/i);
});

test('overlap cannot silently become serial even with an explicit serial declaration', () => {
  const parallel = linkage([step(), step({ startMs: 50, endMs: 150 })]);
  assert.throws(() => buildSequenceFromLinkage(parallel, config), /overlap|parallel|scheduler/i);
  assert.throws(() => buildSequenceFromLinkage({ ...parallel, execution: 'serial' }, config), /overlap|parallel|scheduler/i);
  assert.throws(() => buildSequenceFromLinkage(parallel, config, { execution: 'serial' }), /overlap|parallel|scheduler/i);
});

test('direction-specific sensors avoid impossible opposing-limit AND waits', () => {
  const dualSensors = { ...config, sensors: [
    { part: 'a', point: 'EXT_OK', role: 'extend' },
    { part: 'a', point: 'RET_OK', role: 'retract' }
  ] };
  assert.deepEqual(buildSequenceFromLinkage(linkage(), dualSensors)[0].waits, ['EXT_OK']);
  assert.deepEqual(buildSequenceFromLinkage(linkage(), { ...config, sensors: [dualSensors.sensors[1]] })[0].waits, []);
  const unlabelled = { ...config, sensors: dualSensors.sensors.map(({ role, ...sensor }) => sensor) };
  assert.throws(() => buildSequenceFromLinkage(linkage(), unlabelled), /ambiguous wait/i);
  assert.deepEqual(buildSequenceFromLinkage(linkage([step({ waitPoints: ['EXT_OK'] })]), unlabelled)[0].waits, ['EXT_OK']);
});

test('config derivation selects unique semantic action-side sensor, never first sensor', () => {
  const singleDrive = { ...config, actuators: [{ id: 'a', name: 'A', point: 'CMD', kind: 'cylinder' }], sensors: [
    { point: 'DOWN', part: 'a', role: 'retracted' },
    { point: 'UP', part: 'a', role: 'extended' }
  ] };
  const derived = linkageFromConfig(singleDrive);
  assert.deepEqual(derived.steps[0].waits, ['UP']);
  assert.deepEqual(derived.withoutSensor, []);
  assert.deepEqual(buildSequenceFromLinkage(derived.linkage, singleDrive), derived.steps);
  const ambiguous = linkageFromConfig({ ...singleDrive, sensors: singleDrive.sensors.map(({ role, ...s }) => s) });
  assert.deepEqual(ambiguous.steps[0].waits, []);
  assert.deepEqual(ambiguous.withoutSensor, ['a']);
  const duplicateRole = linkageFromConfig({ ...singleDrive, sensors: singleDrive.sensors.map(s => ({ ...s, role: 'extended' })) });
  assert.deepEqual(duplicateRole.steps[0].waits, []);
});

test('typed condition/reset usage does not count as energized output', () => {
  for (const usage of ['condition', 'reset']) {
    const audit = auditLinkageVsProgram(linkage(), points([{ stepNo: 1, usage }]), safeText, 1, [{ stepNo: 1, sets: [], resets: usage === 'reset' ? ['EXT'] : [], waits: ['IN'], condition: 'IN' }]);
    assert.equal(audit.pointsDriven, 0);
    assert.ok(audit.gaps.some(g => g.kind === 'point-not-driven'));
  }
});

test('structured waits determine coverage; driven outputs with immediate transitions report no-wait', () => {
  const immediate = [{ stepNo: 1, sets: ['EXT'], resets: [], waits: [], condition: 'TRUE' }];
  const audit = auditLinkageVsProgram(linkage(), points(), safeText, 1, immediate);
  assert.equal(audit.pointsDriven, 1);
  assert.equal(audit.pointsWithWait, 0);
  assert.ok(audit.gaps.some(g => g.kind === 'no-wait'));
  const waited = auditLinkageVsProgram(linkage(), points(), safeText, { programStepCount: 1, sequence: [{ ...immediate[0], waits: ['IN'], condition: '"DB_IO".Input' }] });
  assert.equal(waited.pointsWithWait, 1);
  assert.equal(waited.ok, true);
});

test('every drive occurrence needs a wait and omitted metadata cannot prove one', () => {
  const repeated = linkage([step(), step({ startMs: 100, endMs: 200 })]);
  const audit = auditLinkageVsProgram(repeated, points([{ stepNo: 1, usage: 'set' }, { stepNo: 2, usage: 'set' }]), safeText, 2, [
    { stepNo: 1, sets: ['EXT'], waits: ['IN'], condition: 'IN' },
    { stepNo: 2, sets: ['EXT'], waits: [], condition: 'TRUE' }
  ]);
  assert.equal(audit.pointsWithWait, 0);
  assert.ok(audit.gaps.some(g => g.kind === 'no-wait'));
  assert.equal(auditLinkageVsProgram(linkage(), points(), safeText, 1).pointsWithWait, 0);
});

test('zero generated steps mismatch nonempty linkage', () => {
  assert.ok(auditLinkageVsProgram(linkage(), points(), safeText, 0, []).gaps.some(g => g.kind === 'step-count-mismatch'));
});

test('SafeStop comments, declarations and unrelated reset blocks cannot verify gate coverage', () => {
  for (const text of ['// SafeStop\n"DB_IO".Extend := TRUE;', '(* IF SafeStop THEN "DB_IO".Extend := FALSE; END_IF; *)', 'SafeStop : BOOL;', 'IF SafeStop THEN "DB_IO".Other := FALSE; END_IF;', 'IF SafeStop THEN IF FALSE THEN "DB_IO".Extend := FALSE; END_IF; END_IF;']) {
    const audit = auditLinkageVsProgram(linkage(), points(), text, 1, [{ stepNo: 1, sets: ['EXT'], waits: ['IN'] }]);
    assert.equal(audit.safetyGate, false, text);
    assert.ok(audit.gaps.some(g => g.kind === 'no-safety-gate'));
  }
});
