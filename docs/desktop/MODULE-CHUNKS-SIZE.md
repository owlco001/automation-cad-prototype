# 分块体积实测（字节算术 → 打包产物实测）

日期：2026-11-22 · 分支 `fix-audit-findings` · 实测时代码状态 `HEAD=2c59899`（= `eeeb4a4` + 合并 `fix-shared-three-surface`）· 实测期间工作树干净（`git status --porcelain -uall` 0 行，`dist/` `dist-electron/` 已被 `.gitignore` 忽略）

本文目的：把 [MODULE-CHUNKS.md](MODULE-CHUNKS.md#L75) 里那句「体积收益量化……现在不做数字承诺」
换成**可核对的本机实测数字**，并把本机**证不了的**部分逐条列成待补证据。
**没有实测到的数字，本文一律不填。**

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
   只有把分块改成「不在包内、单独下载/单独安装包」（[MODULE-CHUNKS.md:73-74](MODULE-CHUNKS.md#L73-L74) 的第 4 条，
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

- 没有改任何源码、`package.json`、CI、`modules/chunks.json`。
- 没有为「让打包跑通」而设置 `HOME=` / `npm_config_devdir=` / `npmRebuild=false` 等绕行手段。
- 没有联网（未下载 electron、app-builder、NSIS、node 头部）。
- 没有编造 `app.asar` 字节、安装包体积、安装占用、冷启动数值。
- 没有删除或移动任何既有文件；本文是本次唯一新增文件。
- 会话期间该工作树的 `HEAD` 被外部推进过两次（合并 `2c59899`；以及对本文自身的提交）。
  本文的实测数字以 `2c59899` 的代码状态为准，并在该状态上重跑 `build:ext` 复核；
  若后续代码继续前进，§1 的数字需要重测，不能直接沿用。
