// Equivalence guard for the joint-rule precomputation.
//
// `joints-baseline.ts` is the frozen pre-optimization implementation. Every
// case below compares the complete ordered array (including duplicate IDs and
// input order), not just a set of keys. The final test locks the complete
// interference/clearance reports captured before the optimization.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { declaredJoints } from '../../src/machine/joints.ts';
import { declaredJoints as baselineJoints } from '../../test-support/joints-baseline.ts';
import { screenInterference } from '../../src/machine/interference.ts';
import { screenClearance } from '../../src/machine/clearance.ts';
import { clearanceFixture } from '../../test-support/clearance-fixture.mjs';
import {
  REAL_MACHINE_BRIEFS,
  namedDenseJointFixture,
  namedJointFixture
} from '../../test-support/joints-fixture.mjs';
import { parseMachineBrief } from '../../src/machine/spec.ts';
import { synthMachine } from '../../src/machine/synth.ts';
import { resolveMachineGeometry } from '../../src/machine/machine-geometry.ts';

const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function assertSame(parts, label) {
  const before = structuredClone(parts);
  assert.deepEqual(declaredJoints(parts), baselineJoints(parts), label);
  assert.deepEqual(parts, before, `${label}: input must not be mutated`);
}

test('rule pairs keep both orientations and first-match reasons', () => {
  const cases = [
    ['frame-leg-7', 'frame-stringer-front', '立柱插横梁'],
    ['frame-leg-7', 'frame-top', '立柱接台面'],
    ['st3-upright-l', 'st3-plate', '工位立柱接底板'],
    ['st3-beam', 'st3-upright-r', '门架横梁接立柱'],
    ['act-1-mount', 'act-1-body', '执行机构接安装座'],
    ['conveyor-frame', 'conveyor-motor', '输送线组件']
  ];
  for (const [a, b, reason] of cases) {
    for (const ids of [[a, b], [b, a]]) {
      const parts = ids.map((id) => ({ id }));
      assertSame(parts, `${ids.join(' × ')}`);
      assert.deepEqual(declaredJoints(parts), [{ a: a < b ? a : b, b: a < b ? b : a, reason }]);
    }
  }
});

test('overlapping rule membership does not change the selected rule', () => {
  // `frame-leg-*` is the `a` side of both rules 0 and 1; the partner decides.
  // `*-upright-[lr]` is the `a` side of rule 2 and the `b` side of rule 3.
  const parts = [
    { id: 'frame-leg-2' },
    { id: 'frame-top' },
    { id: 'frame-stringer-x' },
    { id: 'st1-upright-l' },
    { id: 'st1-plate' },
    { id: 'st1-beam' }
  ];
  assertSame(parts, 'overlap');
  const byPair = new Map(declaredJoints(parts).map((joint) => [`${joint.a}|${joint.b}`, joint.reason]));
  assert.equal(byPair.get('frame-leg-2|frame-top'), '立柱接台面');
  assert.equal(byPair.get('frame-leg-2|frame-stringer-x'), '立柱插横梁');
  assert.equal(byPair.get('st1-plate|st1-upright-l'), '工位立柱接底板');
  assert.equal(byPair.get('st1-beam|st1-upright-l'), '门架横梁接立柱');
});

test('sensor brackets only join the same stem body, tx or rx', () => {
  const parts = [
    { id: 'sensor-st1-a-bracket' },
    { id: 'sensor-st1-a' },
    { id: 'sensor-st1-a-tx' },
    { id: 'sensor-st1-a-rx' },
    { id: 'sensor-st1-b-bracket' },
    { id: 'sensor-st1-b' },
    { id: 'sensor-st1-c' },
    { id: 'sensor-st1-a-extra' }
  ];
  assertSame(parts, 'sensor stems');
  const keys = new Set(declaredJoints(parts).map((joint) => [joint.a, joint.b].sort().join('|')));
  assert.equal(keys.has('sensor-st1-a|sensor-st1-a-bracket'), true);
  assert.equal(keys.has('sensor-st1-a-bracket|sensor-st1-a-tx'), true);
  assert.equal(keys.has('sensor-st1-a-bracket|sensor-st1-a-rx'), true);
  assert.equal(keys.has('sensor-st1-a-bracket|sensor-st1-b'), false);
  assert.equal(keys.has('sensor-st1-a-bracket|sensor-st1-c'), false);
  assert.equal(keys.has('sensor-st1-a-bracket|sensor-st1-a-extra'), false);
  assert.equal(keys.has('sensor-st1-a-bracket|sensor-st1-b-bracket'), false);
});

