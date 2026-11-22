// 分块入口：design.layout-editor 的渲染层 UI。
//
// 这个文件**只**被 `scripts/build-module-chunks.mjs` 打包成 dist/modules/design.layout-editor.js；
// 核心包不再静态携带整机布局 3D 编辑器（含 three 视口），两边的唯一契约是下面这些导出。
// 契约变更时必须同时改 extension.ts 的 `LayoutEditorChunkExports` 与清单里的 API 版本。
//
// 样式：layout-editor.css 由核心包内联提供（extension.ts 注入 #layout-editor-styles），
// 分块只带 JS；这与 build-module-chunks.mjs 删除 CSS sidecar 的约定一致。
export {
  closeLayoutEditor,
  openLayoutEditor,
  refreshLayoutEditor,
  setLayoutEditorEnabled
} from '../../layout-editor/ui.ts';
export type { LayoutEditorHandle, LayoutEditorHost } from '../../layout-editor/ui.ts';
