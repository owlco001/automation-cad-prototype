export interface SceneIntegrityCounts {
  modelPartCount?: unknown;
  scenePartCount?: unknown;
}

export interface SceneIntegrityResult {
  modelPartCount: number;
  scenePartCount: number;
  complete: boolean;
}

/** Normalize viewer diagnostics and require both counts to be finite, non-negative integers. */
export function sceneIntegrity(
  scene: SceneIntegrityCounts | null | undefined,
  expectedCount?: number
): SceneIntegrityResult {
  const modelPartCount = scene?.modelPartCount;
  const scenePartCount = scene?.scenePartCount;
  const validCounts = typeof modelPartCount === 'number'
    && Number.isInteger(modelPartCount)
    && modelPartCount >= 0
    && typeof scenePartCount === 'number'
    && Number.isInteger(scenePartCount)
    && scenePartCount >= 0;
  const expected = expectedCount === undefined
    ? true
    : Number.isInteger(expectedCount) && expectedCount >= 0;
  return {
    modelPartCount: validCounts ? modelPartCount : 0,
    scenePartCount: validCounts ? scenePartCount : 0,
    complete: validCounts && expected && modelPartCount === scenePartCount
      && (expectedCount === undefined || modelPartCount === expectedCount)
  };
}

export function assertSceneIntegrity(
  scene: SceneIntegrityCounts | null | undefined,
  expectedCount: number
): SceneIntegrityResult {
  const result = sceneIntegrity(scene, expectedCount);
  if (!result.complete) {
    throw new Error(
      `Scene integrity gate failed: expected ${expectedCount}/${expectedCount}, `
      + `got ${result.modelPartCount}/${result.scenePartCount}`
    );
  }
  return result;
}

export interface BuildPartPayload {
  parts?: unknown;
}

/**
 * 从被测对象自己的 `build_machine_model` 返回里取期望件数。
 *
 * 必须是严格正整数：缺失、0、负数、小数、字符串一律抛错。门禁的期望值只能来自
 * 当前这次构建，不能从别的工程抄常数（把 90 写进 106 件的移载机就是这么错的）。
 */
export function buildPartCount(build: unknown): number {
  const parts = (build as BuildPartPayload | null | undefined)?.parts;
  if (typeof parts !== 'number' || !Number.isInteger(parts) || parts <= 0) {
    throw new Error(
      `build payload 的 parts 必须是严格正整数，实际 ${JSON.stringify(parts) ?? 'undefined'}`
    );
  }
  return parts;
}

/**
 * 场景完整性门禁：期望件数取自 build payload，并要求 modelPartCount === scenePartCount === expected。
 * 期望值本身非法（见 buildPartCount）属于脚本/载荷错误，直接抛，不当成场景缺件。
 */
export function assertSceneMatchesBuild(
  scene: SceneIntegrityCounts | null | undefined,
  build: unknown
): SceneIntegrityResult {
  return assertSceneIntegrity(scene, buildPartCount(build));
}
