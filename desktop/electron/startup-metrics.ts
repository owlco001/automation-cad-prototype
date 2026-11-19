/**
 * 启动分段计时（主进程侧，纯函数 + 注入时钟）。
 *
 * 口径边界（不接受「看起来更快」的字段命名）：
 * - `readyToShowMs` 来自 `BrowserWindow` 的 `ready-to-show`：Electron 在渲染进程画过第一帧之后才触发，
 *   是「窗口能显示而不闪白」的最早可靠信号；但它仍然是渲染进程里的绘制，**不等于合成器/GPU 真正 present 的时刻**。
 * - `loadMs` 来自 `webContents` 的 `did-finish-load`：DOM 与子资源加载完成，**还没有出图**，
 *   所以字段叫 load，不叫 paint / firstPaint。
 * - 因此本模块不产出 `paintMs` / `firstPaintMs`；要像素级首帧请走真实截图通道（capturePage），不要拿这两个数顶。
 * - `extensionMs` 是内置扩展脚本注入完成（`executeJavaScript` 返回）的时刻，属于应用自己的启动成本。
 *
 * 起点口径（**别把它读成「进程起跑到首帧」**）：
 * - 零点 = `createStartupRecorder()` 被求值的那一刻。接线方（`main.ts`）在模块顶层调用它，
 *   所以零点 = **main 模块求值点（main-module-evaluation）**：main 的静态 import 图已经跑完、
 *   Electron 自身的 bootstrap（原生启动、app 初始化、模块解析）更早已发生过。
 * - 也就是说：本模块给出的数字**不含** Electron 自身冷启动，也**不含** main 的静态 import 耗时。
 *   要把这两段算进来需要进程级起点（例如 `process.hrtime` 之外的启动戳或 Electron 的 startup 时间戳），
 *   本模块不做，也不在字段名里冒充。
 * - `atMs` / `totalMs` 都是「距零点（main 模块求值）的毫秒数」；`sincePreviousMs` 用**同一个零点**做差，
 *   因此 `Σ sincePreviousMs` 落在 `totalMs` 上（同一口径；差只来自三位小数舍入，每段 ≤ 0.5 ms）。
 *
 * 三条不变量：
 * 1. 零点只在 recorder 创建时读一次；之后每个阶段的时间都相对它，差值一律用**未舍入的 raw 时钟**算，
 *    舍入只发生在写出（`atMs`/`sincePreviousMs`/`totalMs`）时，避免「单调递增的 raw 值因为舍入被判回退」。
 * 2. 没发生的阶段是 `null`（键必存在），不是 0 —— 0 会把「没测到」伪装成「很快」。
 * 3. 顺序错 / 时钟回退一律抛带码的错，不静默排序、不 clamp；重复 mark 幂等（reload / activate 不会崩）；
 *    第一个记录的阶段必须是 `ready`（不允许在空记录上直接记 window/extension 这类后续阶段）。
 */
export const STARTUP_BOUNDARY =
  'readyToShow=renderer first-paint signal (not compositor present); load=did-finish-load (DOM+resources), not a paint';

/** 起点口径常量：日志/文档里引用这句话，避免又写成「进程初始化」或「含 Electron 冷启动」。 */
export const STARTUP_ORIGIN_SEMANTICS =
  'origin=main-module-evaluation (after static imports and Electron bootstrap; excludes both)';

const STARTUP_PHASE_LIST = ['ready', 'window', 'readyToShow', 'load', 'extension'] as const;
export type StartupPhase = (typeof STARTUP_PHASE_LIST)[number];
/** 冻结：`STARTUP_PHASES` 是顺序脊梁的单一来源，运行期被 push 会让 `isStartupPhase` 认下不存在的阶段。 */
export const STARTUP_PHASES: readonly StartupPhase[] = Object.freeze([...STARTUP_PHASE_LIST]);

/** 脊梁的第一个阶段：空记录只能从这里开始（否则「只有 extension 的空壳回执」也能算成功）。 */
export const STARTUP_FIRST_PHASE: StartupPhase = 'ready';

/**
 * 阶段档位：只约束「进程脊梁」（ready → window → 渲染完成 → 扩展注入）。
 * `readyToShow` 与 `load` 同档：Chromium 里首帧和 load 的先后取决于子资源，
 * 硬排会在真机上随机抛错，而这两者在语义上都属于「窗口已经把页面处理完」。
 */
