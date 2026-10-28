# 状态历史归档（STATUS-HISTORY）

从 [STATUS.md](STATUS.md) 移出的历史 smoke 断言矩阵，原文保留。本文件不进入智能体离线知识索引。

## Smoke 断言清单

以下断言名均从 `desktop/electron/main.ts` 实际 grep 得到（另含 `SMOKE_OK`、`SMOKE_FAIL`、`SMOKE_SHOTS_FAIL` 三个控制标记，未计入断言）；参数为最近一次实跑输出（路径类断言只校验文件存在与非空）。无 fake sidecar 时参数化 3 个 `_OK` 不出现、2 个分支输出 `_SKIP`。

| 断言 | 本轮实测 / 含义 |
|------|-----------------|
| `SMOKE_CAD_OK` | `triangles=12 meshes=1`，`cube.stp` 解析统计 |
| `SMOKE_WEBGL_FALLBACK_OK` | `meshes=1 triangles=12 bounds=300×300×300 mm`，无 WebGL 降级面板 |
| `SMOKE_KINEMATICS_UI_OK` | `parts=2 errors=1 slide=25`，标注校验与滑块预览 |
| `SMOKE_KINEMATICS_AUTO_OK` | `high=4 low=1 accepted=1 autoApplied=0`，STEP 动件自动识别只出建议 |
| `SMOKE_AGENT_KINEMATICS_OK` | `high=4 low=1 written=0`，Agent 工具 `suggest_kinematics` 经命令总线拿到建议且不改动件列表 |
| `SMOKE_ORBIT_UNDO_OK` / `SMOKE_ORBIT_MULTI_OK` / `SMOKE_ORBIT_PERSIST_OK` | 主视口 3D 编辑与原型合成一条撤销时间线、多选、`automationcad.orbit.v1` 重开恢复 |
| `SMOKE_AGENT_AUDIT_ROTATED_OK` | `rows=3 files=2`，审计日志轮转后面板/报告读全部保留文件 |
| `SMOKE_MECH_OK` | `hits=1`，干涉 AABB 初筛 |
| `SMOKE_MECH_UI_OK` | `rootTab=1 calculators=3 inspector=1` |
| `SMOKE_EXPORT_OK` | `csv=1 dxf=1`，BOM/DXF 写出 |
| `SMOKE_EXPORT_ASSETS_OK` | `xlsx=16577 glb=1772 obj=903`，XLSX/GLB/OBJ 字节数 |
| `SMOKE_PDF_OK` | A3 报告 PDF 已写出 |
| `SMOKE_PLC_OK` | `points=28`，PLC 仿真点位表 |
| `SMOKE_COMMISSION_OK` | `steps=6 passed=6`，6 步上电 |
| `SMOKE_COMMISSION_UI_OK` | `cases=3 monitor=28 results=18` |
| `SMOKE_COMMISSION_PDF_OK` | 联调章节 PDF 已写出 |
| `SMOKE_COMMISSION_3D_OK` | `ticks=57 parts=16` |
| `SMOKE_COMMISSION_3D_SCALE_OK` | `stations=4 actuators=12 sensors=16 parts=16 ticks=57` |
| `SMOKE_DIAGNOSE_OK` | `codes=2`，故障诊断卡片 |
| `SMOKE_UI_OK` | `stations=2 tags=8 packs=8 parts=55 overlay=1`，工厂/数据包/覆盖层 |
| `SMOKE_PLCGEN_OK` | `files=5 tags=32`，基础 ST 五文件 |
| `SMOKE_PLCGEN_SEQ_OK` | `files=11 steps=2`，11 文件与自动序列 |
| `SMOKE_PLCGEN_SIM_OK` | `steps=6 ok=1 alarms=0`，内置模拟器 |
| `SMOKE_PLCGEN_UI_OK` | `files=11 history=1`，面板预检/生成/历史 |
| `SMOKE_PLCGEN_UI_SKIP` | 无机型配置时的条件跳过分支 |
| `SMOKE_PARAMETRIC_SIDECAR_OK` | `status=ready fake=1`（设置 `AUTOMATIONCAD_PARAMETRIC_CMD` 时） |
| `SMOKE_PARAMETRIC_UI_OK` | `features=2 status=ready`（假 sidecar） |
| `SMOKE_PARAMETRIC_ASSEMBLY_OK` | `solids=2 bomRows=3`（假 sidecar 多实体） |
| `SMOKE_PARAMETRIC_SIDECAR_SKIP` | 未设置 fake sidecar 时的条件跳过分支 |
| `SMOKE_PARAMETRIC_UI_SKIP` | 未设置 fake sidecar 时的条件跳过分支 |
| `SMOKE_ELEC_LIB_OK` | `parts=377 categories=26 symbols=219` |
| `SMOKE_ENCLOSURE_CANVAS_OK` | `placed=2 overlap=1 ratio>0` |
| `SMOKE_ELEC_CHECK_OK` | `findings=4 errors=3`，线号/功率/截面规则 |
| `SMOKE_ELEC_CHECK_UI_OK` | `rows=4 cards=9 pdf=true` |
| `SMOKE_COST_OK` | `lines=6 missing=1 grand=1398.64` |
| `SMOKE_COST_AGENT_OK` | `bomSource=argument lines=6 missing=1 grand=1398.64` |
| `SMOKE_COST_AGENT_EXPORT_OK` | `format=csv bytes=737 name=sanitized` |
| `SMOKE_COST_UI_OK` | `rows=6 cards=9 grand=1398.64 book=6 pdf=1` |
| `SMOKE_AGENT_TOOLS_OK` | `tools=21 implemented=21` |
| `SMOKE_AGENT_TOOLS_V2` | `tools=21`，新增工具全部注册 |
| `SMOKE_MACHINE_DESIGN_OK` | `stations=3 actuators=6 sensors=3 warnings=2 form=linear-4`，覆盖 3 工位、按 18.87 件/分钟给出缺口 |
| `SMOKE_MACHINE_CYCLE_OK` | `mode=cell throughput=32 meets=1`，六工位双轨 `(3.18 + 0.60) / 2` 秒/件 |
| `SMOKE_MACHINE_TEMPLATES_OK` | `templates=5 clarify=1 multi=1`，五类工艺模板与追问上限 |
| `SMOKE_MACHINE_GEOMETRY_OK` | `layout=linear parts=56 axes=6 envelope=1680x740x1177 chunks=2 scene=56`，参数化整机几何 |
| `SMOKE_MACHINE_APPLY_OK` | `machine=design-screw-3st stations=3 bom=5 undo=1`，方案落盘、3D/BOM/PLC 联动与撤销 |
| `SMOKE_AGENT_KB_OK` | `docs=13 chunks=354 query=D2 hits=1`，离线知识索引可检索 |
| `SMOKE_AGENT_BRIDGE_OK` | `scene=1 bom=1`，渲染桥读取 |
| `SMOKE_ORBIT_VIEW_OK` | `mode=fallback parity=1 pick=1 group=3 bore=40→32 stack=+4 hits=1`，主视口 3D 降级路径 |
| `SMOKE_AGENT_CHAT_UI_OK` | `fields=6 log=1` |
| `SMOKE_AGENT_READONLY_UI_OK` | `preview=2 offline=1 rows=2 summary=ok scene=0` |
| `SMOKE_AGENT_NL_OK` | `intents=7 tools=21 audit=3 ctx=616` |
| `SMOKE_AGENT_PLACE_OK` | `placed=1 undo=1` |
| `SMOKE_AGENT_PLAN_OK` | `steps=3 confirm=1` |
| `SMOKE_PROTO_INSERT_OK` | `parts=7→8 dof=+2` |
| `SMOKE_PROTO_UNDO_OK` | `parts=8→7` |
| `SMOKE_PROTO_REDO_OK` | `parts=7→8` |
| `SMOKE_SYNC_PACKAGE_OK` | `files=4 sha=1`，设计包固定产物与指纹 |
| `SMOKE_SYNC_UI_OK` | `fields=8 apiKey=password enabled=checkbox` |
| `SMOKE_UI_SCALE_OK` | `scale=1.15`，默认缩放已下发到 CSS 变量与 renderer |
| `SMOKE_RENDER_QUALITY_OK` | `quality=standard draggingRatio=0.8`，默认档位与拖动降级 |
| `SMOKE_LAN_SWITCH_OK` | `enabled=false host=127.0.0.1 allowlist=1`，LAN 默认关闭且仅监听回环 |
| `SMOKE_LAN_ALLOWLIST_OK` | `allowed=1 denied=0`，同一次 smoke 验证白名单允许与非白名单拒绝 |
| `SMOKE_OK` | 全部 smoke 分支完成后输出 |

