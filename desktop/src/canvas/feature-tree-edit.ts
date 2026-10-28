// UI 重构第 1 步再迭代（机械侧 only）：属性面板的编辑校验与写回。
//
// 上一步只读绑定（树可看、面板可看）已经落地，这一步把面板
// 从“可看”推进到“可改”，但仍然只在模型层：
//   applyPanelEdit(feature, key, value) -> 新的 FeatureNode（原对象不动）
//   applyAdapterEdit(adapterParams, key, value) -> 新的 AdapterParams（原对象不动）
// 返回原对象不动，是为了让后续的命令历史（撤销/重做）
// 能用“改前对象 / 改后对象”这一对快照入栈，不需要另建副本机制。
//
// 校验规则（单位 mm，全部在写回前拦住，失败返回 error，不改原对象）：
//   长度类（box 长宽高、孔径、沉窝直径/深度、圆角半径、板厚、端口孔径）必须 > 0；
//   孔距 >= 0（单孔时为 0）；孔数必须是 >= 1 的整数；定位销孔直径 >= 0（0 = 不设）；
//   沉窝直径必须 > 孔径；材料必须是非空字符串；沉头必须是布尔值；
//   孔数（holes 的 count）是孔位阵列的派生值，不可直接改——改孔数请改孔位阵列；
//   未知字段一律拒绝，不猜、不静默丢弃。
// 电气侧不在本模块：不处理 IO、柜体、电气标签页的任何字段。

export interface EditResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

/**
 * 校验器结果用可判别联合，而不是 EditResult<number>：
 * 后者在 ok=false 时 value 是 number 类型，赋给 EditResult<Params> 会被
 * exactOptionalPropertyTypes 判成类型不兼容；联合里失败分支根本没有 value 字段。
 */
type Check<T> = { ok: true; value: T } | { ok: false; error: string };

type Params = Record<string, unknown>;

function fail<T>(error: string): Check<T> {
  return { ok: false, error };
}

function positiveNumber(value: unknown, label: string): Check<number> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fail(`${label}必须是大于 0 的数`);
  }
  return { ok: true, value };
}

function nonNegativeNumber(value: unknown, label: string): Check<number> {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fail(`${label}必须是不小于 0 的数`);
  }
  return { ok: true, value };
}

function positiveInteger(value: unknown, label: string): Check<number> {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return fail(`${label}必须是大于等于 1 的整数`);
  }
  return { ok: true, value };
}

/** 特征面板字段 -> 校验器（key 是 panelFieldsForFeature 的 key）。 */
const FEATURE_EDITORS: Record<string, (params: Params, value: unknown) => EditResult<Params>> = {
  length: (params, value) => {
    const checked = positiveNumber(value, '长度');
    return checked.ok ? { ok: true, value: { ...params, length: checked.value } } : checked;
  },
  width: (params, value) => {
    const checked = positiveNumber(value, '宽度');
    return checked.ok ? { ok: true, value: { ...params, width: checked.value } } : checked;
  },
  height: (params, value) => {
    const checked = positiveNumber(value, '高度');
    return checked.ok ? { ok: true, value: { ...params, height: checked.value } } : checked;
  },
  diameter: (params, value) => {
    const checked = positiveNumber(value, '孔径');
    if (!checked.ok) return checked;
    const cbDiameter = params.cbDiameter;
    if (typeof cbDiameter === 'number' && checked.value >= cbDiameter) {
      return fail('孔径必须小于沉窝直径');
    }
    return { ok: true, value: { ...params, diameter: checked.value } };
  },
  cbDiameter: (params, value) => {
    const checked = positiveNumber(value, '沉窝直径');
    if (!checked.ok) return checked;
    const diameter = params.diameter;
    if (typeof diameter === 'number' && checked.value <= diameter) {
      return fail('沉窝直径必须大于孔径');
    }
    return { ok: true, value: { ...params, cbDiameter: checked.value } };
  },
  cbDepth: (params, value) => {
    const checked = positiveNumber(value, '沉窝深度');
    return checked.ok ? { ok: true, value: { ...params, cbDepth: checked.value } } : checked;
  },
  radius: (params, value) => {
    const checked = positiveNumber(value, '圆角半径');
    return checked.ok ? { ok: true, value: { ...params, radius: checked.value } } : checked;
  }
};

export function applyPanelEdit(
  feature: { id: string; type: string; name: string; params: Params; suppressed?: boolean },
  key: string,
  value: unknown
): EditResult<typeof feature> {
  if (key === 'count') {
    return fail('孔数由孔位阵列决定，不可直接改');
  }
  const editor = FEATURE_EDITORS[key];
  if (!editor) return fail(`未知字段：${key}`);
  const result = editor(feature.params, value);
  if (!result.ok || result.value === undefined) return fail(result.error ?? '校验失败');
  return { ok: true, value: { ...feature, params: result.value } };
}

export interface AdapterParamsLike {
  fromPort: { family: string; holeDiaMm: number; pitchXMm: number; pitchYMm: number; count: number };
  toPort: { family: string; holeDiaMm: number; pitchXMm: number; pitchYMm: number; count: number };
  plateDimsMm: [number, number, number];
  thicknessMm: number;
  material: string;
  counterBore: boolean;
  dowelDiaMm: number;
  massKg: number;
  costYuan: number | null;
}

export function applyAdapterEdit(
  adapterParams: AdapterParamsLike,
  key: string,
  value: unknown
): EditResult<AdapterParamsLike> {
  const [head, field] = key.split('.');
  if ((head === 'fromPort' || head === 'toPort') && field) {
    const port = adapterParams[head];
    if (field === 'holeDiaMm') {
      const checked = positiveNumber(value, '孔径');
      return checked.ok ? { ok: true, value: { ...adapterParams, [head]: { ...port, holeDiaMm: checked.value } } } : checked;
    }
    if (field === 'pitchXMm' || field === 'pitchYMm') {
      const checked = nonNegativeNumber(value, '孔距');
      return checked.ok ? { ok: true, value: { ...adapterParams, [head]: { ...port, [field]: checked.value } } } : checked;
    }
    if (field === 'count') {
      const checked = positiveInteger(value, '孔数');
      return checked.ok ? { ok: true, value: { ...adapterParams, [head]: { ...port, count: checked.value } } } : checked;
    }
    return fail(`未知字段：${key}`);
  }
  if (key === 'thicknessMm') {
    const checked = positiveNumber(value, '板厚');
    return checked.ok ? { ok: true, value: { ...adapterParams, thicknessMm: checked.value } } : checked;
  }
  if (key === 'dowelDiaMm') {
    const checked = nonNegativeNumber(value, '定位销孔直径');
    return checked.ok ? { ok: true, value: { ...adapterParams, dowelDiaMm: checked.value } } : checked;
  }
  if (key === 'material') {
    if (typeof value !== 'string' || value.trim() === '') return fail('材料必须是非空字符串');
    return { ok: true, value: { ...adapterParams, material: value } };
  }
  if (key === 'counterBore') {
    if (typeof value !== 'boolean') return fail('沉头必须是布尔值');
    return { ok: true, value: { ...adapterParams, counterBore: value } };
  }
  return fail(`未知字段：${key}`);
}
