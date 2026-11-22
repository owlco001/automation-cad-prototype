// 分块入口：plcgen 的渲染层 UI。
//
// 这个文件**只**被 `scripts/build-module-chunks.mjs` 打包成 dist/modules/plcgen.js；
// 核心包不再静态携带 PLC 预检/生成/模拟/导出面板，两边的唯一契约是下面这个导出。
// 契约变更时必须同时改 extension.ts 的 `PlcGenChunkExports` 与清单里的 API 版本。
//
// 样式：plcgen.css 由核心包内联提供（extension.ts 注入 #plcgen-panel-styles），
// 分块只带 JS；这与 build-module-chunks.mjs 删除 CSS sidecar 的约定一致。
export { initPlcGenUi } from '../../plcgen/ui.ts';
export type { PlcGenUiHandle } from '../../plcgen/ui.ts';