test('duplicate IDs stay duplicated and missing/non-string IDs keep old coercion', () => {
  assertSame([
    { id: 'frame-leg-1' },
    { id: 'frame-stringer-x' },
    { id: 'frame-leg-1' },
    { id: 'frame-stringer-x' },
    { id: 'frame-top' }
  ], 'duplicate IDs');
  const duplicate = declaredJoints([
    { id: 'frame-leg-1' },
    { id: 'frame-stringer-x' },
    { id: 'frame-leg-1' },
    { id: 'frame-stringer-x' }
  ]);
  assert.equal(duplicate.length, 4, 'every input-index pair must be emitted');
  assert.equal(new Set(duplicate.map((joint) => JSON.stringify(joint))).size, 1);

  assertSame([
    null,
    undefined,
    {},
    { id: null },
    { id: 12 },
    { id: 'sensor-x-bracket' },
    { id: 'sensor-x' },
    { id: 'sensor-x-rx' }
  ], 'coercion');
});

test('random inputs match the frozen baseline exactly', () => {
  let state = 0x5eed1234;
  const random = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const pool = [
    'frame-leg-1', 'frame-leg-22', 'frame-stringer-front', 'frame-top',
    'st1-upright-l', 'st1-upright-r', 'st1-plate', 'st2-beam',
    'act-1-mount', 'act-1-body', 'act-2-base', 'conveyor-frame',
    'conveyor-belt', 'conveyor-motor', 'sensor-a-bracket', 'sensor-a',
    'sensor-a-tx', 'sensor-a-rx', 'sensor-b-bracket', 'sensor-b',
    'sensor-b-tx', 'sensor-a-extra', 'upright', 'plate', 'beam', 'mount',
    'body', '', 'foo', 'frame-leg-1-upright-l', 'frame-leg-1-beam'
  ];
  for (let round = 0; round < 300; round += 1) {
    const count = Math.floor(random() * 36);
    const parts = [];
    for (let index = 0; index < count; index += 1) {
      const roll = random();
      if (roll < 0.04) parts.push(null);
      else if (roll < 0.07) parts.push({});
      else if (roll < 0.1) parts.push({ id: index });
      else parts.push({ id: pool[Math.floor(random() * pool.length)] });
    }
    assertSame(parts, `random round ${round}`);
  }
});

test('sparse, named and real machine samples match the frozen baseline', () => {
  for (const count of [0, 1, 2, 17, 80, 500]) {
    assertSame(clearanceFixture(count).parts, `sparse ${count}`);
    assertSame(namedJointFixture(count).parts, `named sparse ${count}`);
  }
  for (const count of [80, 120]) {
    assertSame(namedDenseJointFixture(count).parts, `named dense ${count}`);
  }
  for (const brief of REAL_MACHINE_BRIEFS) {
    const geometry = resolveMachineGeometry(synthMachine(parseMachineBrief(brief))).geometry;
    assertSame(geometry.parts, `real machine: ${brief}`);
  }
});

test('complete interference and clearance reports keep pre-optimization hashes', () => {
  // Captured with `joints-baseline.ts` mounted as production `machine/joints.ts`.
  const cases = [
    ['real screw', resolveMachineGeometry(synthMachine(parseMachineBrief(REAL_MACHINE_BRIEFS[0]))).geometry,
      'e2dbf49f9d971d1789db3ec8fdad96303fc28ca442f7d95c29963aff580df568',
      '25602e81e25b2f4f7195f4d677c91b39d10dc0406882899fe32053e43f2ef395'],
    ['real assembly', resolveMachineGeometry(synthMachine(parseMachineBrief(REAL_MACHINE_BRIEFS[1]))).geometry,
      '6a6f45b175b7df6151e19dab873dfb5825797e255debbe9252cd4867916a8e4f',
      '527880bd9d62842833737db853549e3dee6f79e003a86171104b398f623be25e'],
    ['real pv turner', resolveMachineGeometry(synthMachine(parseMachineBrief(REAL_MACHINE_BRIEFS[2]))).geometry,
      '3df79bc1552056771eca4901b0f950014db673fad9ae00bb08ac5b5ae9507935',
      '6f0ec94982a23793b1d1151cb743e460dac73d0409d172b3f65a9fd596ccce76'],
    ['real pv transfer', resolveMachineGeometry(synthMachine(parseMachineBrief(REAL_MACHINE_BRIEFS[3]))).geometry,
      'b6a688b85906f335d61341617b08f626b4c0c87e5cb03b0289ede0fa6b315b3a',
      '56a11b44c4fdc6de1ddc9d12bdb6f3dfa99be73d4e25f3371694d6cf19f08cd0'],
    ['named dense 120', namedDenseJointFixture(120),
      '5134d2b6cdbb72773d03471c23a839d939a7f515a636d93c436d3ff1367e8099',
      '6ddaf389779739c532552a1277480414d35a0d9bb8b5ace123599f5c8905a7a8']
  ];
  for (const [label, geometry, interferenceHash, clearanceHash] of cases) {
    const before = structuredClone(geometry);
    assert.equal(sha256(screenInterference(geometry)), interferenceHash, `${label}: interference`);
    assert.equal(sha256(screenClearance(geometry)), clearanceHash, `${label}: clearance`);
    assert.deepEqual(geometry, before, `${label}: input must not be mutated`);
  }
});
