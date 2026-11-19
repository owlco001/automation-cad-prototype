#!/usr/bin/env node
/**
 * 孤儿 sidecar 体检 / 回收：`npm run doctor:sidecar`（**不接 CI，不进 `npm test` 自动分支**）
 *
 * 为什么要它：参数化内核 sidecar 由 `desktop/electron/parametric.ts:789` 以 `detached: true`
 * 起在独立进程组里，清理只走优雅路径（`killTree` → `process.kill(-pid)`、app 退出钩子、
 * `verify-*.mjs` 的 `finally`）。只要父进程被 SIGKILL（`timeout -k`、CI 取消、面板强杀），
 * `finally` 一行都不会执行，子进程被 init（PID 1）收养 —— 它继续占着端口和几百 MB 内存，
 * 而 `start()` 只会去找**空闲端口**（`portAvailable`），于是孤儿被新端口静默绕过，能活数小时。
 * 本机就实测过：pid 2040641 / 2114164，端口 7431 / 7445，存活 8h+ / 4h+，合计约 894 MB。
 *
 * `detached` 不能删：`killTree` 靠「子进程 = 进程组首」一次性干掉 python 及其孙进程，
 * 去掉 detached 就没有这个进程组语义（Windows 上 detached 又是 job 边界）。所以治理放在
 * **外部**：本脚本只做「发现 + 显式回收」，不改启动路径。
 *
 * 判据（三条**同时**满足才认作本仓 sidecar）：
 *   1) argv[0] 的 basename 以 `python` 开头（`python3` / `python` / `python3.12` 都算）；
 *   2) argv 里有一个**完整路径**是本仓的 `app.py`，两种形态都认（见 `matchSidecar`）：
 *      · 开发态 `<repoRoot>/spike/build123d/app.py` —— 逐段相等，**不做**前缀匹配
 *        （否则 `/x/automation-cad-prototype-2` 这种同形仓库会被误伤）；
 *      · 打包态 `<resourcesPath>/parametric/app.py` —— 与 `parametric.ts:307-320` 的
 *        `resolveScript()` 同一条规则（`join(resourcesPath, 'parametric', 'app.py')`，
 *        macOS 的 `…/Contents/Resources` 大写也认）。这是 electron-builder
 *        `extraResources` 把 `spike/build123d/app.py` 拷成 `parametric/app.py` 的结果 ——
 *        **最会产生孤儿的形态**（用户机器上的 detached 包）原来完全漏检。
 *        这一形态额外要求 argv 带 `--token`/`--token=` 协议旗标（`parametric.ts` 的 launch 必带，
 *        `detached` 起的进程一定有），用来收敛「别的应用也恰好叫 resources/parametric/app.py」的误匹配；
 *      · 给了 `--resources-root` 时**只认**这一份（别处的同形路径一律不认，fail-closed）。
 *   3) `--port <n>`（或 `--port=<n>`）且 7400 ≤ n ≤ 7499。
 *
 * 回收还要再加三条「安全闸」（任一不满足就只列不杀）：
 *   4) PPID === 1（父进程还活着 = 有人正在管它，不归我们）；
 *   5) pid !== 1、pid !== 自己；
 *   6) 年龄 ≥ 阈值（默认 3600 s = 1 h；**`--min-age-min 0` 直接拒绝**，年龄闸不许关）。
 *
 * **pid 复用闸（发信号前，不在识别时）**：从识别到发信号之间可能有 5 s 轮询窗口，孤儿退出后
 * 同一个 pid 会被同用户的新进程复用。所以 record 里留 `startTicks`（`/proc/<pid>/stat` 字段 22），
 * `applyKills` 在 SIGTERM 前、SIGKILL 前各重读一次：读不到 = 目标已退出；对不上 = pid 换人了，
 * **一律不发信号**（原来只看 `/proc/<pid>` 是否存在，会把 SIGKILL 打到无关进程上）。
 *
 * 形态**来源**进 record（`match: 'dev' | 'packaged' | 'packaged-pinned'`）：dry-run 一眼能看出
 * 这条是按哪种形态认出来的，打包态后缀匹配需要人工复核时不必猜。
 *
 * 多会话共用同一个 repo 是本机常态，别人正在跑的 kernel 也是同形 argv，
 * 所以**默认永远 dry-run**，`--kill` 必须显式给，而且先 `--json` 看清楚再杀。
 *
 * 用法：
 *   npm run doctor:sidecar                       # dry-run：列出候选（pid/ppid/port/age/rss/cmd）
 *   npm run doctor:sidecar -- --json             # 同上，末尾输出一行 JSON（默认仍是 dry-run）
 *   npm run doctor:sidecar -- --kill             # 回收：需 repoRoot + 端口窗 + 年龄三闸全过
 *   npm run doctor:sidecar -- --kill --min-age-min 30
 *   npm run doctor:sidecar -- --repo-root /path/to/automation-cad-prototype
 *   npm run doctor:sidecar -- --resources-root /opt/AutomationCAD/resources   # 只治理这个发行包
 *
 * 退出码：0 = 正常（不论有没有候选、不论 dry-run 还是 kill 成功）；
 *         1 = 有匹配的 sidecar 但 `--kill` 后仍存活 / 信号失败 / 端口没放出来；
 *         2 = 用法错（未知参数、`--kill` 时 repoRoot 与 resourcesRoot 下都找不到 `app.py`、
 *             阈值非法 —— 含 `--min-age-min 0`）。
 *
 * 安全：`--token` 的值一律打成 `<redacted>`，不把凭据写进终端/日志/JSON。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 端口窗：与 `parametric.ts` 的分配区间一致（7400-7499）。 */
