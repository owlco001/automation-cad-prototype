// 分块入口：drawings.techdraw 的渲染层 UI。
//
// 这个文件**只**被 `scripts/build-module-chunks.mjs` 打包成 dist/modules/drawings.techdraw.js；
// 核心包不再静态 import `src/drawings/ui.ts`，两边的唯一契约是下面这个导出。
// 契约变更时必须同时改 extension.ts 的 `DrawingsChunkExports` 与清单里的 API 版本。
export { initDrawingsUi } from '../../drawings/ui.ts';
