// 分块入口：project.portable 的渲染层 UI。
//
// 这个文件**只**被 `scripts/build-module-chunks.mjs` 打包成 dist/modules/project.portable.js；
// 核心包不再静态携带工程档案导出菜单与预览对话框，两边的唯一契约是下面这个导出。
// 契约变更时必须同时改 extension.ts 的 `ProjectPortableChunkExports` 与清单里的 API 版本。

type ProjectArchiveApi = NonNullable<NonNullable<Window['desktop']>['projectArchive']>;

export interface ProjectPortableUiInitOptions {
  /** 初始化时的模块开关（与迁出前在启动时读到的值一致；随后由 setEnabled 接管）。 */
  enabled: boolean;
  /** CAD 导出菜单容器（核心包的 #cadExportMenu）。 */
  host: HTMLElement;
  /** 核心包的统一提示。 */
  notify(message: string, error?: boolean, durationMs?: number): void;
  /** 点击导出菜单项后收起菜单（保持迁出前行为）。 */
  closeMenu(): void;
  /** 当前 CAD 是否已取得可导出的持久工程身份。 */
  hasProjectIdentity(): boolean;
  /** 采集与迁出前完全相同的导出快照；不可安全导出时返回 null。 */
  captureSnapshot(): DesktopProjectExportSnapshot | null;
  /** 当前生效的工程档案桥；未声明时返回 null。 */
  projectArchive(): ProjectArchiveApi | null;
}

export interface ProjectPortableUiHandle {
  setEnabled(enabled: boolean): void;
  refresh(): void;
  openExport(): Promise<void>;
  openPreview(): Promise<void>;
  closePreview(): void;
}

const DIALOG_ID = 'cadProjectArchivePreview';

