// UI 重构第 1 步收尾（机械侧 only）：挂载层。
//
// workbench.ts（约 107 KB）无法整文件推送，所以本模块把
// “怎么挂到页面上”做成独立文件，workbench.ts 只需一小段调用：
//
//   featureWorkbench(doc, {
//     tree: document.getElementById('featureTree'),
//     panel: document.getElementById('propertyPanel'),
//     onDocChange: (nextDoc) => { /* 脏子树重算 + 视口刷新 + 历史入栈，见第 2 步 */ }
//   });
//
// featureWorkbench() 是幂等挂载：同一容器只挂一次，之后再调用只是 setDoc(doc)。
// workbench 的 renderInspector() 每次选中都会重跑；如果每次都 addEventListener，
// 监听器会随渲染次数线性增长，而且每个监听各闭一份旧文档，点一次树触发 N 次渲染。
//
// 本模块故意只依赖最小的容器接口（innerHTML + addEventListener），
// 不直接引用 DOM 类型，这样 node --test 可以用假容器验证全部行为；
// 真实页面上传入的 DOM 元素天然满足这个接口。
// 电气侧不在本模块：只挂机械特征树与机械属性面板。

import { applyDocFeatureEdit, type FeatureDocLike } from './feature-tree-doc.ts';
import { buildFeatureTree, findTreeNode, panelFieldsForFeature } from './feature-tree.ts';
import { renderFeatureTreeHtml, renderPanelHtml } from './feature-tree-view.ts';

export interface MountContainer {
  innerHTML: string;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

export interface MountOptions {
  tree: MountContainer;
  panel: MountContainer;
  /** 文档变化时回调：调用方在此做脏子树重算、视口刷新、历史入栈。 */
  onDocChange?: (nextDoc: FeatureDocLike) => void;
}

export interface FeatureWorkbenchHandle {
  /** 换文档（同一容器重复挂载走这里）：选中项还在就保留，否则清空选中。 */
  setDoc(doc: FeatureDocLike): void;
  select(id: string): boolean;
  applyEdit(key: string, value: unknown): boolean;
  getDoc(): FeatureDocLike;
  getSelectedId(): string | null;
  /** 卸掉监听器并清空两个容器，之后可以重新挂载。 */
  destroy(): void;
}

interface EditInputLike {
  value?: unknown;
  checked?: unknown;
  dataset?: { editKey?: string; valueType?: string };
}

function editTarget(event: unknown): EditInputLike | null {
  const target = (event as { target?: unknown } | null)?.target as EditInputLike | null | undefined;
  if (!target || !target.dataset || typeof target.dataset.editKey !== 'string') return null;
  return target;
}

/** 输入框原文 → 参数值；数字解析失败给 NaN，让校验器报错而不是静默吞掉。 */
function coerce(input: EditInputLike): unknown {
  const kind = input.dataset?.valueType;
  if (kind === 'boolean') return input.checked === true;
  const raw = typeof input.value === 'string' ? input.value : '';
  if (kind === 'number') {
    const trimmed = raw.trim();
    if (trimmed === '') return Number.NaN;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return raw;
}

function closestTreeId(event: unknown): string | null {
  const target = (event as { target?: unknown } | null)?.target as
    | { closest?: (selector: string) => { dataset?: { treeId?: string } } | null }
    | null
    | undefined;
  if (!target || typeof target.closest !== 'function') return null;
  const element = target.closest('[data-tree-id]');
  return element?.dataset?.treeId ?? null;
}

interface MountRecord {
  handle: FeatureWorkbenchHandle;
  options: MountOptions;
}

/** 同一容器只挂一次：重复调用只换文档，不叠加监听器。 */
const mounted = new WeakMap<object, MountRecord>();

export function mountFeatureWorkbench(doc: FeatureDocLike, options: MountOptions): FeatureWorkbenchHandle {
  let current = doc;
  let selectedId: string | null = null;

  function render(): void {
    const tree = buildFeatureTree(current);
    options.tree.innerHTML = renderFeatureTreeHtml(tree, selectedId);
    const feature = selectedId ? current.features.find((item) => item.id === selectedId) : undefined;
    options.panel.innerHTML = feature
      ? renderPanelHtml(feature.name, panelFieldsForFeature(feature), { editable: true })
      : renderPanelHtml('未选中特征', []);
  }

  function select(id: string): boolean {
    const tree = buildFeatureTree(current);
    if (!findTreeNode(tree, id)) return false;
    selectedId = id;
    render();
    return true;
  }

  function applyEdit(key: string, value: unknown): boolean {
    if (selectedId === null) return false;
    const result = applyDocFeatureEdit(current, selectedId, key, value);
    const next = result.value;
    if (!result.ok || next === undefined) return false;
    current = next;
    render();
    options.onDocChange?.(current);
    return true;
  }

  const onTreeClick = (event: unknown): void => {
    const id = closestTreeId(event);
    if (id !== null) select(id);
  };

  // 面板编辑入口：输入框 change → 校验 → 不可变写回 → 重渲染
  const onPanelChange = (event: unknown): void => {
    const input = editTarget(event);
    const key = input?.dataset?.editKey;
    if (!input || !key) return;
    applyEdit(key, coerce(input));
  };

  options.tree.addEventListener('click', onTreeClick);
  options.panel.addEventListener('change', onPanelChange);
  render();

  const handle: FeatureWorkbenchHandle = {
    setDoc(next: FeatureDocLike): void {
      current = next;
      if (selectedId !== null && !next.features.some((feature) => feature.id === selectedId)) {
        selectedId = null;
      }
      render();
    },
    select,
    applyEdit,
    getDoc: (): FeatureDocLike => current,
    getSelectedId: (): string | null => selectedId,
    destroy(): void {
      options.tree.removeEventListener?.('click', onTreeClick);
      options.panel.removeEventListener?.('change', onPanelChange);
      options.tree.innerHTML = '';
      options.panel.innerHTML = '';
      mounted.delete(options.tree as object);
    }
  };

  mounted.set(options.tree as object, { handle, options });
  return handle;
}

/** 幂等挂载：已挂过就只换文档并接上新回调。 */
export function featureWorkbench(doc: FeatureDocLike, options: MountOptions): FeatureWorkbenchHandle {
  const existing = mounted.get(options.tree as object);
  if (existing) {
    if (options.onDocChange) existing.options.onDocChange = options.onDocChange;
    else delete existing.options.onDocChange;
    existing.handle.setDoc(doc);
    return existing.handle;
  }
  return mountFeatureWorkbench(doc, options);
}

/** 切到非转接板节点时调用：卸监听 + 清 HTML。 */
export function releaseFeatureWorkbench(container: MountContainer | null | undefined): void {
  if (!container) return;
  const existing = mounted.get(container as object);
  if (existing) {
    existing.handle.destroy();
    return;
  }
  container.innerHTML = '';
}
