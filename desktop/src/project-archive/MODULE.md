# 可移植工程档案（`src/project-archive/`）

## 当前能力

`project.portable` 是默认启用、依赖 Core 的可选内置模块（v2.0.0，API 1–2）。CAD 导出菜单提供 `.acproj` 导出和档案校验/预览。导出按钮仅在当前 CAD 已取得持久工程 ID 时启用；主进程要求用户选择原件，且所选文件必须与 renderer snapshot 中的源文件名、SHA-256 和字节数完全匹配。文件名相同但内容不同的 CAD 不会复用该状态。

schema v2 可收录经现有 schema 验证的 Parametric feature tree、具有 `projectId` 和 stable `objectId` 映射的运动学 annotation v2、CAD viewer camera/wireframe snapshot、以及用户选定的原始 CAD 文件。未收录状态以固定原因码写入 manifest，并会在之后的只读预览中重新显示；如果参数化模块关闭/状态未加载、没有相机状态或运动学没有稳定网格映射，对应字段不会伪装成已保存。工程状态由显式字段白名单构建，不携带 Agent、模块设置、工厂/PLC 配置、凭据、密钥、侧车产物或生成网格缓存。

稳定 project ID 本机保存在 `automationcad.project-identity.v1` 登记表中，以规范化文件名和 CAD 原始字节 SHA-256 作为输入；因此不同内容的同名 CAD 会被隔离，重新打开相同文件可复用同一 ID。模型 `objectId` 由工程 ID、源 hash、零件名/装配路径及几何摘要派生；完全不可区分的重复对象不分配 ID，避免按导入顺序猜绑。该映射提供稳定候选身份，但它不证明异机 CAD 重新解析后的 B-rep/网格几何相同。

导入目前严格解析 `.acproj` 并只显示清单摘要，renderer 不接收候选状态 JSON 或 CAD 二进制，也不写入 localStorage、不打开候选模型、不修改当前工程。档案 parser API 可在内存中构造验证后的 candidate，但桌面 IPC 不会把 candidate 暴露给应用状态写入路径。当前 viewer、参数化和运动学界面缺少“隔离加载候选 CAD → 几何绑定复核 → 所有状态预检 → 原子替换/事务回滚”的共同接口；因此没有“应用/打开工程”功能。跨机器运动学 objectId 仍需在新 CAD loader 输出上重新验证，特征树变换与视角也没有安全的事务应用/回滚。这里明确保留只读预览，不做半恢复。

## schema 与兼容

- ZIP 入口固定为 `manifest.json`，档案类型为 `automationcad.portable-project`。schema v2 含 project ID、源 CAD 原名/hash/大小和模型对象映射；Core schema 独立编号。
- 状态 payload 路径固定为 `state/feature-tree.json`、`state/kinematics.json`、`state/view-state.json`；schema v2 的 `state.omitted` 保存固定白名单未收录原因码（不会保存自由文本），旧 schema v1 没有该字段；CAD 原件放在 `dependencies/NNNN-<safe-name>.<ext>`。
- schema v2 的源 identity 必须唯一对应真实 CAD dependency；objectId 必须由其 identity 字段重算一致，运动学 v2 的所有对象引用都必须在 manifest 映射中且无歧义。feature tree 和运动学来源必须引用包内 CAD dependency。
- 旧 archive schema v1 可严格解析为没有稳定 source identity 的只读候选；旧 FeatureDoc v1 与已支持的新 FeatureDoc/AssemblyDoc schema 仍各自按文档 schema 验证。旧档案不自动升级、绑定当前项目或参与状态恢复。未知档案/Core/state schema 失败关闭。
- 支持独立单文件 CAD：STEP/STP、IGES/IGS、BREP、STL、GLB。OBJ/GLTF 可能需要外部 MTL/纹理/缓冲区，当前不收录；未知扩展名失败关闭。

## 完整性和安全限制

解析先扫描 ZIP 原始中央目录，再交给 `adm-zip`。拒绝绝对路径、盘符、`..`、反斜线别名、重复/大小写碰撞条目、多卷/加密/未知压缩方式、ZIP64 和未声明条目。固定上限：压缩 ZIP 256 MiB、manifest 1 MiB、单状态 10 MiB、单 CAD 原件 200 MiB、解压总量 240 MiB、128 个条目、64 个 CAD dependency；资源声明在解压前检查。桌面读取还限制普通文件属性与实际读取大小。

每个 payload 的大小和 SHA-256 必须匹配 manifest；源 identity 还与 CAD dependency 的原名、大小、hash 交叉验证。哈希和路径校验提供损坏检测/结构完整性，不提供作者认证：manifest 未签名，能同时改写 ZIP 与 manifest 的人也能重新计算 payload 摘要。CAD loader 的 B-rep/几何有效性与跨设备模型等价性不由 archive parser 保证。

## API 与测试

- `resolveCadProjectIdentity(...)`：依据本机 identity registry 创建或复用持久工程 ID，并从当前 import 网格数据生成确定性的 model identity；registry 损坏/歧义时 fail-closed，不按 basename 自动回退。
- `buildPortableProjectArchive(sources)`：验证 payload、稳定 identity、跨字段 dependency 和 schema 后生成 schema-v2 ZIP。
- `parsePortableProjectArchive(bytes)`：严格验证并返回内存 candidate；不会把 candidate 应用到打开的工程。
- `exportSelectedCadAsPortableArchive(dependencies, snapshot)`：主进程选择 CAD 原件，校验 snapshot 与实际字节精确匹配，再通过独占新建写出；模块关闭、对话框取消、校验失败或文件已存在时不覆盖已有文件。
- `previewSelectedPortableArchive(dependencies)`：严格解析用户选择的 `.acproj`，只返回清单摘要。
- `archive.test.mjs` 覆盖 schema-v2 round-trip、stable objectId、FeatureDoc v1、archive schema v1、未知版本、缺失依赖、哈希损坏、路径 traversal、重复条目与资源上限。
- `identity.test.mjs` 覆盖同名不同 CAD 内容隔离、重开复用、导入顺序无关、重复几何 fail-closed 与 registry 损坏。
- `desktop.test.mjs` 覆盖状态+CAD 文件往返、同名异内容 hash 拒绝、取消、模块关闭、坏包/未知版本、保存失败不覆盖和当前工程不变。

完整事务导入仍未实现，也不应宣称为整机可恢复档案。当前可实现的是具有稳定来源 identity、状态候选校验和 CAD 原件依赖的 schema-v2 包，以及严格只读预览；应用这些状态前仍需独立完成候选 CAD 隔离加载、几何重绑定和原子回滚设计。
