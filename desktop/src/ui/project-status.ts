export interface ProjectStatusView {
  name: string;
  stage: 'empty' | 'import' | 'project';
  geometry: 'none' | 'imported-model' | 'saved-model' | 'concept-placeholder';
  saveText: string;
  saveError: boolean;
}

export function projectStatusLabels(view: ProjectStatusView): { title: string; stage: string; geometry: string } {
  return {
    title: view.name.trim() || '未打开工程',
    stage: { empty: '开始设计', import: '导入模型 · 未存为工程', project: '工程工作区' }[view.stage],
    geometry: { none: '尚无模型', 'imported-model': '导入 CAD · 网格查看', 'saved-model': '已保存模型 · 网格查看', 'concept-placeholder': '概念占位体 · 需复核实物' }[view.geometry]
  };
}

/** Move the existing save/recovery buttons without changing their event listeners. */
export function installProjectStatus(options: { read: () => ProjectStatusView; onSave: () => void; onNavigate?: () => void }): { refresh(): void; mount(host: HTMLElement): void; dispose(): void } {
  const bar = document.createElement('section');
  bar.id = 'projectContextBar';
  bar.className = 'project-context-bar';
  bar.setAttribute('aria-label', '当前工程与保存状态');
  bar.innerHTML = '<div class="project-context-heading"><strong data-project-title></strong><span data-project-stage></span></div><span class="project-geometry-badge" data-project-geometry></span><div class="project-context-actions"></div>';
  const workflow = document.createElement('nav');
  workflow.className = 'project-context-workflows';
  workflow.setAttribute('aria-label', '工程工作流程');
  for (const [key, label] of [['design', '设计装配'], ['electrical', '电气设计'], ['plc', 'PLC与联调'], ['delivery', '校核与交付']]) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label!;
    button.addEventListener('click', () => {
      options.onNavigate?.();
      document.querySelector<HTMLButtonElement>(`#workspaceNav [data-workspace="${key}"]`)?.click();
    });
    workflow.appendChild(button);
  }
  bar.appendChild(workflow);
  const actions = bar.querySelector<HTMLElement>('.project-context-actions')!;
  const save = document.createElement('button');
  save.type = 'button'; save.className = 'project-save-action'; save.textContent = '保存工程';
  const onClick = (): void => options.onSave();
  save.addEventListener('click', onClick);
  actions.appendChild(save);
  let disposed = false;
  const refresh = (): void => {
    if (disposed) return;
    const view = options.read();
    const labels = projectStatusLabels(view);
    for (const [selector, text] of [['[data-project-title]', labels.title], ['[data-project-stage]', labels.stage], ['[data-project-geometry]', labels.geometry]]) {
      const element = bar.querySelector<HTMLElement>(selector!);
      if (element && element.textContent !== text) element.textContent = text!;
    }
    bar.dataset.stage = view.stage;
    bar.dataset.saveError = String(view.saveError);
    save.disabled = view.stage === 'empty';
    save.textContent = view.stage === 'project' ? '另存工程' : '存为工程';
    for (const id of ['projectSessionStatus', 'recoverLastProject']) {
      const node = document.getElementById(id);
      if (node && node.parentElement !== actions) actions.appendChild(node);
    }
    const status = document.getElementById('projectSessionStatus');
    if (status) { status.title = view.saveText; status.dataset.error = String(view.saveError); }
  };
  return {
    refresh,
    mount(host): void { if (bar.parentElement !== host) host.prepend(bar); refresh(); },
    dispose(): void { disposed = true; save.removeEventListener('click', onClick); bar.remove(); }
  };
}
