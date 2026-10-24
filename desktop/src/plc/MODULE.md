# 模块：PLC 抽象（src/plc/）

职责：为仿真 PLC 和 Modbus TCP 提供同一套点位读写接口，供联调、面板和后续工作流复用。

## 适配器架构

```
PlcManager（src/plc/manager.ts）
 ├─ SimPlcAdapter    ：内存点表 + 100ms 规则求值 + force
 └─ ModbusPlcAdapter ：modbus-serial TCP，FC01/02/03/04/05/06
```

```ts
interface PlcAdapter {
  readonly kind: 'sim' | 'modbus';
  connect(cfg: PlcConfig): Promise<void>;
  disconnect(): Promise<void>;
  read(id: string): Promise<boolean | number>;
  write(id: string, value: boolean | number): Promise<void>;
  readAll(): Promise<Record<string, boolean | number>>;
  subscribe(cb: (values: Record<string, boolean | number>) => void): () => void;
  status(): 'disconnected' | 'connecting' | 'connected' | 'error';
}
```

`PlcPoint.area` 与 Modbus 功能码对应：

| area | 读 | 写 |
|---|---|---|
| `coil` (0x) | FC01 | FC05 |
| `discrete` (1x) | FC02 | 只读 |
| `holding` (4x) | FC03 | FC06 |
| `input` (3x) | FC04 | 只读 |

## 仿真规则

```ts
{ target: 'Y0', expr: 'X0 && !X1' }
{ target: 'Y1', type: 'latch', set: 'X2', reset: 'X3' }
{ target: 'Y2', type: 'timer', when: 'X4', delayMs: 500 }
```

- 表达式只支持点位、`&&`、`||`、`!`、括号，不使用 `eval`。
- 自锁规则复位优先；定时器输入断开后输出立即复位。
- `force(id, value)` 后该点不再被规则覆盖；`write` 会解除强制。
- 订阅回调收到变化值增量（如 `{ X0: true }`），连接后首次订阅返回完整快照。
- 仿真初始值在 Manager 创建适配器前校验：`int16` 为 −32768..32767，`uint16` 为 0..65535；仿真写入与 `force` 复用相同校验。

## 持久化、超时与错误

- 配置：`userData/plc.json`，原子写入，权限 `0600`。
- Modbus 连接超时 5 秒；Manager 所有读写统一 10 秒超时。
- `ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT` / `ECONNRESET` 全部翻译成中文错误。
- 主进程返回 `{ ok, data }` 或 `{ ok:false, code, message }`，不把网络错误抛成未捕获异常。

## 坑点

1. **同一次写入可能产生两条仿真通知**：先推输入变化，再推规则输出变化；渲染层必须按 id 合并，不能假设回调是完整快照。
2. **仿真规则立即求值一次**：写线圈后马上读反馈时，不需要等下一次 100ms tick；否则联调前置条件会偶发失败。
3. **Modbus 批量读要按区域和数据宽度分组**，不能把 coil 与 holding 混在一次请求里。
4. **离散输入和输入寄存器只读**；联调用例的动作必须写线圈/保持寄存器，反馈只读输入点。
5. **`readAll` 失败会停止轮询并置 error**，需要用户断开重连；不要静默重连掩盖现场接线问题。

## 进度

- ✅ sim 适配器、表达式/自锁/定时器、force、订阅
- ✅ Modbus TCP 读写、分组批量读、中文错误与 5 秒连接超时
- ✅ `plc.json` 持久化、适配器切换、状态/值广播、统一超时
- ⏳ 真实 PLC 现场联调
- ⏳ Siemens S7 / OPC UA 适配器

## 待办

1. 断线自动重连（指数退避）与轮询恢复。
2. 点位导入/导出 CSV，减少现场手工改地址。
3. 写入审计日志（操作者、点位、旧值、新值、时间）。
