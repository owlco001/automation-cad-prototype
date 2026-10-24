import { spawn, type ChildProcess } from 'node:child_process';
import { recordDiagnosticError } from '../src/shared/diagnostics.ts';
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { trackedClearTimeout, trackedSetTimeout } from '../src/shared/resources.ts';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import {
  PARAMETRIC_MODULE_DISABLED_MESSAGE,
  isParametricImportEnabled,
  parametricModuleDisabledBuildResult
} from '../src/modules/parametric-gate.ts';
import {
  compileOps,
  isAssemblyDoc,
  validateFeatures,
  type AssemblyDoc,
  type FeatureDoc
} from '../src/parametric/features.ts';

export type ParametricStatus = 'stopped' | 'starting' | 'ready' | 'unavailable' | 'crashed';

export interface ParametricStatusInfo {
  status: ParametricStatus;
  message: string;
  version?: string;
}

export interface ParametricStartInfo {
  ok: boolean;
  status: ParametricStatus;
  message: string;
  code?: 'MODULE_DISABLED';
  port?: number;
  token?: string;
  version?: string;
}

export interface ParametricBuildResult {
  ok: boolean;
  code?: 'MODULE_DISABLED' | 'UNAVAILABLE' | 'TIMEOUT' | 'BUILD_FAILED';
  message?: string;
  stats?: Record<string, unknown>;
  buildMs?: number;
  files?: Record<string, unknown>;
}

export interface ParametricManagerOptions {
  idleMs?: number;
  buildTimeoutMs?: number;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  portStart?: number;
  portEnd?: number;
  env?: NodeJS.ProcessEnv;
  isPackaged?: boolean;
  resourcesPath?: string;
  appRoot?: string;
  command?: string;
  isEnabled?: () => boolean;
  onStatus?: (state: ParametricStatusInfo) => void;
}

interface CommandSpec {
  command: string;
  args: string[];
}

interface ExitState {
  version: string;
  token: string;
  port: number;
}

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_BUILD_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;
const DEFAULT_HEALTH_INTERVAL_MS = 300;
const DEFAULT_PORT_START = 7430;
const DEFAULT_PORT_END = 7449;

function isJavaScriptFile(path: string): boolean {
  return ['.js', '.mjs', '.cjs'].includes(extname(path).toLowerCase());
}

function isExecutableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    console.debug('[PARAMETRIC_EXECUTABLE_STAT_FAILED]', { site: 'desktop/electron/parametric.ts', path }, error);
    return false;
  }
}

function pathCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  if (isAbsolute(command) || command.includes('/') || (process.platform === 'win32' && command.includes('\\'))) {
    return [command];
  }
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const paths = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const candidates: string[] = [];
  for (const directory of paths) {
    for (const extension of extensions) candidates.push(join(directory, `${command}${extension}`));
  }
  return candidates;
}