export const PORT_MIN = 7400;
export const PORT_MAX = 7499;
/** 默认年龄阈值：1 h。低于这个值的同形进程更可能是「别人正在跑」。 */
export const DEFAULT_MIN_AGE_SECONDS = 3600;
const APP_REL_PATH = join('spike', 'build123d', 'app.py');
/**
 * 打包态形态（`parametric.ts:307-320` 的 `resolveScript({ isPackaged:true })`）：
 * `join(resourcesPath, 'parametric', 'app.py')`，`resourcesPath` = Electron `process.resourcesPath`。
 * 平台目录名不同（win/linux `resources`、macOS `…/Contents/Resources`），所以按 `/^resources$/i` 比。
 */
const PACKAGED_DIR = 'parametric';
const PACKAGED_FILE = 'app.py';
const PACKAGED_RESOURCES = /^resources$/i;
/** `parametric.ts:783` 的 launch 一定带 `--token=<value>`：打包态形态靠它收敛误匹配。 */
const TOKEN_PREFIX = '--token';
const KILL_WAIT_MS = 5000;
const TOKEN_FLAGS = new Set(['--token', '--auth-token']);

// ---------------------------------------------------------------------------
// 纯判定层（无 IO）：classifySidecars / planKills
// ---------------------------------------------------------------------------

/**
 * 把 argv 里的凭据值打码，只留结构。`--token abc` / `--token=abc` 两种形式都盖掉。
 * @param {string[]} argv
 * @returns {string}
 */
export function formatCmdline(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    if (eq > 0 && TOKEN_FLAGS.has(arg.slice(0, eq))) {
      out.push(`${arg.slice(0, eq)}=<redacted>`);
      continue;
    }
    if (TOKEN_FLAGS.has(arg)) {
      out.push(arg);
      if (i + 1 < argv.length) {
        out.push('<redacted>');
        i += 1;
      }
      continue;
    }
    out.push(arg);
  }
  return out.join(' ');
}

/**
 * 从 argv 里取 `--port` 的值。`--port 7431` 与 `--port=7431` 都认；没有就返回 null。
 * @param {string[]} argv
 * @returns {number | null}
 */
