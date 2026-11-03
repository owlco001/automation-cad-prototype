/**
 * 机型库抽屉（`library:*` IPC 的界面层）。
 *
 * 分两半，界线故意画死：
 *   1. 上半部分**纯函数**：格式化、错误码→中文、HTML 片段。不碰 DOM、不 import 任何
 *      带 `?inline` 的样式或 Node 模块，因此可以直接被 `node --test` 加载
 *      （见 desktop/test/commission/machine-library-panel.test.mjs）。
 *   2. 下半部分 `bindMachineLibraryPanel`：把渲染结果挂到抽屉 body 上、绑事件。
 *      数据全部来自传入的 client（渲染层拿不到 fs——文件选择/读写都在主进程），
 *      与 `commission/ui.ts` 的联调逻辑完全解耦，不往那个大函数里塞。
 *
 * 安全边界：id 会出现在 `data-*` 属性里，渲染前一律过 `isSafeLibraryId`；
 * 不合法的行照常显示（用户得知道库里有坏条目），但加载/导出/删除按钮 disabled，
 * 且不写进 `data-library-select`——避免 UI 成为把非法 id 递给主进程的通道。
 */

export interface MachineLibraryEntryView {
  id: string;
  name: string;
  version: string;
  updatedAt: string;
  sizeBytes: number;
  source: string;
}

export type LibraryFailure = { ok: false; code: string; message: string; hint?: string };
export interface LibraryListOk { ok: true; entries: MachineLibraryEntryView[] }
export interface LibraryApplyOk { ok: true; entry: MachineLibraryEntryView; design: unknown }
export interface LibraryImportOk {
  ok: true;
  cancelled?: boolean;
  overwritten?: boolean;
  entry?: MachineLibraryEntryView;
}
export interface LibraryExportOk { ok: true; cancelled?: boolean; path?: string }
export interface LibraryRemoveOk { ok: true; entry?: MachineLibraryEntryView }

/** preload 暴露的 `window.__machineLibrary` 形状（文件选择/读写全在主进程）。 */
export interface MachineLibraryClient {
  list(): Promise<LibraryListOk | LibraryFailure>;
  apply(id: string): Promise<LibraryApplyOk | LibraryFailure>;
  importPackage(options?: { overwrite?: boolean }): Promise<LibraryImportOk | LibraryFailure>;
  exportPackage(id: string): Promise<LibraryExportOk | LibraryFailure>;
  remove(id: string): Promise<LibraryRemoveOk | LibraryFailure>;
}

export interface MachineLibraryPanelState {
  entries: readonly MachineLibraryEntryView[];
  /** 当前选中行；null/缺省表示没选 */
  selectedId?: string | null;
  /** 有 IPC 在飞：所有按钮 disabled，避免连点重复导入 */
  busy?: boolean;
  /** 上一次操作的失败文案（已转中文），渲染在表格下方 */
  error?: string | null;
}

/* ------------------------------------------------------------------ */
/* 错误码 → 中文                                                        */
/* ------------------------------------------------------------------ */

/**
 * 错误码对应的人话。**必须**覆盖用户真会碰到的五个（导入同名、坏包、被改过、路径非法、
 * 太大），其余是主进程可能回上来的补充码；表里没有再回落到 message。
 */
export const MACHINE_LIBRARY_ERROR_TEXT: Readonly<Record<string, string>> = Object.freeze({
  LIBRARY_EXISTS: '同名机型已存在；确认后可以覆盖导入',
  LIBRARY_BAD_ZIP: '机型包不是合法的 .machine.zip（结构损坏、缺 manifest 或条目未声明）。请重新导出后再导入',
  LIBRARY_HASH_MISMATCH: '机型包内容与 manifest 记录的 SHA-256 不符，可能被手工改过；请重新导出后再导入',
  LIBRARY_BAD_PATH: '机型 id 或包内路径不合法（不得包含 ..、斜杠、盘符或控制字符）',
  LIBRARY_TOO_LARGE: '机型包超过大小上限（整包 50 MiB，单文件与条目数另有上限）',
  LIBRARY_INVALID_CONFIG: '机型包里的 config.json 不是合法机型配置，已拒绝导入',
  LIBRARY_UNSUPPORTED_SCHEMA: '机型包格式版本高于当前软件，请升级软件或改用新版本导出的包',
  LIBRARY_NOT_FOUND: '机型库里找不到这台机型（可能已被删除）',
  LIBRARY_IO_FAILED: '机型库读写失败。请确认磁盘可写、空间充足后重试'
});

