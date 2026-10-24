export type UpdateChannel = 'stable' | 'beta';
export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface UpdateSnapshot {
  status: UpdateStatus;
  currentVersion: string;
  channel: UpdateChannel;
  availableVersion?: string;
  releaseName?: string;
  releaseNotes?: string;
  progress?: UpdateProgress;
  message: string;
}

interface UpdateInfoLike {
  version?: unknown;
  releaseName?: unknown;
  releaseNotes?: unknown;
}

interface UpdateProgressLike {
  percent?: unknown;
  transferred?: unknown;
  total?: unknown;
  bytesPerSecond?: unknown;
}

export interface UpdateDriver {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  channel: string | null;
  disableDifferentialDownload: boolean;
  on(event: 'checking-for-update', listener: () => void): unknown;
  on(event: 'update-available', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'update-not-available', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'download-progress', listener: (progress: UpdateProgressLike) => void): unknown;
  on(event: 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateServiceOptions {
  updater: UpdateDriver;
  currentVersion: string;
  channel: UpdateChannel;
  enabled: boolean;
  disabledMessage?: string;
  persistChannel: (channel: UpdateChannel) => void;
  onState?: (snapshot: UpdateSnapshot) => void;
}

const BUSY_CHANNEL_STATUSES = new Set<UpdateStatus>(['checking', 'downloading', 'downloaded']);

function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === 'stable' || value === 'beta';
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function releaseNotesText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, 8_000);
  if (!Array.isArray(value)) return undefined;
  const notes = value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (!entry || typeof entry !== 'object') return '';
      const note = (entry as { note?: unknown }).note;
      return typeof note === 'string' ? note : '';
    })
    .filter(Boolean)
    .join('\n\n');
  return notes ? notes.slice(0, 8_000) : undefined;
}

function updateInfoFields(info: UpdateInfoLike): Pick<UpdateSnapshot, 'availableVersion' | 'releaseName' | 'releaseNotes'> {
  const availableVersion = asNonEmptyString(info.version);
  const releaseName = asNonEmptyString(info.releaseName);
  const releaseNotes = releaseNotesText(info.releaseNotes);
  return {
    ...(availableVersion ? { availableVersion } : {}),
    ...(releaseName ? { releaseName } : {}),
    ...(releaseNotes ? { releaseNotes } : {})
  };
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/\b(token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 320);
}

/**
 * electron-builder 26's NSIS updater skips its Authenticode check when the
 * embedded app-update.yml has no publisherName. Block such packaged builds
 * before any network request rather than treating a missing signer as trusted.
 */
