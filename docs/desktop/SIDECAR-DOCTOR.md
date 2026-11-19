# 孤儿 sidecar 体检 / 回收：`npm run doctor:sidecar`

参数化内核 sidecar（`python spike/build123d/app.py`）是**长驻子进程**。它由
`desktop/electron/parametric.ts` 的 `start()` 以 `detached: true` 起在独立进程组里，
正常退出走 `killTree()` / app 退出钩子 / 诊断脚本的 `finally`。**只要父进程被 SIGKILL，
这三条路一条都不会执行**，子进程被 init（PID 1）收养 —— 它继续占着端口和几百 MB 内存，
而 `start()` 只会去找**空闲端口**（`portAvailable`），于是孤儿被静默绕过，能活数小时。

这个脚本不做架构改动，只做**外部发现 + 显式回收**：不动 `parametric.ts`，不接 CI。

## 用法

```bash
npm run doctor:sidecar                          # dry-run（默认）：列出候选，不发任何信号
npm run doctor:sidecar -- --json                # 同上，末尾一行 JSON（仍是 dry-run）
npm run doctor:sidecar -- --kill                # 回收：三闸全过才动手
npm run doctor:sidecar -- --kill --min-age-min 30
npm run doctor:sidecar -- --repo-root /path/to/automation-cad-prototype
npm run doctor:sidecar -- --resources-root /opt/AutomationCAD/resources   # 只治理这个发行包
```

退出码：`0` 正常（有没有候选、是不是 dry-run 都算正常）· `1` `--kill` 后进程仍存活 / 信号失败 / 端口没放出来 ·
`2` 用法错（未知参数、阈值非法、`--kill` 时 `<repoRoot>/spike/build123d/app.py` 与
`<resourcesRoot>/parametric/app.py` **都**找不到）。**`--min-age-min 0` 一律退 2** —— `0` 不是「更宽松」，
是把年龄闸整个关掉（三闸变两闸），同用户刚起的 kernel 也会进回收计划；想快就写 `1`。

**默认永远是 dry-run。** `--kill` 是唯一会发信号的开关，而且必须显式给。
多会话共用同一个 repo 是本机常态 —— 别人正在跑的 kernel 也是同形 argv，
所以流程固定为「先 `--json` 看，再决定杀」。

## 判据

认作**本仓 sidecar** 必须三条同时成立：

| # | 判据 | 说明 |
|---|---|---|
| 1 | `argv[0]` 的 basename 匹配 `^python[\d.]*$` | `python3` / `python` / `python3.12` 都算 |
| 2 | argv 里有**完整路径等于** `<repoRoot>/spike/build123d/app.py`（开发态）**或** `<resourcesRoot>/parametric/app.py`（打包态） | 开发态逐段相等、**不做前缀匹配**（否则 `...-prototype-2` 这种同形仓库会被误伤）；打包态与 `parametric.ts` 的 `resolveScript()` 同一条规则（`join(resourcesPath,'parametric','app.py')`，macOS 的 `…/Contents/Resources` 大写也认），并**额外要求 argv 带 `--token` 旗标**（分写与等号两种写法都认；`parametric.ts` 的 launch 必带），用来收敛同形误匹配 |
| 3 | `--port <n>` 或 `--port=<n>`，且 `7400 ≤ n ≤ 7499` | 与 `parametric.ts` 的分配区间一致；无 `--port` 直接不算 |

回收（`--kill`）还要再加三闸，任一不满足就**只列不杀**：

| # | 安全闸 | 理由 |
|---|---|---|
| 4 | `ppid === 1` | 父进程还活着 = 有人在管它，不归我们 |
| 5 | `pid !== 1` 且 `pid !== 自己` | PID 1 是 init；不碰自身 |
| 6 | 年龄 ≥ 阈值（默认 3600 s = 1 h） | 短命同形进程更可能是别人刚起的任务；读不到 starttime 一律按「年龄未知」拒绝 |

打包态形态是**最会产生孤儿的形态**（用户机器上的 detached 发行包），原来完全漏检；
给了 `--resources-root` 时**只认**这一份（别处的同形路径一律不认，fail-closed），record 里的
`match` 会写 `dev` / `packaged` / `packaged-pinned`，dry-run 一眼能看出是按哪种形态认出来的。

**已知限制（P2，未改代码）**：`--resources-root` 写错时 **dry-run 仍 `exit 0` 静默零命中**
（只有 `--kill` 才校验路径存在）。所以判空之前先看 `scanned` 与 `sidecars` 计数，别把「路径写错」
读成「没有孤儿」。

年龄取 `/proc/<pid>/stat` 字段 22（starttime，clock ticks）+ `/proc/uptime`，不依赖 `ps` 输出；
RSS 取 `/proc/<pid>/status` 的 `VmRSS`。

**pid 复用闸（发信号前，不在识别时）**：record 保留 `startTicks`，`applyKills` 在 SIGTERM 前、
SIGKILL 前各重读一次 —— 读不到 = 目标已退出；对不上 = pid 换人了，**一律不发信号**。
（旧实现只按 pid 发信号、靠 `/proc/<pid>` 存在性判活，5 s 轮询窗内 pid 被同用户新进程复用就会误杀
无关进程。）残余只有「`/proc` stat 读 → `kill` 系统调用」的微秒窗：pid_max=4M 下该窗内复用不现实，
接受并在脚本头写明。