export function readPort(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') {
      const next = argv[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) return Number(next);
      return null;
    }
    if (arg.startsWith('--port=')) {
      const tail = arg.slice('--port='.length);
      return /^\d+$/.test(tail) ? Number(tail) : null;
    }
  }
  return null;
}

/** `--token` / `--token=…` 是否在 argv 里（打包态形态的收敛判据）。 */
function hasTokenFlag(argv) {
  return argv.some((arg) => arg === TOKEN_PREFIX || arg.startsWith(`${TOKEN_PREFIX}=`));
}

/**
 * 打包态形态判据：`<…>/resources/parametric/app.py`（`resources` 大小写不敏感，macOS 是大写）。
 * 只做**结构**匹配，路径里出现 `..` 之类先 `resolve` 归一化再判，避免 `…/resources/x/../parametric/app.py` 蒙过去。
 * @param {string} value
 * @returns {boolean}
 */
function looksPackagedApp(value) {
  const full = resolve(value);
  if (basename(full) !== PACKAGED_FILE) return false;
  if (basename(dirname(full)) !== PACKAGED_DIR) return false;
  return PACKAGED_RESOURCES.test(basename(dirname(dirname(full))));
}

/**
 * 判定一条进程是否是「本仓的参数化 sidecar」。
 * 只用结构判据，不看 ppid / 年龄 —— 那是回收闸门的事。
 *
 * 两种 `app.py` 形态都认（`parametric.ts:307-320` 的两条分支）：开发态 `<repoRoot>/spike/build123d/app.py`
 * 逐段相等；打包态 `<resourcesPath>/parametric/app.py` 按三段结构 + `--token` 协议旗标。
 * 给了 `resourcesRoot` 就**只认**那一份（别处的同形路径不认，fail-closed）。
 *
 * @param {string[]} argv
 * @param {{ repoRoot: string, resourcesRoot?: string, portMin?: number, portMax?: number }} opts
 * @returns {{ sidecar: boolean, reasons: string[], port: number | null, match: 'dev' | 'packaged' | 'packaged-pinned' | null }}
 */
export function matchSidecar(argv, opts) {
  const reasons = [];
  const portMin = opts.portMin ?? PORT_MIN;
  const portMax = opts.portMax ?? PORT_MAX;
  const exe = argv.length > 0 ? basename(argv[0] ?? '') : '';
  if (!/^python[\d.]*$/.test(exe)) reasons.push(`not-python:${exe || '<empty>'}`);

  const expectedApp = resolve(opts.repoRoot, APP_REL_PATH);
  const pinnedApp = opts.resourcesRoot === undefined
    ? null
    : resolve(opts.resourcesRoot, PACKAGED_DIR, PACKAGED_FILE);
  const tokenFlag = hasTokenFlag(argv);

  let match = null;
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue;
    const full = resolve(arg);
    if (full === expectedApp) {
      match = 'dev';
      break;
    }
    // 显式给了 resourcesRoot：只认那一份，后缀匹配关闭。
    if (pinnedApp !== null) {
      if (full === pinnedApp) {
        match = 'packaged-pinned';
        break;
      }
      continue;
    }
    if (tokenFlag && looksPackagedApp(arg)) {
      match = 'packaged';
      break;
    }
  }
  if (match === null) {
    reasons.push(tokenFlag || pinnedApp !== null ? 'app-path-mismatch' : 'app-path-mismatch-or-auth-flag-missing');
  }

  const port = readPort(argv);
  if (port === null) reasons.push('port-missing');
  else if (port < portMin || port > portMax) reasons.push(`port-out-of-window:${port}`);

  return { sidecar: reasons.length === 0, reasons, port, match };
}

