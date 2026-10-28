// UI 重构第 1 步迭代（机械侧 only）：特征树与属性面板的渲染层。
//
// 分工：feature-tree.ts 负责“树长什么样、面板列哪些字段”，
// 本模块只负责“把它们画成 HTML 字符串”。workbench.ts 后续只需
// 把这两个字符串写进左侧树容器和右侧面板容器，再把点击事件
// 按 data-tree-id 回传给 findTreeNode，整段接入是一次小改动，
// 不需要重写 workbench.ts（约 99 KB，整文件推送受限）。
//
// 为什么是 HTML 字符串而不是直接操作 DOM：
// 1) 本模块在 node --test 下可直接验证（Electron 的 DOM 环境无法跑测试）；
// 2) 不引入任何 DOM 依赖，渲染结果与 workbench 的挂载方式解耦；
// 3) 电气侧不在本模块：只渲染机械特征树与机械属性面板。
//
// 仍不做：编辑输入（本步只读绑定，输入框与写回是下一步）、
// 拖拽排序（只渲染顺序，改顺序仍走后续的命令历史入口）。

import type { FeatureTreeNode, PanelField } from './feature-tree.ts';

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatValue(field: PanelField): string {
  if (typeof field.value === 'boolean') return field.value ? '是' : '否';
  if (field.value === null || field.value === undefined) return '—';
  return `${String(field.value)}${field.unit ? ` ${field.unit}` : ''}`;
}

function renderNode(node: FeatureTreeNode, selectedId: string | null): string {
  const classes = ['tree-node', `tree-node--${node.kind}`];
  if (node.suppressed) classes.push('tree-node--suppressed');
  if (node.id === selectedId) classes.push('tree-node--selected');
  const typeLabel = node.displayType ? ` <span class="tree-node-type">${escapeHtml(node.displayType)}</span>` : '';
  const children = (node.children ?? [])
    .map((child) => renderNode(child, selectedId))
    .join('');
  const childrenHtml = children ? `<ul class="tree-children">${children}</ul>` : '';
  return (
    `<li class="${classes.join(' ')}" data-tree-id="${escapeHtml(node.id)}">` +
    `<span class="tree-node-label">${escapeHtml(node.label)}</span>${typeLabel}` +
    `${childrenHtml}</li>`
  );
}

/** 特征树 -> HTML：根节点本身渲染为一行，其子节点为树体。 */
export function renderFeatureTreeHtml(root: FeatureTreeNode, selectedId: string | null = null): string {
  return `<ul class="feature-tree">${renderNode(root, selectedId)}</ul>`;
}

/** 可直接编辑的字段：数字/布尔/字符串；派生值（如孔数 count）只读。 */
export function isEditableField(field: PanelField): boolean {
  if (field.key === 'count') return false;
  return typeof field.value === 'number' || typeof field.value === 'boolean' || typeof field.value === 'string';
}

export interface PanelRenderOptions {
  /** true 时把可编辑字段渲染成输入框（挂载层用 change 事件写回） */
  editable?: boolean;
}

/** 属性面板 -> HTML：标题 + 字段表，字段名与 feature-tree.ts 的 PanelField 一一对应。 */
export function renderPanelHtml(title: string, fields: PanelField[], options: PanelRenderOptions = {}): string {
  const rows = fields
    .map((field) => {
      const key = escapeHtml(field.key);
      const head = `<th>${escapeHtml(field.label)}</th>`;
      if (!options.editable || !isEditableField(field)) {
        return `<tr data-panel-key="${key}">${head}<td>${escapeHtml(formatValue(field))}</td></tr>`;
      }
      const type = typeof field.value;
      const unit = field.unit ? ` <span class="pp-unit">${escapeHtml(field.unit)}</span>` : '';
      if (type === 'boolean') {
        const checked = field.value === true ? ' checked' : '';
        return `<tr data-panel-key="${key}">${head}<td><input class="pp-input pp-check" type="checkbox" data-edit-key="${key}" data-value-type="boolean"${checked}></td></tr>`;
      }
      const raw = field.value === null || field.value === undefined ? '' : String(field.value);
      return (
        `<tr data-panel-key="${key}">${head}<td>` +
        `<input class="pp-input" type="text" inputmode="${type === 'number' ? 'decimal' : 'text'}" ` +
        `data-edit-key="${key}" data-value-type="${type}" value="${escapeHtml(raw)}">${unit}</td></tr>`
      );
    })
    .join('');
  return (
    `<section class="property-panel"><h2>${escapeHtml(title)}</h2>` +
    `<table><tbody>${rows}</tbody></table></section>`
  );
}
