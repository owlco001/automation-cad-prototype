import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { recordDiagnosticError } from '../src/shared/diagnostics.ts';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
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

/** 启动失败的结构化分类：不读 stderr 原文也能定位（argparse / 缺包 / 占端口 / 早退 / 超时）。 */
export type ParametricStartFailureCode =
  | 'MODULE_DISABLED'
  | 'COMMAND_NOT_FOUND'
  | 'SPAWN_FAILED'
  | 'PROCESS_EXITED'
  | 'HEALTH_TIMEOUT'
  | 'PORT_UNAVAILABLE';

/** 子进程 stderr 的签名分类。 */
export type ParametricStderrClass =
  | 'argparse'
  | 'missing-module'
  | 'address-in-use'
  | 'permission-denied'
  | 'out-of-memory'
  | 'traceback'
  | 'empty'
  | 'unknown';

export interface ParametricStartInfo {
  ok: boolean;
  status: ParametricStatus;
  message: string;
  code?: ParametricStartFailureCode;
  port?: number;
  token?: string;
  version?: string;
  /** 实测启动耗时（launch 开始 → ready 或失败定性），ms。 */
  elapsedMs?: number;
  /** 子进程自己的 exit code（早退场景）；spawn 失败或无 exit 时为 null。 */
  exitCode?: number | null;
  /** 终止信号（SIGKILL/SIGTERM…），正常 exit 为 null。 */
  signal?: string | null;
  /** stderr 结构化分类。 */
  stderrClass?: ParametricStderrClass;
  /** 已脱敏的 stderr 尾部（本次 token 的完整/分片/截断残片均替换为 [REDACTED]），≤ 4 KB。 */
  stderrTail?: string;
}

export interface ParametricBuildOptions {
  /** 装配体逐件导出 STL（零件树、干涉检查用） */
  perPart?: boolean;
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
  /**
   * 测试注入点：只替换 token 的随机源，长度与熵由注入方负责（默认 randomBytes(32).base64url）。
   * 用于稳定复现「token 以 `-` 开头」这类必须对抗的边界，不改变生产默认值。
   */
  tokenFactory?: () => string;
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

/** waitHealthy 的三种结局：就绪 / 子进程自己死了 / 我们等不及。 */
type HealthOutcome = { kind: 'ready'; version: string } | { kind: 'exited' } | { kind: 'timeout' };

/** 一次 launch 期间子进程退出/失联的证据（exit 事件、close、spawn error 都汇到这里）。 */
interface LaunchExitEvidence {
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: string;
}

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
// 30 s 只够单件小特征；整机（28~94 件逐件导出 STEP/STL）实测 40~120 s，
// 超时会被判 BUILD_FAILED 并回退 TS 网格，用户看到的就是"几何没生成"
const DEFAULT_BUILD_TIMEOUT_MS = 180_000;
// 冷启动 import build123d/OCP：Linux 约 3 s，Windows 实测 35 s。
// 3 s 会让首次建模直接判"内核没起来"，用户看到的就是"几何没生成"。
const DEFAULT_HEALTH_TIMEOUT_MS = 90_000;
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

/**
 * Python 解释器候选：PATH 里的 python3/python/py + 常见 venv 位置。
 *
 * 背景：打包版默认只用 PATH 里的 python，而 build123d 通常装在 venv 里
 * （实测 PATH 上的 python 报 `No module named 'build123d'`，内核直接起不来）。
 */
export function pythonCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const list: string[] = [];
  for (const name of ['python3', 'python', 'py']) {
    const found = findExecutable(name, env);
    if (found) list.push(found);
  }
  const home = env.USERPROFILE || env.HOME || '';
  const roots: string[] = [];
  if (env.VIRTUAL_ENV) roots.push(env.VIRTUAL_ENV);
  if (home) {
    roots.push(join(home, 'venvs'));
    roots.push(join(home, '.venvs'));
    roots.push(join(home, '.virtualenvs'));
  }
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    // VIRTUAL_ENV 本身就是一个 venv；venvs/ 下则是多个 venv 的父目录
    const direct = pythonInVenv(root);
    if (direct) list.push(direct);
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      const candidate = pythonInVenv(join(root, entry));
      if (candidate) list.push(candidate);
    }
  }
  return [...new Set(list)];
}