/**
 * 失败结果 → 一句可直接显示的文案。
 * 优先用码表的中文（统一、可断言），表里没有才回落到主进程的 message。
 */
export function libraryErrorText(code: string | undefined, message?: string): string {
  const known = code ? MACHINE_LIBRARY_ERROR_TEXT[code] : undefined;
  if (known) return known;
  const detail = (message ?? '').trim();
  return detail ? `机型库操作失败：${detail}` : '机型库操作失败，请重试';
}

/** 失败结果 → `中文文案（错误码）`，界面上一眼能看到码便于报障。 */
export function describeLibraryFailure(failure: LibraryFailure): string {
  const text = libraryErrorText(failure.code, failure.message);
  return `${text}〔${failure.code}〕`;
}

/**
 * 导入失败后的下一步：**只有** `LIBRARY_EXISTS` 值得问人「要不要覆盖」，
 * 其余（坏包/哈希不符/超大/路径非法）重试也没用，直接报错。
 * 抽成纯函数是因为这条分支决定「会不会二次覆盖用户的机型包」，必须可断言。
 */
export function planImportFailure(failure: LibraryFailure): 'confirm-overwrite' | 'report' {
  return failure.code === 'LIBRARY_EXISTS' ? 'confirm-overwrite' : 'report';
}

/* ------------------------------------------------------------------ */
/* 格式化                                                              */
/* ------------------------------------------------------------------ */