export const STARTUP_PHASE_RANK: Readonly<Record<StartupPhase, number>> = Object.freeze({
  ready: 0,
  window: 1,
  readyToShow: 2,
  load: 2,
  extension: 3
});

/**
 * 允许「晚到」的阶段：`readyToShow` 可能在扩展注入（extension）之后才到 ——
 * xvfb / `--disable-gpu` / 慢首帧下 Chromium 完全可能先 load 完、注入完，再报首帧。
 * 晚到照样记录（它是头条指标，不能因为顺序就丢掉），只要求「window 已经发生过」。
 * 注意 `load` **不**在这个集合里：本应用的 extension 是在 did-finish-load 处理器里注入的，
 * load 出现在 extension 之后说明接线坏了，仍按错序拒绝。
 */
export const STARTUP_LATE_TOLERANT_PHASES: readonly StartupPhase[] = Object.freeze(['readyToShow'] as const);

export const STARTUP_MARK_OUT_OF_ORDER = 'STARTUP_MARK_OUT_OF_ORDER';
export const STARTUP_CLOCK_REGRESSION = 'STARTUP_CLOCK_REGRESSION';
export const STARTUP_MARK_UNKNOWN_PHASE = 'STARTUP_MARK_UNKNOWN_PHASE';

export interface StartupPhaseMark {
  phase: StartupPhase;
  /** 距零点（main 模块求值）的毫秒数，保留三位小数。 */
  atMs: number;
  /**
   * 与上一个已发生阶段的间隔；第一个阶段相对零点。
   * 与 `atMs` **同口径**（都以 main 模块求值为零点），所以 `Σ sincePreviousMs ≈ totalMs`（差只有舍入）。
   * 永不返回 null：`null` 在「间隔」这个语义上没有意义（0 会撒谎，null 会让求和断链）。
   */
  sincePreviousMs: number;
}

export interface StartupSnapshot {
  readyMs: number | null;
  windowMs: number | null;
  readyToShowMs: number | null;
  loadMs: number | null;
  extensionMs: number | null;
  /** 最后一个已发生阶段的时间；一次都没 mark 时为 null。 */
  totalMs: number | null;
  phases: StartupPhaseMark[];
  boundary: string;
}

export interface StartupRecorder {
  /**
   * 记录一个阶段；同一阶段重复 mark 幂等（返回首次记录的**副本**，不读时钟、不改快照）。
   * 返回值是冻结副本：外部改它不会污染内部记录，也改不动（改就抛 TypeError）。
   */
  mark(phase: StartupPhase): StartupPhaseMark;
  /** 只读快照：不读时钟，可重复调用且幂等；每次返回新对象（含 phases 的新副本）。 */
  snapshot(): StartupSnapshot;
  has(phase: StartupPhase): boolean;
}

interface StartupError extends Error {
  code: string;
}

