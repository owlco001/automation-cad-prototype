// FeatureTree 校验：字段层 + 整树层，规则与契约第 2、4 节一致，
// 字段名、类型名与仓库 features.ts 保持一致（box/holes/counterbore/slot/fillet/cylinder）。
// 注意：本文件是契约服务的独立实现，仓库校验仍以 features.ts 为准；
// 两者规则漂移时以契约为准并以测试用例（tests.mjs）发现差异。

const TYPES = ['box', 'cylinder', 'holes', 'counterbore', 'slot', 'fillet'];
const TZ = /(?:Z|[+-]\d{2}:?\d{2})$/;

function isRec(v) { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function posNum(p, k, label, errs) {
  const v = p[k];
  if (v === undefined) { errs.push(`缺少必填参数：${label}.${k}`); return null; }
  if (!isNum(v) || v <= 0) { errs.push(`${label}：参数「${k}」必须大于 0`); return null; }
  return v;
}
function positionsOf(v) {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = [];
  for (const it of v) {
    if (!Array.isArray(it) || it.length !== 2 || !isNum(it[0]) || !isNum(it[1])) return null;
    out.push(it);
  }
  return out;
}
function plateOf(features) {
  let plate = null;
  for (const f of features) {
    if (!isRec(f) || f.type !== 'box' || f.suppressed === true) continue;
    const { length, width, height } = f.params || {};
    if (!isNum(length) || length <= 0 || !isNum(width) || width <= 0 || !isNum(height) || height <= 0) continue;
    const centered = f.params.centered !== false;
    const minX = centered ? -length / 2 : 0, minY = centered ? -width / 2 : 0;
    if (!plate) plate = { minX, maxX: minX + length, minY, maxY: minY + width, thickness: height };
    else plate.thickness = Math.min(plate.thickness, height);
  }
  return plate;
}

export function validateDoc(doc) {
  const errs = [];
  if (doc && doc.material !== undefined) {
    const allowed = ['steel', 'aluminum', 'stainless', 'brass'];
    if (typeof doc.material !== 'string' || !allowed.includes(doc.material)) {
      errs.push(`材料「${String(doc.material)}」不支持，可选：${allowed.join('/')}`);
    }
  }
  if (!isRec(doc) || !Array.isArray(doc.features)) return ['特征树格式无效：features 必须是数组'];
  const feats = doc.features;
  if (feats.length === 0) errs.push('特征树为空，至少需要一个特征');
  const ids = new Map();
  const plate = plateOf(feats);
  feats.forEach((f, i) => {
    if (!isRec(f)) { errs.push(`第 ${i + 1} 个特征：必须是对象`); return; }
    const label = `第 ${i + 1} 个特征（${typeof f.name === 'string' && f.name.trim() ? f.name.trim() : '未命名'}）`;
    const id = typeof f.id === 'string' ? f.id.trim() : '';
    if (!id) errs.push(`缺少必填参数：${label}.id`);
    else if (ids.has(id)) errs.push(`${label}：id「${id}」与第 ${ids.get(id) + 1} 个特征重复`);
    else ids.set(id, i);
    if (!TYPES.includes(f.type)) { errs.push(`${label}：未知特征类型「${String(f.type ?? '')}」`); return; }
    const p = isRec(f.params) ? f.params : {};
    if (!isRec(f.params)) errs.push(`${label}：参数 params 必须是对象`);
    if (f.type === 'box') {
      posNum(p, 'length', label, errs); posNum(p, 'width', label, errs); posNum(p, 'height', label, errs);
      if (p.centered !== undefined && typeof p.centered !== 'boolean') errs.push(`${label}：参数「centered」必须是布尔值`);
    } else if (f.type === 'cylinder') {
      posNum(p, 'diameter', label, errs); posNum(p, 'height', label, errs);
      if (p.at !== undefined && (!Array.isArray(p.at) || p.at.length !== 3 || !p.at.every(isNum))) errs.push(`${label}：参数「at」必须是 3 个数字组成的数组`);
    } else if (f.type === 'holes') {
      const d = posNum(p, 'diameter', label, errs);
      const pos = positionsOf(p.positions);
      if (p.positions === undefined) errs.push(`缺少必填参数：${label}.positions`);
      else if (pos === null) errs.push(`${label}：参数「positions」必须是 [x, y] 二元数组`);
      if (p.depth !== undefined && p.depth !== 'through' && !(isNum(p.depth) && p.depth > 0)) errs.push(`${label}：参数「depth」必须是 through 或大于 0 的数字`);
      if (pos && plate) {
        const out = pos.find(([x, y]) => x < plate.minX || x > plate.maxX || y < plate.minY || y > plate.maxY);
        if (out) errs.push(`${label}：孔 (${out[0]}, ${out[1]}) 在底板包围盒外`);
      }
      if (pos && d !== null) {
        for (let a = 0; a < pos.length; a++) for (let b = a + 1; b < pos.length; b++) {
          if (Math.hypot(pos[a][0] - pos[b][0], pos[a][1] - pos[b][1]) < d) errs.push(`${label}：孔间距小于孔径 ${d} mm`);
        }
      }
    } else if (f.type === 'counterbore') {
      const d = posNum(p, 'diameter', label, errs);
      const cb = posNum(p, 'cbDiameter', label, errs);
      const cbd = posNum(p, 'cbDepth', label, errs);
      const pos = positionsOf(p.positions);
      if (p.positions === undefined) errs.push(`缺少必填参数：${label}.positions`);
      else if (pos === null) errs.push(`${label}：参数「positions」必须是 [x, y] 二元数组`);
      if (p.depth !== undefined && p.depth !== 'through' && !(isNum(p.depth) && p.depth > 0)) errs.push(`${label}：参数「depth」必须是 through 或大于 0 的数字`);
      if (d !== null && cb !== null && cb <= d) errs.push(`${label}：沉头直径 ${cb} mm 必须大于通孔直径 ${d} mm`);
      if (cbd !== null && plate && cbd >= plate.thickness) errs.push(`${label}：沉头深 ${cbd} mm 不小于板厚 ${plate.thickness} mm，会切穿板面`);
    } else if (f.type === 'slot') {
      posNum(p, 'length', label, errs); posNum(p, 'width', label, errs);
    } else if (f.type === 'fillet') {
      const r = posNum(p, 'radius', label, errs);
      if (p.edges !== undefined && p.edges !== '|Z' && p.edges !== 'all') errs.push(`${label}：参数「edges」必须是 |Z 或 all`);
      if (r !== null && plate && r > plate.thickness / 2) errs.push(`${label}：圆角半径 ${r} mm 超过最小板厚 ${plate.thickness} mm 的一半`);
    }
  });
  // 基体约束（契约第 2 节：孔/沉头/圆角都作用在板体上）：
  // 没有 box 的树几何上无从谈起，必须在校验层拦住，不能靠下游 compileOps 才发现。
  const bodyTypes = ['holes', 'counterbore', 'fillet'];
  const bodies = feats.filter((f) => isRec(f) && f.type === 'box' && f.suppressed !== true);
  if (bodies.length === 0) {
    const orphans = feats.filter((f) => isRec(f) && bodyTypes.includes(f.type) && f.suppressed !== true);
    if (orphans.length > 0) {
      errs.push(`缺少基体：${orphans.map((f) => `${f.type}「${typeof f.id === 'string' ? f.id : '?'}」`).join('、')} 需要至少一个 box 板体`);
    }
  }
  if (typeof doc.updatedAt !== 'string' || !TZ.test(doc.updatedAt) || Number.isNaN(Date.parse(doc.updatedAt))) {
    errs.push('updatedAt 必须带时区（如 2026-10-23T12:00:00+08:00）');
  }
  return errs;
}

// 单字段面板编辑校验（契约第 4 节字段层；count 不可直接改；未知字段拒绝）。
export function checkPanelEdit(feature, key, value) {
  if (key === 'count') return '孔数由孔位阵列决定，不可直接改';
  const pos = (label) => (typeof value === 'number' && Number.isFinite(value) && value > 0) ? null : `${label}必须是大于 0 的数`;
  switch (key) {
    case 'length': return pos('长度');
    case 'width': return pos('宽度');
    case 'height': return pos('高度');
    case 'diameter': {
      const e = pos('孔径'); if (e) return e;
      if (typeof feature.params.cbDiameter === 'number' && value >= feature.params.cbDiameter) return '孔径必须小于沉窝直径';
      return null;
    }
    case 'cbDiameter': {
      const e = pos('沉窝直径'); if (e) return e;
      if (typeof feature.params.diameter === 'number' && value <= feature.params.diameter) return '沉窝直径必须大于孔径';
      return null;
    }
    case 'cbDepth': return pos('沉窝深度');
    case 'radius': return pos('圆角半径');
    default: return `未知字段：${key}`;
  }
}

// 编译算子（suppressed 跳过；与仓库 compileOps 白名单一致）。
export function compileOps(doc) {
  const ops = [];
  for (const f of doc.features) {
    if (f.suppressed === true) continue;
    const p = f.params || {};
    if (f.type === 'box') ops.push({ op: 'box', length: p.length, width: p.width, height: p.height });
    else if (f.type === 'cylinder') ops.push({ op: 'cylinder', diameter: p.diameter, height: p.height });
    else if (f.type === 'holes') ops.push({ op: 'holes', diameter: p.diameter, positions: p.positions, depth: p.depth });
    else if (f.type === 'counterbore') ops.push({ op: 'counterbore', diameter: p.diameter, cbDiameter: p.cbDiameter, cbDepth: p.cbDepth, positions: p.positions });
    else if (f.type === 'slot') ops.push({ op: 'slot', length: p.length, width: p.width });
    else if (f.type === 'fillet') ops.push({ op: 'fillet', radius: p.radius, edges: p.edges });
  }
  return ops;
}
