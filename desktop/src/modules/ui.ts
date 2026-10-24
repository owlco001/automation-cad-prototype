import { buildEntryButton, createDrawer, escapeHtml, notify } from '../ui/panels';
import type { ModuleManager, ModuleStatus } from './registry';
import { PARAMETRIC_MODULE_DISABLED_MESSAGE } from './parametric-gate.ts';
import { PARAMETRIC_HISTORY_DISABLED_MESSAGE } from './parametric-history-gate.ts';

const MODULES_ICON = '<svg viewBox="0 0 16 16"><path d="M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z"/><path d="M6.5 4.5h3M4.5 6.5v3M11.5 6.5v3M6.5 11.5h3"/></svg>';

export interface ModuleSettingsUiHandle {
  open(): void;
  close(): void;
  render(): void;
}

export function initModuleSettingsUi(options: {
  manager: ModuleManager;
  onStatesChanged?: (states: ModuleStatus[]) => void;
}): ModuleSettingsUiHandle {
  const { manager } = options;
  const drawer = createDrawer('moduleSettingsDrawer', '功能模块', '查看内置模块状态并选择当前需要启用的功能');
  const entry = buildEntryButton('moduleSettingsEntryButton', '模块设置', MODULES_ICON, () => drawer.open());
  if (entry) entry.classList.add('module-settings-entry-btn');

  const render = (): void => {
    const states = manager.list();
    drawer.body.innerHTML = `${states.map((module) => renderModule(module)).join('')}
      <div class="acp-note">模块随应用内置。本设置仅控制模块是否启用，不提供在线单独安装或卸载；关闭模块不会删除项目中已有的数据。商业规则仍待确定。</div>`;
    drawer.body.querySelectorAll<HTMLInputElement>('[data-module-toggle]').forEach((input) => {
      input.addEventListener('change', () => {
        const id = input.dataset.moduleToggle;
        if (!id) return;
        try {
          const updated = manager.setEnabled(id, input.checked);
          options.onStatesChanged?.(updated);
          render();
          notify(input.checked ? '模块已启用并保存' : id === 'cad.parametric-import'
            ? PARAMETRIC_MODULE_DISABLED_MESSAGE
            : id === 'parametric.history'
              ? PARAMETRIC_HISTORY_DISABLED_MESSAGE
              : '模块已关闭；项目数据保持不变');
        } catch (error) {
          render();
          notify(error instanceof Error ? error.message : String(error), true);
        }
      });
    });
    drawer.footer.textContent = manager.persistenceAvailable()
      ? '设置保存在本机，可随时调整。'
      : '设置存储不可用；启用状态按默认值运行。';
  };

  manager.subscribe((states) => {
    options.onStatesChanged?.(states);
    render();
  });
  render();

  return {
    open(): void {
      render();
      drawer.open();
    },
    close(): void {
      drawer.close();
    },
    render
  };
}

function renderModule(module: ModuleStatus): string {
  const checked = module.enabled ? ' checked' : '';
  const required = module.kind === 'core';
  const canToggle = !required && (module.status === 'enabled' || module.status === 'disabled');
  const disabled = canToggle ? '' : ' disabled';
  const statusLabel = module.status === 'enabled' ? '已启用'
    : module.status === 'disabled' ? '已关闭' : '不可用';
  const dependencies = module.dependencies.length > 0 ? module.dependencies.join('、') : '无';
  const capabilities = module.requiredCapabilities.length > 0 ? module.requiredCapabilities.join('、') : '无';
  const reason = module.reason ? `<div class="acp-module-reason">${escapeHtml(module.reason)}</div>` : '';
  return `<article class="acp-module-row" data-module-id="${escapeHtml(module.id)}">
    <div class="acp-module-head">
      <div class="acp-module-title"><b>${escapeHtml(module.name)}</b><code>${escapeHtml(module.id)} · v${escapeHtml(module.version)}</code></div>
      <label class="acp-switch acp-module-switch">
        <input type="checkbox" data-module-toggle="${escapeHtml(module.id)}" aria-label="${escapeHtml(module.name)}"${checked}${disabled}>
        <span>${statusLabel}</span>
      </label>
    </div>
    <div class="acp-module-description">${escapeHtml(module.description)}</div>
    <div class="acp-module-meta">API ${module.apiCompatibility.min}–${module.apiCompatibility.max} · 依赖：${escapeHtml(dependencies)}</div>
    <div class="acp-module-meta">所需能力：${escapeHtml(capabilities)}</div>
    ${reason}
  </article>`;
}
