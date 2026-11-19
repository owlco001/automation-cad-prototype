#!/usr/bin/env node
/**
 * 严格 180mm 单塔缓存机「可重复验证」入口。
 *
 * 为什么单独一条入口：`npm run machine:e2e` 走的是 UI 点击 + 参数化桩，拿不到「真实 B-Rep 的
 * 180mm 八层工程」；一次性探针 `pv-180-probe.mjs` 硬编码路径、失败不留结论。本脚本把那条
 * 已跑通的路径固化成可重复门禁：
 *
 *   全新独立运行目录（每次 mkdtemp，绝不复用）
 *     → 独立 userData（运行目录内，或 scratch 根内一个尚不存在的新目录）
 *     → 独立空闲 CDP 端口
 *     → xvfb-run + electron --machine-e2e-host
 *     → CDP 调 __AgentBridge.buildMachineModel（内部真实逐件实体化 + 保存到工程库）
 *     → 保存后读回：params / STEP / BOM / 90 对 90 场景完整性 / 包络
 *     → 任一不符即非零退出；进程只按「本轮进程组 + 精确 ownership 证据」清理
 *
 * 明确的能力边界（不要读错）：
 *   - `layers: 8` 只等于 **8 个储位**（第 1 层是底层输送线），**不是 16 位**。16 位是**塔产品**
 *     口径，只存在于 `bufferTower` 纯数据槽位模型里。本脚本不会把 8 层冒充 16 位，且回执把两个
 *     口径分成两个作用域：`modelClaim {slots:8, aligned:true, source:'project-parts'}` 与
 *     `productClaim {slots:16, aligned:false, basis:'cross-model-unverified',
 *     crossModelEquality:false, coveredBy:'verify:step-tower --levels 16',
 *     saveReloadCovered:false}`。只有 `modelClaim.aligned` 进门禁；`productClaim.aligned` **恒为
 *     false**——本机几何即使恰好数到 16 也不能宣称「塔已对齐」（塔根本不在本脚本路径上），
 *     数值相等只写进 `crossModelEquality`（true / false / null）当信息，**不翻转退出码**。
 *   - `slotsFromGeometry` 是**从盘上工程零件表派生的**（`slotsFromGeometryParts`：托板/托条/
 *     挡停/层光电四族逐层数，柱数派生塔数），不是 `params.layers` 回声；几何里整层丢件、
 *     每层件数不对、立柱不足 4 根都会让 `disk.slots.*` 红。
 *   - 90 对 90 只证明「模型件数与场景件数一致」，不证明几何正确：180mm 下的 lift/sweep/push
 *     动态干涉、结构强度、挠度、防坠均未校核。这里的结论只能写成「路径可重复、产物可读回」。
 *   - 本脚本不改产品代码、不写产品 userData、不读任何密钥。
 *
 * 用法：
 *   node scripts/pv-buffer-regenerate.mjs                  # 全新隔离 userData，180mm 八层
 *   node scripts/pv-buffer-regenerate.mjs --dry-run        # 只打印计划，不启动 Electron
 *   node scripts/pv-buffer-regenerate.mjs --user-data DIR  # scratch 根内一个尚不存在的新目录
 *   node scripts/pv-buffer-regenerate.mjs --report FILE     # 只能落在本轮运行目录内
 *   npm run regen:pv-buffer
 *
 * 退出码：0 = 全部门禁通过；1 = 检查失败 / 超时 / 进程异常；2 = 用法或参数错误；
 *        130 = 被 SIGINT 中断；143 = 被 SIGTERM 中断（两者都会先清理本轮进程再落报告）。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** desktop/ 根：脚本固定从自己位置推导，避免 cwd 不同就找不到 electron-run.mjs */
const desktopRoot = resolve(here, '..');
/** repo 根：报告/userData 都不许落到这里 */
const repoRoot = resolve(desktopRoot, '..');
/** 结论/临时目录：默认落在 Hermes scratch，绝不写进仓库 */
const defaultScratch = join(homedir(), '.hermes', 'cache', 'scratch');

/**
 * 基线：这些数字来自真实生成结果（90 件 / 包络 2430×1690×2400 / 782KB STEP），
 * 是"严格 180mm 路径没退化"的锚点。改了机型参数就不该再走基线断言（--allow-non-baseline）。
 */
export const BASELINE = Object.freeze({
  process: 'conveyor',
  name: 'PV缓存单塔8位概念验证-180',
  params: Object.freeze({
    lengthMm: 2400,
    widthMm: 1200,
    beltHeightMm: 900,
    layers: 8,
    layerPitchMm: 180
  }),
  parts: 90,
  envelope: Object.freeze([2430, 1690, 2400]),
  /**
   * 真 B-Rep STEP 实测 1,622,322 B（T2 修复整机 fuse 丢件后；修复前那份"已验收"的
   * 781,970 B 实际只有 47 实体、顶点 z 只到 2196/2400，是丢件产物）。
   * 参数化桩只有几 KB，用它区分"真几何"与"占位几何"。
   */
  minStepBytes: 200_000,
  minStlBytes: 500_000,
  /**
   * 实测 55 个 MANIFOLD_SOLID_BREP / 538 个 ADVANCED_FACE（90 件里相邻件被布尔并成一体）。
   * 修复前是 47/264（丢件版）；这里仍是**下限**，完整性由 `verify:step-tower --levels 8`
   * 按"整机 STEP 顶点并集 == 逐件 STL 并集"判，字节数/实体数下界挡不住丢件。
   */
  minSolidBreps: 40,
  minAdvancedFaces: 200,
  /**
   * 参数声明口径的**期望**储位数（不是几何派生值）。第 1 层是底层输送线，所以 8 层只有
   * 8 个储位。运行期真正的 `slotsFromGeometry` 走 `slotsFromGeometryParts()`——从盘上
   * 工程零件表逐族数出来；这个函数只用来写计划里的「期望」与基线断言。
   */
  slotsFromLayers: (layers) => layers,
  /**
   * **塔产品口径**的声明容量（16 位只存在于 bufferTower 纯数据槽位模型里，几何路径没有）。
   *
   * 这是 `productClaim.slots` 的唯一来源，**不是本机型的声明**——本机型的声明是
   * `modelClaim.slots = slotsFromLayers(layers)`（8 层 ⇒ 8 位）。两个口径绝不在同一字段里
   * 相减：旧实现把 16 当成本轮声明的 `claimedSlots`，于是 8 层机型的 `aligned` 恒为 false，
   * 读的人会以为「8 层丢了 8 个储位」。分层后各作用域只跟自己那条声明比。
   */
  claimedSlots: 16,
  /** 塔 16 位缺口的覆盖点：`verify-step-tower --levels 16`（该路径**不经过**工程库落盘） */
  productCoveredBy: 'verify:step-tower --levels 16'
});

/** 有真实智能体结果、不允许被本脚本当 userData/报告落点的旧真实 PV 工程 */
export const PROTECTED_USER_DATA = Object.freeze([
  '/tmp/automationcad-pv-buffer-live',
  '/tmp/automationcad-pv-buffer-iter'
]);

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const READY_TIMEOUT_MS = 120_000;
/** buildMachineModel 实测 18.7s；给 5 倍余量，超时即视为挂死 */
const BUILD_TIMEOUT_MS = 300_000;

/** 工程名白名单：应用侧 sanitizeId 允许的字符（ASCII 字母数字 / 下划线 / 短横 / 汉字），
 *  1–48 字符，且必须是「已经消毒过」的形态（解析后仍等于自身）。 */
export const PROJECT_NAME_PATTERN = /^[A-Za-z0-9\u4e00-\u9fa5_-]{1,48}$/;

/** 与 electron/projects.ts 的 sanitizeId 保持一致；用于盘上目录名，绝不用原始 name 拼路径 */
export function sanitizeProjectId(value) {
  const safe = String(value).replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return safe || 'project';
}

/** 白名单校验：不满足就不许跑（避免 `../../x`、空格、控制字符进入路径） */
export function validateProjectName(name) {
  if (typeof name !== 'string' || !PROJECT_NAME_PATTERN.test(name) || sanitizeProjectId(name) !== name) {
    throw new Error(`--name 只允许 1–48 位字母/数字/汉字/下划线/短横（且不能以短横开头结尾），实际 ${JSON.stringify(name)}`);
  }
  return name;
}

// ---------------------------------------------------------------- 受保护路径

/**
 * 受保护根：两个方向都要拦——
 *   inside 方向：目标在这些目录里（真实应用配置、旧真实工程、仓库）
 *   ancestor 方向：目标本身是它们的祖先（`/tmp` 是旧 live 工程的祖先，`$HOME` 是配置目录的祖先）
 * 只做**整段路径比较**，不做字符串子串匹配。
 */
function protectedRules({ home = homedir(), env = process.env } = {}) {
  const configHome = (env.XDG_CONFIG_HOME || '').trim() || join(home, '.config');
  const exact = new Set([
    resolve('/'),
    resolve('/tmp'),
    resolve('/home'),
    resolve(home)
  ]);
  const inside = new Set([
    resolve(join(configHome, 'AutomationCAD')),
    resolve(join(configHome, 'automationcad')),
    resolve(join(home, '.config')),
    repoRoot,
    desktopRoot,
    ...PROTECTED_USER_DATA.map((item) => resolve(item))
  ]);
  const ancestorsOf = new Set([...exact, ...inside]);
  return { exact, inside, ancestorsOf };
}

