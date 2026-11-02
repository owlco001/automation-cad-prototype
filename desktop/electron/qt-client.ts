// Electron 主进程侧的「随包 Qt 原生工作台」启动器。
//
// 纪律：
// - 路径解析、环境注入、退出码文案全是纯函数，node:test 里直接测（不 mock spawn）；
// - 唯一的副作用在 launchQt 里：spawn 一次 exe，留 stderr 头 8 KB，退出时算一句人话；
// - 找不到 exe / 缺 DLL / 900ms 内秒退一律返回 { ok: false, message } —— 调用方（IPC / 菜单）不接异常。
// - 进程退出既走 onExit 回调，也走 subscribeQtExit 广播（IPC 侧靠广播把「后知后觉的退出」送到界面）。
//
// 为什么 Qt 要落在 resources/qt/ 而不是 exe 同级：Qt 与 Electron 都想带
// vcruntime140.dll / msvcp140.dll，摊平会互相覆盖；整目录隔离后，Windows 的
// DLL 搜索顺序以子进程自身目录优先，两边各自加载自己那份。

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const QT_EXE_NAME = 'automationcad-qt.exe';
export const PIPELINE_BUNDLE_NAME = 'machine-design-cli.cjs';
/** Qt 是 GUI 子系统程序：缺 DLL 时窗口不出现、stdout 为空，只能靠退出码认。 */
export const STATUS_DLL_NOT_FOUND = 3221225781;
const STATUS_DLL_NOT_FOUND_SIGNED = STATUS_DLL_NOT_FOUND - 0x1_0000_0000;
/** stderr 只留头部，避免把 Qt 的 qInfo 刷屏全塞进内存/日志。 */
export const STDERR_LIMIT = 8 * 1024;
/**
 * 观察窗：GUI 程序正常起来不会在 900ms 内退出，秒退基本等于启动失败
 * （缺 VC++ 运行库、显卡驱动不认、参数不认）。窗内退出直接判 ok:false，
 * 把「点了没反应」变成一句能看的报错；窗内没退才认为起来了。
 */
export const LAUNCH_GRACE_MS = 900;

export type QtEnv = Record<string, string | undefined>;
export type SpawnLike = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface QtPathInput {
  isPackaged: boolean;
  resourcesPath?: string;
  appRoot?: string;
  env?: QtEnv;
  /** 单测注入点：默认 existsSync（真实文件系统） */
  exists?: (path: string) => boolean;
}

export interface QtExeCandidate {
  source: 'env' | 'packaged' | 'dev';
  path: string;
}

/**
 * Qt 可执行文件候选路径，按优先级：AUTOMATIONCAD_QT_EXE（**仅开发态**）→ 打包态 resources/qt → dev vendor/qt。
 * env 指向的文件不存在时**继续往后找**（配错一个环境变量不该让整个入口报废），
 * 但失败信息里会列出全部候选，不至于「点了没反应」。
 *
 * 打包态不采信 AUTOMATIONCAD_QT_EXE：安装包里 Qt 的位置是确定的，认这个变量等于给
 * 「快捷方式 / 父进程顺手设个环境变量」留一条「拉起任意 exe」的口子（同用户权限，故是 P2 不是 P0）。
 */
export function qtExeCandidates(input: QtPathInput): QtExeCandidate[] {
  const candidates: QtExeCandidate[] = [];
  const fromEnv = input.isPackaged ? undefined : input.env?.AUTOMATIONCAD_QT_EXE?.trim();
  if (fromEnv) candidates.push({ source: 'env', path: fromEnv });
  if (input.isPackaged) {
    if (input.resourcesPath) candidates.push({ source: 'packaged', path: join(input.resourcesPath, 'qt', QT_EXE_NAME) });
  } else if (input.appRoot) {
    candidates.push({ source: 'dev', path: join(input.appRoot, 'vendor', 'qt', QT_EXE_NAME) });
  }
  return candidates;
}