function findExecutable(command: string, env: NodeJS.ProcessEnv): string | null {
  for (const candidate of pathCandidates(command, env)) {
    if (existsSync(candidate) && isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function repoRootFromCwd(): string {
  const cwd = process.cwd();
  if (existsSync(join(cwd, 'spike', 'build123d', 'app.py'))) return cwd;
  const parent = resolve(cwd, '..');
  if (existsSync(join(parent, 'spike', 'build123d', 'app.py'))) return parent;
  return cwd;
}

function electronResourcesPath(): string {
  return (process as unknown as { resourcesPath?: string }).resourcesPath ?? '';
}

/** 优先显式环境变量，其次打包内置 Python，最后 PATH 中的 python3/python。 */
export function resolvePython(env: NodeJS.ProcessEnv = process.env, options: {
  isPackaged?: boolean;
  resourcesPath?: string;
} = {}): string | null {
  const configured = env.AUTOMATIONCAD_PYTHON?.trim();
  if (configured) {
    if (isAbsolute(configured) || configured.includes('/') || configured.includes('\\')) {
      return existsSync(configured) && isExecutableFile(configured) ? configured : null;
    }
    return findExecutable(configured, env);
  }

  if (options.isPackaged) {
    const resources = options.resourcesPath ?? electronResourcesPath();
    if (resources) {
      const bundled = join(resources, 'parametric', 'python', process.platform === 'win32' ? 'python.exe' : 'python');
      if (existsSync(bundled) && isExecutableFile(bundled)) return bundled;
    }
  }

  return findExecutable('python3', env) ?? findExecutable('python', env);
}

/** 开发态使用仓库内 spike 脚本，打包态使用 resources/parametric/app.py。 */
export function resolveScript(options: {
  isPackaged?: boolean;
  resourcesPath?: string;
  appRoot?: string;
} = {}): string | null {
  if (options.isPackaged) {
    const resources = options.resourcesPath ?? electronResourcesPath();
    const path = resources ? join(resources, 'parametric', 'app.py') : '';
    return path && existsSync(path) ? path : null;
  }
  const root = options.appRoot ?? repoRootFromCwd();
  const path = join(root, 'spike', 'build123d', 'app.py');
  return existsSync(path) ? path : null;
}

function parseCommandLine(value: string): CommandSpec | null {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token) tokens.push(token);
  }
  if (tokens.length === 0) return null;
  const [first, ...rest] = tokens;
  if (!first) return null;
  if (isJavaScriptFile(first)) return { command: process.execPath, args: [first, ...rest] };
  return { command: first, args: rest };
}

function randomPortOrder(start: number, end: number): number[] {
  const ports: number[] = [];
  for (let port = start; port <= end; port += 1) ports.push(port);
  for (let index = ports.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [ports[index], ports[swap]] = [ports[swap]!, ports[index]!];
  }
  return ports;
}

async function portAvailable(port: number): Promise<boolean> {
  return await new Promise((resolveAvailable) => {
    const server = createServer();
    server.once('error', () => resolveAvailable(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolveAvailable(true));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([
    new Promise<boolean>((resolveExit) => child.once('exit', () => resolveExit(true))),
    delay(ms).then(() => child.exitCode !== null || child.signalCode !== null)
  ]);
}

export class ParametricManager {
  private readonly options: ParametricManagerOptions;
  private readonly idleMs: number;
  private readonly buildTimeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly healthIntervalMs: number;
  private readonly portStart: number;
  private readonly portEnd: number;

  private state: ParametricStatusInfo = { status: 'stopped', message: '参数化建模内核未启动' };
  private proc: ChildProcess | null = null;
  private port: number | null = null;
  private token: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private startPromise: Promise<ParametricStartInfo> | null = null;
  private expectedStop = false;
  private restartUsed = false;
  private stopping: Promise<void> | null = null;
  private buildChain: Promise<unknown> = Promise.resolve();
  private readonly statusListeners = new Set<(state: ParametricStatusInfo) => void>();
  private generation = 0;

  constructor(options: ParametricManagerOptions = {}) {
    this.options = options;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.buildTimeoutMs = options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.healthIntervalMs = options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    this.portStart = options.portStart ?? DEFAULT_PORT_START;
    this.portEnd = options.portEnd ?? DEFAULT_PORT_END;
    if (options.onStatus) this.statusListeners.add(options.onStatus);
  }

  status(): ParametricStatusInfo {
    return { ...this.state };
  }

  onStatus(listener: (state: ParametricStatusInfo) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  async start(): Promise<ParametricStartInfo> {
    if (!isParametricImportEnabled(this.options.isEnabled)) {
      return { ok: false, status: 'unavailable', code: 'MODULE_DISABLED', message: PARAMETRIC_MODULE_DISABLED_MESSAGE };
    }
    if (this.stopping) await this.stopping;
    if (this.state.status === 'ready' && this.proc && this.port !== null && this.token) {
      return {
        ok: true,
        status: 'ready',
        message: this.state.message,
        port: this.port,
        token: this.token,
        ...(this.state.version ? { version: this.state.version } : {})
      };
    }
    if (this.startPromise) return await this.startPromise;

    this.expectedStop = false;
    this.restartUsed = false;
    this.generation += 1;
    const generation = this.generation;
    this.setStatus('starting', '正在启动参数化建模内核…');
    const pending = this.launch(false, generation);
    const tracked = pending.finally(() => {
      if (this.startPromise === tracked) this.startPromise = null;
    });
    this.startPromise = tracked;
    return await tracked;
  }

  async stop(): Promise<void> {
    this.clearIdleTimer();
    this.startPromise = null;
    this.expectedStop = true;
    this.generation += 1;
    const child = this.proc;
    this.proc = null;
    const previous = this.stopping;
    const work = (async () => {
      if (previous) await previous;
      if (child) await this.killTree(child);
      this.port = null;
      this.token = null;
      this.setStatus('stopped', '参数化建模内核已停止');
    })();
    this.stopping = work.finally(() => {
      this.stopping = null;
    });
    await this.stopping;
  }

  build(doc: FeatureDoc | AssemblyDoc): Promise<ParametricBuildResult> {
    if (!isParametricImportEnabled(this.options.isEnabled)) return Promise.resolve(parametricModuleDisabledBuildResult());
    const run = this.buildChain.then(
      () => this.buildOnce(doc),
      () => this.buildOnce(doc)
    );
    this.buildChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async buildOnce(doc: FeatureDoc | AssemblyDoc): Promise<ParametricBuildResult> {
    try {
      if (!isParametricImportEnabled(this.options.isEnabled)) return parametricModuleDisabledBuildResult();
      const errors = validateFeatures(doc);
      if (errors.length > 0) {
        return { ok: false, code: 'BUILD_FAILED', message: `特征树校验失败：${errors.join('；')}` };
      }
      if (this.state.status !== 'ready' || this.port === null || !this.token) {
        return { ok: false, code: 'UNAVAILABLE', message: '参数化建模内核不可用，请先启动或检查 Python 环境' };
      }
      if (!isParametricImportEnabled(this.options.isEnabled)) return parametricModuleDisabledBuildResult();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.buildTimeoutMs);
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/build`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            ...(isAssemblyDoc(doc)
              ? compileOps(doc)
              : { ops: compileOps(doc) }),
            exports: ['step', 'stl']
          }),
          signal: controller.signal
        });
        const payload = await this.readJson(response);
        if (response.status === 401) {
          return { ok: false, code: 'UNAVAILABLE', message: '建模内核授权失败，请重启内核' };
        }
        if (!response.ok || !payload || payload.ok === false) {
          const detail = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
          return { ok: false, code: 'BUILD_FAILED', message: `建模失败：${detail}` };
        }
        return {
          ok: true,
          ...(payload.stats && typeof payload.stats === 'object' ? { stats: payload.stats as Record<string, unknown> } : {}),
          ...(typeof payload.buildMs === 'number' ? { buildMs: payload.buildMs } : {}),
          ...(payload.files && typeof payload.files === 'object' ? { files: payload.files as Record<string, unknown> } : {})
        };
      } catch (error) {
        if (controller.signal.aborted) {
          return { ok: false, code: 'TIMEOUT', message: '建模超时（30 秒），建议简化特征树后重试' };
        }
        return {
          ok: false,
          code: 'UNAVAILABLE',
          message: '建模内核通信失败，请稍后重试'
        };
      } finally {
        clearTimeout(timer);
        this.armIdleTimer();
      }
    } catch (error) {
      return {
        ok: false,
        code: 'BUILD_FAILED',
        message: `建模失败：${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  private async readJson(response: Response): Promise<Record<string, unknown> | null> {
    try {
      const parsed = await response.json();
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch (error) {
      recordDiagnosticError('PARAMETRIC_RESPONSE_PARSE_FAILED', error, {
        site: 'desktop/electron/parametric.ts',
        status: response.status
      });
      return null;
    }
  }

  private async launch(isRestart: boolean, generation: number): Promise<ParametricStartInfo> {
    if (!isParametricImportEnabled(this.options.isEnabled)) {
      return { ok: false, status: 'unavailable', code: 'MODULE_DISABLED', message: PARAMETRIC_MODULE_DISABLED_MESSAGE };
    }
    if (this.expectedStop || generation !== this.generation) {
      return { ok: false, status: 'stopped', message: this.state.message };
    }
    const spec = this.commandSpec();
    if (!spec) {
      return this.failStart(isRestart, '建模内核不可用：未找到 Python 或 sidecar 脚本', generation);
    }

    let port: number | null = null;
    for (const candidate of randomPortOrder(this.portStart, this.portEnd)) {
      if (await portAvailable(candidate)) {
        port = candidate;
        break;
      }
    }
    if (port === null) {
      return this.failStart(isRestart, `建模内核不可用：${this.portStart}–${this.portEnd} 端口均被占用`, generation);
    }
    if (this.expectedStop || generation !== this.generation) {
      return { ok: false, status: 'stopped', message: this.state.message };
    }
    if (!isParametricImportEnabled(this.options.isEnabled)) {
      return { ok: false, status: 'unavailable', code: 'MODULE_DISABLED', message: PARAMETRIC_MODULE_DISABLED_MESSAGE };
    }
    const token = randomBytes(32).toString('base64url');
    const args = [...spec.args, '--port', String(port), '--token', token];

    let child: ChildProcess;
    try {
      child = spawn(spec.command, args, {
        cwd: this.options.appRoot ?? process.cwd(),
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: this.options.env ?? process.env
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '未知错误';
      return this.failStart(isRestart, `建模内核不可用：进程启动失败（${code}）`, generation);
    }

    this.proc = child;
    this.port = port;
    this.token = token;
    child.stdout?.resume();
    child.stderr?.resume();
    child.once('error', () => {
      if (this.proc === child) this.proc = null;
      if (!this.expectedStop) this.setStatus('unavailable', '建模内核不可用：进程启动失败');
    });
    child.once('exit', () => this.handleExit(child, isRestart));

    const version = await this.waitHealthy(child, port);
    if (!version) {
      if (this.proc === child) {
        this.proc = null;
        await this.killTree(child);
      }
      return this.failStart(isRestart, '建模内核不可用：健康检查在 3 秒内未通过', generation);
    }

    if (this.expectedStop || generation !== this.generation) {
      if (this.proc === child) {
        this.proc = null;
        await this.killTree(child);
      }
      return { ok: false, status: 'stopped', message: this.state.message };
    }

    const info: ExitState = { version, token, port };
    this.setStatus('ready', `参数化建模内核就绪（${info.version}）`, info.version);
    this.armIdleTimer();
    return { ok: true, status: 'ready', message: this.state.message, port, token, version };
  }

  private commandSpec(): CommandSpec | null {
    const configured = this.options.command ?? this.options.env?.AUTOMATIONCAD_PARAMETRIC_CMD
      ?? process.env.AUTOMATIONCAD_PARAMETRIC_CMD;
    if (configured?.trim()) {
      return parseCommandLine(configured.trim());
    }
    const python = resolvePython(this.options.env ?? process.env, {
      ...(this.options.isPackaged !== undefined ? { isPackaged: this.options.isPackaged } : {}),
      ...(this.options.resourcesPath ? { resourcesPath: this.options.resourcesPath } : {})
    });
    const script = resolveScript({
      ...(this.options.isPackaged !== undefined ? { isPackaged: this.options.isPackaged } : {}),
      ...(this.options.resourcesPath ? { resourcesPath: this.options.resourcesPath } : {}),
      ...(this.options.appRoot ? { appRoot: this.options.appRoot } : {})
    });
    if (!python || !script) return null;
    return { command: python, args: [script] };
  }

  private async waitHealthy(child: ChildProcess, port: number): Promise<string | null> {
    const deadline = Date.now() + this.healthTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) return null;
      try {
        const signal = AbortSignal.timeout(Math.min(500, this.healthIntervalMs));
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal });
        if (response.ok) {
          const payload = await this.readJson(response);
          if (payload?.ok === true) {
            return typeof payload.version === 'string' && payload.version ? payload.version : 'unknown';
          }
        }
      } catch (error) {
        // 启动期连接拒绝属于正常情况，继续重试。
        console.debug(`[PARAMETRIC_HEALTH_RETRY]`, { site: 'desktop/electron/parametric.ts:485' }, error);
      }
      await delay(this.healthIntervalMs);
    }
    return null;
  }

  private handleExit(child: ChildProcess, wasRestartLaunch: boolean): void {
    if (this.proc !== child) return;
    this.proc = null;
    this.port = null;
    this.token = null;
    if (this.expectedStop) {
      this.setStatus('stopped', '参数化建模内核已停止');
      return;
    }
    if (!wasRestartLaunch && !this.restartUsed) {
      this.restartUsed = true;
      this.setStatus('starting', '建模内核意外退出，正在自动重启一次…');
      const generation = this.generation;
      const pending = this.launch(true, generation);
      const restart = pending.finally(() => {
        if (this.startPromise === restart) this.startPromise = null;
      });
      this.startPromise = restart;
      void restart;
      return;
    }
    this.setStatus('crashed', '建模内核已崩溃，参数化建模暂不可用');
  }

  private failStart(isRestart: boolean, message: string, generation: number): ParametricStartInfo {
    if (this.expectedStop || generation !== this.generation) {
      return { ok: false, status: 'stopped', message: this.state.message };
    }
    const status: ParametricStatus = isRestart ? 'crashed' : 'unavailable';
    this.setStatus(status, message);
    return { ok: false, status, message };
  }

  private setStatus(status: ParametricStatus, message: string, version?: string): void {
    this.state = { status, message, ...(version ? { version } : {}) };
    for (const listener of this.statusListeners) {
      try {
        listener({ ...this.state });
      } catch (error) {
        // 状态监听器不能影响 sidecar 生命周期。
        console.warn(`[PARAMETRIC_STATUS_LISTENER_FAILED]`, { site: 'desktop/electron/parametric.ts:531' }, error);
      }
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.idleMs <= 0) return;
    this.idleTimer = trackedSetTimeout(() => {
      this.idleTimer = null;
      void this.stop();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      trackedClearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async killTree(child: ChildProcess): Promise<void> {
    const pid = child.pid;
    if (!pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      await new Promise<void>((resolveKill) => {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.once('exit', () => resolveKill());
        killer.once('error', () => resolveKill());
        killer.stdout?.resume();
        killer.stderr?.resume();
      });
      await waitForExit(child, 1_000);
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      // 进程可能已经退出。
      console.debug(`[PARAMETRIC_KILL_TERM_RACE]`, { site: 'desktop/electron/parametric.ts:570' }, error);
    }
    if (!(await waitForExit(child, 1_500))) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        // 忽略退出竞态。
        console.debug(`[PARAMETRIC_KILL_EXIT_RACE]`, { site: 'desktop/electron/parametric.ts:576' }, error);
      }
      await waitForExit(child, 500);
    }
  }
}
