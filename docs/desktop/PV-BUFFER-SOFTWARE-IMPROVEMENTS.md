# PV Buffer workflow software improvements

真实 ds4.1flash 软件智能体设计光伏缓存机时发现并修复：

1. 空白画布 `.cw-empty` 全局绝对定位覆盖检查器关闭按钮，改为只定位 `#cwNodes > .cw-empty`。
2. Agent 写确认卡 z-index低于 Agent 抽屉，实际按钮不可命中导致120秒超时误报 USER_DENIED；确认卡提升到最大层级，容量模型和单塔建模真实允许一次成功。
3. 新增 `analyzeBufferCapacity` 及 `design_machine.buffer`：明确上/下游节拍、停机新增、初始库存、在途、预留、容量、净积料和长期背压警告。
4. 生成器允许严格 `layerPitchMm=180`（原下限250），但既有缓存工程仍实际使用250，重新生成才会采用180。
5. Viewer 新增 `sceneIntegrity()`，显式比较模型零件与场景承载零件；避免工程保存90件、视口仅6件时被误报为完整联调。
6. 完整回归（**历史数字，本轮中途跑的那一遍**）3328：3325通过、3跳过、0失败；类型与桌面构建通过。最终定版回归为 3417 tests / 3414 pass / 0 fail / 3 skipped（见 `HANDOFF-NEXT-SESSION.md` §本轮（2026-11-18）真实结果），引用时请用后者。

真实单塔概念工程的剩余缺陷：视口统计曾显示6件而工程90件，需重启新构建后用 `sceneIntegrity`复验；本次工程仍不是双塔/FIFO/安全认证制造设计。