/** 解析 Qt 可执行文件；找不到返回 null（不抛，调用方拼人话）。 */
export function resolveQtExe(input: QtPathInput): string | null {
  const exists = input.exists ?? existsSync;
  for (const candidate of qtExeCandidates(input)) {
    if (exists(candidate.path)) return candidate.path;
  }
  return null;
}

/** 整机管线单文件产物候选路径：打包态 resources/pipeline → dev vendor/pipeline。 */
export function pipelineCandidates(input: QtPathInput): QtExeCandidate[] {
  if (input.isPackaged) {
    return input.resourcesPath
      ? [{ source: 'packaged', path: join(input.resourcesPath, 'pipeline', PIPELINE_BUNDLE_NAME) }]
      : [];
  }
  return input.appRoot
    ? [{ source: 'dev', path: join(input.appRoot, 'vendor', 'pipeline', PIPELINE_BUNDLE_NAME) }]
    : [];
}

export function resolvePipelinePath(input: QtPathInput): string | null {
  const exists = input.exists ?? existsSync;
  for (const candidate of pipelineCandidates(input)) {
    if (exists(candidate.path)) return candidate.path;
  }
  return null;
}

export interface LaunchEnvInput {
  /** Electron 自身的 exe：Qt 用它 + ELECTRON_RUN_AS_NODE 跑 node，客户机不用装 Node */
  electronExePath: string;
  /** 预打包的整机管线（.cjs 单文件） */
  pipelinePath: string;
  env?: QtEnv;
}

/** Electron 主程序的常见文件名：打包态 AutomationCAD(.exe)，开发态 node_modules/electron/dist/electron(.exe)。 */
const ELECTRON_RUNTIME_NAMES = new Set(['automationcad.exe', 'automationcad', 'electron.exe', 'electron']);

/**
 * 取路径末段（同时认 `/` 和 `\`）：node:path 的 basename 在 Linux 上不认 Windows 反斜杠，
 * 而这条判定既要跑在 Windows 真机上，也要能在 Linux 的 CI 里用 Windows 路径做单测。
 */
function exeBaseName(exePath: string): string {
  const normalized = exePath.replace(/\\/g, '/');
  const cut = normalized.lastIndexOf('/');
  return (cut >= 0 ? normalized.slice(cut + 1) : normalized).toLowerCase();
}

/** 这个可执行文件是不是 Electron 主程序（含开发态的 electron / electron.exe）。 */
export function isElectronRuntimePath(exePath: string): boolean {
  return ELECTRON_RUNTIME_NAMES.has(exeBaseName(exePath));
}

/**
 * 给 Qt 子进程准备环境变量。
 * - AUTOMATIONCAD_PIPELINE：Qt 不再 spawn 源码 TS，两边共用同一份预打包产物；
 * - AUTOMATIONCAD_NODE：Qt 内部 QProcess 直接调它（Electron 可执行文件本身就是 node）；
 * - ELECTRON_RUN_AS_NODE=1：让上一条真的以 node 模式跑起来；
 * - AUTOMATIONCAD_NODE_ELECTRON=1：告诉 Qt「这是 Electron，不是 node」——开发态的 runner 叫
 *   electron.exe，Qt 侧若只按 AutomationCAD.exe 认文件名就会判错、不注入 run-as-node，
 *   于是一次按钮弹出第二个 GUI 窗口。Qt 侧以本标记为准，文件名只作兜底。
 * - 其余（PATH 等）一律不动：Qt 需要用户自己的环境。
 */
export function buildLaunchEnv({ electronExePath, pipelinePath, env = {} }: LaunchEnvInput): QtEnv {
  const built: QtEnv = {
    ...env,
    AUTOMATIONCAD_PIPELINE: pipelinePath,
    AUTOMATIONCAD_NODE: electronExePath,
    ELECTRON_RUN_AS_NODE: '1'
  };
  if (isElectronRuntimePath(electronExePath)) built.AUTOMATIONCAD_NODE_ELECTRON = '1';
  return built;
}

