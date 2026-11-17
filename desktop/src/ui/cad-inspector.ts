export type CadInspectorKey = 'inspection' | 'kinematics' | 'parametric';
export type CadInspectorSelection = CadInspectorKey | 'collapsed';

export interface CadInspectorOptions {
  root: HTMLElement;
  onSelect: (key: CadInspectorKey) => void;
  isParametricEnabled: () => boolean;
}

/** Pure selection model, also usable without a DOM. */
export function planCadInspectorSelection(key: CadInspectorSelection, parametricEnabled: boolean) {
  const selected = key === 'parametric' && !parametricEnabled ? 'inspection' : key;
  return {
    selected,
    inspection: selected === 'inspection',
    kinematics: selected === 'kinematics',
    parametric: selected === 'parametric'
  };
}

let nextInspectorId = 0;

/** Keep the existing panels in place; the controller owns only their visibility and tab metadata. */
export function installCadInspector({ root, onSelect, isParametricEnabled }: CadInspectorOptions): {
  refresh(): void;
  select(key: CadInspectorSelection): void;
  dispose(): void;
} {
  const document = root.ownerDocument;
  const main = root.querySelector<HTMLElement>('.cad-main');
  const inspection = root.querySelector<HTMLElement>('.cad-inspector');
  const kinematics = root.querySelector<HTMLElement>('#cadKinematicsDrawer');
  const parametric = root.querySelector<HTMLElement>('#cadParametricDrawer');
  if (!main || !inspection || !kinematics || !parametric) {
    throw new Error('CAD inspector requires .cad-main, .cad-inspector and both drawer containers');
  }
  const panels = { inspection, kinematics, parametric };
  const keys: CadInspectorSelection[] = ['inspection', 'kinematics', 'parametric', 'collapsed'];
  const labels: Record<CadInspectorSelection, string> = {
    inspection: '检查', kinematics: '运动学', parametric: '参数化', collapsed: '收起'
  };
  const prefix = `cad-inspector-${++nextInspectorId}`;
  const savedAttributes = Object.values(panels).map((panel) => ({
    panel,
    id: panel.getAttribute('id'),
    role: panel.getAttribute('role'),
    labelledBy: panel.getAttribute('aria-labelledby')
  }));
  const originalRootSelection = root.getAttribute('data-cad-inspector-panel');
  const nav = document.createElement('nav');
  nav.className = 'cad-inspector-tabs';
  nav.setAttribute('role', 'tablist');
  nav.setAttribute('aria-label', 'CAD 检查面板');
  const buttons = new Map<CadInspectorSelection, HTMLButtonElement>();
  const listeners: Array<() => void> = [];
  let disposed = false;
  let selected: CadInspectorSelection = !parametric.hidden
    ? 'parametric' : !kinematics.hidden ? 'kinematics' : !inspection.hidden ? 'inspection' : 'collapsed';

  for (const key of keys) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${prefix}-${key}-tab`;
    button.textContent = labels[key];
    button.setAttribute('role', 'tab');
    button.setAttribute('data-cad-inspector-tab', key);
    if (key !== 'collapsed') {
      const panel = panels[key];
      if (!panel.id) panel.id = `${prefix}-${key}-panel`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', button.id);
      button.setAttribute('aria-controls', panel.id);
    }
    const click = () => {
      // Programmatic select propagates errors; event activation keeps the restored panel usable.
      try { select(key); } catch { /* select has restored the previous visibility */ }
    };
    const keydown = (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const available = keys.filter((item) => !buttons.get(item)!.hidden && !buttons.get(item)!.disabled);
      const current = available.indexOf(key);
      const backwards = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
        : (current + (backwards ? -1 : 1) + available.length) % available.length;
      const target = available[index];
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      try { select(target); } catch { return; }
      buttons.get(target)?.focus();
    };
    button.addEventListener('click', click);
    button.addEventListener('keydown', keydown);
    listeners.push(() => {
      button.removeEventListener('click', click);
      button.removeEventListener('keydown', keydown);
    });
    buttons.set(key, button);
    nav.appendChild(button);
  }
  buttons.get('collapsed')!.setAttribute('aria-controls', Object.values(panels).map((panel) => panel.id).join(' '));
  main.parentNode!.insertBefore(nav, main);

  const Observer = document.defaultView?.MutationObserver;
  const observer = Observer ? new Observer((records) => {
    if (disposed) return;
    // Prefer the last drawer opened by an existing API when several changes share a microtask.
    const opened = records.filter((record) => record.type === 'attributes'
      && (record.target === kinematics || record.target === parametric)
      && !(record.target as HTMLElement).hidden);
    const latest = opened[opened.length - 1]?.target;
    const next = latest === parametric ? 'parametric' : latest === kinematics ? 'kinematics'
      : !parametric.hidden ? 'parametric' : !kinematics.hidden ? 'kinematics'
        : selected === 'kinematics' || selected === 'parametric' ? 'inspection' : selected;
    apply(next);
  }) : undefined;

  function apply(key: CadInspectorSelection): void {
    const enabled = isParametricEnabled();
    const plan = planCadInspectorSelection(key, enabled);
    selected = plan.selected;
    // Disconnect while writing so our hidden changes cannot trigger another selection cycle.
    observer?.disconnect();
    for (const panelKey of ['inspection', 'kinematics', 'parametric'] as const) {
      const hidden = !plan[panelKey];
      if (panels[panelKey].hidden !== hidden) panels[panelKey].hidden = hidden;
    }
    const parametricButton = buttons.get('parametric')!;
    parametricButton.hidden = !enabled;
    parametricButton.disabled = !enabled;
    for (const [buttonKey, button] of buttons) {
      const active = buttonKey === selected;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    }
    root.setAttribute('data-cad-inspector-panel', selected);
    observer?.observe(root, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  }

  function select(key: CadInspectorSelection): void {
    if (disposed) return;
    const next = planCadInspectorSelection(key, isParametricEnabled()).selected;
    const previous = selected;
    const visibility = Object.values(panels).map((panel) => ({ panel, hidden: panel.hidden }));
    try {
      if (next === 'kinematics' || next === 'parametric') onSelect(next);
      apply(next);
    } catch (error) {
      apply(previous);
      observer?.disconnect();
      visibility.forEach(({ panel, hidden }) => {
        if (panel.hidden !== hidden) panel.hidden = hidden;
      });
      observer?.observe(root, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
      throw error;
    }
  }

  function refresh(): void {
    if (disposed) return;
    const next = !panels.parametric.hidden ? 'parametric' : !panels.kinematics.hidden ? 'kinematics'
      : selected === 'kinematics' || selected === 'parametric' ? 'inspection' : selected;
    apply(next);
  }

  function restoreAttribute(element: HTMLElement, name: string, value: string | null): void {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }

  apply(selected);
  return {
    refresh,
    select,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      listeners.forEach((remove) => remove());
      nav.remove();
      for (const { panel, id, role, labelledBy } of savedAttributes) {
        restoreAttribute(panel, 'id', id);
        restoreAttribute(panel, 'role', role);
        restoreAttribute(panel, 'aria-labelledby', labelledBy);
      }
      restoreAttribute(root, 'data-cad-inspector-panel', originalRootSelection);
    }
  };
}