export function hasTrustedUpdateConfig(configText: string): boolean {
  if (!/^provider:\s*github\s*$/m.test(configText)) return false;
  if (!/^owner:\s*owlco001\s*$/m.test(configText)) return false;
  if (!/^repo:\s*automation-cad-prototype\s*$/m.test(configText)) return false;

  const publisher = configText.match(/^publisherName:[ \t]*(.*)$/m);
  if (!publisher) return false;
  const inline = publisher[1]?.trim() ?? '';
  if (inline && inline !== '[]' && inline !== 'null' && inline !== '~') {
    const scalar = inline.replace(/^['"]|['"]$/g, '').trim();
    if (scalar && scalar !== '[]' && scalar !== 'null' && scalar !== '~') return true;
  }
  const followingLines = configText.slice((publisher.index ?? 0) + publisher[0].length).split(/\r?\n/);
  for (const line of followingLines) {
    if (line && !/^\s/.test(line)) break;
    const item = line.match(/^\s+-\s*(.*)$/);
    if (!item) continue;
    const value = (item[1] ?? '').replace(/^['"]|['"]$/g, '').trim();
    if (value && value !== 'null' && value !== '~') return true;
  }
  return false;
}

export function assertUpdateIpcAuthorization(context: {
  mainWindowAlive: boolean;
  senderIsMainWindow: boolean;
  senderIsMainFrame: boolean;
  senderUsesFileUrl: boolean;
}): void {
  if (!context.mainWindowAlive || !context.senderIsMainWindow ||
      !context.senderIsMainFrame || !context.senderUsesFileUrl) {
    throw new Error('拒绝来自非主窗口的更新操作。');
  }
}

export function assertUpdateModuleEnabled(enabled: boolean): void {
  if (!enabled) throw new Error('MODULE_DISABLED: 更新通道模块已关闭。');
}

export class UpdateChannelService {
  private readonly updater: UpdateDriver;
  private readonly enabled: boolean;
  private readonly disabledMessage: string;
  private readonly persistChannel: (channel: UpdateChannel) => void;
  private readonly onState: ((snapshot: UpdateSnapshot) => void) | undefined;
  private state: UpdateSnapshot;

  constructor(options: UpdateServiceOptions) {
    this.updater = options.updater;
    this.enabled = options.enabled;
    this.disabledMessage = options.disabledMessage ?? '应用内更新在此环境中不可用。';
    this.persistChannel = options.persistChannel;
    this.onState = options.onState;

    // Never auto-download or install just because the application is closing.
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    // NSIS blockmap delta stays enabled. electron-updater falls back to the
    // complete installer on Windows when differential download cannot proceed.
    this.updater.disableDifferentialDownload = false;

    this.state = {
      status: this.enabled ? 'idle' : 'disabled',
      currentVersion: options.currentVersion,
      channel: isUpdateChannel(options.channel) ? options.channel : 'stable',
      message: this.enabled ? '尚未检查更新。' : this.disabledMessage
    };
    this.applyChannel(this.state.channel);
    this.bindUpdaterEvents();
  }

  snapshot(): UpdateSnapshot {
    return {
      ...this.state,
      ...(this.state.progress ? { progress: { ...this.state.progress } } : {})
    };
  }

  async setChannel(channel: unknown): Promise<UpdateSnapshot> {
    if (!isUpdateChannel(channel)) throw new Error('更新渠道必须是 stable 或 beta。');
    if (BUSY_CHANNEL_STATUSES.has(this.state.status)) {
      throw new Error('检查、下载或待安装期间不能切换更新渠道。');
    }
    if (channel === this.state.channel) return this.snapshot();

    this.persistChannel(channel);
    this.state = {
      status: this.enabled ? 'idle' : 'disabled',
      currentVersion: this.state.currentVersion,
      channel,
      message: this.enabled ? '更新渠道已切换，请重新检查。' : this.disabledMessage
    };
    this.applyChannel(channel);
    this.publish();
    return this.snapshot();
  }

  async check(): Promise<UpdateSnapshot> {
    if (!this.enabled) return this.snapshot();
    if (this.state.status === 'checking' || this.state.status === 'downloading' || this.state.status === 'downloaded') {
      return this.snapshot();
    }

    this.state = {
      status: 'checking',
      currentVersion: this.state.currentVersion,
      channel: this.state.channel,
      message: '正在检查更新…'
    };
    this.publish();
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.fail(error);
    }
    return this.snapshot();
  }

  async download(): Promise<UpdateSnapshot> {
    if (!this.enabled) return this.snapshot();
    if (this.state.status !== 'available') throw new Error('当前没有可下载的更新。');

    this.state = {
      ...this.state,
      status: 'downloading',
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
      message: '正在下载更新…'
    };
    this.publish();
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.fail(error);
    }
    return this.snapshot();
  }

  installAfterConfirmation(): UpdateSnapshot {
    if (!this.enabled || this.state.status !== 'downloaded') {
      throw new Error('尚无已验证完成的更新可安装。');
    }
    // isSilent=false: NSIS update is never requested in silent mode.
    this.updater.quitAndInstall(false, true);
    return this.snapshot();
  }

  private applyChannel(channel: UpdateChannel): void {
    // channel setter itself enables downgrade in electron-updater. Always turn
    // it back off so switching beta -> stable cannot silently downgrade.
    this.updater.channel = channel === 'beta' ? 'beta' : 'latest';
    this.updater.allowPrerelease = channel === 'beta';
    this.updater.allowDowngrade = false;
  }

  private bindUpdaterEvents(): void {
    this.updater.on('checking-for-update', () => {
      if (!this.enabled) return;
      this.state = { ...this.state, status: 'checking', message: '正在检查更新…' };
      this.publish();
    });
    this.updater.on('update-available', (info) => {
      if (!this.enabled) return;
      this.state = {
        status: 'available',
        currentVersion: this.state.currentVersion,
        channel: this.state.channel,
        ...updateInfoFields(info),
        message: '发现新版本。下载需由你主动开始。'
      };
      this.publish();
    });
    this.updater.on('update-not-available', () => {
      if (!this.enabled) return;
      this.state = {
        status: 'not-available',
        currentVersion: this.state.currentVersion,
        channel: this.state.channel,
        message: '当前已是此渠道的最新版本。'
      };
      this.publish();
    });
    this.updater.on('download-progress', (progress) => {
      if (!this.enabled) return;
      const percent = Math.max(0, Math.min(100, asFiniteNumber(progress.percent)));
      this.state = {
        ...this.state,
        status: 'downloading',
        progress: {
          percent,
          transferred: Math.max(0, asFiniteNumber(progress.transferred)),
          total: Math.max(0, asFiniteNumber(progress.total)),
          bytesPerSecond: Math.max(0, asFiniteNumber(progress.bytesPerSecond))
        },
        message: `正在下载更新：${percent.toFixed(1)}%`
      };
      this.publish();
    });
    this.updater.on('update-downloaded', (info) => {
      if (!this.enabled) return;
      this.state = {
        status: 'downloaded',
        currentVersion: this.state.currentVersion,
        channel: this.state.channel,
        ...updateInfoFields(info),
        message: '下载与更新器校验已完成。安装前仍需确认。'
      };
      this.publish();
    });
    this.updater.on('error', (error) => this.fail(error));
  }

  private fail(error: unknown): void {
    if (!this.enabled) return;
    this.state = {
      status: 'error',
      currentVersion: this.state.currentVersion,
      channel: this.state.channel,
      message: `更新失败：${safeErrorMessage(error)}`
    };
    this.publish();
  }

  private publish(): void {
    this.onState?.(this.snapshot());
  }
}