/** stderr 只留头部 limit 字节（UTF-8 可能切半字符，展示层再 trim 即可）。 */
export function headBytes(text: string, limit = STDERR_LIMIT): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

/** 退出码 → 一句能贴到对话框里的中文。 */
export function describeQtExit(code: number | null, stderr = ''): string {
  const tail = stderr.trim();
  const withTail = (base: string): string => (tail ? `${base}\n${tail.slice(0, 1200)}` : base);
  if (code === null) return withTail('Qt 工作台已退出（被信号终止，没有退出码）');
  const hex = `0x${(code >>> 0).toString(16).toUpperCase()}`;
  if (code === STATUS_DLL_NOT_FOUND || code === STATUS_DLL_NOT_FOUND_SIGNED) {
    return withTail(
      `Qt 工作台没有启动（${hex}）：缺 VC++ 运行库/DLL，请重装 AutomationCAD 或检查 resources/qt 目录是否完整（windeployqt 漏拷 vcruntime140.dll 时就是这个退出码）`
    );
  }
  if (code === 0) return withTail('Qt 工作台已退出');
  return withTail(`Qt 工作台异常退出（${hex}）`);
}

export interface LaunchQtOptions extends QtPathInput {
  /** Electron 可执行文件（process.execPath） */
  electronExePath: string;
  /** 额外命令行参数，例如 ['--geometry-ui'] */
  args?: string[];
  /** 子进程退出（或被收掉）时回调，message 已人话化 */
  onExit?: (info: QtExitInfo) => void;
  /** 单测注入点；默认 node 的 spawn */
  spawnImpl?: SpawnLike;
}

/** onExit 收到的信息（pid 拿不到时为 null）。 */
export interface QtExitInfo {
  pid: number | null;
  code: number | null;
  signal: string | null;
  stderr: string;
  message: string;
}

/** 进程退出广播的载荷：ipc 侧原样 send 成 'qt:exited'，渲染层按 qt-exit-notice 映射文案。 */
export interface QtExitEvent {
  pid: number;
  code: number | null;
  signal: string | null;
  /** stderr 片段（头部，最多 STDERR_LIMIT 个码元；UTF-8 可能切半字符，展示层自己 trim） */
  stderrTail: string;
}

export type QtLaunchResult =
  | { ok: true; pid: number; exe: string; pipeline: string; alreadyRunning?: true }
  | { ok: false; message: string };

/**
 * launchQt 的返回值：既是「此刻的结论」（同步字段，老调用方照旧能读 ok/pid/message），
 * 也是「观察窗结束后的最终结论」（PromiseLike）。`await launchQt(...)` 拿到的才是真结论：
 * 900ms 内秒退 → { ok:false, message }，窗口内没退 → { ok:true, pid }。
 * ipcMain.handle 会 await 回调的返回值，所以渲染进程沿 Promise 走拿到的就是最终结论。
 */
export type QtLaunchHandle =
  | (Extract<QtLaunchResult, { ok: true }> & PromiseLike<QtLaunchResult>)
  | (Extract<QtLaunchResult, { ok: false }> & PromiseLike<QtLaunchResult>);

// ---- 退出广播（模块级订阅集合） ----

const qtExitListeners = new Set<(event: QtExitEvent) => void>();

/**
 * 订阅「被 launchQt 起的 Qt 进程退出」，返回取消函数。
 * 每个进程退出（含 spawn 失败）广播一次 { pid, code, signal, stderrTail }；
 * 0 是正常收工，要不要提示由订阅方决定。单个订阅方抛异常不影响其他订阅方与进程收尾。
 */
export function subscribeQtExit(listener: (event: QtExitEvent) => void): () => void {
  qtExitListeners.add(listener);
  return () => {
    qtExitListeners.delete(listener);
  };
}