function pythonInVenv(dir: string): string | null {
  const candidates = process.platform === 'win32'
    ? [join(dir, 'Scripts', 'python.exe'), join(dir, 'python.exe')]
    : [join(dir, 'bin', 'python3'), join(dir, 'bin', 'python')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * 检查解释器能否 import build123d 且工作正常：看 sys.prefix 下的 site-packages，
 * 不实际 import（import 一次要 6~7 秒，只用于启动时选路）。
 */
export function hasBuild123d(python: string): boolean {
  try {
    const probe = spawnSync(python, ['-c', 'import sys;print(sys.prefix)'], { encoding: 'utf8', timeout: 15000 });
    if (probe.status !== 0) return false;
    const prefix = (probe.stdout || '').trim();
    if (!prefix) return false;
    if (existsSync(join(prefix, 'Lib', 'site-packages', 'build123d'))) return true;
    const libDir = join(prefix, 'lib');
    if (!existsSync(libDir)) return false;
    for (const entry of readdirSync(libDir)) {
      if (existsSync(join(libDir, entry, 'site-packages', 'build123d'))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 解释器能否真正 import build123d。
 *
 * 只看 site-packages 不够：实测有个 venv 明明装了 build123d，但它的 Pillow 坏了，
 * import 时崩在 `cannot import name '_imaging' from 'PIL'`，内核照样起不来。
 * 这里实际跑一次 import（首次 6~7 秒），失败就换下一个候选。
 */
export function canImportBuild123d(python: string): boolean {
  try {
    const probe = spawnSync(python, ['-c', 'import build123d'], { encoding: 'utf8', timeout: 90_000 });
    return probe.status === 0;
  } catch {
    return false;
  }
}

/** 选一个真能 import build123d 的解释器；都不行则回退到第一个可用解释器（错误信息仍可读）。 */
export function selectKernelPython(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    // 先做便宜的目录检查，避免为明显没装的解释器付 7 秒 import 代价
    if (!hasBuild123d(candidate)) continue;
    if (canImportBuild123d(candidate)) return candidate;
  }
  return candidates[0] ?? null;
}

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

  // 没有显式配置、也没有随包 python：在 PATH 与常见 venv 里挑一个装了 build123d 的
  return selectKernelPython(pythonCandidates(env));
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

export interface BrepInterferenceHit {
  a: string;
  b: string;
  volumeMm3: number;
  ratio: number;
  severity: string;
}

export interface BrepInterferenceResult {
  ok: boolean;
  code?: string;
  message?: string;
  parts?: number;
  candidates?: number;
  checks?: number;
  hits?: BrepInterferenceHit[];
  elapsedMs?: number;
  tolerances?: { volumeMm3: number; ratio: number };
}

/**
 * 跑 B-Rep 精确干涉脚本（OCP 布尔）。超时/解析失败都返回结构化结果，不抛异常给 UI。
 * 注意：这是 O(n²) 的布尔运算，几十件就要几十秒；脚本自己会在零件/候选对超限时拒绝。
 */
export async function runBrepInterferenceScript(options: {
  python: string;
  script: string;
  stepPath: string;
  timeoutMs?: number;
  maxParts?: number;
  maxCandidates?: number;
}): Promise<BrepInterferenceResult> {
  const timeoutMs = options.timeoutMs ?? 600_000;
  const args = [options.script, options.stepPath];
  if (options.maxParts !== undefined) args.push('--max-parts', String(options.maxParts));
  if (options.maxCandidates !== undefined) args.push('--max-candidates', String(options.maxCandidates));
  return await new Promise<BrepInterferenceResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: BrepInterferenceResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ChildProcess;
    try {
      child = spawn(options.python, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ ok: false, code: 'SPAWN_FAILED', message: error instanceof Error ? error.message : String(error) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      finish({ ok: false, code: 'TIMEOUT', message: `B-Rep 干涉超时（${Math.round(timeoutMs / 1000)} 秒）：装配太大，先按子装配拆分` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      finish({ ok: false, code: 'SPAWN_FAILED', message: error.message });
    });
    child.on('close', (code) => {
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
      if (!line) {
        finish({ ok: false, code: 'NO_OUTPUT', message: stderr.trim().slice(-400) || `脚本无输出（退出码 ${code}）` });
        return;
      }
      try {
        finish(JSON.parse(line) as BrepInterferenceResult);
      } catch {
        finish({ ok: false, code: 'BAD_OUTPUT', message: `脚本输出不是 JSON：${line.slice(0, 200)}` });
      }
    });
  });
}

/** 上报的 stderr 尾部上限：证据要留，但不能无限缓存子进程输出。 */
export const STDERR_TAIL_BYTES = 4096;
/** 原始缓冲额外留一点余量：被裁剪的边界片段才能被识别成「本次 token 的残片」并抹掉。 */
const STDERR_CAPTURE_HEADROOM_BYTES = 256;
const REDACTED_TEXT = '[REDACTED]';

const STDERR_SIGNATURES: ReadonlyArray<{ klass: ParametricStderrClass; hint: string; pattern: RegExp }> = [
  // `--token -abc` 会被 argparse 当成选项名：`argument --token: expected one argument` → exit 2
  {
    klass: 'argparse',
    hint: '参数解析失败（argparse 拒绝命令行：多半是 --token 的值以 - 开头）',
    pattern: /expected one argument|unrecognized arguments|argument -{1,2}[A-Za-z][\w-]*: /
  },
  {
    klass: 'missing-module',
    hint: '缺包（ModuleNotFoundError：该解释器没装 build123d/OCP）',
    pattern: /ModuleNotFoundError|No module named/
  },
  {
    klass: 'address-in-use',
    hint: '端口被占用（Address already in use）',
    pattern: /Address already in use|EADDRINUSE|Errno (98|48|10048)/
  },
  { klass: 'permission-denied', hint: '权限不足（Permission denied）', pattern: /Permission denied|EACCES/ },
  {
    klass: 'out-of-memory',
    hint: '内存不足或被 OOM 杀掉',
    pattern: /MemoryError|Cannot allocate memory|Out of memory|Killed/
  },
  { klass: 'traceback', hint: 'Python traceback', pattern: /Traceback \(most recent call last\)/ }
];

/** 只看 stderr 签名就能把 argparse / 缺包 / 占端口 分开，不需要把原文塞进结果。 */
export function classifySidecarStderr(text: string): { klass: ParametricStderrClass; hint: string } {
  if (!text.trim()) return { klass: 'empty', hint: '' };
  for (const signature of STDERR_SIGNATURES) {
    if (signature.pattern.test(text)) return { klass: signature.klass, hint: signature.hint };
  }
  return { klass: 'unknown', hint: 'stderr 未匹配到已知签名' };
}

/**
 * 子进程 stderr 的尾部缓存 + 本次 token 脱敏。
 *
 * 三条硬要求：只留尾部（4 KB，不能把整份输出攒在内存里）；本次 token 无论完整出现、
 * 被 write 分片、还是被缓冲裁剪截断，都不得进入结果；脱敏后仍要留下可诊断的上下文。
 */
export class StderrTailCapture {
  private raw = '';
  private readonly limit = STDERR_TAIL_BYTES + STDERR_CAPTURE_HEADROOM_BYTES;
  private readonly secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  /** 每个 data 都走这里：先按完整 token 抹一次（分片跨界靠整段缓冲解决），再裁到上限。 */
  push(chunk: string): void {
    if (!chunk) return;
    this.raw = this.scrub(`${this.raw}${chunk}`, false);
    if (this.raw.length > this.limit) this.raw = this.raw.slice(-this.limit);
  }

  /** 上报用：补抹「裁剪边界只剩 token 后缀」的残片，再截到 4 KB。 */
  tail(): string {
    return this.scrub(this.raw, true).slice(-STDERR_TAIL_BYTES);
  }

  private scrub(text: string, stripHeadFragment: boolean): string {
    if (!this.secret) return text;
    let out = text;
    // 缓冲被裁过之后，开头可能只剩 token 的后半截；长度 ≥6 的后缀才算（1~2 字符会误伤普通日志）。
    if (stripHeadFragment) {
      for (let cut = 1; cut + 6 <= this.secret.length; cut += 1) {
        const fragment = this.secret.slice(cut);
        if (out.startsWith(fragment)) {
          out = `${REDACTED_TEXT}${out.slice(fragment.length)}`;
          break;
        }
      }
    }
    if (out.includes(this.secret)) out = out.split(this.secret).join(REDACTED_TEXT);
    return out;
  }
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
  private readonly tokenFactory: () => string;
  private generation = 0;
  /**
   * 启动期标记：这段时间子进程退出属于「启动失败」，由 launch() 自己定性。
   * 历史上子进程早退会在这里抢跑一次自动重启，把真因和真实尝试次数一起盖掉。
   *
   * 必须按 launch 作用域：stop() 之后立刻 start() 时，旧 launch 可能还卡在健康轮询里，
   * 它的收尾若无条件清标记，会把新 launch 的「启动期」抹成「运行期崩溃」。
   */
  private launchSeq = 0;
  private launchActiveSeq = 0;
  private get launchActive(): boolean {
    return this.launchActiveSeq !== 0;
  }

  constructor(options: ParametricManagerOptions = {}) {
    this.options = options;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.buildTimeoutMs = options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.healthIntervalMs = options.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    this.portStart = options.portStart ?? DEFAULT_PORT_START;
    this.portEnd = options.portEnd ?? DEFAULT_PORT_END;
    // 熵不变：默认仍是 32 字节 CSPRNG → 43 字符 base64url，注入点只换随机源。
    this.tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString('base64url'));
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

  build(doc: FeatureDoc | AssemblyDoc, options: ParametricBuildOptions = {}): Promise<ParametricBuildResult> {
    if (!isParametricImportEnabled(this.options.isEnabled)) return Promise.resolve(parametricModuleDisabledBuildResult());
    const run = this.buildChain.then(
      () => this.buildOnce(doc, options),
      () => this.buildOnce(doc, options)
    );
    this.buildChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async buildOnce(doc: FeatureDoc | AssemblyDoc, options: ParametricBuildOptions = {}): Promise<ParametricBuildResult> {
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
            exports: ['step', 'stl'],
            // 逐件导出：零件树/干涉检查需要独立实体，合并体只有一个网格
            ...(options.perPart === true ? { perPart: true } : {})
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

  /** 启动期边界：launchActive 覆盖整段 launch，子进程在此期间退出不算「运行期崩溃」。 */
  private async launch(isRestart: boolean, generation: number): Promise<ParametricStartInfo> {
    const seq = ++this.launchSeq;
    this.launchActiveSeq = seq;
    try {
      return await this.launchOnce(isRestart, generation, seq);
    } finally {
      // 只清理自己这一代：重叠时新 launch 的标记不能被旧 launch 的收尾抹掉。
      if (this.launchActiveSeq === seq) this.launchActiveSeq = 0;
    }
  }

  private async launchOnce(isRestart: boolean, generation: number, seq: number): Promise<ParametricStartInfo> {
    const startedAt = Date.now();
    if (!isParametricImportEnabled(this.options.isEnabled)) {
      return { ok: false, status: 'unavailable', code: 'MODULE_DISABLED', message: PARAMETRIC_MODULE_DISABLED_MESSAGE };
    }
    if (this.expectedStop || generation !== this.generation) {
      return { ok: false, status: 'stopped', message: this.state.message };
    }
    const spec = this.commandSpec();
    if (!spec) {
      return this.failStart(isRestart, '建模内核不可用：未找到 Python 或 sidecar 脚本', generation, {
        code: 'COMMAND_NOT_FOUND',
        elapsedMs: Date.now() - startedAt
      });
    }

    let port: number | null = null;
    for (const candidate of randomPortOrder(this.portStart, this.portEnd)) {
      if (await portAvailable(candidate)) {
        port = candidate;
        break;
      }
    }
    if (port === null) {
      return this.failStart(isRestart, `建模内核不可用：${this.portStart}–${this.portEnd} 端口均被占用`, generation, {
        code: 'PORT_UNAVAILABLE',
        elapsedMs: Date.now() - startedAt
      });
    }
    if (this.expectedStop || generation !== this.generation) {
      return { ok: false, status: 'stopped', message: this.state.message };
    }
    if (!isParametricImportEnabled(this.options.isEnabled)) {
      return { ok: false, status: 'unavailable', code: 'MODULE_DISABLED', message: PARAMETRIC_MODULE_DISABLED_MESSAGE };
    }
    const token = this.tokenFactory();
    // 必须用 `--token=<值>`：随机 base64url 有 1/64 概率以 `-` 开头，而 `--token -abc`
    // 会被 argparse 当成选项名 → `expected one argument` → exit 2（子进程在监听前就死）。
    const args = [...spec.args, '--port', String(port), `--token=${token}`];

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
      return this.failStart(isRestart, `建模内核不可用：进程启动失败（${code}）`, generation, {
        code: 'SPAWN_FAILED',
        elapsedMs: Date.now() - startedAt
      });
    }

    this.proc = child;
    this.port = port;
    this.token = token;

    const exit: LaunchExitEvidence = { exited: false, code: null, signal: null };
    const stderr = new StderrTailCapture(token);
    const markExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (exit.exited) return;
      exit.exited = true;
      exit.code = code;
      exit.signal = signal;
    };
    child.stdout?.resume();
    // stderr 原先直接 resume() 丢进 /dev/null：CI 里子进程为什么死永远查不出来。
    // 现在只留 4 KB 尾缓冲，并且进结果前按本次 token（含分片/截断残片）脱敏。
    child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
    child.once('error', (error) => {
      exit.spawnError = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      markExit(null, null);
      if (this.proc === child) this.proc = null;
      // 启动期的定性由 launchOnce() 负责，这里不抢着改状态。
      if (this.expectedStop || this.launchActive) return;
      this.setStatus('unavailable', `建模内核不可用：进程启动失败（${exit.spawnError}）`);
    });
    child.once('exit', (code, signal) => {
      markExit(code, signal);
      this.handleExit(child, isRestart, { exit, stderr });
    });

    const health = await this.waitHealthy(child, port, exit);
    const elapsedMs = Date.now() - startedAt;
    if (health.kind !== 'ready') {
      if (this.proc === child) {
        this.proc = null;
        await this.killTree(child);
      }
      const stderrTail = stderr.tail();
      const classified = classifySidecarStderr(stderrTail);
      return this.failStart(
        isRestart,
        this.describeStartFailure(isRestart, health, exit, elapsedMs, classified.hint),
        generation,
        {
          code: health.kind === 'timeout' ? 'HEALTH_TIMEOUT' : exit.spawnError ? 'SPAWN_FAILED' : 'PROCESS_EXITED',
          elapsedMs,
          exitCode: exit.code,
          signal: exit.signal,
          stderrClass: classified.klass,
          stderrTail
        }
      );
    }

    if (this.expectedStop || generation !== this.generation) {
      if (this.proc === child) {
        this.proc = null;
        await this.killTree(child);
      }
      return { ok: false, status: 'stopped', message: this.state.message };
    }

    // ready 之后立刻落下启动期标记：此后崩溃才是「运行期崩溃」，必须保留一次自动重启。
    if (this.launchActiveSeq === seq) this.launchActiveSeq = 0;
    const info: ExitState = { version: health.version, token, port };
    this.setStatus('ready', `参数化建模内核就绪（${info.version}）`, info.version);
    this.armIdleTimer();
    return {
      ok: true,
      status: 'ready',
      message: this.state.message,
      port,
      token,
      version: health.version,
      elapsedMs: Date.now() - startedAt
    };
  }

  /** B-Rep 精确干涉：复用同一个 Python 解释器（OCP 随 build123d 一起装）。 */
  async brepInterference(stepPath: string, options: { timeoutMs?: number; maxParts?: number; maxCandidates?: number } = {}): Promise<BrepInterferenceResult> {
    const python = resolvePython(this.options.env ?? process.env, {
      ...(this.options.isPackaged !== undefined ? { isPackaged: this.options.isPackaged } : {}),
      ...(this.options.resourcesPath ? { resourcesPath: this.options.resourcesPath } : {})
    });
    if (!python) {
      return { ok: false, code: 'PYTHON_NOT_FOUND', message: '没有可用的 Python 解释器：B-Rep 干涉需要装 Python + OCP/build123d' };
    }
    const root = this.options.appRoot;
    const script = root ? join(root, 'spike', 'brep-interference', 'brep_interference.py') : null;
    if (!script || !existsSync(script)) {
      return { ok: false, code: 'SCRIPT_MISSING', message: `找不到干涉脚本：${script ?? '(appRoot 未配置)'}` };
    }
    return await runBrepInterferenceScript({ python, script, stepPath, ...options });
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

  /**
   * 早退与超时必须分开：一种是子进程自己死了（code/signal/stderr 有话说），一种是我们等不及了。
   * 以前两者都返回 null，被同一句写死的「健康检查在 3 秒内未通过」盖住。
   */
  private async waitHealthy(child: ChildProcess, port: number, exit: LaunchExitEvidence): Promise<HealthOutcome> {
    const deadline = Date.now() + this.healthTimeoutMs;
    const hasExited = (): boolean => exit.exited || child.exitCode !== null || child.signalCode !== null;
    while (Date.now() < deadline) {
      if (hasExited()) return { kind: 'exited' };
      try {
        const signal = AbortSignal.timeout(Math.min(500, this.healthIntervalMs));
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal });
        if (response.ok) {
          const payload = await this.readJson(response);
          if (payload?.ok === true) {
            return {
              kind: 'ready',
              version: typeof payload.version === 'string' && payload.version ? payload.version : 'unknown'
            };
          }
        }
      } catch (error) {
        // 启动期连接拒绝属于正常情况，继续重试。
        console.debug(`[PARAMETRIC_HEALTH_RETRY]`, { site: 'desktop/electron/parametric.ts:waitHealthy' }, error);
      }
      if (hasExited()) return { kind: 'exited' };
      await delay(this.healthIntervalMs);
    }
    // 预算用尽前再确认一次：刚好在这轮等待里死掉的子进程不能报成「超时」。
    return hasExited() ? { kind: 'exited' } : { kind: 'timeout' };
  }

  /** 两类失败必须给出不同的话，而且超时这句要用 healthTimeoutMs 实值。 */
  private describeStartFailure(
    isRestart: boolean,
    outcome: HealthOutcome,
    exit: LaunchExitEvidence,
    elapsedMs: number,
    stderrHint: string
  ): string {
    const prefix = isRestart ? '建模内核已崩溃' : '建模内核不可用';
    if (outcome.kind === 'timeout') {
      const seconds = Math.round(this.healthTimeoutMs / 1000);
      return `${prefix}：健康检查在 ${seconds} 秒（${this.healthTimeoutMs} ms）内未通过，实测 ${elapsedMs} ms`;
    }
    if (exit.spawnError) {
      return `${prefix}：进程启动失败（${exit.spawnError}），实测 ${elapsedMs} ms`;
    }
    const code = exit.code === null ? '未知' : String(exit.code);
    const signal = exit.signal ?? '无';
    const hint = stderrHint ? `；stderr：${stderrHint}` : '';
    return `${prefix}：子进程已退出（code=${code} signal=${signal}，启动后 ${elapsedMs} ms）${hint}`;
  }

  private handleExit(
    child: ChildProcess,
    wasRestartLaunch: boolean,
    evidence?: { exit: LaunchExitEvidence; stderr: StderrTailCapture }
  ): void {
    if (this.proc !== child) return;
    this.proc = null;
    this.port = null;
    this.token = null;
    if (this.expectedStop) {
      this.setStatus('stopped', '参数化建模内核已停止');
      return;
    }
    const stderrTail = evidence ? evidence.stderr.tail() : '';
    const classified = classifySidecarStderr(stderrTail);
    if (classified.klass !== 'empty') {
      // 只落分类 + 已脱敏尾部（token 在捕获阶段就替换成 [REDACTED]），尾部再截 600 字符防刷屏。
      console.warn('[PARAMETRIC_SIDECAR_EXIT]', {
        site: 'desktop/electron/parametric.ts:handleExit',
        duringStart: this.launchActive,
        code: evidence?.exit.code ?? null,
        signal: evidence?.exit.signal ?? null,
        stderrClass: classified.klass,
        stderrTail: stderrTail.slice(-600)
      });
    }
    // 启动期退出：定性（PROCESS_EXITED / SPAWN_FAILED、code、signal、stderr 分类）
    // 全部由 launch() 给出。这里不重启、不改状态，否则重启会抢跑并把真因盖掉。
    if (this.launchActive) return;
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

  private failStart(
    isRestart: boolean,
    message: string,
    generation: number,
    evidence: Partial<ParametricStartInfo> = {}
  ): ParametricStartInfo {
    if (this.expectedStop || generation !== this.generation) {
      return { ok: false, status: 'stopped', message: this.state.message };
    }
    const status: ParametricStatus = isRestart ? 'crashed' : 'unavailable';
    this.setStatus(status, message);
    // 显式逐项赋值（不用 ...evidence）：tsconfig 开了 exactOptionalPropertyTypes，
    // 展开 Partial<...> 会把 `code?: X` 变成 `X | undefined` 而不被接受。
    const info: ParametricStartInfo = { ok: false, status, message };
    if (evidence.code !== undefined) info.code = evidence.code;
    if (evidence.elapsedMs !== undefined) info.elapsedMs = evidence.elapsedMs;
    if (evidence.exitCode !== undefined) info.exitCode = evidence.exitCode;
    if (evidence.signal !== undefined) info.signal = evidence.signal;
    if (evidence.stderrClass !== undefined) info.stderrClass = evidence.stderrClass;
    if (evidence.stderrTail !== undefined) info.stderrTail = evidence.stderrTail;
    return info;
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
