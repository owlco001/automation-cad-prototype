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
 *   - `layers: 8` 只等于 **8 个储位**（第 1 层是底层输送线），**不是 16 位**。16 位目前只存在于
 *     `bufferTower` 纯数据槽位模型里。本脚本不会把 8 层冒充 16 位，报告里固定打印
 *     `slotsFromGeometry=8 claimedSlots=16 aligned=false`。
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
  /** 真 B-Rep STEP 实测 781,970B；参数化桩只有几 KB，用它区分"真几何"与"占位几何" */
  minStepBytes: 200_000,
  minStlBytes: 500_000,
  /** 实测 47 个 MANIFOLD_SOLID_BREP / 264 个 ADVANCED_FACE（47 实体）；桩/空文件远达不到 */
  minSolidBreps: 40,
  minAdvancedFaces: 200,
  /** 几何层数 → 储位数：第 1 层是底层输送线，所以 8 层只有 8 个储位 */
  slotsFromLayers: (layers) => layers,
  claimedSlots: 16
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
      slotsFromGeometry: BASELINE.slotsFromLayers(options.params.layers),
      claimedSlots: BASELINE.claimedSlots,
      slotsAligned: BASELINE.slotsFromLayers(options.params.layers) === BASELINE.claimedSlots
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
    return { checks, project: null };
  }
  let project = null;
  try {
    project = JSON.parse(readFileSync(projectFile, 'utf8'));
  } catch (error) {
    checks.add('disk.projectJsonParsed', false, { error: String(error?.message ?? error) });
    return { checks, project: null };
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

  return { checks, project };
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
  const note = {
    slotsFromGeometry: BASELINE.slotsFromLayers(options.params.layers),
    claimedSlots: BASELINE.claimedSlots,
    aligned: BASELINE.slotsFromLayers(options.params.layers) === BASELINE.claimedSlots,
    text: `几何层数 ${options.params.layers} 层 = ${BASELINE.slotsFromLayers(options.params.layers)} 个储位；`
      + `16 位只存在于 bufferTower 纯数据槽位模型，本脚本不把 8 层冒充 16 位。`
  };

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
