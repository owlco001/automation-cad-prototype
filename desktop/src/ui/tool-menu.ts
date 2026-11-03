/**
 * 顶部右侧入口栏 → 「工具」下拉菜单。
 *
 * 背景：入口加到 14 个之后，窗口一窄 `syncEntryBarMode()` 就降级成图标模式
 * （`.is-compact` 把 `.acp-entry-btn span` 全隐藏），顶上就剩一排认不出的方块，
 * 用户只能靠 title 一个个悬停猜。这里把这些入口收进一个带文字的分组菜单，
 * 栏上只留「机械 / 电气」切换、「CAD 查看」主入口和「工具」按钮。
 *
 * 只搬 DOM 节点、不重建：入口按钮自己的 click 监听（含"再点一次收抽屉"逻辑）
 * 都在节点上，`appendChild` 会原样保留。id 也不变，外部按 id 取元素仍有效。
 */

interface ToolGroup {
  title: string;
  /** 按 id 或 data-act 匹配；顺序即菜单内顺序 */
  keys: string[];
}

const GROUPS: ReadonlyArray<ToolGroup> = [
  {
    title: '设计',
    keys: ['designWizardEntry', 'assemblyEntryButton', 'drawingEntryButton', 'agentEntryButton']
  },
  {
    title: '电气',
    keys: ['elecLibEntryButton', 'elecCheckEntryButton', 'plcGenEntryButton']
  },
  {
    title: '模块',
    keys: [
      'factoryEntryButton',
      'commissionEntryButton',
      'machineLibraryEntryButton',
      'packEntryButton',
      'canvasWorkbenchEntryButton',
      'enclosureEntryButton',
      'costEntryButton',
      'syncEntryButton',
      'moduleSettingsEntryButton'
    ]
  },
  {
    title: '视图与帮助',
    keys: ['measure', 'display', 'automationCadUpdateButton', 'help']
  }
];

/** 菜单里不该出现的：主入口与域切换留在栏上 */
const KEEP_IN_BAR = new Set(['cadEntryButton', 'tbToolsButton']);

const TOGGLE_ID = 'tbToolsButton';
const MENU_ID = 'tbToolsMenu';

/** 入口节点可能带 id，也可能只有 data-act（测量/显示/帮助），两种都能对上分组 */
function keyOf(element: HTMLElement): string {
  return element.id || element.dataset.act || '';
}

function closeMenu(): void {
  const panel = document.getElementById(MENU_ID);
  const toggle = document.getElementById(TOGGLE_ID);
  if (panel) panel.hidden = true;
  toggle?.setAttribute('aria-expanded', 'false');
}

function ensureMenu(): { bar: HTMLElement; panel: HTMLElement; toggle: HTMLButtonElement } | null {
  const bar = document.querySelector<HTMLElement>('.tb-right');
  if (!bar) return null;

  let toggle = document.getElementById(TOGGLE_ID) as HTMLButtonElement | null;
  if (!toggle) {
    toggle = document.createElement('button');
    toggle.id = TOGGLE_ID;
    toggle.type = 'button';
    toggle.className = 'tb-tools-btn';
    toggle.setAttribute('aria-haspopup', 'menu');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.title = '更多功能（工具菜单）';
    toggle.innerHTML = '<span>工具</span><span class="tb-tools-caret" aria-hidden="true">▾</span>';
    bar.appendChild(toggle);
  }

  let panel = document.getElementById(MENU_ID);
  if (!panel) {
    panel = document.createElement('div');
    panel.id = MENU_ID;
    panel.className = 'tb-tools-menu';
    panel.setAttribute('role', 'menu');
    panel.hidden = true;
    // 挂在顶栏（.topbar，position:relative）里做绝对定位：
    // 1) 不能放 .tb-right，那里 overflow-x:auto 会把菜单裁掉；
    // 2) 不能用 position:fixed + JS 算坐标——整页有 html{zoom:1.15}，
    //    算出来的左侧还要被缩放一次，菜单会右移溢出窗口，只剩图标露在外面。
    (bar.closest('.topbar') ?? document.body).appendChild(panel);
  }

  if (!panel.dataset.bound) {
    panel.dataset.bound = '1';
    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = panel!.hidden;
      panel!.hidden = !open;
      toggle!.setAttribute('aria-expanded', String(open));
    });
    // 点菜单项后收起。必须用捕获阶段：入口自己的监听里调了 stopPropagation()，
    // 冒泡阶段收不到这个 click，菜单会一直挂着。
    panel.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest('button, a');
      if (item) closeMenu();
    }, true);
    document.addEventListener('pointerdown', (event) => {
      const target = event.target as Node;
      if (panel!.hidden || panel!.contains(target) || toggle!.contains(target)) return;
      closeMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel!.hidden) closeMenu();
    });
    window.addEventListener('resize', () => closeMenu());
  }

  return { bar, panel, toggle };
}

export function closeToolMenu(): void {
  closeMenu();
}

export interface ToolMenuPlan {
  title: string;
  keys: string[];
}

/**
 * 纯函数：已注册的入口 key → 菜单分组与组内顺序。
 * 空分组不出现（模块开关没开的入口不该留个空标题），未登记的新入口进「其他」。
 */
export function planToolMenu(keys: readonly string[]): ToolMenuPlan[] {
  const seen = new Set<string>();
  const unique = keys.filter((key) => {
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const plan: ToolMenuPlan[] = [];
  for (const group of GROUPS) {
    const hit = group.keys.filter((key) => unique.includes(key));
    if (hit.length > 0) plan.push({ title: group.title, keys: hit });
  }
  const extra = unique.filter((key) => !GROUPS.some((group) => group.keys.includes(key)));
  if (extra.length > 0) plan.push({ title: '其他', keys: extra });
  return plan;
}

function buildSection(title: string): HTMLElement {
  const section = document.createElement('div');
  section.className = 'tb-menu-group';
  section.dataset.group = title;
  const head = document.createElement('div');
  head.className = 'tb-menu-head';
  head.textContent = title;
  section.appendChild(head);
  return section;
}

/**
 * 把栏上的入口搬进菜单。可重复调用：新注册的入口下次调用时补进对应分组；
 * 已搬过的节点按声明顺序重排（appendChild 只是移动，不重建、不丢监听）。
 */
export function syncToolMenu(): void {
  const mounted = ensureMenu();
  if (!mounted) return;
  const { bar, panel } = mounted;

  const pool = new Map<string, HTMLElement>();
  const collect = (root: ParentNode): void => {
    root.querySelectorAll<HTMLElement>('.acp-entry-btn, .tbtn[data-act], #automationCadUpdateButton').forEach((element) => {
      if (KEEP_IN_BAR.has(element.id)) return;
      const key = keyOf(element);
      if (pool.has(key)) return;
      pool.set(key, element);
    });
  };
  collect(bar);
  collect(panel);
  if (pool.size === 0) return;

  const plan = planToolMenu([...pool.keys()]);

  // 先把条目节点摘出来，再清空骨架：节点还活着，appendChild 会原样放回
  [...panel.querySelectorAll<HTMLElement>('.tb-menu-item')].forEach((item) => item.remove());
  panel.textContent = '';

  for (const section of plan) {
    const box = buildSection(section.title);
    for (const key of section.keys) {
      const element = pool.get(key);
      if (!element) continue;
      element.classList.add('tb-menu-item');
      box.appendChild(element);
    }
    panel.appendChild(box);
  }
}
