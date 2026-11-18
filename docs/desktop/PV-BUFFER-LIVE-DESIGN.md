
## 软件问题修复（真实交互中发现）
- 空白画布的 `.cw-empty` 原先全局绝对定位，覆盖检查器并拦截关闭按钮；已限定到 `#cwNodes > .cw-empty`。
- 智能体写确认卡 z-index=9200 低于智能体抽屉（约 2147482500），确认按钮实际无法命中，导致120秒超时却显示 USER_DENIED；已提升确认卡到2147483647，并通过真实指针命中验证。
- `design_machine` 新增 `buffer` 容量分析参数与清晰的 partial-concept-only 能力边界。

## 最终回归
完整回归：3328 tests，3325 passed，3 skipped，0 failed；TypeScript和桌面构建通过。独立真实模型工程目录保留在 `/tmp/automationcad-pv-buffer-live`，不属于仓库交付；确认卡写入过程最终成功，模型和项目文件已落盘。