function broadcastQtExit(event: QtExitEvent): void {
  for (const listener of [...qtExitListeners]) {
    try {
      listener(event);
    } catch {
      // 订阅方自己的异常不能影响其他订阅方，更不能影响 activeQt 收尾
    }
  }
}

// ---- 在案进程（集合，不是单个槽位） ----

interface ActiveQtRecord {
  pid: number;
  child: ChildProcess;
  exe: string;
  pipeline: string;
}

/**
 * 在案的 Qt 进程：pid → 记录。用集合而不是单个槽位——单个槽位被后一次 launch 覆盖后，
 * 先起的那只就再也没人收（常驻吃 OCCT 显存），这正是本次要治的病。
 */
const activeQt = new Map<number, ActiveQtRecord>();

function isChildAlive(child: ChildProcess): boolean {
  return typeof child.pid === 'number' && child.exitCode === null && child.signalCode === null;
}

/** 在案且仍存活的首个 pid（没有则 null）。 */
export function activeQtPid(): number | null {
  for (const [pid, record] of activeQt) {
    if (isChildAlive(record.child)) return pid;
  }
  return null;
}

/** 在案且仍存活的全部 pid。 */
export function activeQtPids(): number[] {
  const pids: number[] = [];
  for (const [pid, record] of activeQt) {
    if (isChildAlive(record.child)) pids.push(pid);
  }
  return pids;
}

/**
 * 把「同步结论」和「观察窗结论」拼成一个返回值：字段取自同步结论，
 * then 指向最终结论（不可枚举，别让 JSON.stringify / structuredClone 看见它）。
 */
function withVerdict(fields: QtLaunchResult, finalVerdict: Promise<QtLaunchResult>): QtLaunchHandle {
  const handle: Record<string, unknown> = { ...fields };
  Object.defineProperty(handle, 'then', {
    value: finalVerdict.then.bind(finalVerdict),
    enumerable: false,
    configurable: true
  });
  return handle as unknown as QtLaunchHandle;
}

function settledHandle(result: QtLaunchResult): QtLaunchHandle {
  return withVerdict(result, Promise.resolve(result));
}

/**
 * 拉起随包 Qt 工作台。
 * - 已有存活实例：**不再 spawn**，返回 { ok:true, pid:现有pid, alreadyRunning:true }（连点两下不该漏进程）；
 * - spawn 成功但 900ms 内就退出：结论是失败 —— 这一条把「点了没反应」变成能看的报错；
 * - 同步字段只代表此刻，最终结论用 await 取（见 QtLaunchHandle）。
 */