/** 字节 → `1.2 MB` / `864 KB` / `—`。负数与非有限值按未知处理，不显示 `NaN`。 */
export function formatLibrarySize(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** ISO 时间 → 本地 `YYYY-MM-DD HH:mm`；解析不了就原样返回（别把库里的脏数据吞掉）。 */
export function formatLibraryUpdatedAt(iso: string | undefined): string {
  const text = typeof iso === 'string' ? iso.trim() : '';
  if (!text) return '—';
  const stamp = Date.parse(text);
  if (Number.isNaN(stamp)) return text;
  const date = new Date(stamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 来源列：本机保存 / 外部导入 */
export function librarySourceLabel(source: string | undefined): string {
  return source === 'local' ? '本机保存' : '外部导入';
}

/**
 * 机型 id 是否可以直接拼进库目录。
 *
 * 口径与主进程 `validateLibraryId`（src/machine/library-ipc.ts）/ `sanitizeMachineId`
 * 一致：净化前后逐字相等才放行。这里是渲染层自己的一份（不能 import 主进程那份，
 * 它带 node:fs），两份任何一处改动都要同步改测试。
 */
export function isSafeLibraryId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (!value || value.trim() !== value) return false;
  if (value.length > 64) return false;
  if (value.includes('/') || value.includes('\\')) return false;
  if (value.includes('..') || value.startsWith('.')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(value)) return false;
  if (/[._-]$/.test(value)) return false;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) return false;
  return true;
}

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/* ------------------------------------------------------------------ */
/* HTML 片段                                                           */
/* ------------------------------------------------------------------ */

function renderRow(entry: MachineLibraryEntryView, state: MachineLibraryPanelState): string {
  const safe = isSafeLibraryId(entry.id);
  const selected = safe && state.selectedId === entry.id;
  const busy = state.busy === true;
  const selectable = safe && !busy;
  const selectAttrs = selectable
    ? ` data-library-select="${escapeHtml(entry.id)}" role="button" tabindex="0" title="选中 ${escapeHtml(entry.name)}"`
    : ' data-library-row-invalid="1" title="机型 id 不合法，已禁止加载/导出/删除"';
  const source = librarySourceLabel(entry.source);
  return `<tr class="mlib-row${selected ? ' is-selected' : ''}${safe ? '' : ' is-invalid'}"`
    + ` data-library-row="${escapeHtml(entry.id)}" aria-selected="${selected ? 'true' : 'false'}"${selectAttrs}>`
    + `<td class="mlib-name">${escapeHtml(entry.name)}<span class="mlib-id">${escapeHtml(entry.id)}</span></td>`
    + `<td class="mono">${escapeHtml(entry.version)}</td>`
    + `<td class="mono">${escapeHtml(formatLibrarySize(entry.sizeBytes))}</td>`
    + `<td><span class="acp-pill${entry.source === 'local' ? ' is-ok' : ''}">${escapeHtml(source)}</span></td>`
    + `<td class="mono">${escapeHtml(formatLibraryUpdatedAt(entry.updatedAt))}</td>`
    + `<td class="mlib-mark">${safe ? (selected ? '✓' : '') : '✕'}</td>`
    + '</tr>';
}

/**
 * 抽屉正文：表头（名称/版本/大小/来源/更新时间）+ 行 + 底部按钮 + 空态 + 错误行。
 *
 * 不用 `hidden` 切换：单测直接断言字符串里有没有空态文案，`hidden` 在字符串层面看不出真假。
 */
export function renderMachineLibraryPanelHtml(state: MachineLibraryPanelState): string {
  const entries = Array.isArray(state.entries) ? state.entries : [];
  const busy = state.busy === true;
  const selected = entries.find((entry) => entry.id === state.selectedId && isSafeLibraryId(entry.id));
  const hasSelection = selected !== undefined;
  const disabled = (extra: boolean): string => (busy || extra ? ' disabled' : '');
  const selectedName = selected ? selected.name : '';

  const table = entries.length === 0
    ? `<div class="mlib-empty" data-machine-library-empty>还没有机型；可以让智能体生成后说「存进机型库」</div>`
    : `<div class="mlib-table-wrap"><table class="mlib-table" data-machine-library-table>
        <thead><tr><th>名称</th><th>版本</th><th>大小</th><th>来源</th><th>更新时间</th><th></th></tr></thead>
        <tbody>${entries.map((entry) => renderRow(entry, { ...state, busy })).join('')}</tbody>
      </table></div>`;

  const error = state.error
    ? `<div class="mlib-error" data-machine-library-error role="alert">${escapeHtml(state.error)}</div>`
    : '';

  const summary = `<div class="mlib-summary"><span>共 ${entries.length} 台机型</span>`
    + `<span class="acp-pill">${hasSelection ? `已选：${escapeHtml(selectedName)}` : '未选中机型'}</span>`
    + `${busy ? '<span class="acp-pill is-warn" data-machine-library-busy>处理中…</span>' : ''}</div>`;

  const actions = `<div class="mlib-actions">
      <button type="button" class="acp-btn" data-machine-library-import${disabled(false)}>导入 .machine.zip</button>
      <button type="button" class="acp-btn" data-machine-library-export${disabled(!hasSelection)}>导出</button>
      <button type="button" class="acp-btn acp-btn-danger" data-machine-library-remove${disabled(!hasSelection)}>删除</button>
      <button type="button" class="acp-btn acp-btn-primary" data-machine-library-apply${disabled(!hasSelection)}>加载</button>
    </div>`;

  return `<div class="mlib-panel" data-machine-library-panel data-entry-count="${entries.length}">
      ${summary}
      ${error}
      ${table}
      ${actions}
      <div class="acp-note">加载会用库里的机型替换当前方案（3D 视图、BOM 与 IO 点位一起重建），故需二次确认。导入只接受主进程文件选择框选出的 <code>.machine.zip</code>；包内每个文件都会逐条比对 SHA-256，校验不过不会入库。</div>
    </div>`;
}

/** 抽屉样式：自带一份，不依赖 commission.css 的加载顺序（只复用 panels.css 的 .acp-btn/.acp-pill）。 */
export const MACHINE_LIBRARY_STYLES = `
.mlib-panel{display:flex;flex-direction:column;gap:8px}
.mlib-summary{display:flex;align-items:center;gap:8px;font-size:10px;color:#86919a}
.mlib-summary .acp-pill{margin-left:auto}
.mlib-table-wrap{border:1px solid #343a40;border-radius:4px;overflow:auto;max-height:calc(100vh - 320px)}
.mlib-table{width:100%;border-collapse:collapse;font-size:10px}
.mlib-table th{padding:6px 8px;border-bottom:1px solid #3a4249;color:#7f8a92;text-align:left;font-weight:500;background:#1d2124;position:sticky;top:0}
.mlib-table td{padding:7px 8px;border-bottom:1px solid #2d3237;color:#b8c0c7;vertical-align:middle}
.mlib-table tr:last-child td{border-bottom:0}
.mlib-table .mono{font:9px/1.35 var(--font-mono,monospace);color:#8f9aa3}
.mlib-row[data-library-select]{cursor:pointer}
.mlib-row[data-library-select]:hover td{background:#23282c}
.mlib-row.is-selected td{background:#1d3230;color:#dff5f1}
.mlib-row.is-invalid td{color:#a08a7a}
.mlib-name{display:flex;flex-direction:column;gap:2px}
.mlib-id{font:9px/1.3 var(--font-mono,monospace);color:#6e777f}
.mlib-mark{width:18px;text-align:center;color:#1b8f82}
.mlib-empty{padding:22px 12px;border:1px dashed #3a4249;border-radius:4px;color:#7f8a92;font-size:11px;line-height:1.7;text-align:center;background:#1b1e21}
.mlib-error{padding:7px 9px;border:1px solid #6d3c3c;border-radius:3px;background:#332323;color:#ffc9c4;font-size:10px;line-height:1.6}
.mlib-actions{display:flex;gap:6px;align-items:center}
.mlib-actions .acp-btn-primary{margin-left:auto}
`;

/* ------------------------------------------------------------------ */
/* DOM 绑定                                                            */
/* ------------------------------------------------------------------ */

export interface MachineLibraryPanelHooks {
  /** apply 成功后：把 design 交给调用方刷新 3D/BOM/电气（走既有的机型应用链路） */
  onApplied(design: unknown, entry: MachineLibraryEntryView): void;
  notify(message: string, error?: boolean): void;
  /** 二次确认；返回 true 才继续。默认 `window.confirm` */
  confirm?(message: string): boolean;
}

export interface BindMachineLibraryPanelOptions extends MachineLibraryPanelHooks {
  /** 抽屉正文容器（`.acp-drawer-body`） */
  root: HTMLElement;
  client: MachineLibraryClient;
}

export interface MachineLibraryPanelHandle {
  /** 重新拉列表并重绘（打开抽屉、导入/删除/加载成功后都走它） */
  refresh(): Promise<void>;
  dispose(): void;
}

/**
 * 把机型库面板挂到一个容器上。所有动作串行（`busy` 锁），失败只显示中文文案 + 错误码，
 * 不把主进程异常原文糊到界面上。
 */
export function bindMachineLibraryPanel(options: BindMachineLibraryPanelOptions): MachineLibraryPanelHandle {
  const { root, client } = options;
  const confirm = options.confirm ?? ((message: string) => window.confirm(message));
  const state: { entries: MachineLibraryEntryView[]; selectedId: string | null; busy: boolean; error: string | null } = {
    entries: [],
    selectedId: null,
    busy: false,
    error: null
  };

  const render = (): void => {
    root.innerHTML = renderMachineLibraryPanelHtml({
      entries: state.entries,
      selectedId: state.selectedId,
      busy: state.busy,
      error: state.error
    });
  };

  const selected = (): MachineLibraryEntryView | undefined =>
    state.entries.find((entry) => entry.id === state.selectedId && isSafeLibraryId(entry.id));

  const fail = (failure: LibraryFailure): void => {
    state.error = describeLibraryFailure(failure);
    options.notify(state.error, true);
  };

  const run = async (task: () => Promise<void>): Promise<void> => {
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    render();
    try {
      await task();
    } finally {
      state.busy = false;
      render();
    }
  };

  const refresh = async (): Promise<void> => {
    const result = await client.list();
    if (!result.ok) {
      fail(result);
      return;
    }
    state.entries = Array.isArray(result.entries) ? result.entries : [];
    // 选中的机型被删掉/被覆盖改名后不能继续留着选中态
    if (state.selectedId && !state.entries.some((entry) => entry.id === state.selectedId)) {
      state.selectedId = null;
    }
    if (!state.selectedId && state.entries.length > 0) {
      const first = state.entries.find((entry) => isSafeLibraryId(entry.id));
      if (first) state.selectedId = first.id;
    }
  };

  const applySelected = async (): Promise<void> => {
    const entry = selected();
    if (!entry) return;
    const ok = confirm(
      `加载机型「${entry.name}」（${entry.version}）会替换当前方案：\n`
      + '3D 视图、BOM 草稿与 IO 点位都会按它重建。\n\n继续加载？'
    );
    if (!ok) return;
    await run(async () => {
      const result = await client.apply(entry.id);
      if (!result.ok) {
        fail(result);
        return;
      }
      try {
        options.onApplied(result.design, result.entry ?? entry);
      } catch (error) {
        // 库里的包已经落盘成功，失败的是「应用到当前工程」这一步：分开报，别谎称加载失败。
        state.error = `机型已加载到库，但应用到当前工程失败：${error instanceof Error ? error.message : String(error)}`;
        options.notify(state.error, true);
        await refresh();
        return;
      }
      options.notify(`已加载机型：${result.entry?.name ?? entry.name}`);
      await refresh();
    });
  };

  const importPackage = async (): Promise<void> => {
    await run(async () => {
      const first = await client.importPackage({ overwrite: false });
      if (first.ok) {
        if (first.cancelled) return;
        state.selectedId = first.entry?.id ?? state.selectedId;
        options.notify(first.overwritten
          ? `已覆盖导入：${first.entry?.name ?? first.entry?.id ?? ''}`
          : `已导入：${first.entry?.name ?? first.entry?.id ?? ''}`);
        await refresh();
        return;
      }
      // 同名冲突必须问人：覆盖是破坏性操作，绝不自动重试。
      if (planImportFailure(first) !== 'confirm-overwrite') {
        fail(first);
        return;
      }
      const overwrite = confirm('同名机型已存在，是否覆盖？\n\n覆盖后库里旧版本的机型包会被替换（不可撤销）。');
      if (!overwrite) return;
      const retry = await client.importPackage({ overwrite: true });
      if (!retry.ok) {
        fail(retry);
        return;
      }
      if (retry.cancelled) return;
      state.selectedId = retry.entry?.id ?? state.selectedId;
      options.notify(`已覆盖导入：${retry.entry?.name ?? retry.entry?.id ?? ''}`);
      await refresh();
    });
  };

  const exportSelected = async (): Promise<void> => {
    const entry = selected();
    if (!entry) return;
    await run(async () => {
      const result = await client.exportPackage(entry.id);
      if (!result.ok) {
        fail(result);
        return;
      }
      if (result.cancelled) return;
      options.notify(`已导出机型包：${result.path ?? entry.id}`);
    });
  };

  const removeSelected = async (): Promise<void> => {
    const entry = selected();
    if (!entry) return;
    if (!confirm(`删除机型「${entry.name}」（${entry.version}）？\n\n删除后需要重新导入才能恢复。`)) return;
    await run(async () => {
      const result = await client.remove(entry.id);
      if (!result.ok) {
        fail(result);
        return;
      }
      state.selectedId = null;
      options.notify(`已删除机型：${entry.name}`);
      await refresh();
    });
  };

  const onClick = (event: Event): void => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const button = target.closest<HTMLElement>('[data-machine-library-apply],[data-machine-library-import],[data-machine-library-export],[data-machine-library-remove]');
    if (button && !(button as HTMLButtonElement).disabled) {
      if (button.hasAttribute('data-machine-library-apply')) void applySelected();
      else if (button.hasAttribute('data-machine-library-import')) void importPackage();
      else if (button.hasAttribute('data-machine-library-export')) void exportSelected();
      else if (button.hasAttribute('data-machine-library-remove')) void removeSelected();
      return;
    }
    const row = target.closest<HTMLElement>('[data-library-select]');
    const id = row?.dataset.librarySelect;
    if (!id || state.busy || !isSafeLibraryId(id)) return;
    state.selectedId = id;
    render();
  };

  root.addEventListener('click', onClick);
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-library-select]');
    if (!row) return;
    event.preventDefault();
    row.click();
  };
  root.addEventListener('keydown', onKeydown);

  void refresh().then(render).catch((error: unknown) => {
    state.error = `机型库列表读取失败：${error instanceof Error ? error.message : String(error)}`;
    render();
  });

  return {
    refresh: async (): Promise<void> => {
      await refresh();
      render();
    },
    dispose(): void {
      root.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKeydown);
    }
  };
}
