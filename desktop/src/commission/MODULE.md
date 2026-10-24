# 模块：通电联调（src/commission/）

职责：在仿真或真实 PLC 上按固定顺序上电，执行动作/信号检查用例，并输出可归档的联调报告。

## 可选模块边界

- 模块 ID：`commission.io-test`；默认启用，可在「模块设置」单独关闭，不依赖 `plcgen`。
- 关闭时隐藏并拒绝 6 步上电、3 条标准 IO 用例及其失败诊断；通过 `AutomationCadCommission` 暴露的测试运行入口也会返回失败。
- **不控制实时 PLC 连接权限**：连接/断开、点位读写、实时监视与既有强制写入确认仍走独立的 `plc:*` IPC；关闭测试模块不会断开连接、禁用这些接口或清除工程数据。
- 如果关闭发生在测试执行期间，当前已发出的单次 IO 操作允许完成，执行器在下一次读取/写入前停止；不会继续后续测试步骤。

## 数据结构

```ts
interface Step {
  id: string;
  name: string;
  precondition?: (values: Record<string, boolean | number>) => string | null;
  action: 'wait' | 'set' | 'expect';
  point?: string;
  value?: boolean | number;
  timeoutMs?: number;
  expect?: boolean | number;
}

interface StepResult {
  stepId: string;
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
  at: string;
  durationMs: number;
  message?: string;
}
```

`runSequence()` 顺序执行：`set` 写入并回读；`wait` / `expect` 每 50ms 轮询，默认 3 秒超时；任一步失败立即停止，消息包含阶段、点位、期望值与实际值。可选的 `io.onStep(result, step)` 会在每步结束后回调，用于驱动 3D 视图和故障诊断。

## 3D 联动与诊断

- `machine-config.ts` 定义机型配置（工位、执行机构、传感器及点位映射）并做中文校验；`demoMachineConfig()` 提供 4 工位 × 3 执行机构（气缸/夹爪/旋转）× 16 传感器样例。
- `scene3d.ts` 调用 `machine/geometry.ts` 按配置生成参数化整机几何（机架、工位底板、门架、气缸缸体+活塞杆、夹爪、旋转台、传感器、安全光栅、输送线/分度转盘，单位 mm），经 `machine/geometry-three.ts` 渲染，运动件按生成器给出的轴向/行程动画。气缸按 `extendPoint`/`retractPoint` 与 `durationMs` 插值，夹爪按 `gripPoint` 开合，旋转轴按 `point` 转到 90°；故障高亮通过 `sensors[].part` 或执行机构点位映射到部件。
- `initCommissionPanel()` 暴露 `getMachineConfig()` / `setMachineConfig(config | null)`：应用机型方案时销毁旧 `createScene3D` 实例并用新配置重建；传 `null` 恢复内置 4 工位样机。启动时渲染层读取 `machine:active` 恢复上次方案，指针缺失或损坏则保持样机。
- 3D 视图默认开启，关闭后停止渲染；WebGL 不可用时显示降级文案，不抛异常。`window.__Commission3D.stats()` 暴露帧/更新计数、工位数、执行机构数、传感器数、部件数（工位 + 执行机构）以及 `geometryParts` / `envelopeMm` / `layout`；`scene.machineGeometry()` 返回当前几何。
- 边界：STEP 只提供几何，不含轴类型、行程和运动学。若 CAD 覆盖层存在完整运动学标注，3D 场景优先按
  `MovingPart.meshIds` + `MachineConfig` 点位映射驱动；标注缺失/行程为 0/点位未绑定时回退到配置驱动，
  面板顶部黄条会说明原因。两种模式都不声称支持任意 STEP 自动识别机构。
- `diagnose.ts` 为纯函数，覆盖执行元件未到位、输出未动作、双传感器、安全回路、通讯异常、PLC 未 RUN、气压不足及通用兜底，并按置信度降序返回可执行排查步骤。

## 标准内容

- 28 点位：15 DI（X0~X14）、9 DO（Y0~Y8）、2 AI、2 AO，编号与内置 IO 规划对应。
- 6 步上电：主回路 → 24V → PLC RUN → 气源 → 回原点 → 就绪。
- 3 条用例：点动、气缸伸出/缩回、急停链路。
- 仿真默认规则：反馈跟随输出、安全门/急停联锁、500ms 就绪定时器、急停锁存。
- 单跑用例时若上电未完成，UI 会先自动执行 6 步上电。

## 报告

`export/report.ts` 新增 `commission` 章节，包含 PLC 类型/状态、上电明细、用例明细、期望/实际与耗时。主进程仍走 `webContents.printToPDF` 的 A3 横向通道。

## 坑点

1. **动作只写线圈/保持寄存器**，传感器输入只读；否则换到真实 PLC 会因写离散输入失败。
2. **上电步骤之间有前置条件**，不能一键跳到最后一步；失败时保留首次失败点。
3. **异步轮询不能用固定 sleep 总时长**，必须按 deadline 判断，避免慢 PLC 把 3 秒拖成更久。
4. **报告里的 expected/actual 是字符串快照**，便于 PDF 直接展示；结构化值仍保留在点位快照中。

## 进度

- ✅ 纯函数序列执行器与失败定位
- ✅ 28 点位、6 步上电、3 条用例、仿真全通过
- ✅ 联调面板、逐步/一键、单跑/全跑、强制写入确认
- ✅ 可选 `commission.io-test` 模块开关；关闭测试后保留实时 PLC 连接与监视
- ✅ PDF 联调章节与 smoke 断言
- ⏳ 真机 IO 校验与报告签字/归档流程

## 待办

1. 支持用例参数化（不同机型/工位）。
2. 记录操作员与设备序列号。
3. 历史联调报告列表与版本对比。