function startupError(code: string, detail: string): StartupError {
  const error = new Error(`${code}: ${detail}`) as StartupError;
  error.code = code;
  return error;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isStartupPhase(value: string): value is StartupPhase {
  return (STARTUP_PHASES as readonly string[]).includes(value);
}

function isLateTolerant(phase: StartupPhase): boolean {
  return STARTUP_LATE_TOLERANT_PHASES.includes(phase);
}

function freezeMark(mark: StartupPhaseMark): StartupPhaseMark {
  return Object.freeze({ ...mark });
}

const PHASE_FIELD: Readonly<Record<StartupPhase, keyof Pick<StartupSnapshot, 'readyMs' | 'windowMs' | 'readyToShowMs' | 'loadMs' | 'extensionMs'>>> =
  Object.freeze({
    ready: 'readyMs',
    window: 'windowMs',
    readyToShow: 'readyToShowMs',
    load: 'loadMs',
    extension: 'extensionMs'
  });

/**
 * @param now 单调时钟；默认 `performance.now()`。注入用（测试里给受控序列）。
 *            注意：recorder 创建时就会读一次作为零点，注入时钟要算上这一次。
 */
export function createStartupRecorder(now: () => number = () => performance.now()): StartupRecorder {
  const origin = now();
  if (!Number.isFinite(origin)) {
    throw startupError(STARTUP_CLOCK_REGRESSION, `零点时钟不是有限数：${origin}`);
  }

  const marks: StartupPhaseMark[] = [];
  /** 与 marks 一一对应的未舍入 raw 时钟：回退判据与差值都用它，舍入只在写出时发生。 */
  const rawAts: number[] = [];
  const byPhase = new Map<StartupPhase, StartupPhaseMark>();
  let lastRank = -1;

  const mark = (phase: StartupPhase): StartupPhaseMark => {
    if (typeof phase !== 'string' || !isStartupPhase(phase)) {
      throw startupError(
        STARTUP_MARK_UNKNOWN_PHASE,
        `未知启动阶段「${String(phase)}」；允许：${STARTUP_PHASES.join(',')}（首帧不叫 paint）`
      );
    }
    const existing = byPhase.get(phase);
    // reload / activate / 重复事件：第二次及以后是幂等空操作，不能再读时钟（读到的值没有意义）
    if (existing) return freezeMark(existing);

    const rank = STARTUP_PHASE_RANK[phase];
    if (marks.length === 0) {
      if (phase !== STARTUP_FIRST_PHASE) {
        throw startupError(
          STARTUP_MARK_OUT_OF_ORDER,
          `第一个阶段必须是 ${STARTUP_FIRST_PHASE}（脊梁从 whenReady 开始）；收到 ${phase}，拒绝在空记录上直接记后续阶段`
        );
      }
    } else if (isLateTolerant(phase)) {
      // 首帧信号可以晚到（晚于 load/extension 都合法），但「window 还没建就有首帧」是不可能的
      if (lastRank < STARTUP_PHASE_RANK.window) {
        throw startupError(
          STARTUP_MARK_OUT_OF_ORDER,
          `阶段 ${phase} 早于 window；已记：${marks.map((entry) => entry.phase).join('→') || '（空）'}`
        );
      }
    } else if (rank < lastRank) {
      const previous = marks[marks.length - 1];
      throw startupError(
        STARTUP_MARK_OUT_OF_ORDER,
        `阶段 ${phase} 晚于 ${previous ? previous.phase : '（无）'} 才到达；已记：${marks.map((entry) => entry.phase).join('→') || '（空）'}`
      );
    }

    const at = now();
    if (!Number.isFinite(at)) {
      throw startupError(STARTUP_CLOCK_REGRESSION, `阶段 ${phase} 的时钟不是有限数：${at}`);
    }
    // 回退判据只比 raw 值：拿 raw 和已舍入的 atMs 比会造出「100.001 < 100.001」这种自相矛盾的假回退。
    const previousRaw = rawAts[rawAts.length - 1];
    const floorRaw = previousRaw === undefined ? origin : previousRaw;
    if (at < floorRaw) {
      throw startupError(
        STARTUP_CLOCK_REGRESSION,
        `阶段 ${phase} 的时钟回退：${roundMs(at - origin)} < ${roundMs(floorRaw - origin)}（相对 main 模块求值零点；单调时钟被破坏，拒绝记录）`
      );
    }

    const recorded: StartupPhaseMark = Object.freeze({
      phase,
      atMs: roundMs(at - origin),
      // 与 atMs 同口径：第一段相对零点，之后相对上一个阶段的 raw 时刻
      sincePreviousMs: roundMs(at - floorRaw)
    });
    marks.push(recorded);
    rawAts.push(at);
    byPhase.set(phase, recorded);
    lastRank = Math.max(lastRank, rank);
    return freezeMark(recorded);
  };

  const snapshot = (): StartupSnapshot => {
    const last = marks[marks.length - 1];
    const result: StartupSnapshot = {
      readyMs: null,
      windowMs: null,
      readyToShowMs: null,
      loadMs: null,
      extensionMs: null,
      totalMs: last ? last.atMs : null,
      phases: marks.map((entry) => ({ ...entry })),
      boundary: STARTUP_BOUNDARY
    };
    for (const entry of marks) {
      result[PHASE_FIELD[entry.phase]] = entry.atMs;
    }
    return result;
  };

  return {
    mark,
    snapshot,
    has: (phase: StartupPhase) => byPhase.has(phase)
  };
}
