// 守住 machine-e2e step 14 的场景件数门禁：期望值必须来自被测机器**自己的** build payload。
// 背景（本次修复的回归）：移载机那一步曾把 PV 缓存机的 90/90 写死，而同一台机器实测 106 件，
// 跑到 step 14 必然抛错；门禁数字从别的工程抄来，本身也不构成证据。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSceneMatchesBuild,
  buildPartCount,
  sceneIntegrity
} from '../../src/cad/scene-integrity.ts';
import { BASELINE } from '../../scripts/pv-buffer-regenerate.mjs';

// 真实记录（machine-e2e step 11 顶升移载机，隔离复跑时打印的载荷形状）：
// MACHINE_E2E_STEP_11_OK transfer-build-model parts=106 loaded=106 colored=106 ...
const REAL_TRANSFER_BUILD = Object.freeze({ ok: true, parts: 106, loadedParts: 106, coloredParts: 106 });

test('真实 106 件移载机：期望件数取自 build payload，门禁通过', () => {
  assert.equal(buildPartCount(REAL_TRANSFER_BUILD), 106);
  assert.deepEqual(
    assertSceneMatchesBuild({ modelPartCount: 106, scenePartCount: 106, complete: true }, REAL_TRANSFER_BUILD),
    { modelPartCount: 106, scenePartCount: 106, complete: true }
  );
  // 旧实现写死 90：同一台 106 件的机器会被自己的门禁判死（这正是被修掉的回归）。
  assert.equal(sceneIntegrity({ modelPartCount: 106, scenePartCount: 106 }, 90).complete, false);
  assert.throws(
    () => assertSceneMatchesBuild({ modelPartCount: 106, scenePartCount: 106 }, { parts: 90 }),
    /expected 90\/90, got 106\/106/
  );
});

test('场景件数与期望不一致（106/105、空场景）必须拒', () => {
  assert.throws(
    () => assertSceneMatchesBuild({ modelPartCount: 106, scenePartCount: 105 }, REAL_TRANSFER_BUILD),
    /expected 106\/106, got 106\/105/
  );
  assert.throws(
    () => assertSceneMatchesBuild({}, REAL_TRANSFER_BUILD),
    /expected 106\/106, got 0\/0/
  );
  assert.throws(() => assertSceneMatchesBuild(null, REAL_TRANSFER_BUILD), /expected 106\/106/);
});

test('期望件数必须是严格正整数：缺失/0/负数/小数/字符串/NaN 一律拒', () => {
  const bad = [
    undefined,
    null,
    {},
    { parts: 0 },
    { parts: -106 },
    { parts: 1.5 },
    { parts: '106' },
    { parts: Number.NaN },
    { parts: Number.POSITIVE_INFINITY }
  ];
  for (const payload of bad) {
    assert.throws(
      () => buildPartCount(payload),
      /parts 必须是严格正整数/,
      `应拒绝 ${JSON.stringify(payload) ?? String(payload)}`
    );
  }
});

test('PV 独立 regen 仍按 90 判（BASELINE.parts），不被移载机改动带偏', () => {
  assert.equal(BASELINE.parts, 90);
  assert.equal(buildPartCount({ parts: BASELINE.parts }), 90);
  assert.doesNotThrow(() =>
    assertSceneMatchesBuild({ modelPartCount: 90, scenePartCount: 90 }, { parts: BASELINE.parts }));
  assert.throws(
    () => assertSceneMatchesBuild({ modelPartCount: 90, scenePartCount: 89 }, { parts: BASELINE.parts }),
    /expected 90\/90, got 90\/89/
  );
});