/**
 * 逐条分类。**纯函数**：不读 /proc、不发信号，测试直接喂 fixture 行。
 *
 * @param {Array<{ pid: number, ppid: number, argv: string[], ageSeconds?: number, startTicks?: number,
 *                 rssKb?: number }>} entries
 * @param {{ repoRoot: string, resourcesRoot?: string, portMin?: number, portMax?: number,
 *           minAgeSeconds?: number, selfPid?: number }} opts
 * @returns {Array<{
 *   pid: number, ppid: number, port: number | null, ageSeconds: number | null, rssKb: number | null,
 *   startTicks: number | null, match: 'dev' | 'packaged' | 'packaged-pinned' | null,
 *   cmdline: string, sidecar: boolean, verdict: 'killable' | 'orphan-too-young' | 'refused' | 'not-sidecar',
 *   reasons: string[]
 * }>}  verdict 含义：
 *   `not-sidecar`        —— 不是本仓 sidecar（跨仓库同形 / 非 python / 端口越界 / 无 --port）；
 *   `refused`            —— 是本仓 sidecar，但安全闸不过（PID 1 / 自己 / PPID≠1）；
 *   `orphan-too-young`   —— 是真孤儿，但年龄没到阈值；
 *   `killable`           —— 三条安全闸全过，`--kill` 时才会动手。
 *
 * `startTicks` 是**身份**（`/proc/<pid>/stat` 字段 22）：`applyKills` 发信号前靠它复验，
 * 所以它必须随 record 一路传到 planKills（只用来算 ageSeconds 就丢掉 = pid 复用窗口没闭合）。
 */
export function classifySidecars(entries, opts) {
  const minAgeSeconds = opts.minAgeSeconds ?? DEFAULT_MIN_AGE_SECONDS;
  const selfPid = opts.selfPid ?? -1;
  const records = [];

  for (const entry of entries) {
    const argv = Array.isArray(entry.argv) ? entry.argv.filter((x) => x !== '') : [];
    const { sidecar, reasons, port, match } = matchSidecar(argv, opts);
    const ageSeconds = Number.isFinite(entry.ageSeconds) ? Number(entry.ageSeconds) : null;
    const startTicks = Number.isFinite(entry.startTicks) ? Number(entry.startTicks) : null;
    const record = {
      pid: entry.pid,
      ppid: entry.ppid,
      port,
      ageSeconds,
      startTicks,
      match,
      rssKb: Number.isFinite(entry.rssKb) ? Number(entry.rssKb) : null,
      cmdline: formatCmdline(argv),
      sidecar,
      verdict: sidecar ? 'killable' : 'not-sidecar',
      reasons: [...reasons]
    };

    if (!sidecar) {
      records.push(record);
      continue;
    }

    // 安全闸 1：PID 1 永远不碰（那是 init）。
    if (record.pid === 1) {
      record.verdict = 'refused';
      record.reasons.push('refuse:pid-1');
      records.push(record);
      continue;
    }
    // 安全闸 2：不碰自己。
    if (record.pid === selfPid) {
      record.verdict = 'refused';
      record.reasons.push('refuse:self');
      records.push(record);
      continue;
    }
    // 安全闸 3：PPID 必须 1（= 已脱离父进程）。PPID 还指着别的进程 = 有人正在管它。
    if (record.ppid !== 1) {
      record.verdict = 'refused';
      record.reasons.push(`refuse:ppid-not-1:${record.ppid}`);
      records.push(record);
      continue;
    }
    // 安全闸 4：年龄门槛（不知道年龄 = 不给杀）。
    if (ageSeconds === null || ageSeconds < minAgeSeconds) {
      record.verdict = 'orphan-too-young';
      record.reasons.push(
        ageSeconds === null ? 'refuse:age-unknown' : `refuse:age-below:${ageSeconds}<${minAgeSeconds}`
      );
      records.push(record);
      continue;
    }

    records.push(record);
  }

  return records;
}

/**
 * 从分类结果里挑出**真正会动手**的目标。`kill !== true` 时恒为空 —— 默认 dry-run 就是靠这一条，
 * 而不是靠「调用方记得别杀」。
 * `startTicks` 必须一起带上：它是发信号前复验身份的凭据，丢了就只能按 pid 猜。
 * @param {ReturnType<typeof classifySidecars>} records
 * @param {{ kill?: boolean }} opts
 * @returns {Array<{ pid: number, port: number | null, startTicks: number | null }>}
 */
