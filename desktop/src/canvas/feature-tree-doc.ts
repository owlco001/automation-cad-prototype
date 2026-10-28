// UI 重构第 1 步收尾（机械侧 only）：文档级操作。
//
// 特征树上的操作，最终都要落到 FeatureDoc 上，而不是 UI 自己的副本：
//   - 拖动排序 = 改 features 数组顺序（顺序即建模顺序）；
//   - 压缩/解除压缩 = 改 FeatureNode.suppressed；
//   - 面板编辑 = 按 id 找到特征，调用 feature-tree-edit.ts 的校验写回。
// 全部返回新文档，原文档不动——撤销/重做只需要保存改前改后两份文档。
// 电气侧不在本模块，不处理 IO、柜体、电气标签页。

import { applyPanelEdit, type EditResult } from './feature-tree-edit.ts';

export interface FeatureNodeLike {
  id: string;
  type: string;
  name: string;
  params: Record<string, unknown>;
  suppressed?: boolean;
}

export interface FeatureDocLike {
  schemaVersion: 1;
  sourceFile?: string;
  features: FeatureNodeLike[];
  updatedAt: string;
}

function findIndex(doc: FeatureDocLike, id: string): number {
  return doc.features.findIndex((feature) => feature.id === id);
}

/** 把特征移到目标下标（越界下标会被夹到合法范围），原文档不动。 */
export function reorderFeature(doc: FeatureDocLike, id: string, targetIndex: number): EditResult<FeatureDocLike> {
  const from = findIndex(doc, id);
  if (from === -1) return { ok: false, error: `找不到特征：${id}` };
  const features = [...doc.features];
  const moved = features.splice(from, 1)[0];
  if (!moved) return { ok: false, error: `找不到特征：${id}` };
  // targetIndex 是"移动后的最终下标"：先摘出再按原坐标夹取，移下去时正好落在期望位置
  const clamped = Math.max(0, Math.min(targetIndex, features.length));
  features.splice(clamped, 0, moved);
  return { ok: true, value: { ...doc, features } };
}

/** 压缩/解除压缩：suppressed 取反，原文档不动。 */
export function toggleSuppressed(doc: FeatureDocLike, id: string): EditResult<FeatureDocLike> {
  const index = findIndex(doc, id);
  if (index === -1) return { ok: false, error: `找不到特征：${id}` };
  const features = doc.features.map((feature, i) =>
    i === index ? { ...feature, suppressed: feature.suppressed !== true } : feature
  );
  return { ok: true, value: { ...doc, features } };
}

/** 按 id 对单个特征做面板编辑（校验规则见 feature-tree-edit.ts），原文档不动。 */
export function applyDocFeatureEdit(
  doc: FeatureDocLike,
  id: string,
  key: string,
  value: unknown
): EditResult<FeatureDocLike> {
  const index = findIndex(doc, id);
  const target = index === -1 ? undefined : doc.features[index];
  if (!target) return { ok: false, error: `找不到特征：${id}` };
  const result = applyPanelEdit(target, key, value);
  const next = result.value;
  if (!result.ok || next === undefined) return { ok: false, error: result.error ?? '校验失败' };
  const features = doc.features.map((feature, i) => (i === index ? next : feature));
  return { ok: true, value: { ...doc, features } };
}
