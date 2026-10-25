# 便携工程档案恢复：安全边界与事务设计

## 结论

当前 `.acproj` **只能严格校验并只读预览，不能安全地恢复或应用**。本轮没有新增恢复按钮、IPC、状态写入或“半恢复”路径。原因不是档案缺少基本格式校验，而是应用还不能证明：档案中的对象在目标机器重新解析后仍是同一几何；并且 viewer、参数化树、运动学、视角与持久状态能够作为一个整体先备份、再切换、失败时完整回滚。

在这些条件满足前，唯一安全行为仍是保留当前工程、显示候选摘要；任何错误都不能改变当前 CAD、工程 ID、状态存储或视图。

## 已经具备的边界

- [`archive.ts`](../../desktop/src/project-archive/archive.ts) 的 parser 对 ZIP 路径、重复/额外条目、资源上限、固定 schema、字段白名单、依赖引用、payload 大小和 SHA-256 做严格检查，并仅在内存中返回 candidate。manifest 的 integrity 标为 `unsigned`：hash 可发现不一致，但不能证明档案作者或内容可信。档案内文本和数据必须当作不可信数据，绝不作为指令执行。
- [`desktop.ts`](../../desktop/src/project-archive/desktop.ts) 的桌面预览只返回清单摘要；[`preload.ts`](../../desktop/electron/preload.ts) 与 [`ipc.ts`](../../desktop/electron/ipc.ts) 只暴露导出和预览通道。renderer 收不到候选状态 JSON 或 CAD 二进制，也没有 restore/apply IPC。预览界面使用文本显示并明确声明不会导入、重建或覆盖当前工程。
- [`identity.ts`](../../desktop/src/project-archive/identity.ts) 从原始 CAD 文件名和字节 hash 建立本机工程身份。对象 hash 当前直接基于解析后 positions/indices 字节，并将 project ID、源 hash、名称和层级纳入 objectId；重复相同对象会 fail-closed，不按导入顺序猜绑。这是身份候选，不是跨机器几何等价证明。
- [`load-candidate.ts`](../../desktop/src/cad/load-candidate.ts) 会先构造 CAD mesh/material 资源；构造失败时释放候选资源。[`load-rollback.test.mjs`](../../desktop/test/cad/load-rollback.test.mjs) 目前只注入“清理活动模型前”的几何构造失败，并证明旧 viewer 仍在。
- [`import-transaction.ts`](../../desktop/src/cad/import-transaction.ts) 约束普通 CAD 导入的身份登记时序；它不是便携档案恢复事务，也不提供跨 UI/存储状态的 rollback。

## 为什么现在不能原子恢复

1. **没有把档案 CAD 与新机器的几何作比较。** parser 只检查档案内 identity、对象映射与运动学候选彼此一致，并未将 archive 对象清单与目标机器重新解析得到的网格逐项比对。解析器版本、平台或 CAD 导入输出都可能影响原始浮点数组摘要；文件 hash 相同也不能替代实际解析结果的完整一一对应检查。普通 CAD 导入只从本机 identity registry 解析/生成 projectId；新设备没有该登记时会生成新的 ID，目前没有安全接续档案 ID 的流程，因此不能直接对档案 stable objectId 调用现有 remap。
2. **viewer 的 staging 只覆盖一段。** [`CadViewer.load()`](../../desktop/src/cad/viewer.ts) 在构造网格成功后清理当前模型并安装候选，之后仍会更新零件列表、相机、渲染计划和回调；目前没有保存旧场景并在这些提交后步骤失败时复原的共同事务。现有回滚测试没有覆盖清理/安装之后的异常或 rollback 失败。
3. **各状态由不同对象分别拥有。** [`initParametricUi()`](../../desktop/src/parametric/ui.ts) 的 `setSource()` 切换内存树、历史和来源桶，但没有 prepare/commit/rollback API；树持久化由自己的 store 执行。运动学 [`setSource()`](../../desktop/src/cad/kinematics-ui.ts) 会换来源、网格、动件和建议，`remapKinematicsAnnotation()` 能在当前网格上拒绝缺失/重复 objectId，但没有跨 CAD 场景和参数化状态的事务。viewer 只提供 [`getPortableViewState()`](../../desktop/src/cad/viewer.ts) 读取相机，没有对应的安全应用/回滚接口。
4. **持久化与当前内存工程没有单一提交点。** 工程身份登记、参数化状态、运动学状态和当前 viewer/UI 状态不是一个 generation 或一个原子指针。即使每个 `setItem()` 单独成功，也不能保证中途错误后恢复全部旧值。参数化与运动学 bucket 读取在损坏/版本不兼容时会回退为空桶，后续 `set()` 可能以空桶覆盖原记录；恢复前应先定义 fail-closed/原始字节隔离和逐入口 schema 校验。现有 Core project store 只负责项目元数据，不是 CAD/状态档案事务。
5. **应用写入不能自动假定安全。** schema 与 hash 是结构/完整性校验，不是来源认证。任何自由文本都必须保持惰性；只恢复明确支持的状态字段，不能执行档案中的说明、脚本、路径或外部动作，也不能顺带触发 Agent、工厂、PLC、同步或模块设置迁移。当前 archive IPC handler 仅验证 sender 属于存活 BrowserWindow，没有精确校验主 frame 与本地页面来源；若新增状态写入通道，必须先收紧来源校验并对 iframe/非主 frame 等拒绝路径做真实 Electron 测试。