---

（以下内容由 STATUS.md 归档，不进离线索引）

## Smoke 断言（当前在跑的关键几条）

| 断言 | 实测 |
|------|------|
| `SMOKE_OK` | 全部 smoke 分支完成后输出 |
| `SMOKE_PLACEHOLDER_DIMS_OK` | `w=18 h=85 d=78.5 y=0`（插 `iC65N-C16-1P` 后包围盒等于数据包外形、贴地）；降级 smoke 无 WebGL 时打印 `SMOKE_PLACEHOLDER_DIMS_SKIP reason=no-webgl`，属正常 |
| `SMOKE_DESIGN_WEBGL_OK` | `renderer=ANGLE (… SwiftShader …) seed=STEP_fixture:1 scene=61 partPaths=61 tree=61 placements=13` |
| `SMOKE_AGENT_PLACE_OK` | `placed=1 undo=1` |
| `SMOKE_DESIGN_WIZARD_OK` / `_CANDIDATES_OK` / `_LAYOUT_OK` / `_SAVE_OK` | `steps=5` / `count=3` / `placements=13 overlaps=0` / `project=Smoke-整机设计` |
| `MACHINE_SHOTS_DONE` | `captured=4 failed=0` |

完整历史断言矩阵见 [STATUS-HISTORY.md](STATUS-HISTORY.md#smoke-断言清单)。

## 早期验证记录（2026-10-27）

| 命令 | 结果 |
|------|------|
| `npm run perf:baseline` | 3000 件：`sceneBuildMs=71.0`、`tickP95Ms=2.34`、`heapPeakMb=39.0` |
| `npm run bench:render` | 500 件 / 100,000 三角面 → `drawCalls=20`，实例合并省 96%，`budget=OK` |
| `npm run check:orbit-webgl` | `ORBIT_WEBGL_OK mode=webgl canvases=2 pick=cyl carriageX=140 clip=1 hits=1` |
| `npm run sync:e2e` | `SYNC_E2E_OK package=dsp_4718a1a3b50b484da618dcf611277916 dup=true diff=1 bytes=856`（真实 material-flow 后端 8899） |

---

（由 STATUS.md 归档，不进离线索引）

## 夜间迭代（2026-10-28 夜，5 个 PR 全绿合并）

| PR | 内容 | 关键数字 |
|----|------|----------|
| #26 | Qt 特征右键菜单（压缩/解除压缩、删除特征）+ `--feature-ops-selftest` | 压缩沉头孔 94,166.8 → **95,966.9 mm³**（差值 1,800.1 正是该特征体积）；删除被引用基体走 409 `REFERENCE_IN_USE` |
| #27 | Qt 改 SSE 推送为主、10s 轮询兜底、断线 3s 重连 | 自检把轮询调到 30s，改树 → 刷新 **138ms** |
| #28 | 契约服务可选落盘 `FT_DATA_DIR`（单文件 JSON + 原子写 + 快照） | 重启后 r1/高度 19 还在；重启后 undo 仍能回到 12；默认不写盘 |
| #29 | MCP 补 `ft_set_suppressed` / `ft_delete_feature`（4 → 6 工具） | 压缩后体积变大、删除引用基体回 `REFERENCE_IN_USE` + 提示「先处理引用方」 |
| #30 | 材料与质量：`doc.material` + `setMaterial` + Qt「工具→材质」菜单 | 铝 **0.2543 kg** vs 钢 0.7392 kg，体积都是 94,166.8 mm³ |

夜间实测汇总（本机 Linux）：featuretree **35/35**、MCP **16 条 PASS**、落盘 **10/10**、
真几何 **18 条 PASS**、Qt 三个 selftest 全过（`FT_QT_SELFTEST_OK revision=2 height=13`、
`FT_QT_HISTORY_OK undo=r2 redo=r3`、`FT_QT_FEATUREOPS_OK suppressed=95307.2 restored=94166.8`、`QT_SSE_OK 138ms`）、
desktop `npm test` **2589（2587 通过 / 2 跳过）**。
