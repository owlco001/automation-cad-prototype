// 分块入口：system.update 的渲染层 UI。
//
// 这个文件**只**被 `scripts/build-module-chunks.mjs` 打包成 dist/modules/system.update.js；
// 核心包不再静态携带「软件更新」按钮与对话框，两边的唯一契约是下面这个导出。
// 契约变更时必须同时改 extension.ts 的 `SystemUpdateChunkExports` 与清单里的 API 版本。
export { initUpdatePanel } from '../../update/ui.ts';
export type { UpdatePanelHandle } from '../../update/ui.ts';