export function initProjectPortableUi(options: ProjectPortableUiInitOptions): ProjectPortableUiHandle {
  let enabled = options.enabled;

  // 初始化可能因重试被再次调用：先清掉上一次留下的入口与对话框，避免叠加。
  options.host.querySelectorAll<HTMLElement>('[data-project-archive-entry]').forEach((node) => node.remove());
  document.getElementById(DIALOG_ID)?.remove();

  options.host.insertAdjacentHTML('beforeend', `
    <span class="cad-export-sep" data-project-archive-entry></span>
    <button type="button" data-project-archive="export-cad" data-project-archive-entry><span>导出可支持工程状态</span><em>.acproj</em></button>
    <button type="button" data-project-archive="preview" data-project-archive-entry><span>校验/预览工程档案</span><em>只读</em></button>
  `);
  const exportEntry = options.host.querySelector<HTMLButtonElement>('[data-project-archive="export-cad"]');
  const previewEntry = options.host.querySelector<HTMLButtonElement>('[data-project-archive="preview"]');
  if (!exportEntry || !previewEntry) throw new Error('工程档案导出入口未创建');
  const exportButton: HTMLButtonElement = exportEntry;
  const previewButton: HTMLButtonElement = previewEntry;

  const dialog = document.createElement('dialog');
  dialog.id = DIALOG_ID;
  dialog.className = 'cad-project-archive-dialog';
  dialog.setAttribute('aria-labelledby', 'cadProjectArchivePreviewTitle');
  dialog.innerHTML = `
    <div class="cad-project-archive-dialog-head">
      <div><h2 id="cadProjectArchivePreviewTitle">工程档案只读预览</h2><p>内容已通过结构、依赖与 SHA-256 校验；本操作不会应用或覆盖当前工程。</p></div>
      <button type="button" class="cad-project-archive-close" data-project-archive-close aria-label="关闭预览">×</button>
    </div>
    <pre id="cadProjectArchivePreviewBody"></pre>
  `;
  const previewBody = dialog.querySelector<HTMLElement>('#cadProjectArchivePreviewBody');
  if (!previewBody) throw new Error('工程档案预览节点未创建');
  const body: HTMLElement = previewBody;
  document.body.appendChild(dialog);

  function describeStateExclusions(codes: readonly string[]): string[] {
    const labels: Record<string, string> = {
      'feature-tree-module-disabled': '参数化模块关闭，未收录特征树',
      'feature-tree-not-loaded': '特征树状态未加载',
      'feature-tree-source-mismatch': '特征树来源与当前 CAD 不匹配',
      'kinematics-stable-object-binding-unavailable': '运动学缺少无歧义 stable objectId 映射',
      'kinematics-not-loaded': '运动学标注未加载',
      'cad-view-state-unavailable': '无法安全采集 CAD 视角状态'
    };
    return codes.map((code) => labels[code] ?? code);
  }

  function closePreview(): void {
    if (dialog.open) dialog.close();
  }

  function refresh(): void {
    const available = enabled && options.projectArchive() !== null;
    options.host.querySelectorAll<HTMLElement>('[data-project-archive-entry]').forEach((entry) => {
      entry.hidden = !available;
    });
    const hasIdentity = options.hasProjectIdentity();
    exportButton.disabled = !available || !hasIdentity;
    exportButton.title = hasIdentity
      ? '导出当前持久身份对应的可支持状态与 CAD 原件'
      : '尚未加载可建立持久身份的 CAD；请重新导入后再导出';
  }

  async function openExport(): Promise<void> {
    if (!enabled) {
      options.notify('功能模块「project.portable」当前已关闭。', true);
      return;
    }
    const api = options.projectArchive();
    if (!api) {
      options.notify('工程档案文件操作仅在桌面版可用。', true);
      return;
    }
    const snapshot = options.captureSnapshot();
    if (!snapshot) {
      options.notify('无法安全导出：当前 CAD 尚无持久工程身份，已禁用导出；请重新导入 CAD 后重试。', true);
      return;
    }
    try {
      const result = await api.exportProject(snapshot);
      if (!result.ok) {
        if (result.code !== 'CANCELED') options.notify(result.message, true);
        return;
      }
      const value = result.value;
      const included = Object.entries(value.includedState)
        .filter(([, includedState]) => includedState)
        .map(([key]) => key)
        .join('、') || '无状态';
      const excluded = value.excludedState.length
        ? `；未收录：${describeStateExclusions(value.excludedState).join('；')}`
        : '';
      options.notify(`已创建 ${value.path}（含 CAD 原件与候选状态：${included}；schema v2，导入仍为只读预览${excluded}）`);
    } catch (error) {
      options.notify(error instanceof Error ? error.message : String(error), true);
    }
  }

  async function openPreview(): Promise<void> {
    if (!enabled) {
      options.notify('功能模块「project.portable」当前已关闭。', true);
      return;
    }
    const api = options.projectArchive();
    if (!api) {
      options.notify('工程档案文件操作仅在桌面版可用。', true);
      return;
    }
    try {
      const result = await api.preview();
      if (!result.ok) {
        if (result.code !== 'CANCELED') options.notify(result.message, true);
        return;
      }
      renderPreview(result.value);
    } catch (error) {
      options.notify(error instanceof Error ? error.message : String(error), true);
    }
  }

  function renderPreview(preview: DesktopProjectArchivePreview): void {
    const stateLines = [
      `参数化特征树：${preview.state.featureTree ? '档案中有候选数据；尚未应用' : '不包含'}`,
      `运动学标注：${preview.state.kinematics ? '档案中有候选数据；stable objectId 已校验，但尚未针对本机 CAD 重导入验证' : '不包含'}`,
      `视角状态：${preview.state.viewState ? '档案中有候选数据；当前视口未应用' : '不包含'}`
    ];
    const dependencyLines = preview.dependencies.length > 0
      ? preview.dependencies.map((item) => `- ${item.originalName} (${item.format}, ${item.size} bytes, SHA-256 ${item.sha256})`)
      : ['- 无'];
    const omittedStateLines = preview.omittedState.length
      ? describeStateExclusions(preview.omittedState).map((reason) => `- ${reason}`)
      : ['- 无'];
    const identityLines = preview.project.identity
      ? [
          `来源身份：${preview.project.identity.sourceName} · ${preview.project.identity.sourceSize} bytes`,
          `源 SHA-256：${preview.project.identity.sourceSha256}`,
          `稳定模型对象：${preview.project.identity.modelObjects.length} 个（相同几何重复对象不分配 ID）`
        ]
      : ['来源身份：旧版 schema 无稳定 source identity'];
    body.textContent = [
      `项目名称：${preview.project.name}`,
      `档案 ID：${preview.project.id}`,
      `档案/Core schema：${preview.schemaVersion}/${preview.coreSchemaVersion}`,
      `创建版本/时间：${preview.appVersion} · ${preview.createdAt}`,
      ...identityLines,
      '',
      '状态候选：',
      ...stateLines,
      '',
      '未收录状态：',
      ...omittedStateLines,
      '',
      'CAD 依赖：',
      ...dependencyLines,
      '',
      `完整性：${preview.integrity.algorithm} (${preview.integrity.authenticity})，仅校验条目与 manifest 一致性。`,
      `尚不支持：${preview.unsupported.join('、')}`,
      '',
      '此处只显示经过校验的候选清单，不会导入、重建或覆盖当前工程。'
    ].join('\n');
    if (!dialog.open) dialog.showModal();
  }

  function setEnabled(next: boolean): void {
    enabled = next;
    refresh();
    if (!enabled) closePreview();
  }

  function runAction(action: () => Promise<void>): void {
    void action().catch((error) => {
      options.notify(error instanceof Error ? error.message : String(error), true);
    });
  }

  exportButton.addEventListener('click', () => {
    options.closeMenu();
    runAction(openExport);
  });
  previewButton.addEventListener('click', () => {
    options.closeMenu();
    runAction(openPreview);
  });
  dialog.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('[data-project-archive-close]')) {
      dialog.close();
    }
  });

  refresh();
  return { setEnabled, refresh, openExport, openPreview, closePreview };
}