export function launchQt(options: LaunchQtOptions): QtLaunchHandle {
  const running = activeQtPid();
  if (running !== null) {
    const existing = activeQt.get(running);
    if (existing) {
      return settledHandle({
        ok: true,
        pid: running,
        exe: existing.exe,
        pipeline: existing.pipeline,
        alreadyRunning: true
      });
    }
  }

  const exe = resolveQtExe(options);
  if (!exe) {
    const searched = qtExeCandidates(options).map((candidate) => `${candidate.path}（${candidate.source}）`);
    return settledHandle({
      ok: false,
      message: searched.length
        ? `找不到 Qt 工作台（${QT_EXE_NAME}）：${searched.join(' / ')}。开发态请先跑 node scripts/vendor-qt.mjs（QT_DIST 指向 CI 产出的 Qt dist）。`
        : `找不到 Qt 工作台（${QT_EXE_NAME}）：没有可用的候选路径（缺 appRoot/resourcesPath）。`
    });
  }
  const pipeline = resolvePipelinePath(options);
  if (!pipeline) {
    return settledHandle({
      ok: false,
      message: `找不到预打包整机管线（${PIPELINE_BUNDLE_NAME}）：${pipelineCandidates(options).map((candidate) => candidate.path).join(' / ') || '(无候选路径)'}。请先跑 node scripts/build-pipeline.mjs。`
    });
  }

  const spawnImpl: SpawnLike = options.spawnImpl ?? spawn;
  let stderrTail = '';
  let child: ChildProcess;
  try {
    child = spawnImpl(exe, options.args ?? [], {
      cwd: dirname(exe),
      // Qt 是 GUI 程序：控制台窗口一定要藏掉
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildLaunchEnv({ electronExePath: options.electronExePath, pipelinePath: pipeline, env: options.env ?? {} })
    });
  } catch (error) {
    return settledHandle({
      ok: false,
      message: `Qt 工作台启动失败：${error instanceof Error ? error.message : String(error)}`
    });
  }

  const pid = child.pid;
  if (typeof pid !== 'number') {
    // spawn 失败时进程对象还会发 'error'：挂个空监听，别让它升级成 uncaughtException
    child.once('error', () => undefined);
    return settledHandle({ ok: false, message: `Qt 工作台启动失败：spawn 没有返回进程号（${exe}）` });
  }

  child.stderr?.on('data', (chunk: unknown) => {
    if (stderrTail.length >= STDERR_LIMIT) return;
    stderrTail = headBytes(stderrTail + String(chunk));
  });
  child.stdout?.resume();

  activeQt.set(pid, { pid, child, exe, pipeline });

  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let verdictSettled = false;
  let resolveVerdict: (result: QtLaunchResult) => void = () => undefined;
  const finalVerdict = new Promise<QtLaunchResult>((resolve) => {
    resolveVerdict = resolve;
  });
  /** 只认第一次结论：观察窗结论先到就以它为准，退出事件晚到不再改写。 */
  const conclude = (result: QtLaunchResult): void => {
    if (verdictSettled) return;
    verdictSettled = true;
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
    resolveVerdict(result);
  };

  let finished = false;
  const finish = (code: number | null, signal: string | null, spawnErrorMessage?: string): void => {
    if (finished) return;
    finished = true;
    activeQt.delete(pid);
    const message = spawnErrorMessage ?? describeQtExit(code, stderrTail);
    broadcastQtExit({ pid, code, signal, stderrTail });
    options.onExit?.({ pid, code, signal, stderr: stderrTail, message });
    // 观察窗内退出 = 启动失败；窗口过了则只广播，不改已经给出的结论
    conclude({ ok: false, message });
  };

  child.once('error', (error: Error) => {
    finish(null, null, `Qt 工作台启动失败：${error.message}（${exe}）`);
  });
  child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    finish(code, signal);
  });

  graceTimer = setTimeout(() => {
    graceTimer = null;
    conclude({ ok: true, pid, exe, pipeline });
  }, LAUNCH_GRACE_MS);

  return withVerdict({ ok: true, pid, exe, pipeline }, finalVerdict);
}

/**
 * 收掉在案的全部 Qt 进程（Electron 退出时调）：win32 用 `taskkill /PID <pid> /T /F` 连子孙进程一起，
 * 其他平台 SIGTERM。返回是否真的发过信号；杀完清空记录（留着会让「已在运行」误判）。
 * killImpl 是单测注入点：win32 分支在生产里跑不到，argv 写错不会有人发现。
 */
export function killActiveQt(platform: string = process.platform, killImpl: SpawnLike = spawn): boolean {
  const records = [...activeQt.values()];
  activeQt.clear();
  let signalled = false;
  for (const record of records) {
    const pid = record.child.pid;
    if (typeof pid !== 'number') continue;
    if (platform === 'win32') {
      try {
        const killer = killImpl('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.once('error', () => undefined);
        signalled = true;
      } catch {
        // 进程可能已退出，忽略
      }
      continue;
    }
    try {
      record.child.kill('SIGTERM');
      signalled = true;
    } catch {
      // 已退出，忽略
    }
  }
  return signalled;
}
