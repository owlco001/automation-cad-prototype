# 可选模块的代码分块（第一切片）

目标：让「可选模块」的代码可以**不随核心一起加载**，并按需从本地安装目录取用；为后续
「离线签名包 / 在线目录」留出接口，但**本切片不做下载**。

## 为什么不是 ESM 动态 import

扩展宿主是以**经典脚本**注入到 `file://` 页面的（`desktop/electron/main.ts` 的
`did-finish-load` 段：创建 `<script>` 指向 `dist/extension.js`），渲染进程是
`sandbox: true` + `contextIsolation: true`，页面没有任何 CSP/模块解析保证。
因此可控的做法是：

1. 分块打成**经典 IIFE 脚本**，执行时按约定自注册；
2. 由**主进程**读本地文件、按清单逐字节校验，再交给渲染层执行；
3. 渲染层只拿到「已校验的源码」这一件事，拿不到任意路径读写能力。

`vite.config.ts` 的 `inlineDynamicImports: true` 保持不变：核心仍是**单文件**，
分块由独立的 esbuild 步骤产出，不影响现有启动路径。

## 组成

| 文件 | 作用 |
|---|---|
| `desktop/modules/chunks.json` | 哪些模块有独立分块、入口文件在哪。默认为空。 |
| `desktop/scripts/build-module-chunks.mjs` | 构建分块 + 写 `dist/modules/manifest.json`（字节数、sha256 来自实际产物） |
| `desktop/src/modules/chunk-manifest.ts` | 清单与自注册格式的纯校验（构建侧与运行侧共用） |
| `desktop/src/modules/chunk-loader.ts` | 渲染层加载器：白名单 → 模块状态 → 依赖 → API 区间 → 字节数 → sha256 → 执行 |
| `desktop/electron/module-chunks.ts` | 主进程读取器：只按 id 取清单里的文件名，再校验、再交付源码 |

分块自注册格式（构建产物必须严格如此）：

```js
globalThis.__cadRegisterModuleChunk({ id: '<module id>', apiVersion: 1, exports: <default export> });
```

## 运行命令

- `npm run build:modules`：按 `modules/chunks.json` 产出 `dist/modules/*.js` 与 `manifest.json`。
- `npm run build:ext`：已在末尾追加分块构建（默认配置为空，产出空清单）。
- 配置里出现的 id 必须存在于 `src/modules/registry.ts`，且是 `kind: 'optional'` 且 `implemented: true`；
  否则构建直接失败，避免做出永远无法启用的分块。

## 安全与离线语义

- 清单是**白名单**：未声明的 id 不会被执行，调用方只能传 id，不能传路径。
- 交付前校验**字节数 + sha256**；任一不符即拒绝，并按「未安装」处理，不做「先跑再报错」。
- 分块自注册的 id 与 API 版本必须与清单一致；不一致视为版本错配。
- 模块关闭、依赖未启用、API 区间不含宿主版本，全部在**执行之前**拒绝。
- 同一 id 单飞 + 缓存；失败不缓存，修好后可重试。
- 加载器自身不发任何网络请求：源码只来自注入的 `readSource` 端口。
- 主进程读取器尚未通过 IPC 暴露给渲染层，因此**本切片没有新增渲染层能力面**；
  接线时必须连同 preload 白名单与权限一起评审。

## 尚未完成（下一批切片）

1. **移出第一个真实模块**：把某个可选模块的实现从 `src/extension.ts` 的静态依赖里搬进
   `src/modules/chunks/<id>.ts`，并用 loader 的 `load(id)` 取代静态 import；需要同时处理
   该模块 UI 的异步初始化（先隐藏/禁用，加载完成后显示）。
   建议顺序：`cost.estimation`（纯计算 + 报告）→ `elec.validation` → `plcgen`。
2. **IPC 接线**：主进程 `modules:chunk` 处理器 + preload 白名单方法（只接受 id，返回源码与清单版本）。
3. **打包**：`dist/modules` 已随 `files: dist/**/*` 进入 asar；若未来分块需要 asar 外读取，
   再加 `extraResources` 映射。当前读取路径走 `app.getAppPath()/dist/modules`。
4. **独立安装包**：签名清单、原子切换、失败回滚、离线导入。这条链路才叫「按需下载」，
   本切片只做「按需加载已随包发布的分块」。
5. **体积收益量化**：需要先搬一个真实模块，才能测安装包与冷启动的差值；现在不做数字承诺。

## 测试

- `test/modules/chunk-manifest.test.mjs`：清单结构/版本/重复 id/路径穿越/哈希格式，与自注册格式一致性。
- `test/modules/chunk-loader.test.mjs`：白名单、模块关闭、依赖缺失、API 不兼容、哈希/字节不符、未注册、执行抛错、单飞与失败不缓存。
- `test/scripts/build-module-chunks.test.mjs`：默认配置为空（防止把探针发出去）、真实产物哈希与字节数一致、分块在沙箱里能自注册并执行、配置校验分支。
- `test/electron/module-chunks.test.mjs`：主进程读取器的合法交付、未声明 id、清单缺失/损坏/越界、篡改与缺失文件。

探针分块只存在于 `test-support/`，生产配置为空，因此发布产物里不会出现测试模块。
