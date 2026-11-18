import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSceneIntegrity, sceneIntegrity } from '../../src/cad/scene-integrity.ts';

test('scene integrity accepts the formal 90/90 completeness gate', () => {
  assert.deepEqual(sceneIntegrity({ modelPartCount: 90, scenePartCount: 90 }, 90), {
    modelPartCount: 90,
    scenePartCount: 90,
    complete: true
  });
  assert.doesNotThrow(() => assertSceneIntegrity({ modelPartCount: 90, scenePartCount: 90 }, 90));
});

test('scene integrity rejects mismatched counts and wrong expected totals', () => {
  assert.equal(sceneIntegrity({ modelPartCount: 90, scenePartCount: 89 }, 90).complete, false);
  assert.equal(sceneIntegrity({ modelPartCount: 89, scenePartCount: 89 }, 90).complete, false);
  assert.throws(
    () => assertSceneIntegrity({ modelPartCount: 90, scenePartCount: 89 }, 90),
    /expected 90\/90, got 90\/89/
  );
});

test('scene integrity does not treat missing or invalid counts as complete', () => {
  assert.equal(sceneIntegrity({}, 90).complete, false);
  assert.equal(sceneIntegrity({ modelPartCount: '90', scenePartCount: 90 }, 90).complete, false);
  assert.equal(sceneIntegrity({ modelPartCount: -1, scenePartCount: -1 }, 90).complete, false);
  assert.equal(sceneIntegrity({ modelPartCount: 90.5, scenePartCount: 90.5 }, 90).complete, false);
});