输出里 `--token` 的值**一律打码为 `<redacted>`**，不把凭据写进终端、日志或 `--json`。

## 实测（本机，R11 采集）

```
$ npm run doctor:sidecar --silent
sidecar-doctor DRY-RUN · repoRoot=/tmp/automation-cad-prototype · 端口 7400-7499 · 年龄阈值 1h00m · 扫描 340 个进程
pid 2040641  ppid 1  port 7431  age 9h00m  rss 451 MB  [KILLABLE] (dev) /root/.venvs/b123d/bin/python3 /tmp/automation-cad-prototype/spike/build123d/app.py --port 7431 --token <redacted>
pid 2114164  ppid 1  port 7445  age 5h18m  rss 443 MB  [KILLABLE] (dev) /root/.venvs/b123d/bin/python /tmp/automation-cad-prototype/spike/build123d/app.py --port 7445 --token <redacted>
合计 2 个 sidecar，其中可回收 2 个，占用约 894 MB。

$ npm run doctor:sidecar -- --kill
sidecar-doctor KILL · ... · 即将回收 2 个孤儿（SIGTERM → 5 s → SIGKILL）：2040641, 2114164
  pid 2040641 已退出
  pid 2114164 已退出
# exit 0；复扫（--json）sidecars=[]、targets=[]、killed=[]，端口 7431/7445 均已释放
```

这两个进程在 R10 收尾时就已存在（`parametric.ts:789` 的 `detached: true` + 父进程被强杀），
当时实测端口 7431 / 7445、存活 8 h 19 m / 4 h 37 m、内存 462 MB + 453 MB ≈ **894 MB**，
且没有 pidfile / reaper 能发现它们（全仓 `grep pidfile|\.pid|stale` 无命中）。
R11 先 dry-run 取证（只列不杀），随后 `--kill` **实测回收成功**：两个进程消失、端口释放、
复扫 0 命中、`exit 0`。**回收不是自动的** —— 脚本不接 CI、不加定时任务，下次残留仍要显式跑。

## 为什么不能靠删 `detached: true` 解决

`killTree()` 用 `process.kill(-pid)` 杀的是**整个进程组**：python 自己还会拉起子进程
（OCP 线程/临时进程），只有把 sidecar 设成进程组首（`detached: true`）才能一次收干净；
Windows 上 `detached` 同时是 job 边界。删掉它 = 每个 sidecar 都可能留下孙进程，
代价比治理两个孤儿大。所以本轮只加外部体检脚本，启动路径零改动。
真正的架构解（pidfile + 启动时 reaper）不在本轮范围。

## 释放方式（人工，需确认）

```bash
npm run doctor:sidecar -- --json          # 先看：pid / port / age / rss
npm run doctor:sidecar -- --kill          # 三闸全过才动手（SIGTERM → 5 s → SIGKILL）
ss -ltnp | grep -E ':74[0-9][0-9]'        # 复核端口已释放
```

若目标不满足三闸（例如年龄不足 1 h），脚本会打印 `refuse:age-below:<实际><阈值>` 并**一个信号都不发**；
确认确实是本仓自己的残留后，才用 `--min-age-min` 放宽阈值 —— **最小写 `1`，`0` 会被拒（exit 2）**。
`--kill` 失败（进程仍在 / 端口仍被占）退 1，与「用法错」的 2 分开，别把 1 读成参数写错。

## 测试

`desktop/test/meta/sidecar-doctor.test.mjs`（定向跑，**不在 `npm test` 的自动分支里加特判**）：

```bash
node --test desktop/test/meta/sidecar-doctor.test.mjs
```

**15 例**（R11 整改后 8 → 15，实跑 15/15）：真孤儿 fixture 识别 · repoRoot/端口/解释器不符 → `not-sidecar` ·
PPID≠1 / PID 1 / 自身 → `refused` · 年龄不足 → `orphan-too-young`、计划为空且 killer 零调用 ·
dry-run 不发信号 · 用法错（含 `--min-age-min 0`）退出码 2 · 三闸全过恰好一次 SIGTERM ·
进程消失后**复查端口**（未释放 → `port-still-listening` / 退出码 1）· **身份闸 4 例**（`startTicks` 进 record
一路不丢 / 发信号前对不上 → `refuse:pid-reused` 零信号 / SIGTERM 后 pid 复用不升级 SIGKILL / 身份未知拒发）·
**打包态 3 例**（`resources/parametric/app.py` 认得出且 dev 形态不回归 / 打包态走完三闸且凭据打码 /
`--resources-root` 机器上无 dev `app.py` 也能 `--kill`）。

`--kill` 的成功判据是两件事：`/proc/<pid>` 消失 **且** 127.0.0.1 上该端口能被重新试绑；
只满足前者（端口还被别人占着）会报 `port-still-listening` 并退出 1。
