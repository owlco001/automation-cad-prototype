# 分块体积实测（字节算术 → 打包产物实测）

日期：2026-11-22 · 分支 `fix-audit-findings` · 实测时代码状态 `HEAD=2c59899`（= `eeeb4a4` + 合并 `fix-shared-three-surface`）· 实测期间工作树干净（`git status --porcelain -uall` 0 行，`dist/` `dist-electron/` 已被 `.gitignore` 忽略）

本文目的：把 [MODULE-CHUNKS.md](MODULE-CHUNKS.md#L75) 里那句「体积收益量化……现在不做数字承诺」
换成**可核对的本机实测数字**，并把本机**证不了的**部分逐条列成待补证据。
**没有实测到的数字，本文一律不填。**

> **2026-11-23 增补**：§8 给出把「安装包体积 / 解包后占用 / 冷启动」变成 CI 可复现数字的
> 脚本与 workflow 接线，并列出仍需人工做的 Full/Core 双版本共存验收。本轮**没有触发任何
> workflow 运行**，所以 §8 只写字段、命令与判据，不填任何 CI 实测值；真实数字要等
> `windows-build` 跑完后从 step summary 与 artifact 里取。

## 0. 结论先行

| 项目 | 状态 | 结果 |
|---|---|---|
| `npm run build:ext` | ✅ 实跑 | EXIT=0，产物字节见 §1 |
| 7 个分块与 `manifest.json` 的字节/sha256 一致性 | ✅ 实测（本机 `dist/`） | 7/7 一致，总计 **587,496 B** + 清单 **1,861 B** |
| `electron-builder --dir --linux dir` | ❌ **失败**（沙箱只读 `$HOME`） | 无任何产物；见 §2 的精确报错 |
| `app.asar` 字节数 | ⛔ **未取得** | 打包没跑起来，没有 asar 可测；不给推测值 |
| asar 内是否存在 `dist/modules/*` | ⛔ **未取得** | 同上；只有「配置上会被打进去」的静态证据（§4） |
| 从 asar 抽块比对 sha256 | ⛔ **未取得** | 同上 |
| Windows NSIS 体积 / 安装后占用 / 冷启动 / 双版本共存 | ❌ 本机不可测 | 见 §5，给出 Windows runner 上的验收步骤 |

**阅读本文最重要的一条判断**见 §3：按当前架构和当前 `files` 配置，**分块并不会让安装包变小**。
分块解决的是「加载」而不是「分发体积」；真正让字节下降的是分块过程中顺带做掉的
「three.js 不再逐块重复」（`a4cfd6a`），而那是另一件事。

## 1. 本次实跑：`npm run build:ext`

命令（本机 Linux，`node v26.7.0`，x86_64，内核 6.8.12；`node_modules` 为符号链接 →
`/root/workspace/automation-cad-prototype/desktop/node_modules`）：

```
cd /root/workspace/automation-cad-audit-main/desktop
npm run build:ext          # EXIT=0
```

脚本链：`tsc --noEmit && vite build && node scripts/build-electron.mjs && node scripts/build-mcp.mjs
&& node scripts/check-bundle-size.mjs && node scripts/build-module-chunks.mjs --quiet`

关键输出（原样）：

```
dist/occt-import-js.wasm  7,604.03 kB │ gzip: 3,114.12 kB
dist/extension.js         2,783.18 kB │ gzip:   866.24 kB
{"extensionBytes":2783215,"extensionGzipBytes":865759,"wasmBytes":7604031,"totalBytes":10387246,
 "nativeBytes":{"main.cjs":6996190,"mcp.cjs":1524510,"preload.cjs":13546}}
```

说明：`dist/` 与 `dist-electron/` 的 mtime（23:16）原本已晚于 `src/ electron/ scripts/ modules/` 的最新改动，
理论上可跳过；但本机当时无法从产物反证「与 HEAD 完全同源」，所以**实际重跑了一遍**，而非假定它是最新。
重跑过程中发现代码状态在会话期间前进了：先有合并 `fix-shared-three-surface`（`2c59899`），
`dist/` 随后被重建（23:20:12，晚于该提交），`extension.js` 从 2,783,181 B 变为 2,783,215 B。
因此本文的**有效版本号是 `2c59899`**（不是会话开始时的 `eeeb4a4`），并在该状态上重跑了一次 `build:ext` 复核。
分块的字节与哈希与重跑前**完全一致**；`extension.js` 与重跑前相比从 2,783,181 B 变为 2,783,215 B（+34 B，随代码状态变化），下表一律取**当前 HEAD 的实测值**。

产物字节（`stat -c %s`）：

| 文件 | 字节 |
|---|---:|
| `dist/extension.js` | 2,783,215 |
| `dist/occt-import-js.wasm` | 7,604,031 |
| `dist-electron/main.cjs` | 6,996,190 |
| `dist-electron/mcp.cjs` | 1,524,510 |
| `dist-electron/preload.cjs` | 13,546 |
| `dist/modules/manifest.json` | 1,861 |
| `dist/modules/*.js`（7 个） | **587,496** |

### 1.1 分块逐文件（字节 + sha256，均取自实际产物）

| id | 文件 | 字节 | sha256（前 12 位） |
|---|---|---:|---|
| `cost.estimation` | `cost.estimation.js` | 53,697 | `088a731902e8` |
| `design.layout-editor` | `design.layout-editor.js` | 315,580 | `9f1568d48c6f` |
| `drawings.techdraw` | `drawings.techdraw.js` | 22,689 | `86f8a7fa86ea` |
| `elec.validation` | `elec.validation.js` | 40,206 | `31e1303cca28` |
| `plcgen` | `plcgen.js` | 139,032 | `cc4275a7d8c1` |
| `project.portable` | `project.portable.js` | 8,317 | `1517dd333881` |
| `system.update` | `system.update.js` | 7,975 | `8d953759f9f2` |
| **合计** | | **587,496** | |

`manifest.json` = **1,861 B**（`schemaVersion 1` / `moduleApiVersion 1` / 7 条 `chunks`）。
`dist/modules` 目录合计 **593,453 B**（= 587,496 + 1,861 + 4 字节目录项），且**没有多余文件**
（没有残留 `.css`、没有测试探针块）。

### 1.2 一致性核验（清单 vs 磁盘产物）

方法：用 `node` 读 `dist/modules/manifest.json`，对每个 `chunks[].file` 逐字节读盘，
比较 `bytes`、`sha256`，并检查自注册标记。自注册形态实测为：

```
(globalThis.__cadRegisterModuleChunk||function(){throw new Error('chunk host missing')})
  ({id:"cost.estimation",apiVersion:1,exports:x})
```

注意标记是 `({id:"…"`（**没有空格**），用 `grep -a 'id: "…"'` 这种带空格的模式会**假阴性**。

结果：

```
chunk_js_files_on_disk=7
chunk_total_bytes=587496 manifest_bytes=1861
verify_ok=7 verify_bad=0
orphans=(none)
```

交叉验证（仓库自带门禁，同样 EXIT=0）：

```
npm run modules:verify
MODULE_CHUNKS_PROGRESS chunked=7/12 stillInCore=5
MODULE_CHUNK_OK … ×7
MODULE_CHUNKS_VERIFIED chunks=7 root=…/desktop/dist/modules
```

> 顺带发现：[MODULE-CHUNKS.md:62](MODULE-CHUNKS.md#L62) 仍写「当前：1/12」，与实测 **7/12** 不符（历史文案未随迁移更新）。本文不改它，留作下一批切片的文档债。

## 2. 打包实测失败：`electron-builder --dir`

命令（未加任何 `--publish`、未改任何配置、未联网下载）：

```
./node_modules/.bin/electron-builder --dir --linux dir
```

**结果：失败，无 `release/` 目录，无 `app.asar`。** 原样日志：

```
  • electron-builder  version=26.15.3 os=6.8.12-20-pve
  • loaded configuration  file=package.json ("build" field)
  • executing @electron/rebuild  electronVersion=45.2.0 arch=x64 buildFromSource=false
    workspaceRoot=…/automation-cad-audit-main/desktop projectDir=./ appDir=./
  • installing native dependencies  arch=x64
  • preparing       moduleName=@serialport/bindings-cpp arch=x64
  ⨯
Error: ENOENT: no such file or directory, mkdir '/root/.electron-gyp'
    at async Object.mkdir (node:internal/fs/promises:1605:10)
    at async go (…/node_modules/node-gyp/lib/install.js:161:23)
    at async install (…/node_modules/node-gyp/lib/install.js:63:18)
    at async getNodeDir (…/node_modules/node-gyp/lib/configure.js:79:7)
    errno: -2, code: 'ENOENT', syscall: 'mkdir', path: '/root/.electron-gyp'
  ⨯ node-gyp failed to rebuild '…/node_modules/@serialport/bindings-cpp'
```

### 2.1 失败原因（诚实归因）

- **不是**「electron-builder 需要下载 app-builder / electron 而失败」。electron-builder **26.x 已无
  `app-builder-bin` 依赖**（`app-builder-lib@26.15.3` 的 deps 里没有它，`node_modules` 里也确实没有），
  走的是纯 JS 路径；`node_modules/electron/dist` 已存在（electron **45.2.0**，与 `^45.2.0` 一致），
  `~/.cache/electron/**/electron-v45.2.0-linux-x64.zip` 也在本机缓存里。
- **真实原因**：`@electron/rebuild` 在打包最前面要为原生依赖 `@serialport/bindings-cpp@13.0.0`
  （由 `serialport` 引入）跑 node-gyp，node-gyp 要先 `mkdir /root/.electron-gyp`，
  而本会话的 `$HOME` 是**只读**的：

  ```
  $ mkdir -p /root/.cad-probe
  mkdir: cannot create directory '/root/.cad-probe': Read-only file system
  ```

  即这是**沙箱文件系统边界**，不是网络问题，也不是工程配置问题。构建在「准备原生依赖」阶段就退出，
  连 asar 都没开始组装。
- **为什么只跑到这一步就停**：本会话的审批提示被禁用，无法申请把 `$HOME` 置为可写；
  用 `HOME=` / `npm_config_devdir=` 之类的环境变量把 node-gyp 的头部缓存挪进工作区，
  等于**绕开被明确禁止的沙箱边界**，且任务要求「记录准确错误并停止、不要改配置凑成功」，
  因此**没有尝试**。若在正常开发机上重跑，这一步之后 node-gyp 还可能要下载 node/electron 头部，
  那是另一个**未实测**的风险点。
- 旁证（不构成失败原因，但会影响以后在这台机器上打包）：`extraResources` 里的
  `desktop/vendor/qt`、`desktop/vendor/dwg`、`desktop/vendor/pipeline` 三个目录**本机都不存在**
  （分别由 `scripts/vendor-qt.mjs`、`scripts/vendor-dwg.mjs`、`scripts/build-pipeline.mjs` 在
  `npm run dist:win` 链路里生成，不在 `build:ext` 里）。即使 `$HOME` 可写，这次 `--dir` 也会在
  extraResources 阶段缺这三份资源；`vendor/qt` 的校验门槛是「文件数 ≥ 40 且总字节 > 30 MB」。

## 3. 实测到的「体积账」：分块不等于安装包变小

这是本次唯一能下结论的架构级判断，依据是本机实测字节 + 仓库里可核对的配置/代码：

1. **分块确实进了 asar 候选区。** `package.json` 的 `files` 含 `dist/**/*`（[package.json:92](../../desktop/package.json#L92)），
   `dist/modules` 在 `dist/` 下；[MODULE-CHUNKS.md:71](MODULE-CHUNKS.md#L71) 也写明「`dist/modules` 已随
   `files: dist/**/*` 进入 asar」，运行时读取路径是 `app.getAppPath()/dist/modules`。
   所以 7 个分块 **587,496 B + 清单 1,861 B = 589,357 B** 是**照样随包发布**的。
2. **「按需加载」省的是内存与启动期执行，不是安装包字节。** 模块文件仍完整躺在 asar 里；
   只有把分块改成「不在包内、单独下载/单独安装包」（[MODULE-CHUNKS.md:85-86](MODULE-CHUNKS.md#L85-L86) 的第 4 条，
   目前**未实现**），这 589,357 B 才会真正从安装包里消失。
3. **让字节真正下降的是同一批提交里的另一件事**：`a4cfd6a`「Share three.js from the core bundle
   instead of duplicating it per chunk」。分块是独立 IIFE，若不外置共享依赖，`three` 会**每块各打一份**；
   因为 `sharedExternals` 把 three 外置成 `globalThis.__cadSharedDeps.THREE`，现在只剩一份。
   `design.layout-editor` 单块 315,580 B 也印证块内没有整份 three。
4. **因此「分块让安装包变小」这句话在当前形态下不成立**；能成立的说法只有两种，且都需要实测：
   - 「分块让**核心启动路径**变小/变快」（= 冷启动，见 §5.3，本机未测）；
   - 「把分块移出包体后可省 ≈ 589 KB 未压缩 / 压缩后见 §3.1」（= 分发体积，尚未做成这种形态）。

### 3.1 本机压缩参考（**不是安装包数字**）

对 7 个分块做本地压缩，仅为给出量级参考（`xz` 的 LZMA2 与 NSIS 的 LZMA 同族但**不同实现/参数**）：

| 方式 | 字节 | 占原始 587,496 B |
|---|---:|---:|
| 原始（未压缩，asar 内就是这个量级） | 587,496 | 100% |
| `gzip -9` 逐文件求和 | 185,422 | 31.6% |
| `gzip -9` 拼接后单流 | 180,935 | 30.8% |
| `xz -9e` 拼接后单流（LZMA2） | **142,496** | **24.3%** |

**用途仅限于说明：这 589 KB 在安装包里被压缩后大约是 140–180 KB 量级。**
它**不能**用来推算 `Setup-0.6.5.exe` 会因此缩小多少，因为 NSIS 是**整体 solid 压缩**：
少 589 KB 输入，最终 exe 的变化量取决于这些字节落在哪个压缩块、与谁共享字典，
**必须实测**（§5.1）。本文不对「安装包会缩小 XXX MB」做任何承诺。

### 3.2 明确不做的算术

- 不用 `dist/` 总字节（10,976,603 B）反推安装包：`dist-electron/*.map`（29,876,398 B）被
  `!**/*.map` 排除，`dist-electron/occt-import-js.wasm`（7,604,031 B）被单独排除，
  而生产 `dependencies`（`node-opcua`、`mqtt`、`serialport`、`@modelcontextprotocol/sdk`、`xlsx`…）
  默认也会进 asar —— 这几项的净额**本机没有测到**（打包没跑起来），不填。
- 不拿历史上的 154,246,911 B 当「基线」去减：那是 `main@227e4a0` 的包，与当前 HEAD 之间既有分块迁移
  也有其它改动，**不是同一变量**的对照（§5.1 给了正确做法）。

## 4. asar 内验证：为什么没做，以及补做时怎么做

本次**没有**任何 asar 文件可供验证（打包在 §2 失败）。所以：

- ⛔ 「`app.asar` 字节数」：未取得。
- ⛔ 「resources 下 extraResources 合计字节」：未取得。仅记录**打包源**在磁盘上的实测值
  （这对 asar 之外的 `resources/` 有参考意义，但**不等于**安装产物里的字节）：

  | 来源（`extraResources.from`） | 磁盘实测 | 备注 |
  |---|---:|---|
  | `../packs/builtin` → `resources/packs/builtin` | 386,812 B（21 文件） | 存在 |
  | `../index.html` → `resources/web/index.html` | 18,820 B | 存在 |
  | `../app.js` → `resources/web/app.js` | 122,931 B | 存在 |
  | `../styles.css` → `resources/web/styles.css` | 44,707 B | 存在 |
  | `../electrical.js` → `resources/web/electrical.js` | 124,925 B | 存在 |
  | `../electrical.css` → `resources/web/electrical.css` | 34,217 B | 存在 |
  | `../spike/build123d/app.py` → `resources/parametric/app.py` | 28,296 B | 存在 |
  | `../spike/freecad/techdraw_job.py` → `resources/freecad/techdraw_job.py` | 132,984 B | 存在 |
  | `vendor/dwg` → `resources/dwg` | **不存在** | 需 `vendor-dwg.mjs` |
  | `vendor/qt` → `resources/qt` | **不存在** | 需 `vendor-qt.mjs`（≥40 文件 / >30 MB） |
  | `vendor/pipeline` → `resources/pipeline` | **不存在** | 需 `build-pipeline.mjs` |
  | **已存在的部分合计** | **893,692 B** | = `packs/builtin` 386,812 + web 5 件 345,600 + 2 个 .py 161,280；不含三个缺失的 vendor |

- ⛔ 「asar 内 `dist/modules/manifest.json` + 7 个分块」：未取得。
- ⛔ 「从 asar 抽取分块比对 sha256」：未取得。**能抽取才算严格**，本机抽不到，所以本文
  **不主张** asar 内分块与清单一致；只主张 `dist/` 产物与清单一致（§1.2）。

### 4.1 补做方法（本机可用，待打包能跑时执行）

`@electron/asar@3.4.1` 在 `node_modules` 里（是 `app-builder-lib` 的依赖），无需 `npx` 联网：

```bash
# 存在性 + 抽取
node -e "const a=require('@electron/asar');
  console.log(a.listPackage('release/linux-unpacked/resources/app.asar')
    .filter(p=>p.startsWith('/dist/modules')));"
node -e "const a=require('@electron/asar'),fs=require('fs');
  fs.writeFileSync('/tmp/le.js',a.extractFile('release/linux-unpacked/resources/app.asar','dist/modules/design.layout-editor.js'));"
sha256sum /tmp/le.js        # 必须等于 manifest 里的 9f1568d48c6f…（完整值见 §1.1 对应行）
```

`extractFile` 拿到的是 asar 里**实际的字节**，与 `dist/modules/manifest.json` 比 sha256 才是严格验证。
**注意 asar 的路径写法**：`extractFile` 的第二个参数用相对路径（不带前导 `/`），`listPackage` 返回的
是带 `/` 的条目；两种风格写错会得到 `ENOENT`，别把 ENOENT 误当「分块没进包」。

若 `@electron/asar` 不可用，退化方案（**只能证明存在性，不能证明字节一致**）：

```bash
grep -a -c '__cadRegisterModuleChunk' release/linux-unpacked/resources/app.asar
grep -a -o 'id:"design.layout-editor"' release/linux-unpacked/resources/app.asar | head -1
grep -a -o '"design.layout-editor"' release/linux-unpacked/resources/app.asar | head -1   # 清单里的 id
```

局限：asar 是「头部 JSON + 拼接数据」，`grep -a` 命中的是**未压缩明文**里的片段，只能说明
「这段字节串出现在 asar 里」，无法排除它在别处（例如 map 或重复副本）、也无法证明长度/哈希正确。

## 5. 本机证不了的四项：缺口与验收步骤

以下四项**都必须**在 Windows 上做（本机 Linux，无法安装 NSIS 包，也无法做 Windows 共存）。
四项的共同前提：先让 `npm run dist:win` 在 Windows runner 上跑通（它含
`vendor-qt.mjs` → `build-pipeline.mjs` → `vendor-dwg.mjs` → `electron-builder --win nsis --x64`）。

### 5.1 Windows NSIS 安装包体积（当前 HEAD 的真实 exe 字节）

本机缺失的东西：一个真的 `AutomationCAD-Setup-0.6.5.exe`（或对应新版本）及其字节数。

必读的已知数据（**仅历史基线，不是本次测量**）：`AutomationCAD-Setup-0.6.5.exe` =
**154,246,911 B / 147.1 MB**，sha256 `c4f1031f…558c90`，来自 `main@227e4a0`
（[STATUS.md:17-22](STATUS.md#L17-L22)）。当前 `fix-audit-findings@2c59899` **没有任何已发布安装包**。

建议验收步骤（Windows runner，与 §5.2 一次跑完）：

1. 用**同一个** electron-builder 版本、**同一台** runner 跑两次打包，只有「分块有无」是变量：
   - **A（当前 HEAD）**：正常 `npm run dist:win`；
   - **B（对照基线）**：`git worktree add ../baseline e5e187b`（= 分块迁移第一个提交 `0814c60` 的父提交，
     即 `0814c60^`，早于全部 7 次模块迁移），在同一 runner 上同样 `npm run dist:win`。
2. 各自记录：
   ```
   stat -c '%s %n' release/AutomationCAD-Setup-*.exe        # 或 PowerShell: (Get-Item …).Length
   sha256sum release/AutomationCAD-Setup-*.exe
   ```
   并在日志里保留 electron-builder 的 `• building … target=nsis` 段与 `ASSERT_*` 自证行
   （现有打包自证里有 `ASSERT_4_SIZE_OK bytes=…`，可直接当体积证据）。
3. 结论只写 **A 减 B 的实测差**（B 很可能更大，因为 B 的 three 逐块重复）。**不要**用
   §3.1 的 142,496 B 去预测 exe 差值。
4. 若 A 与 B 的差异同时混入了非分块改动，需在报告里点名「这不是单变量实验」——目前 B 与 A 之间
   除了分块迁移还有别的提交，**严格单变量需要另做一个「只回退 chunks.json 而保留其它改动」的构建**，
   而这属于改配置做对照，须经评审后再做，本文不擅自做。

### 5.2 安装后占用

本机缺失：一个真的 Windows 安装。

建议验收步骤：

1. 干净 Win11 快照（无 VS/conda/Node），安装 A 包，记安装目录（`oneClick: false` +
   `allowToChangeInstallationDirectory: true`，可指定）。
2. 记录：
   ```powershell
   # 安装目录总占用（≈ Program Files 下 productName 目录）
   (Get-ChildItem 'C:\Program Files\AutomationCAD' -Recurse -File | Measure-Object Length -Sum).Sum
   (Get-ChildItem 'C:\Program Files\AutomationCAD' -Recurse -File).Count
   # 关键分项
   (Get-Item 'C:\Program Files\AutomationCAD\resources\app.asar').Length
   'resources\packs\builtin','resources\web','resources\qt','resources\dwg','resources\pipeline' |
     ForEach-Object { $p = Join-Path 'C:\Program Files\AutomationCAD' $_;
       if (Test-Path $p) { "$_ = " + (Get-ChildItem $p -Recurse -File | Measure-Object Length -Sum).Sum }
       else { "$_ = MISSING" } }
   ```
3. **必须同时核对 asar 内容与清单**（这才是本机没做到的那一步，在 Windows 上很容易做）：
   ```powershell
   npx --no-install @electron/asar extract-file "…\resources\app.asar" dist/modules/manifest.json
   npx --no-install @electron/asar extract-file "…\resources\app.asar" dist/modules/plcgen.js
   Get-FileHash .\plcgen.js -Algorithm SHA256   # 必须 = cc4275a7d8c10706877e746a40fe016f444fcf1a7fb5b30a835d0ff114bada58
   ```
   判据：7 个分块全部提取成功且 sha256 与 `manifest.json` 逐条相等（完整 sha256 见
   `dist/modules/manifest.json`，前 12 位见 §1.1）。任何一条不等 = 打包链把分块改了字节，属阻塞级问题。
4. `resources/qt`、`resources/dwg`、`resources/pipeline` 三处**必须存在且非空**；
   `vendor-qt.mjs` 的门槛是 ≥40 文件 / >30 MB，若安装后 `resources/qt` 不满足，说明打包链退化。

### 5.3 冷启动耗时

本机缺失：本机是 Linux 且无显示器（需要 `xvfb-run`），而且**平台不同，数字不能外推**到 Windows。
分块对启动的影响是**两个方向**，必须分别测，别只测总时间：

- 变慢的方向：主进程要读清单 + 按 id 读盘 + 逐块算 sha256 校验（`electron/module-chunks.ts`）；
- 变快的方向：核心 `extension.js` 不再静态 `import` 那 7 个模块的 UI，首帧少解析/少执行。

建议验收步骤（Windows，冷启动 = 进程新建且 OS 文件缓存尽量冷）：

1. 每次测量前重启一次或用 RAMMap/`EmptyStandbyList` 清待机列表，**同一台机、同一份数据**重复 ≥10 次取中位数。
2. 打点（不改业务逻辑的最小观测）：
   - 主进程：`app.whenReady()` / `BrowserWindow` 创建 / `did-finish-load` / 首个 `modules:chunk` 请求与完成；
   - 渲染层：对应的 `performance.mark`。
   现有代码里已有可借用的诊断入口（`npm run diagnose`、`scripts/electron-run.mjs`），
   但**冷启动时间轴需要新增打点**，这属于源码改动，需单独评审后再做。
3. 记录：`cold_start_ms` 中位数、p95、首帧时间、`chunk_load_ms` 逐块耗时；
   A/B 两组（同 §5.1 的 A/B 构建）各跑一轮，报告**差值与波动**，只报「快/慢 X ms」而不给置信区间等于没测。
4. 若拿不到打点，至少用 Windows 性能计数器/`Windows Performance Recorder` 记录
   `Process Start → First Frame`，并明确写「未做应用内打点，只有系统级时间」。

### 5.4 双版本共存

本机缺失：Windows 安装/卸载行为。

已具备的基础（可在代码里核对，属**静态证据**，不是验收）：

- Full 与 Core 是**不同 appId / productName / 可执行名 / 输出目录**：
  `cn.automationcad.desktop` + `AutomationCAD`（[package.json:83-84](../../desktop/package.json#L83-L84)）
  vs `cn.automationcad.desktop.core` + `AutomationCAD Core` + `release-core`
  （`scripts/dist-win-core.mjs`）。
- userData 目录按 `identity.appName` 分：`join(appDataDirectory, identity.appName)`
  （[electron/edition.ts:60](../../desktop/electron/edition.ts#L60)），即 `AutomationCAD` 与
  `AutomationCAD Core` 两个目录；rpc 端口也分开（7420 / 7421）。
- 主进程有 `app.requestSingleInstanceLock()`（`dist-electron/main.cjs` 命中 1 次），
  所以**同 appId 的两个版本不能同时运行**，只能「先后启动」。

建议验收步骤（Windows）：

1. 「共存」要拆成两个独立命题，分别给结论：
   - **P1 安装共存**：同 appId 的 v_old 与 v_new 装到**不同目录**，两个都能启动、都报各自版本；
     再验证**同目录覆盖安装**（升级）后旧文件是否残留、`resources/qt` 是否被替换。
   - **P2 数据共存**：两版本共用 `%APPDATA%\AutomationCAD` 时，工程库/packs 是否被新版 schema 写坏。
     判据：先让 v_old 建工程并保存 → 装 v_new 打开 → 再回 v_old 打开同一工程**不报错、不丢数据**
     （若 schema 有迁移，必须能备份/回滚，见 `docs/modular-development-roadmap.md` 的更新章节）。
2. 记录：
   ```powershell
   Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' |
     Where-Object DisplayName -like '*AutomationCAD*' |
     Select-Object DisplayName,DisplayVersion,InstallLocation,UninstallString
   ```
   加上两个安装目录的 `resources\app.asar` 版本号（见 §5.2 的 extract 方法，读包内 `package.json` 的 `version`），
   以及卸载 v_new 后 v_old 是否仍可启动。
3. **本次分块改动对共存的风险点**（应在 P1 中专门验）：分块是「按 id 从
   `app.getAppPath()/dist/modules` 读」，所以**分块与 asar 同源、不会跨版本串用**；
   但 `modules/chunks.json` 里 `coreMustNotContain` 这类门禁只保证构建期，运行期若旧版
   userData 里存了「模块启用状态」，跨版本 id/版本区间变化（`apiCompatibility.min/max`，
   `project.portable` 已是 `1..2`）需要单独验一次「旧状态 + 新包」的加载拒绝是否给出明确提示。

## 6. 复现清单（本机可跑的部分）

```bash
cd /root/workspace/automation-cad-audit-main/desktop
npm run build:ext                                  # ⟵ §1，EXIT=0
stat -c '%s %n' dist/extension.js dist/occt-import-js.wasm dist/modules/*
sha256sum dist/modules/*.js                        # ⟵ §1.1
npm run modules:verify                             # ⟵ §1.2，EXIT=0
# §1.2 的逐条比对（不依赖任何 npx/网络）：见下方脚本
./node_modules/.bin/electron-builder --dir --linux dir   # ⟵ §2，在本会话必然失败于只读 $HOME
```

§1.2 的比对脚本（本次实际用法，可原样保存后运行）：

```js
// node verify-chunks.mjs dist/modules
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const dir = process.argv[2] ?? 'dist/modules';
const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
for (const c of m.chunks) {
  const b = await readFile(join(dir, c.file));
  const ok = b.length === c.bytes && sha(b) === c.sha256
    && b.toString('utf8').includes('__cadRegisterModuleChunk')
    && b.toString('utf8').includes('({id:"' + c.id + '"');
  console.log(ok ? 'OK  ' : 'BAD ', c.id, b.length, sha(b).slice(0, 12));
}
const orphans = (await readdir(dir)).filter((f) => f !== 'manifest.json'
  && !m.chunks.some((c) => c.file === f));
console.log('orphans=' + (orphans.join(',') || '(none)'));
```

## 7. 本文没有做的事（划清边界）

> 本节只描述 2026-11-22 那一轮的边界；2026-11-23 的体积脚本/workflow 增补见 §8。

- 没有改任何源码、`package.json`、CI、`modules/chunks.json`。
- 没有为「让打包跑通」而设置 `HOME=` / `npm_config_devdir=` / `npmRebuild=false` 等绕行手段。
- 没有联网（未下载 electron、app-builder、NSIS、node 头部）。
- 没有编造 `app.asar` 字节、安装包体积、安装占用、冷启动数值。
- 没有删除或移动任何既有文件；本文是本次唯一新增文件。
- 会话期间该工作树的 `HEAD` 被外部推进过两次（合并 `2c59899`；以及对本文自身的提交）。
  本文的实测数字以 `2c59899` 的代码状态为准，并在该状态上重跑 `build:ext` 复核；
  若后续代码继续前进，§1 的数字需要重测，不能直接沿用。

## 8. CI 可复现证据（2026-11-23 增补）

本节不是一次新的实测：只增加「以后怎么在 CI 里稳定拿到体积与冷启动数字」的脚本、workflow
接线和验收判据。**本轮没有触发任何 workflow 运行**，所以下面不填任何 CI 实测值；真实数字要等
`windows-build` 跑完后，从该次 run 的 step summary 与 artifact 里取。

### 8.1 `report-package-size.mjs`：体积证据脚本

文件：[desktop/scripts/report-package-size.mjs](../../desktop/scripts/report-package-size.mjs)。

```bash
cd desktop

# 语法检查
node --check scripts/report-package-size.mjs

# 打包后运行：默认扫描 desktop/release；--json 可选，写了才有机器可读文件
node scripts/report-package-size.mjs \
  --dir release \
  --json release/package-size-report.json
```

- `--dir` 省略时默认 `desktop/release`（按脚本自身位置解析，不依赖当前目录）；`--dir` 写相对路径时
  按当前工作目录解析。
- stdout 是人读摘要；`--json` 额外落一份 UTF-8 JSON。脚本不联网、不改产物。
- 扫描内容：
  - 递归扫描 `--dir` 下**每个 `.exe`**（NSIS 安装器、`win-unpacked` 里的 Electron 主程序、
    `resources/qt` 里的 Qt 辅助程序都算），记录字节数与 sha256；
  - `resources/app.asar` 的字节数；
  - `resources/**` 与 `win-unpacked/**` 的合计字节/文件数；
  - 若 `@electron/asar`（`node_modules` 内 3.4.1）可用，用 `extractFile` 抽取
    `dist/modules/manifest.json` 与清单里的每个分块，逐字节核对 `bytes` 与 `sha256`。
- **缺产物时非零退出**：目录不存在、没有 `.exe`、没有 `resources/app.asar`、没有
  `win-unpacked/`，任一成立即 exit 2，并在 `missing` 数组里写清缺什么。
- **asar 分块不一致时 exit 3**：清单抽不出、清单不是合法 JSON、分块抽不出、字节或 sha256
  不匹配，都会进 `asarChunkIntegrity.failures[]`。
- 没有 `@electron/asar`、或没有 asar 可抽时，`asarChunkIntegrity.status` 是 `notVerified`，
  人读摘要也写 `notVerified` / `reason=...`，**不会打印 `ok` 或 `verified`**。这是「没验」，
  不是「验过」。若 asar 存在但清单/分块抽不出，则是 `failed`（exit 3），不是 `notVerified`。

退出码与 `asarChunkIntegrity.status`：

| 退出码 | 含义 |
|---:|---|
| `0` | 报告已生成；asar 完整性为 `verified`（或本机没有 `@electron/asar` 而明确 `notVerified`） |
| `2` | 产物缺失（`missing[]` 说明缺什么） |
| `3` | asar 存在，但清单/分块抽取或逐字节比对失败（`failures[]` 给 id、文件、期望/实际哈希） |

| `status` | 含义 |
|---|---|
| `verified` | 清单与每个分块的 `bytes`/`sha256` 全部一致 |
| `failed` | 至少一条失败；CI 看到 exit 3 |
| `notVerified` | 没有 asar、没有 `@electron/asar`、或清单抽不出；**不主张完整性** |

JSON 顶层结构（字段名稳定，CI 用 PowerShell `ConvertFrom-Json` 读取）：

```json
{
  "schemaVersion": 1,
  "generatedAt": "<ISO-8601>",
  "tool": "report-package-size",
  "dir": "<扫描目录绝对路径>",
  "status": "ok",
  "missing": [],
  "exe": [
    {
      "path": "AutomationCAD-Setup-<version>.exe",
      "bytes": 0,
      "sha256": "<64 hex>",
      "area": "release-root"
    }
  ],
  "appAsar": { "path": "win-unpacked/resources/app.asar", "bytes": 0 },
  "resources": { "bytes": 0, "files": 0, "paths": ["win-unpacked/resources"] },
  "winUnpacked": { "path": "win-unpacked", "bytes": 0, "files": 0 },
  "asarChunkIntegrity": {
    "status": "verified",
    "checked": 7,
    "ok": 7,
    "failures": [],
    "reason": null,
    "manifest": {
      "path": "dist/modules/manifest.json",
      "bytes": 1861,
      "sha256": "<64 hex>",
      "chunksDeclared": 7,
      "disk": { "path": "dist/modules/manifest.json", "bytes": 1861, "sha256": "<64 hex>", "match": true }
    }
  }
}
```

> 上面的 `0` 是字段占位，不是实测值。`checked`/`ok` 是**条数**；`failures` 为空数组才表示
> 逐条都通过。顶层 `status` 是汇总：`ok`（产物齐全且完整性 `verified`）/ `missing`（缺产物）/
> `integrity-failed`（分块不一致）/ `unverified`（asar 没验）。逐条失败原因仍看
> `asarChunkIntegrity.failures[]`。
> `manifest.disk` 是「asar 内清单 vs 当前 `desktop/dist/modules/manifest.json`」的
> 附加信息，**不参与** `verified/failed` 判定：有磁盘清单时 `match` 为 `true/false`，没有时
> `match: null, reason: "not-available"`。用旧 release 配新 `dist/` 跑时 `match` 可能为 `false`，
> 这只是提示「产物与当前工作树不同源」，不能单独判打包链坏。

本机用假 release + 真 `dist/modules` 做过的结构验证（**不是真实安装包数字**）：

```text
PACKAGE_SIZE_REPORT dir=.../release
status=ok
EXE (...)
  AutomationCAD-Setup-<version>.exe  <bytes> B  sha256=<64hex>  area=release-root
  win-unpacked/AutomationCAD.exe      <bytes> B  sha256=<64hex>  area=win-unpacked
APP_ASAR win-unpacked/resources/app.asar  <bytes> B
RESOURCES  <bytes> B in <n> files  paths=win-unpacked/resources
WIN_UNPACKED  <bytes> B in <n> files  path=win-unpacked
ASAR_CHUNK_INTEGRITY status=verified checked=7 ok=7 failures=0
  manifest sha256=<64hex> bytes=1,861 diskMatch=true
```

### 8.2 `windows.yml` 里新增了哪几步

改动只发生在**已有的** `build` job 内，紧跟现有「打包后自证」步骤；**不新增 job，不改触发条件**
（仍是 `workflow_dispatch`）。新增三步：

| 顺序 | 步骤名 | 作用 |
|---:|---|---|
| 1 | `报告安装包体积（JSON + 人读摘要）` | `node scripts/report-package-size.mjs --dir release --json release/package-size-report.json`；把 Markdown 摘要 + 完整 JSON（折叠块）写进 `$GITHUB_STEP_SUMMARY`；脚本 exit 2/3、`asarChunkIntegrity.status != verified` 或 `manifest.disk.match != true` 时本步失败 |
| 2 | `冷启动测量（headless STARTUP_METRICS，N=5）` | 对打包后的 `win-unpacked/AutomationCAD.exe` 跑 5 次 headless；解析每行 `STARTUP_METRICS`，把样本、median、p95 写进 summary；环境不支持则 `SKIPPED` + 原因，不伪造数字 |
| 3 | `上传体积报告 artifact`（`actions/upload-artifact@v4`，artifact 名 `AutomationCAD-Package-Size-Report`） | 上传 `desktop/release/package-size-report.json`，保留 14 天 |

> 体积报告步骤排在「打包后自证」之后：此时 NSIS 安装器、`win-unpacked`、`resources/app.asar`
> 都已存在；排在便携包压缩之前，所以不需要等 zip。

### 8.3 CI 里能看到哪些数字

全部从该次 `windows-build` run 的 step summary 或 artifact 读，不需要在本机复现：

| 数字 | 位置 | 口径/限制 |
|---|---|---|
| NSIS 安装器字节 + sha256 | summary 的 exe 表；JSON `exe[]` | 每个 `.exe` 都列，`area=release-root` 的那行是安装包 |
| `win-unpacked` 里 Electron 主程序 / Qt 辅助程序的字节 + sha256 | 同上，`area=win-unpacked` | 便于核对「安装后的可执行文件」与安装器不是同一份 |
| `app.asar` 字节 | summary；JSON `appAsar` | 只报字节，不含解包开销 |
| `resources/**` 合计字节 / 文件数 | summary；JSON `resources` | **包含** `win-unpacked/resources/**`；与下一行重叠，不能相加 |
| `win-unpacked/**` 合计字节 / 文件数 | summary；JSON `winUnpacked` | 解包目录的文件字节合计；**不是** NTFS 实际占用（簇大小/稀疏/压缩）、不含快捷方式、卸载器写入与 `%APPDATA%` 的 userData |
| asar 分块完整性 | summary；JSON `asarChunkIntegrity` | `checked`/`ok`/`failures`；CI 要求 `status=verified` 且 `manifest.disk.match=true` 才通过 |
| 冷启动 5 个 `totalMs` 样本、median、p95 | summary 的「冷启动」块 | 见 §8.4 的口径；`INCOMPLETE`/`SKIPPED` 时没有 median/p95 |
| 失败原因 | summary；脚本 stdout/stderr | `PACKAGE_SIZE_MISSING` / `PACKAGE_SIZE_ASAR_FAILED` / `COLD_START SKIPPED` |

注意：

- `win-unpacked/**` 是「安装后占用」的**可复现代理**，不是 §5.2 那种在 Windows 上装完后的
  实际目录占用；后者仍要人工按 §5.2 做（NTFS 分配、快捷方式、卸载器、userData 都会影响最终数字）。
- 这些数字是**单次构建的绝对值**，不是分块 A/B 差分。要回答「分块让包变小了吗」，仍必须按
  §5.1 做同 runner、同 electron-builder 的 A/B；CI 当前的体积步骤不能单独证明因果。
- 冷启动同理：CI 给的是同一构建在 runner 上的重复测量，不含「分块前/后」对照；因果结论仍按
  §5.3 的 A/B 方法做。

### 8.4 冷启动步骤的口径（为什么这些数字能信、又不能过度解读）

`windows.yml` 的新步骤实际执行：

```text
desktop/release/win-unpacked/AutomationCAD.exe \
  --headless-smoke --disable-gpu --disable-gpu-compositing --disable-software-rasterizer
```

重复 5 次，每次都是**新进程**。解析主进程打印的唯一一行：

```text
STARTUP_METRICS {"readyMs":...,"windowMs":...,"readyToShowMs":...,"loadMs":...,"extensionMs":...,"totalMs":...,"phases":[...],"boundary":"..."} trigger=...
```

计入样本的条件（任一不满足就丢弃并记原因）：

1. 进程 exit code = 0；
2. 能匹配到 `STARTUP_METRICS` 行；
3. `trigger` 不含 `degraded=`，也不是 `fallback-timer:*`（兜底回执只有部分阶段，不能当首帧）；
4. `totalMs` 是有限正数。

统计：

- **median**：5 个样本排序后的中位数；
- **p95**：nearest-rank（`ceil(0.95 × N) - 1`）；N=5 时等于最大值。summary 里会写明这一点，
  不把 p95 伪装成比 max 更精细的统计量；
- 5/5 有效才输出 `MEASURED` 与 median/p95；1–4 个有效输出 `INCOMPLETE`，只列样本与失败原因，
  **不给 median/p95**；0 个有效输出 `COLD_START SKIPPED reason=...`。没有数字时不会补数字。

口径边界（与 §5.3 一致，必须一起读）：

- `totalMs` 的零点 = **main 模块求值起点**，不含 Electron bootstrap、不含 main 的静态 import；
  它回答的是「应用代码开始执行到首帧/回执」这一段，不是「双击到窗口」的整段时间。
- headless 下没有真实首帧，`readyToShowMs` 可能为 `null`；兜底回执会被本步骤丢弃。
- 每次都是新进程，但**没有清 OS 文件缓存**，所以是「进程级冷启动」，不是「OS 冷缓存」；
  真正的冷缓存重复测量仍按 §5.3 用 RAMMap/`EmptyStandbyList` 做。
- 如果 runner 不支持 Electron headless（无桌面会话、缺依赖等），步骤会打印
  `COLD_START SKIPPED reason=...` 并继续，不会把 job 弄红，也不会造数。Linux 上的 `xvfb-run`
  不适用于 `windows-latest`；这里用的是 Electron 自己的 `--headless-smoke`。

### 8.5 结论：分块仍随包发布，所以体积不因分块而减小

**这条结论不因新增 CI 而改变，反而被 CI 的 asar 检查再次证明：**

1. `desktop/package.json` 的 `files` 仍含 `dist/**/*`（[package.json:92](../../desktop/package.json#L92)），
   `dist/modules` 在 `dist/` 下，所以 7 个分块 **587,496 B** + `manifest.json` **1,861 B** =
   **589,357 B** 仍被打进 `app.asar`，随安装包发布。
2. 新增的 `asarChunkIntegrity` 做的是「从 `app.asar` 里把分块抽出来，逐字节比对 manifest」；
   它证明的是**分块确实在包里**且字节一致，不是「分块让包变小」。如果哪天分块被移出包体，
   这项检查会以 `not-found-or-unreadable` 失败——那才是分发形态改变。
3. 分块优化的是**加载/启动期执行**（按需读块、核心包少解析），不是分发字节；要让安装包真正
   减小，必须把分块改成包外下载/独立安装（[MODULE-CHUNKS.md:85-86](MODULE-CHUNKS.md#L85-L86)
   的第 4 条，**目前未实现**）。
4. 同一批提交里让字节下降的是 `a4cfd6a`「three.js 不再逐块重复」，不是分块本身；两者不要混为
   一谈。CI 的单构建体积数字也不能替代 §5.1 的 A/B 归因。

### 8.6 仍需人工：Full / Core 双版本共存验收

CI 的 `windows.yml` 只打 **Full**（`npm run dist:win`），不打 Core；本轮也不新增 job。Core
安装包要人工在 Windows 上构建：

```powershell
cd desktop
npm run dist:win        # Full  -> release\AutomationCAD-Setup-<version>.exe
npm run dist:win:core   # Core  -> release-core\AutomationCAD-Core-Setup-<version>.exe
```

静态事实（构建配置可核对，但**不等于**安装验收）：

- Full：appId `cn.automationcad.desktop`、productName `AutomationCAD`；
  Core：appId `cn.automationcad.desktop.core`、productName `AutomationCAD Core`、输出
  `release-core`（[dist-win-core.mjs](../../desktop/scripts/dist-win-core.mjs)）。
- userData 按 `identity.appName` 分：`%APPDATA%\AutomationCAD` vs
  `%APPDATA%\AutomationCAD Core`；Core 的 sessionData 再落到
  `%APPDATA%\AutomationCAD Core\session`（[edition.ts:13-19](../../desktop/electron/edition.ts#L13-L19)、
  [edition.ts:60](../../desktop/electron/edition.ts#L60)）。
- rpc 端口 7420（Full）/ 7421（Core）；Core 的 `extraResources` 不含 `vendor/qt`，所以
  `resources/qt` 不应出现在 Core 包里。

必须人工做的检查（建议在一台干净 Win11 快照上按顺序做，并把结果贴进发布记录）：

| # | 步骤 | 判据 |
|---:|---|---|
| 1 | 安装 Full 与 Core 到**不同目录**（NSIS 允许改目录） | 两个安装器都成功；两个 `InstallLocation` 不同；两个主程序都能启动并报各自版本 |
| 2 | 查注册表卸载项 | `DisplayName` 有两条（`AutomationCAD` / `AutomationCAD Core`）；`UninstallString`、`InstallLocation` 互不覆盖 |
| 3 | 查安装目录资源 | Full 有 `resources\qt\automationcad-qt.exe` 且 `resources\qt` 文件数 ≥40；Core **没有** `resources\qt`；两包都有 `resources\pipeline\machine-design-cli.cjs` |
| 4 | 查包内身份标记 | 从各自 `resources\app.asar` 抽 `package.json`：Full 无 `automationCadEdition`（或不是 `core`），Core 为 `"core"`；防止 Core 包误装成 Full 身份 |
| 5 | 同时启动两个版本 | 两个窗口可同时存在；Full 用 7420、Core 用 7421；单实例锁不互踢（若互踢，记录哪个先退） |
| 6 | userData 隔离 | 在 Full 里建工程/改设置，检查写入只在 `%APPDATA%\AutomationCAD`；在 Core 里同样操作，只在 `%APPDATA%\AutomationCAD Core`；两侧的 `packs-state.json`、工程、日志、`session` 不互相出现 |
| 7 | 卸载 Full（保留 Core） | Core 仍能启动、Core userData 不变、Core 安装目录文件数不变；Full 自己的安装目录被卸载器清掉（userData 默认可能保留，记录实际行为） |
| 8 | 重装 Full，再卸载 Core | Full 仍能启动、Full userData 不变；Core 安装目录被清掉；没有把 Full 的注册表项/快捷方式一起删掉 |
| 9 | 更新隔离 | Core 不提供应用内更新（`editionUpdateRestriction` 的提示可见）；Full 的更新检查/下载不写 Core 的 userData，也不覆盖 Core 安装目录 |
| 10 | 反向共存（可选但建议） | 先装 Core 再装 Full、先卸 Core 再卸 Full，重复 #6–#8 的判据；确认安装顺序不影响结果 |

关键取证命令（PowerShell，路径以实际 `InstallLocation` 为准）：

```powershell
# 两个安装器与字节
Get-Item .\release\AutomationCAD-Setup-*.exe, .\release-core\AutomationCAD-Core-Setup-*.exe |
  Select-Object FullName, Length

# 注册表两条卸载项
Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
                 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' |
  Where-Object { $_.DisplayName -like '*AutomationCAD*' } |
  Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString

# userData 是否分开（先记基线，再启动/操作，再比对 LastWriteTime）
$full = Join-Path $env:APPDATA 'AutomationCAD'
$core = Join-Path $env:APPDATA 'AutomationCAD Core'
Get-ChildItem $full -Force -ErrorAction SilentlyContinue | Select-Object Name, LastWriteTime
Get-ChildItem $core -Force -ErrorAction SilentlyContinue | Select-Object Name, LastWriteTime
Get-ChildItem (Join-Path $core 'session') -Force -ErrorAction SilentlyContinue | Select-Object Name, LastWriteTime

# 包内 package.json（直接读 asar，不落盘、不改安装目录；在 desktop/ 下执行以便 require 到 @electron/asar）
node -e "const a=require('@electron/asar'); const p=JSON.parse(a.extractFile(process.argv[1],'package.json').toString('utf8')); console.log(JSON.stringify({name:p.name,version:p.version,automationCadEdition:p.automationCadEdition}))" `
  'C:\Program Files\AutomationCAD\resources\app.asar'
node -e "const a=require('@electron/asar'); const p=JSON.parse(a.extractFile(process.argv[1],'package.json').toString('utf8')); console.log(JSON.stringify({name:p.name,version:p.version,automationCadEdition:p.automationCadEdition}))" `
  'C:\Program Files\AutomationCAD Core\resources\app.asar'
```

判据汇总：**Full 与 Core 的安装目录、注册表项、userData、端口、`resources/qt` 必须互不串**；
卸载任一方后另一方仍可启动；任何一侧的 userData 被另一侧写入，都算阻塞级问题（会破坏
「Core 作为精简版/独立数据」的承诺）。同 appId 的旧版/新版共存另见 §5.4，不要和 Full/Core
共存混为一谈。

### 8.7 本机可跑的校验（本轮实际执行）

```bash
cd /root/workspace/automation-cad-audit-main

# 1) 脚本语法
node --check desktop/scripts/report-package-size.mjs

# 2) 缺产物时必须非零退出（desktop/dist 没有 .exe / app.asar / win-unpacked）
node desktop/scripts/report-package-size.mjs --dir desktop/dist; echo "exit=$?"   # 期望 2

# 3) workflow YAML 解析
python3 - <<'PY'
import yaml
yaml.safe_load(open('.github/workflows/windows.yml', encoding='utf-8'))
print('YAML_OK')
PY
```

> 这一轮**没有**执行 `gh workflow run`、没有 push、没有改任何触发条件；CI 数字要等下一次
> 手动触发 `windows-build` 后才有。不要把本节的字段样例当成实测值。