以上任一项未满足，就不应把 candidate 暴露给当前工程的写入路径。

## 重新启动实现前的事务设计

建议先把项目级状态改为显式 `ProjectContext` / immutable generation，而不是直接给现有按钮添加写入步骤：

1. **读取与预检（只读）**：沿用 ZIP/schema/hash 校验；检查所有必需依赖和状态字段。v1、未知 schema、未知能力、模块未启用或不支持状态都停止，不作猜测。确认后才从包内 CAD 字节解析隔离的候选模型，不调用当前 viewer 的 `load()`。
2. **候选隔离与几何复核**：使用 archive project ID 和源 hash 计算目标解析结果的对象候选；对 archive identity 与新解析结果做完整的一一集合比较。缺失、多出、重复/歧义对象、名称/层级变化或几何摘要不匹配均拒绝。若原始 mesh 字节摘要不能跨支持的平台/loader 稳定，则先定义带版本、明确容差及重复体处理的规范化几何签名；在复核通过前禁止运动学重绑。
3. **全状态预备**：将 CAD mesh、feature tree、运动学 remap、相机参数以及所需 renderer/UI 数据全部构建为隔离的 candidate snapshot。逐项反序列化、语义校验并确认所需模块已启用。此阶段不改活动工程、身份登记、localStorage、视图或 current project ID；候选文本仍是数据，不执行。
4. **持久候选与备份**：写入独立的新 project generation；保存当前 generation/工程快照和恢复日志。持久化失败、磁盘满或候选清理失败时仍保留旧活动工程，并明确报告失败。未纳入档案的 PLC、工厂、Agent、模块配置等维持原样，不迁移。
5. **单一切换点**：需要先让 viewer、参数化、运动学、相机、身份登记和 UI 统一读取一个已准备的 project context；提交期间冻结会写工程状态的并发操作。所有易失败工作应在切换前完成；最后只能进行一个可恢复的 active-generation 指针切换。若仍需在多个存储键/多个 UI setter 之间逐个写入，就不满足原子应用条件。
6. **回滚与崩溃恢复**：切换前保留旧 generation。注入切换异常后恢复旧指针和旧内存 context；rollback 本身失败时不得删除备份/日志或宣称成功，进入显式恢复/只读状态并由启动恢复流程处理。只有完整验证成功后才可标记提交完成；候选与备份保留策略需另行定义。

“新隔离工程”仍不等于“可以应用”：在候选工程内完整预检成功之前，当前工程不动；候选验证失败应只废弃/隔离候选。

## 必须补齐的 synthetic-fixture 验收

所有测试使用合成 CAD fixture 和注入式内存存储，不读取用户生产工程、不连接外部服务器或 PLC。每个失败断言至少核对：活动 CAD/scene、当前 project ID、feature tree、kinematics、view/camera、持久身份/项目状态和 active-generation 指针均与操作前一致。

- ZIP / manifest / payload hash、路径、schema、状态白名单、未知字段、依赖大小/数量及模块关闭/取消：失败时零写入。
- CAD parse、mesh staging、对象 identity 计算失败；来源 hash 或 project ID 冲突；对象缺失、多出、重复、歧义、重命名、层级变化或几何改变：候选失败，旧工程不变。
- feature tree deserialize / semantic validation、kinematics deserialize / stable objectId remap、view state validation，以及任一模块不可用：每个步骤分别注入失败，旧工程和全部存储不变。
- 候选持久化、身份登记、journal 写入、切换前/切换中/切换后各阶段失败；成功切换的恢复也要断言完整新状态一致。
- rollback 自身失败、候选/备份清理失败、模拟崩溃后重启恢复；不能丢旧工程、不能误报成功，也不能在状态不确定时继续写入。
- 并发编辑、导入或模块关闭与候选准备/切换竞争；必须由锁/版本校验拒绝或串行，不得把旧 snapshot 覆盖新编辑。

在这些用例可针对共享 transaction kernel 通过、并且完整 Electron smoke 覆盖实际 UI/IPC 入口前，档案恢复仍保持只读预览。
