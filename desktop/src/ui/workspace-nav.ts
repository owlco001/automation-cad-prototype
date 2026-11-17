export type WorkspaceKey = 'design' | 'electrical' | 'plc' | 'delivery';

export interface WorkspaceNavOptions {
  onWorkspaceChange?: (key: WorkspaceKey) => void;
}

export interface WorkspaceNavHandle {
  /** Re-read registered tools and their current module availability. */
  refresh(): void;
  /** Select the workflow and invoke its existing domain switch. */
  setActive(key: WorkspaceKey): void;
  dispose(): void;
}

const WORKSPACES: ReadonlyArray<{
  key: WorkspaceKey;
  label: string;
  domain: 'mech' | 'elec';
  tools: readonly string[];
}> = [
  { key: 'design', label: '设计装配', domain: 'mech', tools: [
    'designWizardEntry', 'assemblyEntryButton', 'machineLibraryEntryButton', 'canvasWorkbenchEntryButton', 'agentEntryButton'
  ] },
  { key: 'electrical', label: '电气设计', domain: 'elec', tools: ['elecLibEntryButton', 'enclosureEntryButton'] },
  { key: 'plc', label: 'PLC与联调', domain: 'elec', tools: ['plcGenEntryButton', 'commissionEntryButton', 'factoryEntryButton', 'syncEntryButton'] },
  { key: 'delivery', label: '校核与交付', domain: 'mech', tools: ['elecCheckEntryButton', 'drawingEntryButton', 'costEntryButton', 'packEntryButton'] }
];

/** The menu itself is normally hidden; only the original entry's own availability matters. */
function available(button: HTMLElement | null): button is HTMLButtonElement {
  return button?.tagName === 'BUTTON' && !button.hidden &&
    !(button as HTMLButtonElement).disabled && button.getAttribute('aria-disabled') !== 'true' &&
    button.getAttribute('aria-hidden') !== 'true' && button.style.display !== 'none' &&
    button.style.visibility !== 'hidden';
}

/**
 * Workflow tabs and live shortcuts. Original entry nodes stay in the tool menu, preserving
 * their IDs, listeners and drawer toggle behavior. No shortcut supplies a separate action.
 * Install once after the topbar exists; refresh also supports later module registration.
 */
export function installWorkspaceNav(options: WorkspaceNavOptions = {}): WorkspaceNavHandle {
  const topbar = document.querySelector<HTMLElement>('.topbar');
  let disposed = false;
  let queued = false;
  let active: WorkspaceKey = document.body.dataset.domain === 'elec' ? 'electrical' : 'design';
  let signature = '';
  const root = document.createElement('div');
  root.id = 'workspaceNav';
  root.className = 'workspace-nav';
  const tabs = document.createElement('nav');
  tabs.className = 'workspace-nav-tabs';
  tabs.setAttribute('aria-label', '工作流程');
  const strip = document.createElement('div');
  strip.id = 'workspaceToolStrip';
  strip.className = 'workspace-tool-strip';
  strip.setAttribute('role', 'group');
  root.appendChild(tabs);
  root.appendChild(strip);

  const buttons = new Map<WorkspaceKey, HTMLButtonElement>();
  for (const workspace of WORKSPACES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-nav-button';
    button.dataset.workspace = workspace.key;
    button.textContent = workspace.label;
    button.addEventListener('click', () => setActive(workspace.key));
    tabs.appendChild(button);
    buttons.set(workspace.key, button);
  }
  if (topbar) topbar.insertBefore(root, topbar.querySelector('.modes'));

  function refresh(): void {
    if (disposed) return;
    const domain = document.body.dataset.domain ??
      document.querySelector<HTMLElement>('.domsw-btn.is-active')?.dataset.domain;
    const selected = WORKSPACES.find((workspace) => workspace.key === active)!;
    // Keep PLC/delivery selected while their domain is active, but follow legacy domain controls.
    if (domain && domain !== selected.domain) {
      active = domain === 'elec' ? 'electrical' : 'design';
      options.onWorkspaceChange?.(active);
    }
    const workspace = WORKSPACES.find((item) => item.key === active)!;
    root.dataset.workspace = active;
    for (const [key, button] of buttons) {
      const on = key === active;
      button.classList.toggle('is-active', on);
      button.setAttribute('aria-pressed', String(on));
      if (on) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    strip.setAttribute('aria-label', `${workspace.label}工具`);
    const tools = workspace.tools.flatMap((id) => {
      const original = document.getElementById(id);
      if (!available(original)) return [];
      const label = original.querySelector('span')?.textContent?.trim() ||
        original.textContent?.trim() || original.title;
      return label ? [{ id, label, title: original.title || label }] : [];
    });
    const nextSignature = JSON.stringify([active, tools]);
    if (signature === nextSignature) return;
    signature = nextSignature;
    strip.replaceChildren();
    strip.hidden = tools.length === 0;
    for (const tool of tools) {
      const proxy = document.createElement('button');
      proxy.type = 'button';
      proxy.className = 'workspace-tool-shortcut';
      proxy.dataset.toolTarget = tool.id;
      proxy.textContent = tool.label;
      proxy.title = tool.title;
      proxy.addEventListener('click', () => {
        if (disposed) return;
        const original = document.getElementById(tool.id);
        if (available(original)) original.click();
        refresh();
      });
      strip.appendChild(proxy);
    }
  }

  function scheduleRefresh(): void {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      refresh();
    });
  }

  function setActive(key: WorkspaceKey): void {
    if (disposed) return;
    const workspace = WORKSPACES.find((item) => item.key === key);
    if (!workspace) return;
    const changed = active !== key;
    active = key;
    // Domain handlers own the views, modes and domain-dependent module visibility.
    const domainButton = document.querySelector<HTMLButtonElement>(`button[data-domain="${workspace.domain}"]`);
    if (available(domainButton)) domainButton.click();
    refresh();
    scheduleRefresh();
    if (changed && active === key) options.onWorkspaceChange?.(key);
  }

  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver((records) => {
    // Ignore our own aria/class/shortcut updates to avoid a refresh feedback loop.
    if (records.some((record) => !root.contains(record.target))) scheduleRefresh();
  });
  if (topbar) observer?.observe(topbar, {
    subtree: true, childList: true, attributes: true, characterData: true,
    attributeFilter: ['hidden', 'disabled', 'aria-disabled', 'aria-hidden', 'style', 'class', 'data-domain', 'title']
  });
  observer?.observe(document.body, { attributes: true, attributeFilter: ['data-domain'] });
  refresh();
  return {
    refresh,
    setActive,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      root.remove();
    }
  };
}