/** 该路径是否受保护（或本身就是受保护路径的祖先 / 软链到受保护路径） */
export function isProtectedUserData(dir, options = {}) {
  let target;
  try {
    target = resolve(dir);
    // 存在的路径先按真实路径比较：软链到受保护目录必须也判 true
    if (existsSync(target)) target = realpathSync(target);
  } catch {
    return true;
  }
  const depth = target.split(sep).filter(Boolean).length;
  // `/`(=0)、`/tmp`(=1)、`$HOME/x`(=2) 这类浅目录一律拒绝：它们通常是受保护工程的祖先
  if (depth < 3) return true;
  const rules = protectedRules(options);
  for (const root of rules.exact) if (target === root) return true;
  for (const root of rules.inside) {
    if (target === root) return true;
    if (target.startsWith(root + sep)) return true;
  }
  for (const root of rules.ancestorsOf) {
    if (root.startsWith(target + sep)) return true;
  }
  return false;
}

/** 逐段检查既有组件：拒绝任何符号链接（userData / report 都不许穿过软链） */
export function assertNoSymlink(target, label = '路径') {
  const absolute = resolve(target);
  const parts = absolute.split(sep).filter(Boolean);
  let current = sep;
  for (const part of parts) {
    current = join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`拒绝符号链接作为 ${label}：${current}`);
    if (!info.isDirectory() && current !== absolute) throw new Error(`${label} 的父路径不是目录：${current}`);
  }
}

/** scratch 根：默认 Hermes scratch；可用 PV_REGEN_SCRATCH 覆盖，但不许指向受保护目录 */
export function resolveScratchRoot({ env = process.env, home = homedir(), create = true } = {}) {
  const raw = env.PV_REGEN_SCRATCH?.trim();
  const root = raw ? resolve(raw) : join(home, '.hermes', 'cache', 'scratch');
  if (!isAbsolute(root)) throw new Error(`scratch 根必须是绝对路径：${raw}`);
  if (isProtectedUserData(root, { env, home })) throw new Error(`拒绝把受保护目录当作 scratch 根：${root}`);
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  assertNoSymlink(root, 'scratch 根');
  if (existsSync(root) && realpathSync(root) !== root) {
    throw new Error(`scratch 根解析后与字面路径不一致（疑似符号链接）：${root}`);
  }
  return root;
}

/**
 * 校验「一个全新的、位于 scratch 根内的目录」。拒绝：
 *   - 相对路径 / 空值
 *   - 受保护目录、受保护目录的祖先
 *   - scratch 根本身或根外路径
 *   - 任何一段符号链接
 *   - 已经存在的目录（不复用既有 userData）
 */
export function assertFreshDir(dir, { root, label = '目录', ...options } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error(`${label} 不能为空`);
  if (!isAbsolute(dir)) throw new Error(`${label} 必须是绝对路径：${dir}`);
  const absolute = resolve(dir);
  if (isProtectedUserData(absolute, options)) throw new Error(`拒绝使用受保护目录作为 ${label}：${absolute}`);
  if (root) {
    const base = resolve(root);
    if (absolute === base) throw new Error(`拒绝把 scratch 根本身当作 ${label}：${absolute}`);
    if (!absolute.startsWith(base + sep)) {
      throw new Error(`拒绝把 scratch 之外的目录当作 ${label}：${absolute}（只允许 ${base} 下新建）`);
    }
  }
  assertNoSymlink(absolute, label);
  if (existsSync(absolute)) throw new Error(`拒绝复用既有 ${label}（目录已存在）：${absolute}`);
  return absolute;
}

/** 真正创建（非递归：父目录必须已存在；创建后 realpath 必须等于字面路径） */
export function createFreshDir(dir, { mode = 0o700, ...options } = {}) {
  const absolute = assertFreshDir(dir, options);
  mkdirSync(absolute, { recursive: false, mode });
  const real = realpathSync(absolute);
  if (real !== absolute) {
    try { rmSync(absolute, { recursive: true, force: true }); } catch { /* 尽力 */ }
    throw new Error(`创建后路径被解析到别处（疑似符号链接）：${real}`);
  }
  return absolute;
}

/** 本轮唯一的运行目录（mkdtemp 保证唯一；绝不与遗留进程共用） */
export function createRunDir(scratchRoot) {
  const base = resolve(scratchRoot);
  const dir = realpathSync(mkdtempSync(join(base, 'pv-buffer-regen-')));
  if (dirname(dir) !== base) throw new Error(`运行目录不在 scratch 根内：${dir}`);
  return dir;
}

/** 报告只允许是「本轮运行目录内尚不存在的新文件」——不能覆盖任何用户指定的文件 */
export function assertReportTarget(reportPath, { ownedDir, ...options } = {}) {
  if (typeof reportPath !== 'string' || !reportPath.trim()) throw new Error('--report 缺少路径');
  if (!isAbsolute(reportPath)) throw new Error(`--report 必须是绝对路径：${reportPath}`);
  const absolute = resolve(reportPath);
  const owned = resolve(ownedDir);
  if (absolute === owned || !absolute.startsWith(owned + sep)) {
    throw new Error(`--report 只能写本轮新建运行目录内：${owned}（收到 ${absolute}）`);
  }
  if (isProtectedUserData(absolute, options)) throw new Error(`拒绝把报告写入受保护目录：${absolute}`);
  if (!/\.json$/i.test(absolute)) throw new Error(`--report 必须是 .json 文件：${absolute}`);
  assertNoSymlink(absolute, '--report');
  if (existsSync(absolute)) throw new Error(`拒绝覆盖既有报告文件：${absolute}`);
  return absolute;
}