export function planKills(records, opts) {
  if (opts?.kill !== true) return [];
  return records
    .filter((r) => r.verdict === 'killable')
    .map((r) => ({ pid: r.pid, port: r.port, startTicks: r.startTicks ?? null }));
}

/**
 * 身份闸：`/proc/<pid>/stat` 的 starttime 与识别时是否一致。
 *
 * 为什么不能只看 `/proc/<pid>` 存在性：孤儿收到 SIGTERM 退出后，同一个 pid 可能在毫秒级被
 * 同用户的新进程复用（Linux pid 分配是递增+回绕，长跑机器上并不罕见）。按 pid 发信号 + 存在性判活
 * 的写法有两处坏结果：SIGKILL 打到**无关进程**（真误杀），以及把「目标已退出」报成 `still-alive`（假阳性）。
 *
 * @param {{ pid: number, startTicks?: number | null }} target
 * @param {(pid: number) => number | null} readTicks
 * @returns {{ ok: true, startTicks: number } | { ok: false, reason: string }}
 */
export function verifyIdentity(target, readTicks) {
  const expected = Number.isFinite(target.startTicks) ? Number(target.startTicks) : null;
  if (expected === null) return { ok: false, reason: 'refuse:identity-unknown' };
  const actual = readTicks(target.pid);
  // 读不到 = 这个 pid 已经不在（或 stat 不可读）→ 我们的目标已经退出，别再动这个号。
  if (actual === null) return { ok: false, reason: 'gone-before-signal' };
  if (actual !== expected) return { ok: false, reason: `refuse:pid-reused:${actual}!=${expected}` };
  return { ok: true, startTicks: expected };
}

/**
 * 执行回收计划。`killer` / `readStartTicks` 可注入（测试用记录器验证「不该杀时一次都没调用」）。
 *
 * 每个目标两次身份复验：SIGTERM 前一次、SIGKILL 前再一次。判活也一律走身份
 * （`stillOurs`），不走 `/proc` 存在性 —— 复用出来的新进程不归我们，也不是「我们的目标还活着」。
 *
 * @param {Array<{ pid: number, port: number | null, startTicks?: number | null }>} targets
 * @param {{ killer?: (pid: number, signal: NodeJS.Signals) => void, sleep?: (ms: number) => Promise<void>,
 *           portProbe?: (port: number) => Promise<boolean>, procRoot?: string,
 *           readStartTicks?: (pid: number) => number | null }} [deps]
 * @returns {Promise<Array<{ pid: number, ok: boolean, portFree?: boolean, refused?: boolean, error?: string }>>}
 */
