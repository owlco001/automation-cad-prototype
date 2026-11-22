// 分块入口：elec.validation 的渲染层 UI。
//
// 这个文件**只**被 `scripts/build-module-chunks.mjs` 打包成 dist/modules/elec.validation.js；
// 核心包不再静态 import `src/elec/ui.ts`，两边的唯一契约是下面这个导出。
// 契约变更时必须同时改 extension.ts 的 `ElecChunkExports` 与清单里的 API 版本。
export { initElecCheckPanel } from '../../elec/ui.ts';
export type { ElecCheckPanelHandle } from '../../elec/ui.ts';