/** 独占创建：'wx' 保证「已存在就失败」，把 TOCTOU 挡在写盘那一刻 */
function writeNewFile(file, text) {
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------- 参数

function usage() {
  return [
    '用法：node scripts/pv-buffer-regenerate.mjs [选项]',
    '',
    '  --dry-run              只打印运行计划与断言，不启动 Electron',
    '  --user-data <dir>      scratch 根内一个「尚不存在」的新目录；既有目录/软链/受保护目录一律拒绝',
    '  --report <file>        只能写本轮新建运行目录内的新 .json；默认 <运行目录>/report.json（每次唯一）',
    '  --name <工程名>        默认 ' + BASELINE.name,
    '  --layers <n>           默认 8（8 层 = 8 储位，不等于 16 位）',
    '  --pitch <mm>           层距，默认 180',
    '  --timeout <ms>         整体看门狗，默认 ' + DEFAULT_TIMEOUT_MS,
    '  --allow-non-baseline   非基线参数时只记录件数/包络，不做基线断言',
    '  --help                 打印本帮助',
    '',
    '退出码：0 通过 / 1 检查失败 / 2 用法错误 / 130 SIGINT / 143 SIGTERM'
  ].join('\n');
}

/**
 * 解析参数。未知选项直接抛错（由 CLI 转成退出码 2），不做静默忽略——
 * 静默忽略会让「我明明传了 --pitch 180 但跑的是默认值」这种事查不出来。
 */
export function parseArgs(argv = []) {
  const options = {
    help: false,
    dryRun: false,
    userData: null,
    reportPath: null,
    name: BASELINE.name,
    params: { ...BASELINE.params },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    allowNonBaseline: false
  };
  const need = (index, flag) => {
    const value = argv[index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 缺少取值`);
    return value;
  };
  const positiveInt = (raw, flag, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const text = String(raw).trim();
    if (!/^\d+$/.test(text)) throw new Error(`${flag} 必须是正整数，实际 ${JSON.stringify(raw)}`);
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${flag} 必须在 ${min}–${max} 之间，实际 ${text}`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--user-data':
        options.userData = need((index += 1), flag);
        break;
      case '--report':
        options.reportPath = need((index += 1), flag);
        break;
      case '--name':
        options.name = validateProjectName(need((index += 1), flag));
        break;
      case '--layers':
        options.params.layers = positiveInt(need((index += 1), flag), flag, { max: 512 });
        break;
      case '--pitch':
        options.params.layerPitchMm = positiveInt(need((index += 1), flag), flag, { max: 10_000 });
        break;
      case '--timeout':
        options.timeoutMs = positiveInt(need((index += 1), flag), flag, { min: 1000, max: 3_600_000 });
        break;
      case '--allow-non-baseline':
        options.allowNonBaseline = true;
        break;
      default:
        throw new Error(`未知选项 ${flag}`);
    }
  }
  options.baseline = options.params.layers === BASELINE.params.layers
    && options.params.layerPitchMm === BASELINE.params.layerPitchMm;
  return options;
}

// ---------------------------------------------------------------- 端口 / 启动

/** 取一个当前空闲的本地端口（listen(0) 后立刻关闭；与遗留实例抢端口是本仓库的老坑） */
export async function freePort() {
  return await new Promise((done, fail) => {
    const server = createServer();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/**
 * 装配启动命令。userData 与端口只通过环境变量传给 electron-run.mjs——
 * `--machine-e2e-host` 在 electron/main.ts 里读它们，否则会写到真实 userData、固定 9229。
 */
export function buildLaunchSpec({ port, userData, hasXvfb = true }) {
  const passthrough = [
    'scripts/electron-run.mjs',
    '--machine-e2e-host',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader'
  ];
  const env = {
    AUTOMATIONCAD_E2E_USERDATA: resolve(userData),
    AUTOMATIONCAD_E2E_CDP_PORT: String(port)
  };
  if (!hasXvfb) {
    // 没有 xvfb-run 时退回直接起 Electron（要求已有 DISPLAY，否则会立刻失败）
    return { command: process.execPath, args: passthrough, env };
  }
  return {
    command: 'xvfb-run',
    args: ['-a', '-s', '-screen 0 1920x1200x24', process.execPath, ...passthrough],
    env
  };
}

/** 运行计划（--dry-run 与实际启动共用同一份，避免"计划是一套、跑的是另一套"） */
export function planSummary(options, { userData, port, reportPath, runDir }) {
  return {
    runDir: runDir ? resolve(runDir) : null,
    userData: resolve(userData),
    port,
    reportPath: resolve(reportPath),
    name: options.name,
    projectDir: join('projects', sanitizeProjectId(options.name)),
    params: { ...options.params },
    process: BASELINE.process,
    baseline: options.baseline,
    timeoutMs: options.timeoutMs,
    expect: {
      parts: BASELINE.parts,
      envelope: [...BASELINE.envelope],
      minStepBytes: BASELINE.minStepBytes,
      minStlBytes: BASELINE.minStlBytes,
      // 计划阶段的「期望」：参数声明口径。运行期真正的几何派生值见 disk.slots.*（从盘上
      // project.json 的 partsList 逐族数出来），计划里没有零件表就不冒充。
      slotsFromGeometry: BASELINE.slotsFromLayers(options.params.layers),
      slotsFromGeometrySource: 'params（计划阶段没有几何；运行期由盘上零件表派生，见 note/disk.slots.*）',
      claimedSlots: BASELINE.claimedSlots,
      slotsAligned: BASELINE.slotsFromLayers(options.params.layers) === BASELINE.claimedSlots,
      /**
       * 口径分层（A1）：计划阶段也把两个作用域分开写，别等运行期才分层。
       * 本机型声明 = 参数层数（8 层 ⇒ 8 位）；计划阶段**没有几何**，所以 `modelClaim.aligned`
       * 只能记 null —— 拿参数回声给自己签 true 正是旧实现的病，这里不重犯。
       */
      ...slotClaims({
        fromGeometry: null,
        modelSlots: BASELINE.slotsFromLayers(options.params.layers),
        productSlots: BASELINE.claimedSlots,
        source: 'params-declared'
      })
    }
  };
}

// ---------------------------------------------------------------- 检查列表

/**
 * 极简检查器：每条检查带 name/ok/detail，最后统一打印并决定退出码。
 * 不做 assert 抛错——一次跑完想看到"到底几条不过"，而不是第一条就中断。
 */
export function createChecks() {
  const items = [];
  const add = (name, ok, detail) => {
    items.push({ name, ok: Boolean(ok), detail: detail ?? null });
    return Boolean(ok);
  };
  return {
    items,
    add,
    eq(name, actual, expected) {
      return add(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
    },
    gte(name, actual, min) {
      const value = Number(actual);
      return add(name, Number.isFinite(value) && value >= min, { actual: value, min });
    },
    failed() {
      return items.filter((item) => !item.ok);
    }
  };
}

/** 基线断言之外的降级说明：非基线参数时只记录，不拿它当门禁 */
function soft(checks, options) {
  return !options.baseline && options.allowNonBaseline;
}

// ---------------------------------------------------------------- 储位派生（从几何零件表）

/**
 * 储位件族表：口径照 `src/machine/buffer-tower-assembly.ts` 的 `SLOT_FAMILIES`——
 * 「层数 / 每层位数 / 塔数」三项**全部从零件表数出来**，一项都不抄配置；四个独立件族
 * 逐层核对，所以整层一起丢时不会「两边同减 1」自我抵消（那正是旧实现的漏洞）。
 *
 * 为什么这里额外给了 `namePattern`：本脚本能拿到的最硬证据是盘上
 * `projects/<id>/project.json` 的 `partsList`，而 `electron/projects.ts` 落盘时只保留
 * `{file,name}` —— 件号（`tray-2`）已经丢了（`file` 是 `NNNN-<件名>.stl`，由件名 sanitize 而来）。
 * 所以族判据同时给 idPattern 与 namePattern：谁在就认谁；两个都对不上 = 解析不出，
 * 记错误（fail-closed），绝不按「差不多」猜一个层号。
 */
export const PV_SLOT_FAMILIES = Object.freeze([
  { key: 'tray', label: '托板 tray-*', perLevel: 1, idPattern: /^tray-(\d+)$/, namePattern: /^第\s*(\d+)\s*层托板$/ },
  { key: 'trayRail', label: '托条 tray-rail-*', perLevel: 2, idPattern: /^tray-rail-(\d+)-(?:left|right)$/, namePattern: /^第\s*(\d+)\s*层托条（(?:左|右)）$/ },
  { key: 'stop', label: '挡停 stop-*', perLevel: 1, idPattern: /^stop-(\d+)$/, namePattern: /^第\s*(\d+)\s*层挡停板$/ },
  { key: 'layerSensor', label: '层光电 layer-sensor-*', perLevel: 1, idPattern: /^layer-sensor-(\d+)$/, namePattern: /^第\s*(\d+)\s*层到位光电$/ },
  { key: 'trayRoller', label: '层传动辊 tray-roller-*', perLevel: 2, optional: true, idPattern: /^tray-roller-(\d+)-(?:in|out)$/, namePattern: /^第\s*(\d+)\s*层传动辊（(?:进|出)）$/ }
]);

/** 一件一命中：件号优先，件名兜底；都对不上返回 null（不猜） */
function slotLevelOf(part, family) {
  const id = typeof part?.id === 'string' ? part.id : '';
  if (id) {
    const byId = family.idPattern.exec(id);
    if (byId) return Number(byId[1]);
  }
  const name = typeof part?.name === 'string' ? part.name : '';
  if (name) {
    const byName = family.namePattern.exec(name);
    if (byName) return Number(byName[1]);
  }
  return null;
}

/**
 * 储位口径**分层**（A1）：本机型的 `modelClaim` 与塔产品的 `productClaim` 永远分两个作用域。
 *
 * 为什么必须分层：旧实现把**塔**的 16 位写进本机型的 `claimedSlots`，再让 8 层几何去减它，
 * 得到的 `aligned=false` 既不是「8 层丢了 8 个储位」，也不是「塔容量虚标」——读的人只会得出
 * 错结论。分层后各作用域只跟自己那条声明比：
 *   - `modelClaim.aligned`：本轮几何派生值 == 本机型声明（8 层 ⇒ 8 位）。**只有这条配进门禁**。
 *   - `productClaim.aligned`：**恒为 false**。这是跨机型比较（本机 8 层几何 vs 塔 16 位产品
 *     容量），塔根本不在本脚本路径上，本机几何数到几都不能证明塔已对齐；`basis` 固定
 *     `'cross-model-unverified'`，`saveReloadCovered:false` 写明塔没走「存库 → 盘上读回」。
 *     数值是否恰好相等只写在 `crossModelEquality`（true / false / null）里当**信息**，
 *     任何笔记/回执都不许据此写「塔一致 / 已覆盖 / 16 位完成」。
 *
 * 两个作用域都**不许省略**：几何派生失败（`fromGeometry === null`）时也原样给出来，
 * `aligned` 记 null / false 并标 `basis`，绝不把「量不出来」冒充成 true。
 */
export function slotClaims({
  fromGeometry = null,
  modelSlots = BASELINE.slotsFromLayers(BASELINE.params.layers),
  productSlots = BASELINE.claimedSlots,
  source = 'project-parts'
} = {}) {
  const measured = typeof fromGeometry === 'number' && Number.isFinite(fromGeometry);
  return {
    modelClaim: {
      slots: modelSlots,
      aligned: measured ? fromGeometry === modelSlots : null,
      source
    },
    productClaim: {
      slots: productSlots,
      // 跨机型比较永远不给 true：本机几何再怎么数，也证明不了塔走了存库/读回
      aligned: false,
      basis: 'cross-model-unverified',
      // 纯信息位：数值恰好相等 ≠ 塔已覆盖（null = 本轮没有几何，量不出来）
      crossModelEquality: measured ? fromGeometry === productSlots : null,
      coveredBy: BASELINE.productCoveredBy,
      saveReloadCovered: false
    }
  };
}

/**
 * `slotsFromGeometry` 的唯一派生口。**输入是零件表，不是 `params.layers`**：
 * - 层数：托板件族覆盖第 2..N 层（第 1 层是底层输送线，没有托板），再加回 `transferLevels`；
 * - 每层位数：每层托板件数（一块托板 = 一个储位），不乘 `params.slotsPerLevel`；
 * - 塔数：4 根立柱为一塔，按立柱组数数出来。
 *
 * 任何一项数不出来（缺族、缺层、每层件数不符、层号越界、立柱不足 4 根）都**记 error 并
 * `ok:false`**，不抛错、不返回 NaN 冒充数字——门禁要能一次列全「哪层哪族丢了」。
 */
export function slotsFromGeometryParts(parts, options = {}) {
  const layers = Number(options.layers ?? BASELINE.params.layers);
  const transferLevels = Number(options.transferLevels ?? 1);
  const claimed = Number(options.claimed ?? BASELINE.claimedSlots);
  /** 本机型声明口径：8 层 ⇒ 8 位（塔的 16 位不许混进来，见 slotClaims） */
  const modelSlots = Number.isSafeInteger(Number(options.modelSlots))
    ? Number(options.modelSlots)
    : BASELINE.slotsFromLayers(layers);
  const list = (Array.isArray(parts) ? parts : []).filter((part) => part && typeof part === 'object');
  const errors = [];
  const layerTrace = [];

  if (!Number.isSafeInteger(layers) || layers < 2) {
    errors.push(`层数参数无效（${options.layers}）：至少 2 层才有储位可派生`);
    return {
      ok: false, source: 'project-parts', partsCount: list.length, claimed,
      // 几何派生不出来也必须给两个作用域：省略作用域本身比值为 null 更危险
      ...slotClaims({ fromGeometry: null, modelSlots, productSlots: claimed }),
      fromGeometry: null, aligned: null, levelsFromGeometry: null, slotsPerLevelFromGeometry: null,
      towersFromGeometry: null, transferLevels, usableStorage: null, trayCount: null, layerTrace, errors
    };
  }
  if (list.length === 0) {
    // 空零件表不许当「0 储位」放过去：没有几何 ≠ 没有储位
    errors.push('零件表为空（partsList 缺失）：没有几何可派生储位，fail-closed');
  }

  const expectedLevels = Array.from({ length: layers - 1 }, (_, index) => index + 2);
  const countsByFamily = new Map();
  for (const family of PV_SLOT_FAMILIES) {
    const counts = new Map();
    for (const part of list) {
      const level = slotLevelOf(part, family);
      if (level === null || !Number.isSafeInteger(level) || level < 1) continue;
      counts.set(level, (counts.get(level) ?? 0) + 1);
    }
    countsByFamily.set(family.key, counts);
  }

  // 非可选族：逐层齐全 + 每层件数 == perLevel + 不许出现越界层号
  for (const family of PV_SLOT_FAMILIES) {
    if (family.optional) continue;
    const counts = countsByFamily.get(family.key) ?? new Map();
    const missing = expectedLevels.filter((level) => !counts.has(level));
    const extra = [...counts.keys()].filter((level) => !expectedLevels.includes(level)).sort((a, b) => a - b);
    if (missing.length > 0) {
      errors.push(`${family.label} 缺第 ${missing.join('、')} 层（整层丢失必须由本族自己现形，不能靠别的件族同时 −1 自证）`);
    }
    if (extra.length > 0) {
      errors.push(`${family.label} 多出第 ${extra.join('、')} 层（参数 ${layers} 层 ⇒ 应有第 2~${layers} 层）`);
    }
    const wrong = expectedLevels.filter((level) => counts.has(level) && counts.get(level) !== family.perLevel);
    if (wrong.length > 0) {
      errors.push(`${family.label} 每层应 ${family.perLevel} 件，第 ${wrong.map((level) => `${level} 层（${counts.get(level)} 件）`).join('、')} 不符`);
    }
  }

  // 条件族（传动辊）：各层一致，且只能是 0 或 2 件（一条进一条出）
  const rollerCounts = countsByFamily.get('trayRoller') ?? new Map();
  const perLevelRollers = expectedLevels.map((level) => rollerCounts.get(level) ?? 0);
  const rollerSet = new Set(perLevelRollers);
  const rollerBad = [...rollerSet].filter((count) => count !== 0 && count !== 2);
  if (rollerSet.size > 1 || rollerBad.length > 0) {
    errors.push(`层传动辊应各层一致且为 0 或 2 件，实际各层件数 {${[...rollerSet].join('、')}}`);
  }

  // 层数 = 托板层数 + 进出料层
  const trayCounts = countsByFamily.get('tray') ?? new Map();
  const trayCount = trayCounts.size;
  const levelsFromGeometry = trayCount + transferLevels;
  if (levelsFromGeometry !== layers) {
    errors.push(`几何层数 ${levelsFromGeometry}（托板 ${trayCount} 层 + 进出料 ${transferLevels}）≠ 参数 ${layers} 层`);
  }

  // 每层位数 = 第 2 层托板件数（一块托板 = 一个储位）
  const slotsPerLevelFromGeometry = trayCounts.get(2) ?? 0;
  if (slotsPerLevelFromGeometry < 1) {
    errors.push('第 2 层没有托板：每层储位数读不出来（不从 params.slotsPerLevel 抄）');
  }

  // 塔数：4 根立柱为一塔
  const columnCount = list.filter((part) => /^column-(fl|fr|bl|br)$/.test(String(part.id ?? ''))
    || /^缓存立柱 \d+$/.test(String(part.name ?? ''))).length;
  const towersFromGeometry = columnCount > 0 && columnCount % 4 === 0 ? columnCount / 4 : null;
  if (towersFromGeometry === null) {
    errors.push(`缓存立柱 ${columnCount} 根 ⇒ 塔数读不出（应 4 根/塔）`);
  }

  const fromGeometry = towersFromGeometry === null || slotsPerLevelFromGeometry < 1
    ? null
    : levelsFromGeometry * slotsPerLevelFromGeometry * towersFromGeometry;

  for (const level of expectedLevels) {
    layerTrace.push(`第 ${level} 层：托板 ${trayCounts.get(level) ?? 0}/托条 ${(countsByFamily.get('trayRail') ?? new Map()).get(level) ?? 0}`
      + `/挡停 ${(countsByFamily.get('stop') ?? new Map()).get(level) ?? 0}/光电 ${(countsByFamily.get('layerSensor') ?? new Map()).get(level) ?? 0}`
      + `/辊 ${rollerCounts.get(level) ?? 0}`);
  }

  const ok = errors.length === 0 && fromGeometry !== null;
  return {
    ok,
    source: 'project-parts',
    partsCount: list.length,
    claimed,
    // 两个作用域：modelClaim 才是本机型口径（进 `disk.slots.modelClaimAligned` 门禁），
    // productClaim 是塔产品口径（登记，不判门禁）。
    ...slotClaims({ fromGeometry, modelSlots, productSlots: claimed }),
    fromGeometry,
    // ⚠️ 仅为兼容既有读法保留的**跨口径原样比较**（几何 vs 塔 16 位），只作 detail，
    // 不许再用它判门禁、更不证明塔已覆盖——门禁看 modelClaim.aligned，覆盖看 saveReloadCovered。
    aligned: fromGeometry === null ? null : fromGeometry === claimed,
    levelsFromGeometry,
    slotsPerLevelFromGeometry,
    towersFromGeometry,
    transferLevels,
    usableStorage: fromGeometry === null || towersFromGeometry === null
      ? null
      : fromGeometry - towersFromGeometry * transferLevels,
    trayCount,
    layerTrace,
    errors
  };
}

/**
 * 报告/日志里的「储位」回执。dry-run 阶段没有零件表，派生不出来就写 `null` +
 * `source='dry-run-no-parts'`——**不拿参数回声冒充几何派生值**（旧实现就是 `(layers)=>layers`
 * 挂了个 `slotsFromGeometry` 的名字，几何少一层它恒为 true）。
 */
export function slotsNote(slots, options) {
  const claimed = BASELINE.claimedSlots;
  const modelSlots = BASELINE.slotsFromLayers(options.params.layers);
  if (!slots) {
    const expected = modelSlots;
    return {
      slotsFromGeometry: null,
      expectedSlotsFromParams: expected,
      claimedSlots: claimed,
      aligned: null,
      source: 'dry-run-no-parts',
      // 本轮没有几何：modelClaim.aligned 只能记 null（不拿参数回声冒充 true），
      // 但两个作用域都必须出现——省略作用域正是旧口径的病根。
      ...slotClaims({ fromGeometry: null, modelSlots: expected, productSlots: claimed, source: 'dry-run-no-parts' }),
      text: `本轮没有读工程零件表，储位数不从几何派生（不拿参数回声冒充几何）；`
        + `按参数期望 ${options.params.layers} 层 = ${expected} 个储位，声明 ${claimed} 位，两者不等：`
        + `本脚本不把 ${options.params.layers} 层冒充 ${claimed} 位。`
        + `口径分层：modelClaim（本机型）${expected} 位、aligned=null（无几何不冒充 true）；`
        + `productClaim（塔产品）${claimed} 位、aligned=false（跨机型未验证，恒 false）、`
        + `crossModelEquality=null（本轮没有几何，数值是否相等不确定）、`
        + `coveredBy='${BASELINE.productCoveredBy}'、`
        + `saveReloadCovered=false（塔不在本脚本「存库 → 盘上读回」路径上）。`
    };
  }
  const modelClaim = slots.modelClaim ?? slotClaims({ fromGeometry: slots.fromGeometry }).modelClaim;
  const productClaim = slots.productClaim ?? slotClaims({ fromGeometry: slots.fromGeometry }).productClaim;
  return {
    slotsFromGeometry: slots.fromGeometry,
    claimedSlots: claimed,
    aligned: slots.aligned,
    source: slots.source,
    // 分层回执：两个作用域都在，各跟自己那条声明比（8 层 ≠ 16 位这个事实仍在 text/detail 里）
    modelClaim,
    productClaim,
    levelsFromGeometry: slots.levelsFromGeometry,
    slotsPerLevelFromGeometry: slots.slotsPerLevelFromGeometry,
    towersFromGeometry: slots.towersFromGeometry,
    transferLevels: slots.transferLevels,
    layerTrace: slots.layerTrace,
    errors: slots.errors,
    text: `几何零件表派生（${slots.partsCount} 件）：托板 ${slots.trayCount} 层 + 进出料 ${slots.transferLevels} 层`
      + ` = ${slots.levelsFromGeometry} 层 × ${slots.slotsPerLevelFromGeometry} 位/层 × ${slots.towersFromGeometry} 塔`
      + ` = ${slots.fromGeometry} 个储位；塔产品声明 ${claimed} 位，`
      // 数值恰好相等也只是一条信息：塔不在本脚本路径上，绝不写「一致 / 已覆盖 / 16 位完成」
      + (slots.aligned === true
        ? `本机几何数值恰好也是 ${claimed}，但这只是数值相等，不构成塔的对齐或覆盖证据（塔不走本脚本存库/读回）。`
        : `不一致（本脚本不把 ${slots.levelsFromGeometry} 层冒充 ${claimed} 位）。`)
      + `口径分层：modelClaim（本机型）${modelClaim.slots} 位、几何 ${slots.fromGeometry} 位 ⇒ aligned=${modelClaim.aligned}`
      + `（source=${modelClaim.source}，这条才进门禁）；productClaim（塔产品）${productClaim.slots} 位 ⇒ aligned=false（跨机型未验证，恒 false，不翻转退出码）、`
      + `crossModelEquality=${productClaim.crossModelEquality}（仅数值相等信息，不构成塔的对齐证据）、`
      + `coveredBy='${productClaim.coveredBy}'、saveReloadCovered=${productClaim.saveReloadCovered}。`
      + '16 层塔身几何由 bufferTower 建造器生成（146 件静态件表），但不在本脚本路径上，故本报告无塔 B-Rep/STEP。'
  };
}

// ---------------------------------------------------------------- 纯断言（可单测）

/** BOM 行 → {rows, qty}：conveyorBom 会把同名同规格合并，所以 qty 合计才等于件数 */
export function bomSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let qty = 0;
  for (const row of list) {
    const value = Number(row?.qty);
    if (Number.isFinite(value)) qty += value;
  }
  return { rows: list.length, qty };
}

/** 构建返回 → 归一化事实（纯函数，单测拿假对象即可覆盖断言分支） */
export function buildFacts(result) {
  const source = result && typeof result === 'object' ? result : {};
  const bom = bomSummary(source.bom);
  return {
    ok: source.ok === true,
    code: source.code ?? null,
    message: source.message ?? null,
    parts: Number(source.parts),
    loadedParts: Number(source.loadedParts),
    coloredParts: Number(source.coloredParts),
    solids: source.solids ?? null,
    volumeMm3: source.volumeMm3 ?? null,
    massKg: source.massKg ?? null,
    envelope: Array.isArray(source.envelope) ? source.envelope.map(Number) : null,
    buildMs: source.buildMs ?? null,
    bomRows: bom.rows,
    bomQty: bom.qty,
    stepBytes: Number(source.files?.step ?? NaN),
    stlBytes: Number(source.files?.stl ?? NaN),
    partFiles: Number(source.files?.partCount ?? NaN),
    savedProject: source.project?.saved === true,
    warnings: source.warnings ?? null
  };
}

export function assertBuildFacts(checks, facts, options) {
  checks.add('build.ok', facts.ok, { code: facts.code, message: facts.message });
  checks.add('build.savedProject', facts.savedProject);
  if (soft(checks, options)) {
    checks.add('build.parts.recorded', Number.isFinite(facts.parts), { parts: facts.parts });
    checks.add('build.envelope.recorded', Array.isArray(facts.envelope), { envelope: facts.envelope });
  } else {
    checks.eq('build.parts', facts.parts, BASELINE.parts);
    checks.eq('build.loadedParts', facts.loadedParts, BASELINE.parts);
    checks.eq('build.envelopeMm', facts.envelope, [...BASELINE.envelope]);
    checks.eq('build.bomQty', facts.bomQty, BASELINE.parts);
  }
  // STEP 体积 + B-Rep 特征数量是"真几何"的唯一廉价证据（桩几何只有几 KB）
  checks.gte('build.stepBytes', facts.stepBytes, BASELINE.minStepBytes);
  checks.gte('build.stlBytes', facts.stlBytes, BASELINE.minStlBytes);
  checks.gte('build.solids', facts.solids, 1);
  checks.add('build.massKg.positive', Number(facts.massKg) > 0, { massKg: facts.massKg });
  // 180 不许被二次夹紧：有 warning 就说明层距被改过
  checks.add('build.noWarnings', facts.warnings === null || facts.warnings === undefined,
    { warnings: facts.warnings ?? null });
  return checks;
}

/** 工程库记录（IPC 读回）→ 参数 / STEP / BOM 行数 */
export function assertRecordFacts(checks, record, options) {
  if (!record) {
    checks.add('record.present', false);
    return checks;
  }
  checks.add('record.present', true, { id: record.id, name: record.name });
  checks.eq('record.process', record.process, BASELINE.process);
  checks.eq('record.params.layerPitchMm', record.params?.layerPitchMm, options.params.layerPitchMm);
  checks.eq('record.params.layers', record.params?.layers, options.params.layers);
  checks.eq('record.params.lengthMm', record.params?.lengthMm, options.params.lengthMm);
  checks.eq('record.params.widthMm', record.params?.widthMm, options.params.widthMm);
  checks.eq('record.params.beltHeightMm', record.params?.beltHeightMm, options.params.beltHeightMm);
  checks.add('record.hasStep', record.hasStep === true);
  checks.add('record.hasStl', record.hasStl === true);
  const partsList = Array.isArray(record.partsList) ? record.partsList.length : 0;
  if (soft(checks, options)) {
    checks.add('record.partsList.recorded', partsList > 0, { partsList });
  } else {
    checks.eq('record.parts', Number(record.parts), BASELINE.parts);
    checks.eq('record.partsList', partsList, BASELINE.parts);
    checks.eq('record.envelopeMm', Array.isArray(record.envelope) ? record.envelope.map(Number) : null,
      [...BASELINE.envelope]);
  }
  return checks;
}

/** 场景完整性：模型件数 = 场景件数，且两边都是 90（缺件/重复计数都不许过） */
export function assertSceneFacts(checks, scene, options) {
  const integrity = scene?.integrity ?? null;
  checks.add('scene.integrityPresent', Boolean(integrity), integrity);
  checks.add('scene.integrityComplete', integrity?.complete === true, integrity);
  checks.add('scene.sceneParts', Number(scene?.sceneParts) > 0, { sceneParts: scene?.sceneParts });
  if (!soft(checks, options)) {
    checks.eq('scene.modelPartCount', Number(integrity?.modelPartCount), BASELINE.parts);
    checks.eq('scene.scenePartCount', Number(integrity?.scenePartCount), BASELINE.parts);
    checks.eq('scene.scenePartsExact', Number(scene?.sceneParts), BASELINE.parts);
    checks.eq('scene.bomRows', Number(scene?.bomRows), BASELINE.parts);
  }
  checks.add('scene.revisionPresent', typeof scene?.revision === 'string' && scene.revision.length > 0,
    { revision: scene?.revision ?? null });
  return checks;
}

/**
 * 盘上工程校验：读 project.json / model.step / model.stl / parts/。
 * 这是"保存后读回"的硬证据——内存里的返回可能被包装过，盘上的文件不会。
 */
export function verifyProjectDir(dir, options) {
  const checks = createChecks();
  const projectFile = join(dir, 'project.json');
  if (!existsSync(projectFile)) {
    checks.add('disk.projectJson', false, { path: projectFile });
    return { checks, project: null, slots: null };
  }
  let project = null;
  try {
    project = JSON.parse(readFileSync(projectFile, 'utf8'));
  } catch (error) {
    checks.add('disk.projectJsonParsed', false, { error: String(error?.message ?? error) });
    return { checks, project: null, slots: null };
  }
  checks.add('disk.projectJsonParsed', true);
  checks.eq('disk.name', project.name, options.name);
  checks.eq('disk.process', project.process, BASELINE.process);
  checks.eq('disk.params.layerPitchMm', project.params?.layerPitchMm, options.params.layerPitchMm);
  checks.eq('disk.params.layers', project.params?.layers, options.params.layers);
  checks.eq('disk.params.lengthMm', project.params?.lengthMm, options.params.lengthMm);
  checks.eq('disk.params.widthMm', project.params?.widthMm, options.params.widthMm);
  checks.eq('disk.params.beltHeightMm', project.params?.beltHeightMm, options.params.beltHeightMm);
  checks.add('disk.hasStep', project.hasStep === true);
  checks.add('disk.hasStl', project.hasStl === true);
  if (soft(checks, options)) {
    checks.add('disk.parts.recorded', Number(project.parts) > 0, { parts: project.parts });
  } else {
    checks.eq('disk.parts', Number(project.parts), BASELINE.parts);
    checks.eq('disk.envelopeMm', Array.isArray(project.envelope) ? project.envelope.map(Number) : null,
      [...BASELINE.envelope]);
  }

  const stepPath = join(dir, 'model.step');
  if (!existsSync(stepPath)) {
    checks.add('disk.modelStep', false);
  } else {
    const bytes = statSync(stepPath).size;
    checks.add('disk.modelStep', true, { bytes });
    checks.gte('disk.stepBytes', bytes, BASELINE.minStepBytes);
    const text = readFileSync(stepPath, 'utf8');
    checks.add('disk.stepHeader', /^ISO-10303-21;/m.test(text.trimStart()), { head: text.slice(0, 40) });
    checks.add('disk.stepBrep', text.includes('MANIFOLD_SOLID_BREP'));
    const solidBreps = (text.match(/MANIFOLD_SOLID_BREP/g) ?? []).length;
    checks.gte('disk.stepSolidBreps', solidBreps, BASELINE.minSolidBreps);
    const advancedFaces = (text.match(/ADVANCED_FACE/g) ?? []).length;
    checks.gte('disk.stepAdvancedFaces', advancedFaces, BASELINE.minAdvancedFaces);
  }

  const stlPath = join(dir, 'model.stl');
  if (!existsSync(stlPath)) {
    checks.add('disk.modelStl', false);
  } else {
    const bytes = statSync(stlPath).size;
    checks.add('disk.modelStl', true, { bytes });
    checks.gte('disk.stlBytes', bytes, BASELINE.minStlBytes);
  }

  // 自动保存的 session.json：证明"保存后重开 + autosave flush"真的落盘
  checks.add('disk.sessionJson', existsSync(join(dir, 'session.json')));

  const partsDir = join(dir, 'parts');
  const partFiles = existsSync(partsDir)
    ? readdirSync(partsDir).filter((name) => /\.stl$/i.test(name)).length
    : 0;
  checks.add('disk.partsDir', existsSync(partsDir), { partFiles });
  if (!soft(checks, options)) checks.eq('disk.partFiles', partFiles, BASELINE.parts);

  /**
   * 储位派生（P1-3）：唯一输入是盘上零件表 `partsList`，**不是** `params.layers`。
   * 旧实现 `slotsFromLayers: (layers) => layers` 是参数回声——几何整层丢件它照样 true。
   * 这里逐族逐层数：缺族 / 缺层 / 每层件数不符 / 立柱不足 4 根都会让 `disk.slots.*` 红。
   */
  const slots = slotsFromGeometryParts(project.partsList, {
    layers: options.params.layers,
    claimed: BASELINE.claimedSlots,
    modelSlots: BASELINE.slotsFromLayers(options.params.layers)
  });
  checks.add('disk.slots.derived', slots.ok, {
    errors: slots.errors,
    partsList: slots.partsCount,
    fromGeometry: slots.fromGeometry,
    levelsFromGeometry: slots.levelsFromGeometry,
    slotsPerLevel: slots.slotsPerLevelFromGeometry,
    towers: slots.towersFromGeometry,
    claimed: slots.claimed,
    // 旧字段（跨口径原样比较）：保留只为兼容既有读法，**不证明塔覆盖**，门禁看 modelClaimAligned
    aligned: slots.aligned,
    legacyAlignedScope: 'geometry-vs-product（跨机型数值比较，仅 detail，不证明塔已对齐/已覆盖）',
    modelClaim: slots.modelClaim,
    productClaim: slots.productClaim
  });
  checks.eq('disk.slots.levelsFromGeometry', slots.levelsFromGeometry, options.params.layers);
  checks.add('disk.slots.fromGeometryPositive',
    Number.isSafeInteger(slots.fromGeometry) && slots.fromGeometry > 0,
    { fromGeometry: slots.fromGeometry });

  /**
   * 口径分层（A1）的三条检查。**只有第一条是本机型门禁**；后两条分别管「两个作用域都在且
   * 分别是派生值」与「塔的缺口如实登记」。`productClaim.aligned` **恒为 false 且不参与任何一条
   * 判据的绿/红** —— 它是跨机型未验证口径，不许翻转 regen 退出码。
   */
  checks.add('disk.slots.modelClaimAligned',
    // slots.ok 是本条的前置：托板层数×每层件数×塔数是**乘积**，删第 3 层再补第 9 层时乘积仍是 8，
    // 单看 aligned 会漏掉「整层错位」。几何自身有 error（缺层/越界/每层件数不符）就不许给绿。
    slots.ok === true && slots.modelClaim?.aligned === true, {
      slotsOk: slots.ok,
      errors: slots.errors,
      modelClaim: slots.modelClaim ?? null,
      fromGeometry: slots.fromGeometry,
      note: '本机型几何派生值必须等于本机型声明（8 层 ⇒ 8 位），且几何派生本身必须 ok（slots.ok）；'
        + '乘积相同但整层错位的几何不得给绿。塔的 16 位不在这一条里判'
    });
  const productSlots = slots.productClaim?.slots ?? null;
  const derivedCrossModelEquality = slots.fromGeometry === null ? null : slots.fromGeometry === productSlots;
  checks.add('disk.slots.scopeSplit',
    Boolean(slots.modelClaim) && Boolean(slots.productClaim)
      && Number.isSafeInteger(slots.modelClaim.slots) && slots.modelClaim.slots > 0
      && slots.modelClaim.source === 'project-parts'
      && Number.isSafeInteger(productSlots) && productSlots > 0
      // 跨机型口径：aligned 必须恒 false、basis 固定；相等信息只能落在 crossModelEquality 且必须是
      // **派生值**（几何 vs 塔声明），写死成常量就红
      && slots.productClaim.aligned === false
      && slots.productClaim.basis === 'cross-model-unverified'
      && slots.productClaim.crossModelEquality === derivedCrossModelEquality,
    {
      modelClaim: slots.modelClaim ?? null,
      productClaim: slots.productClaim ?? null,
      derivedCrossModelEquality,
      modelVsProductEqual: slots.modelClaim?.slots === slots.productClaim?.slots
    });
  checks.add('disk.slots.productClaimRegistered',
    slots.productClaim?.coveredBy === BASELINE.productCoveredBy
      && slots.productClaim?.saveReloadCovered === false,
    {
      coveredBy: slots.productClaim?.coveredBy ?? null,
      saveReloadCovered: slots.productClaim?.saveReloadCovered ?? null,
      aligned: slots.productClaim?.aligned ?? null,
      crossModelEquality: slots.productClaim?.crossModelEquality ?? null,
      note: '塔 16 位只由 verify:step-tower --levels 16 覆盖，且不经过工程库落盘；'
        + '谁把 saveReloadCovered 写成 true（声称塔已走 regen 存库/读回）这一条就红'
    });

  return { checks, project, slots };
}

// ---------------------------------------------------------------- CDP

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export async function connectCdp({ port, getOutput, isExited }) {
  let target = null;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isExited()) throw new Error(`Electron 提前退出：${getOutput().slice(-2000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
      const list = await response.json();
      target = list.find((item) => item.type === 'page' && String(item.url).includes('index.html')) ?? null;
      if (target) break;
    } catch { /* 还没起来 */ }
    await delay(200);
  }
  if (!target) throw new Error(`CDP 页面未出现（${READY_TIMEOUT_MS}ms）：${getOutput().slice(-2000)}`);

  const socket = new WebSocket(new URL(target.webSocketDebuggerUrl));
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('CDP 握手超时')), 10_000);
    socket.addEventListener('open', () => { clearTimeout(timer); done(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); fail(new Error('CDP 连接失败')); }, { once: true });
  });

  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.fail(new Error(`${entry.method}: ${message.error.message}`));
    else entry.done(message.result);
  });

  const send = (method, params = {}, timeout = 30_000) => new Promise((done, fail) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      fail(new Error(`${method} 超时（${timeout}ms）`));
    }, timeout);
    pending.set(id, { method, timer, done, fail });
    socket.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expression, timeout = 60_000) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '页面脚本异常');
    }
    return result.result?.value;
  };

  await send('Runtime.enable');
  return {
    evaluate,
    close() { try { socket.close(); } catch { /* 已关闭 */ } }
  };
}

// ---------------------------------------------------------------- 进程 ownership / 清理

/**
 * 读 /proc/<pid>/stat。返回 ppid / pgid / starttime（开机 tick），读不到返回 null。
 * comm 里可能有空格和括号，所以从最后一个 ')' 之后开始切。
 */
export function readProcStat(pid, procRoot = '/proc') {
  try {
    const raw = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return null;
    const rest = raw.slice(close + 1).trim().split(/\s+/);
    return {
      state: rest[0],
      ppid: Number(rest[1]),
      pgid: Number(rest[2]),
      starttime: Number(rest[19])
    };
  } catch {
    return null;
  }
}

/** 读 /proc/<pid>/cmdline 的 argv（NUL 分隔，已过滤空串） */
export function readProcArgv(pid, procRoot = '/proc') {
  try {
    return readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8').split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** 命令行里是否有**精确**的 userData 标记（绝不使用 includes/子串） */
export function hasExactUserDataToken(argv, userData) {
  if (!Array.isArray(argv)) return false;
  const target = resolve(userData);
  const flag = `--user-data-dir=${target}`;
  const env = `AUTOMATIONCAD_E2E_USERDATA=${target}`;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === flag || token === env) return true;
    if (token === '--user-data-dir' && argv[index + 1] === target) return true;
  }
  return false;
}

/** 该 pid 的祖先链（含自身）是否包含 ancestor */
function chainContains(pid, ancestor, procRoot) {
  let current = pid;
  for (let depth = 0; depth < 64; depth += 1) {
    if (current === ancestor) return true;
    const info = readProcStat(current, procRoot);
    if (!info || !Number.isInteger(info.ppid) || info.ppid <= 0 || info.ppid === current) return false;
    current = info.ppid;
  }
  return false;
}

function selfPgid(procRoot) {
  const info = readProcStat(process.pid, procRoot);
  return info && Number.isInteger(info.pgid) ? info.pgid : null;
}

/** 受保护路径的精确命令行标记：任何情况下都不许杀带这些标记的进程 */
function protectedArgvTokens(options = {}) {
  const rules = protectedRules(options);
  const roots = new Set([...rules.inside, ...rules.exact]);
  const tokens = new Set();
  for (const root of roots) {
    tokens.add(`--user-data-dir=${root}`);
    tokens.add(`AUTOMATIONCAD_E2E_USERDATA=${root}`);
  }
  return tokens;
}

/**
 * 清理 API 的入参闸门：`userData` 必须是**非空绝对路径字符串**，否则抛错（fail-closed）。
 *
 * 为什么不能静默返回 `[]`：静默空集会被上层读成“没有残留进程”，于是
 * `cleanup.noLeftoverProcess` 被记成 `ok:true`，而一个进程都没清 —— 这正是 P2-15
 * 「清理声称成功却留孤儿」的形状（复审 N4：`terminateOwned(target, {...})` 少写一层对象时复现）。
 * 受保护路径**不抛错**：它返回空集是正确的结论（那些进程明确不属于本轮），保护方向不变。
 */
export function assertCleanupUserData(userData, label = 'userData') {
  if (typeof userData !== 'string' || userData.trim() === '' || !isAbsolute(userData)) {
    const received = userData === null ? 'null'
      : Array.isArray(userData) ? 'array'
        : typeof userData === 'string' ? JSON.stringify(userData) : typeof userData;
    throw new Error(`${label} 必须是非空绝对路径字符串（收到 ${received}）：拒绝在参数形状不明时清理进程。`);
  }
  return resolve(userData);
}

/**
 * 找出「本轮」残留进程。ownership 证据只有三类：
 *   1. group —— 进程组 id 等于本轮 spawn 出来的子进程 pid（唯一，不会碰到别人的组）
 *   2. tree  —— 祖先进程链能走到本轮子进程 pid（子孙自己 setsid 也逃不掉），
 *               同样受 `sinceTicks` 约束（子孙一定晚于本轮子进程启动，早于它的只能是被复用的 pid）
 *   3. token —— 命令行里带**精确**的 `--user-data-dir=<本轮 userData>`（或等价环境标记），
 *               且启动时刻不早于本轮子进程（防 PID/路径复用的旧实例）
 * 绝不按子串匹配；受保护路径的进程一条都不返回；`userData` 形状非法时抛错而不是返回空集。
 */
export function findOwnedLeftovers(userData, {
  procRoot = '/proc',
  pgid = null,
  sinceTicks = 0,
  ...options
} = {}) {
  const target = assertCleanupUserData(userData);
  if (isProtectedUserData(target, options)) return [];
  const groupId = Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  if (groupId !== null && groupId === selfPgid(procRoot)) {
    // 配置错误：本轮 pgid 与脚本自己同组，按组清理会连自己一起杀
    throw new Error(`拒绝按脚本自身进程组清理：pgid=${groupId}`);
  }
  let entries = [];
  try { entries = readdirSync(procRoot); } catch { return []; }
  const protectedTokens = protectedArgvTokens(options);
  const found = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid || pid === process.ppid) continue;
    const info = readProcStat(pid, procRoot);
    if (!info) continue;
    const argv = readProcArgv(pid, procRoot) ?? [];
    if (argv.some((token) => protectedTokens.has(token))) continue;

    let evidence = null;
    if (groupId !== null && info.pgid === groupId) evidence = 'group';
    else if (
      groupId !== null
      // 子孙一定在本轮子进程之后启动：早于它的只能是 pid/组 id 复用出来的陌生进程链。
      && (sinceTicks <= 0 || (Number.isFinite(info.starttime) && info.starttime >= sinceTicks))
      && chainContains(info.ppid, groupId, procRoot)
    ) evidence = 'tree';
    else if (
      target
      && sinceTicks > 0
      && hasExactUserDataToken(argv, target)
      && argv.some((token) => /electron/i.test(token))
      && Number.isFinite(info.starttime)
      && info.starttime >= sinceTicks
    ) evidence = 'token';
    if (!evidence) continue;
    found.push({ pid, pgid: info.pgid, starttime: info.starttime, evidence });
  }
  return found.sort((a, b) => a.pid - b.pid);
}

/** 兼容旧名字：只返回 pid，语义与 findOwnedLeftovers 完全一致（严格证据、无子串） */
export function findLeftovers(userData, options = {}) {
  return findOwnedLeftovers(userData, options).map((row) => row.pid);
}

/**
 * 只清理本轮 spawn 的进程组 + 有精确 ownership 证据的 pid。
 * 顺序：组 SIGTERM → 逐个 pid SIGTERM（逃出组的）→ 等 grace → 重新取证后 SIGKILL。
 * 任何一步都重新校验目标身份，避免 PID 复用误杀。
 *
 * 两条不变式：
 *   - `userData` 形状非法时**抛错**（见 `assertCleanupUserData`），绝不静默返回“干净”；
 *   - 组信号只在 `initial.length > 0` 且 `-pgid` 仍被本次证据认领时发出。组 id 本身没有
 *     启动时刻可比，所以“防 PID/组 id 复用”这句话**只对 token/tree 证据成立**：
 *     组证据靠的是“本轮 spawn 出来的 pid 未被复用”，窗口是秒级。
 */
export async function terminateOwned({
  userData,
  pgid = null,
  sinceTicks = 0,
  procRoot = '/proc',
  graceMs = 5000,
  ...options
} = {}) {
  const target = assertCleanupUserData(userData);
  const query = { procRoot, pgid, sinceTicks, ...options };
  const initial = findOwnedLeftovers(target, query);
  if (initial.length === 0) return []; // 没有任何本轮证据：连组信号都不发，避免 PID/组 id 复用误伤
  const groupId = Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  if (groupId !== null && process.platform !== 'win32') {
    try { process.kill(-groupId, 'SIGTERM'); } catch { /* 组已不存在 */ }
  }
  for (const row of initial) {
    if (row.evidence === 'group') continue; // 组信号已覆盖
    try { process.kill(row.pid, 'SIGTERM'); } catch { /* 已经没了 */ }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (findOwnedLeftovers(target, query).length === 0) return [];
    await delay(150);
  }
  const remaining = findOwnedLeftovers(target, query);
  for (const row of remaining) {
    // 再查一遍：只有仍然能被同一份证据认出来的 pid 才允许硬杀
    const fresh = findOwnedLeftovers(target, query).some((item) => item.pid === row.pid);
    if (!fresh) continue;
    try { process.kill(row.pid, 'SIGKILL'); } catch { /* 已经没了 */ }
  }
  await delay(250);
  return findOwnedLeftovers(target, query);
}

/**
 * 本轮子进程的监督器：spawn（独立进程组）、收集输出、把 SIGINT/SIGTERM
 * 转成可 await 的停止信号。清理只走 terminateOwned 的 ownership 证据。
 */
export function createSupervisor({ userData, graceMs = 5000 } = {}) {
  let child = null;
  let command = null;
  let output = '';
  let sinceTicks = 0;
  let interrupted = null;
  let spawnFailed = false;
  let resolveSignal;
  const signalPromise = new Promise((done) => { resolveSignal = done; });

  const onSignal = (signal) => {
    if (interrupted) return; // 第二次信号不覆盖第一次，也不让 Node 默认处理器直接退出
    interrupted = signal;
    resolveSignal(signal);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const isExited = () => child === null
    || spawnFailed
    || child.exitCode !== null
    || Boolean(child.signalCode)
    || child.killed === true;

  return {
    get child() { return child; },
    get pid() { return child?.pid ?? null; },
    get command() { return command; },
    get output() { return output; },
    get interrupted() { return interrupted; },
    get signalPromise() { return signalPromise; },
    isExited,

    start({ command: cmd, args, env, cwd = desktopRoot }) {
      if (child) throw new Error('supervisor 只能 start 一次');
      command = cmd;
      output = '';
      child = spawn(cmd, args, {
        cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env }
      });
      sinceTicks = readProcStat(child.pid)?.starttime ?? 0;
      const collect = (chunk) => { output = (output + chunk).slice(-60_000); };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.on('error', (error) => {
        spawnFailed = true;
        output += `\nSPAWN_ERROR ${error.message}`;
      });
      return child;
    },

    async stop(extra = {}) {
      return terminateOwned({ userData, pgid: child?.pid ?? null, sinceTicks, graceMs, ...extra });
    },

    dispose() {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  };
}

// ---------------------------------------------------------------- 主流程

function signalExitCode(signal) {
  return signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : 1;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`PV_REGEN_USAGE ${error.message}`);
    console.error(usage());
    return 2;
  }
  if (options.help) {
    console.log(usage());
    return 0;
  }

  // ---- 路径预检：全部在启动 Electron 之前完成，失败一律退 2 且不留下垃圾目录
  let scratchRoot;
  let runDir = null;
  let userData = null;
  let createdUserData = null;
  let reportPath = null;
  try {
    scratchRoot = resolveScratchRoot();
    runDir = createRunDir(scratchRoot);
    if (options.userData) {
      userData = assertFreshDir(options.userData, { root: scratchRoot, label: 'userData' });
    } else {
      userData = join(runDir, 'userdata');
    }
    reportPath = options.reportPath
      ? assertReportTarget(options.reportPath, { ownedDir: runDir })
      : join(runDir, 'report.json');
    if (!options.dryRun) {
      createdUserData = createFreshDir(userData, { root: scratchRoot, label: 'userData' });
    }
  } catch (error) {
    console.error(`PV_REGEN_USAGE ${error.message}`);
    if (runDir && existsSync(runDir)) {
      try { rmSync(runDir, { recursive: true, force: true }); } catch { /* 尽力 */ }
    }
    console.error(usage());
    return 2;
  }

  const port = await freePort();
  const plan = planSummary(options, { userData, port, reportPath, runDir });
  // dry-run 阶段没有零件表：note 明确写「未派生」，不拿参数回声当几何派生值。
  // 真跑起来读完盘上工程后会用 slotsNote(disk.slots, options) 覆盖成本轮的真值。
  let note = slotsNote(null, options);
  let slots = null;

  if (options.dryRun) {
    try {
      writeNewFile(reportPath, `${JSON.stringify({ ok: true, dryRun: true, runDir, plan, note }, null, 2)}\n`);
    } catch (error) {
      console.error(`PV_REGEN_USAGE 报告写入失败：${error.message}`);
      return 2;
    }
    console.log(`PV_REGEN_PLAN ${JSON.stringify(plan)}`);
    console.log(`PV_REGEN_NOTE ${JSON.stringify(note)}`);
    console.log(`PV_REGEN_DRY_RUN ok=true（未启动 Electron） report=${reportPath}`);
    return 0;
  }

  const checks = createChecks();
  const startedAt = new Date();
  let cdp = null;
  let fatal = null;
  let facts = null;
  let scene = null;
  let record = null;
  let diskProject = null;

  const log = (line) => {
    console.log(line);
  };

  const supervisor = createSupervisor({ userData, graceMs: 6000 });

  // 看门狗：整体超时不是"多等一会儿"，而是立即按违规处理（否则挂死的 Electron 会把 CI 拖满）
  let watchdogTimer = null;
  const watchdog = new Promise((_, reject) => {
    watchdogTimer = setTimeout(() => {
      fatal = `总超时 ${options.timeoutMs}ms`;
      reject(new Error(fatal));
    }, options.timeoutMs);
  });

  const run = async () => {
    const spec = buildLaunchSpec({ port, userData, hasXvfb: true });
    log(`PV_REGEN_LAUNCH ${JSON.stringify({ command: spec.command, userData: plan.userData, port })}`);
    supervisor.start({ command: spec.command, args: spec.args, env: spec.env });

    cdp = await connectCdp({
      port,
      getOutput: () => supervisor.output,
      isExited: () => supervisor.isExited()
    });

    const readyStart = Date.now();
    const readyDeadline = Date.now() + READY_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < readyDeadline) {
      ready = await cdp.evaluate('window.__AUTOMATION_CAD_EXTENSION_READY__ === true').catch(() => false);
      if (ready) break;
      await delay(200);
    }
    checks.add('host.extensionReady', ready, { readyMs: Date.now() - readyStart });
    if (!ready) throw new Error('扩展未就绪，不继续构建（避免拿半初始化的视口当证据）');

    // 渲染层隔离：页面拿不到 require/process，才算"跑在真实窗口里"
    const isolation = await cdp.evaluate('({require: typeof window.require, process: typeof window.process})');
    checks.add('host.rendererIsolated', isolation.require === 'undefined' && isolation.process === 'undefined',
      isolation);

    const built = await cdp.evaluate(`(async () => {
      const startedAt = Date.now();
      const result = await window.__AgentBridge.buildMachineModel(${JSON.stringify({
        process: BASELINE.process,
        params: options.params,
        name: options.name
      })});
      return { result, elapsedMs: Date.now() - startedAt };
    })()`, BUILD_TIMEOUT_MS);
    facts = buildFacts(built.result);
    facts.elapsedMs = built.elapsedMs;
    assertBuildFacts(checks, facts, options);
    if (!facts.ok) throw new Error(`构建失败：${facts.code ?? ''} ${facts.message ?? ''}`.trim());

    // 保存后读回①：工程库 IPC 记录（参数 / STEP / BOM 行）
    record = await cdp.evaluate(`(async () => {
      const list = await window.desktop.projects.list();
      const found = list.find((item) => item.name === ${JSON.stringify(options.name)});
      return found ? {
        id: found.id, name: found.name, process: found.process, params: found.params,
        parts: found.parts, massKg: found.massKg, envelope: found.envelope,
        hasStep: found.hasStep, hasStl: found.hasStl,
        partsList: Array.isArray(found.partsList) ? found.partsList.map((item) => item.file) : []
      } : null;
    })()`, 60_000);
    assertRecordFacts(checks, record, options);

    // 保存后读回②：场景完整性 + BOM + session revision
    scene = await cdp.evaluate(`(async () => {
      const integrity = window.AutomationCadViewer?.sceneIntegrity?.() ?? null;
      const sceneParts = (await window.__AgentBridge.getSceneParts()).length;
      const bom = await window.__AgentBridge.getBom();
      const id = window.AutomationCadProjects?.currentId?.() ?? null;
      const session = id ? await window.desktop.projects.session(id) : null;
      return {
        integrity, sceneParts, bomRows: bom.length,
        bomQty: bom.reduce((sum, row) => sum + (Number(row?.qty) || 0), 0),
        id, revision: session?.revision ?? null, sessionOk: session?.ok ?? null
      };
    })()`, 90_000);
    assertSceneFacts(checks, scene, options);
    checks.add('scene.sessionOk', scene.sessionOk === true || scene.sessionOk === null,
      { sessionOk: scene.sessionOk });

    // 保存后读回③：盘上工程（不依赖进程内状态）；目录名用与应用一致的 sanitizeId
    const projectsDir = join(userData, 'projects');
    const projectDir = join(projectsDir, sanitizeProjectId(options.name));
    const disk = verifyProjectDir(projectDir, options);
    for (const item of disk.checks.items) checks.add(`disk3.${item.name}`, item.ok, item.detail);
    diskProject = disk.project;
    // 储位真值（从盘上零件表派生）：note 在这里才第一次有几何依据
    slots = disk.slots ?? null;
    note = slotsNote(slots, options);
    log(`PV_REGEN_SLOTS ${JSON.stringify(slotsNote(slots, options))}`);
    if (!diskProject) {
      const names = existsSync(projectsDir) ? readdirSync(projectsDir) : [];
      throw new Error(`盘上没有 ${projectDir}；实际目录：${JSON.stringify(names)}`);
    }
  };

  let exitCode = 1;
  try {
    const workPromise = run();
    // 被 race 放弃后 workPromise 仍可能拒绝（CDP/文件），吞掉以免变成未处理拒绝
    workPromise.catch(() => {});
    await Promise.race([workPromise, watchdog, supervisor.signalPromise]);
  } catch (error) {
    if (!supervisor.interrupted) {
      fatal = fatal ?? String(error?.message ?? error);
      console.error(`PV_REGEN_ERROR ${fatal}`);
      if (supervisor.output) console.error(supervisor.output.slice(-3000));
    }
  } finally {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    const interrupted = supervisor.interrupted;
    if (interrupted) log(`PV_REGEN_INTERRUPTED ${interrupted}`);
    try { cdp?.close(); } catch { /* 已关闭 */ }
    const leftovers = await supervisor.stop({ graceMs: interrupted ? 8000 : 6000 });
    // 清理完成后才摘信号监听：第二次 Ctrl-C 不会在 kill 窗口里把脚本直接打死
    supervisor.dispose();
    checks.add('cleanup.noLeftoverProcess', leftovers.length === 0, { leftovers });
    if (createdUserData && !existsSync(join(createdUserData, 'projects'))) {
      // 只在"完全没产物"时删掉本轮自己建的目录；有产物就留着，报告里写明路径
      try { rmSync(createdUserData, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
    }
    const failed = checks.failed();
    exitCode = interrupted ? signalExitCode(interrupted) : (fatal || failed.length > 0 ? 1 : 0);
    for (const item of checks.items) log(`PV_REGEN_CHECK ${JSON.stringify(item)}`);
    log(`PV_REGEN_NOTE ${JSON.stringify(note)}`);
    log(`PV_REGEN_RESULT ok=${exitCode === 0} checks=${checks.items.length} failed=${failed.length}`
      + ` userData=${resolve(userData)} report=${reportPath}`);
    if (failed.length > 0) {
      log(`PV_REGEN_FAIL ${failed.map((item) => item.name).join(',')}`);
    }
    const report = {
      ok: exitCode === 0,
      interrupted: interrupted ?? null,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt.getTime(),
      runDir,
      plan,
      note,
      userData: resolve(userData),
      port,
      slots,
      facts,
      scene,
      record: record ? { ...record, params: record.params } : null,
      diskProject: diskProject
        ? {
          name: diskProject.name,
          process: diskProject.process,
          params: diskProject.params,
          parts: diskProject.parts,
          massKg: diskProject.massKg,
          envelope: diskProject.envelope
        }
        : null,
      checks: checks.items,
      failed: failed.map((item) => item.name),
      fatal: interrupted ? `中断信号 ${interrupted}` : fatal,
      logTail: supervisor.output.slice(-4000)
    };
    try {
      // 只新建、绝不覆盖；'wx' 是最后一道闸
      writeNewFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
      console.error(`PV_REGEN_REPORT_FAILED ${error.message}`);
      exitCode = 1;
    }
    return exitCode;
  }
  return exitCode;
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    // 兜底：任何未捕获异常都必须变成非零退出，不能"看起来跑完了"
    .catch((error) => {
      console.error(`PV_REGEN_FATAL ${error?.stack ?? error}`);
      process.exit(1);
    });
}