export async function applyKills(targets, deps = {}) {
  const killer = deps.killer ?? ((pid, signal) => process.kill(pid, signal));
  const portProbe = deps.portProbe ?? isPortFree;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const procRoot = deps.procRoot ?? '/proc';
  const readTicks = deps.readStartTicks ?? ((pid) => readStartTicks(pid, procRoot));
  const results = [];

  for (const target of targets) {
    // ① 发信号前的身份闸：pid 复用就不动（这是唯一的误杀入口）。
    const before = verifyIdentity(target, readTicks);
    if (!before.ok) {
      results.push({ pid: target.pid, ok: false, refused: true, error: before.reason });
      continue;
    }
    // 判活 = 「这个 pid 还是不是我们识别到的那一个进程」。消失/换人都算我们的目标已经退出。
    const stillOurs = () => {
      const ticks = readTicks(target.pid);
      return ticks !== null && ticks === before.startTicks;
    };

    try {
      killer(target.pid, 'SIGTERM');
      let gone = false;
      for (let waited = 0; waited < KILL_WAIT_MS && !gone; waited += 250) {
        await sleep(250);
        gone = !stillOurs();
      }
      if (!gone) {
        // ② 升级 SIGKILL 前再验一次：5 s 窗口足够让 pid 被复用。
        const again = verifyIdentity(target, readTicks);
        if (!again.ok) {
          results.push({
            pid: target.pid,
            ok: false,
            refused: true,
            error: `${again.reason}:before-sigkill`
          });
          continue;
        }
        killer(target.pid, 'SIGKILL');
        await sleep(250);
        gone = !stillOurs();
      }
      if (!gone) {
        results.push({ pid: target.pid, ok: false, error: 'still-alive' });
        continue;
      }
      // 进程消失不等于端口释放（理论上 fd 随进程关闭，这里实测一遍，因为「端口还被占着」
      // 才是复现孤儿那个 bug 的真实症状）。
      const portFree = target.port === null ? true : await portProbe(target.port);
      results.push(
        portFree
          ? { pid: target.pid, ok: true, portFree }
          : { pid: target.pid, ok: false, portFree, error: `port-still-listening:${target.port}` }
      );
    } catch (error) {
      results.push({ pid: target.pid, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return results;
}

/**
 * 试绑 127.0.0.1:<port> 判断端口是否真的空出来了（只绑不留，立即关）。
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function isPortFree(port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

// ---------------------------------------------------------------------------
// IO 层：读 /proc
// ---------------------------------------------------------------------------

/**
 * 快速探活：`/proc/<pid>` 是否存在（不发 0 号信号，避免 EPERM 误判）。
 *
 * **不能单独当判据**：pid 会被复用，存在只说明「这个号有人用」。回收路径的身份判据是
 * `verifyIdentity`（starttime 比对）；本函数保留给调用方的粗探活/文档示例。
 * @param {number} pid
 * @returns {boolean}
 */
export function isAlive(pid) {
  try {
    statSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

function readStartTicks(pid, procRoot) {
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    // comm 可能带空格/括号，按**最后一个** ')' 切，字段 3 起才可信。
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // tail[0] = state(字段3) → starttime 是字段 22 → tail[19]
    const ticks = Number(tail[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

function readPpid(pid, procRoot) {
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // tail[1] = 字段 4 = ppid
    const ppid = Number(tail[1]);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

function readRssKb(pid, procRoot) {
  try {
    const status = readFileSync(join(procRoot, String(pid), 'status'), 'utf8');
    const line = status.split('\n').find((l) => l.startsWith('VmRSS:'));
    if (line === undefined) return null;
    const kb = Number(line.replace(/[^\d]/g, ''));
    return Number.isFinite(kb) ? kb : null;
  } catch {
    return null;
  }
}

function readArgv(pid, procRoot) {
  try {
    const raw = readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8');
    return raw.split('\0').filter((x) => x !== '');
  } catch {
    return null;
  }
}

function readUptimeSeconds(procRoot) {
  try {
    const up = readFileSync(join(procRoot, 'uptime'), 'utf8').trim().split(' ')[0];
    const seconds = Number(up);
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

/**
 * 扫 `/proc/*`，返回 classifySidecars 能吃的 entries。
 *
 * `startTicks` 一并回传：它是 pid 的**身份**（字段 22），`applyKills` 发信号前要拿它复验；
 * 只用来算 `ageSeconds` 就丢掉，等于把 pid 复用窗口留在那里。
 * @param {{ procRoot?: string, clkTck?: number }} [opts]
 */
export function scanProcesses(opts = {}) {
  const procRoot = opts.procRoot ?? '/proc';
  const clkTck = opts.clkTck ?? 100;
  const uptime = readUptimeSeconds(procRoot);
  const entries = [];

  let names;
  try {
    names = readdirSync(procRoot);
  } catch {
    return entries;
  }

  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const argv = readArgv(pid, procRoot);
    if (argv === null || argv.length === 0) continue;
    const ppid = readPpid(pid, procRoot);
    if (ppid === null) continue;
    const startTicks = readStartTicks(pid, procRoot);
    const ageSeconds =
      startTicks !== null && uptime !== null ? Math.max(0, Math.round(uptime - startTicks / clkTck)) : null;
    entries.push({ pid, ppid, argv, ageSeconds, startTicks, rssKb: readRssKb(pid, procRoot) });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `用法: node scripts/sidecar-doctor.mjs [选项]

  (默认)                  dry-run：只列出候选，不发任何信号
  --json                  末尾输出一行 JSON 摘要（仍是 dry-run，除非同时给 --kill）
  --kill                  回收满足三闸的孤儿（repoRoot + 端口窗 + 年龄）
  --min-age-min <分钟>    年龄阈值，默认 60（= 1 h）；必须 > 0（0 = 关掉年龄闸，直接拒绝）
  --repo-root <路径>      开发态仓库根，默认脚本上一级（desktop/..）
  --resources-root <路径> 发行包的 resources 目录（含 parametric/app.py）；给了就只认这一份
  --help                  本帮助

两种 app.py 形态都认：<repoRoot>/spike/build123d/app.py（开发态）、
<resourcesRoot>/parametric/app.py（打包态，等价于 Electron 的 process.resourcesPath/parametric/app.py）。

退出码: 0 正常 / 1 kill 后仍存活 / 2 用法错`;

function parseArgs(argv) {
  const opts = {
    kill: false,
    json: false,
    help: false,
    minAgeSeconds: DEFAULT_MIN_AGE_SECONDS,
    repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
    resourcesRoot: undefined
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--kill') opts.kill = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--min-age-min') {
      const raw = argv[i + 1];
      i += 1;
      const minutes = Number(raw);
      // `0` 不是「更宽松」，是把年龄闸整个关掉（三闸变两闸）：同用户 1 秒前刚起的 kernel
      // 也会进回收计划。想快就写 1，不许写 0。
      if (raw === undefined || !Number.isFinite(minutes) || minutes <= 0) {
        return { error: `--min-age-min 需要一个 > 0 的分钟数（收到 ${raw ?? '<缺失>'}；0 = 关掉年龄闸，不做）` };
      }
      opts.minAgeSeconds = Math.round(minutes * 60);
    } else if (arg === '--repo-root') {
      const raw = argv[i + 1];
      i += 1;
      if (raw === undefined || raw.startsWith('--')) {
        return { error: '--repo-root 需要一个路径' };
      }
      opts.repoRoot = resolve(raw);
    } else if (arg === '--resources-root') {
      const raw = argv[i + 1];
      i += 1;
      if (raw === undefined || raw.startsWith('--')) {
        return { error: '--resources-root 需要一个路径（发行包的 resources 目录）' };
      }
      opts.resourcesRoot = resolve(raw);
    } else {
      return { error: `未知参数: ${arg}` };
    }
  }

  return { opts };
}

function formatAge(seconds) {
  if (seconds === null) return '?';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function formatRss(kb) {
  if (kb === null) return '?';
  return `${(kb / 1024).toFixed(0)} MB`;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    console.error(`sidecar-doctor: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }

  const { opts } = parsed;
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  // repoRoot（开发态）或 resourcesRoot（打包态）必须真的存在 App 脚本 —— 否则端口窗内随便什么
  // 同形进程都成了「本仓孤儿」。两种形态任一成立即可。
  const appPath = join(opts.repoRoot, APP_REL_PATH);
  const packagedPath = opts.resourcesRoot === undefined
    ? null
    : join(opts.resourcesRoot, PACKAGED_DIR, PACKAGED_FILE);
  const exists = (path) => {
    if (path === null) return false;
    try {
      statSync(path);
      return true;
    } catch {
      return false;
    }
  };
  const appExists = exists(appPath);
  const packagedExists = exists(packagedPath);
  if (opts.kill && !appExists && !packagedExists) {
    console.error(
      `sidecar-doctor: --kill 需要有效的 repoRoot 或 resourcesRoot，找不到 ${appPath}`
        + (packagedPath === null ? '' : ` 也找不到 ${packagedPath}`)
    );
    return 2;
  }
  if (!appExists && !packagedExists) {
    console.error(`sidecar-doctor: 警告 找不到 ${appPath}（只做 dry-run 匹配；打包态形态仍按后缀认）`);
  }

  const entries = deps.entries ?? scanProcesses({ procRoot: deps.procRoot, clkTck: deps.clkTck });
  const records = classifySidecars(entries, {
    repoRoot: opts.repoRoot,
    ...(opts.resourcesRoot === undefined ? {} : { resourcesRoot: opts.resourcesRoot }),
    minAgeSeconds: opts.minAgeSeconds,
    selfPid: process.pid
  });
  const sidecars = records.filter((r) => r.sidecar);
  const targets = planKills(records, { kill: opts.kill });

  if (!opts.json) {
    console.log(
      `sidecar-doctor ${opts.kill ? 'KILL' : 'DRY-RUN'} · repoRoot=${opts.repoRoot}` +
        `${opts.resourcesRoot === undefined ? '' : ` · resourcesRoot=${opts.resourcesRoot}`} · ` +
        `端口 ${PORT_MIN}-${PORT_MAX} · 年龄阈值 ${formatAge(opts.minAgeSeconds)} · 扫描 ${records.length} 个进程`
    );
    if (sidecars.length === 0) {
      console.log(
        '没有找到本仓的 sidecar 进程（已认两种形态：spike/build123d/app.py、resources/parametric/app.py；'
          + `端口 ${PORT_MIN}-${PORT_MAX}）。`
      );
    } else {
      for (const r of sidecars) {
        const mark = r.verdict === 'killable' ? 'KILLABLE' : r.verdict.toUpperCase();
        console.log(
          `pid ${r.pid}  ppid ${r.ppid}  port ${r.port ?? '?'}  age ${formatAge(r.ageSeconds)}  ` +
            `rss ${formatRss(r.rssKb)}  [${mark}] (${r.match ?? '?'}) ${r.cmdline}`
        );
        if (r.reasons.length > 0) console.log(`  └ ${r.reasons.join(' ')}`);
      }
      const killable = records.filter((r) => r.verdict === 'killable').length;
      const rssTotal = sidecars.reduce((sum, r) => sum + (r.rssKb ?? 0), 0);
      console.log(`合计 ${sidecars.length} 个 sidecar，其中可回收 ${killable} 个，占用约 ${formatRss(rssTotal)}。`);
    }
  }

  let killResults = [];
  if (targets.length > 0) {
    console.log(
      `即将回收 ${targets.length} 个孤儿（SIGTERM → 5 s → SIGKILL）：${targets.map((t) => t.pid).join(', ')}`
    );
    killResults = await applyKills(targets, deps);
    for (const r of killResults) {
      console.log(r.ok ? `  pid ${r.pid} 已退出` : `  pid ${r.pid} 未能退出: ${r.error}`);
    }
  } else if (opts.kill) {
    console.log('没有满足三闸（repoRoot + 端口窗 + 年龄）的孤儿，未发任何信号。');
  }

  if (opts.json) {
    console.log(
      JSON.stringify({
        repoRoot: opts.repoRoot,
        resourcesRoot: opts.resourcesRoot ?? null,
        portWindow: [PORT_MIN, PORT_MAX],
        minAgeSeconds: opts.minAgeSeconds,
        mode: opts.kill ? 'kill' : 'dry-run',
        scanned: records.length,
        sidecars: sidecars.map((r) => ({
          pid: r.pid,
          ppid: r.ppid,
          port: r.port,
          ageSeconds: r.ageSeconds,
          startTicks: r.startTicks,
          match: r.match,
          rssKb: r.rssKb,
          verdict: r.verdict,
          reasons: r.reasons,
          cmdline: r.cmdline
        })),
        targets: targets.map((t) => t.pid),
        killed: killResults
      })
    );
  }

  const failed = killResults.filter((r) => !r.ok);
  return failed.length > 0 ? 1 : 0;
}

// 只在被直接执行时跑 CLI（`import` 本文件做单测不会触发扫描）。
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    }
  );
}
