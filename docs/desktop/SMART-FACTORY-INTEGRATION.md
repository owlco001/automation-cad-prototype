# 智慧工厂对接：现状、缺口与改动清单

对象项目：`owlco001/material-flow-system`（GitHub / Gitee 同名，生产 `http://221.231.106.194:5556`，本机演示 `:8000`）。
本文是给**智慧工厂侧**的改动说明（需求 #6），客户端实现见 `src/sync/`。

> **客户端状态（2026-10-23）**：桌面端 P2-C 已完成，包含固定路径 ZIP（`manifest.json` / `bom.csv` / `report.pdf` / `model.glb` / `drawing.dxf`）、manifest SHA-256、`X-Design-Key` + `Idempotency-Key` 上传、15 秒超时中文错误、设置页与手动同步。服务端 0.22.0 已实现 `/api/v1/design-sync/*`，本地临时 DB 端到端已跑通（见第六节）；生产实例 `221.231.106.194:5556` 从开发机不可达，部署状态仍待 D2 决策。

## 一、现状（已实现，可直接用）

鉴权：`Authorization: Bearer <token>`（`current_user` 依赖），管理台另有 Cookie + CSRF，**不适合桌面客户端**。

| 能力 | 端点 | 说明 |
|------|------|------|
| 机台图纸列表 | `GET /api/v1/devices/{device_id}/drawings` | 返回 `{deviceId, deviceNo, drawings[]}` |
| 物料图纸列表 | `GET /api/v1/materials/{code}/drawings` | 返回 `{materialCode, drawings[]}` |
| 图纸详情 | `GET /api/v1/drawings/{id}` | `_drawing_payload`，含页数、状态 |
| 图纸页 PDF | `GET /api/v1/drawings/{id}/pages/{n}` | `application/pdf`，长缓存 |
| 缩略图 | `GET /api/v1/drawings/{id}/pages/{n}/thumb` | `image/webp` |
| BOM 导入 | `POST /admin/agent/import/bom/{preview,commit}` | 管理台会话，Agent 导入 |
| 模型上传 | `POST /admin/models/upload` | 表单 + CSRF，管理台使用 |

结论：**读**已具备；**写**（设计包上传、版本比对、绑定）目前只有管理台表单，桌面端无法安全调用。

## 二、建议新增：设计同步 API（`/api/v1/design-sync`）

### 鉴权
- 新增 `X-Design-Key: <key>`，key 在管理台「设备接入」页生成，**只存哈希**（bcrypt/argon2），可吊销、可限定 `deviceId` 范围
- 与用户 Bearer 分离：设计同步是机器身份，不做用户会话
- 传输要求 HTTPS（生产已有 cloudflared/反代）

### 1) 上传设计包
```
POST /api/v1/design-sync/packages
Content-Type: multipart/form-data
X-Design-Key: ...
Idempotency-Key: <sha256 of zip>      # 相同指纹直接返回已有包，不重复入库

fields:
  deviceId      string  必填（机台编号）
  manifest      string  JSON 字符串（见下）
  file          binary  zip，≤200MB
```
manifest：
```json
{
  "schemaVersion": 1,
  "projectId": "asm-slide-cyl",
  "projectName": "滑台气缸装配体",
  "appVersion": "0.2.0",
  "createdAt": "2026-10-22T14:00:00Z",
  "bomSha256": "…",
  "files": [{ "path": "bom.csv", "sha256": "…", "size": 1234, "kind": "BOM|PDF|STEP|GLTF|DXF" }],
  "bom": [{ "no": 1, "name": "底板", "spec": "BASE-01", "qty": 1, "mat": "AL6061" }]
}
```
客户端 P2 PLC 扩展仍保持顶层 `schemaVersion: 1`，原 `files[]` 和 BOM/PDF/GLB/DXF 路径不变，额外附带可选 `plc: { schemaVersion: 1, target, generatedVersion, machineId, programFiles, mapping }`；扩展内每项均有 `path/size/sha256`，ZIP 文件位于 `plc/`。**当前只完成本地客户端构建与解析校验，未向外部服务上传验证**；服务端若对 manifest 字段严格校验，或要求 ZIP 只能含 `files[]` 声明的路径，需先更新服务端以接受 `plc` 子清单及其声明的条目，再启用生产上传。旧包不带 `plc` 时仍按原 v1 解析。

PLC 文件仅限 8 个 ST、`io-tags.csv`、`mapping.json` 和机型 `machine-io-map.csv`，每项不超过 1 MiB、PLC 部分总量不超过 8 MiB；客户端会校验目标、生成器版本、路径、长度、SHA-256、密钥/凭据特征和（若提供）当前机型 IO mapping。下载候选不会自动覆盖本地工程，缺少机型上下文时仅返回待后续显式应用的数据。当前 `MachineConfig` 不持久化 PLC safety 扩展；急停/安全门预检未满足时会中止整个包生成，不猜测绑定。

返回 `201 {"packageId","version","uploadedAt","duplicated":false}`；指纹重复返回 `200 {..., "duplicated": true}`。

### 2) 列表与版本
```
GET /api/v1/design-sync/packages?deviceId=&projectId=&limit=20
→ { items:[{packageId, projectId, version, bomSha256, createdAt, uploadedBy}] }
```

### 3) 版本比对
```
GET /api/v1/design-sync/packages/{id}/diff?against=latest
→ { base:{packageId,version}, bomAdded:[], bomRemoved:[], bomChanged:[{no,field,from,to}],
    filesAdded:[], filesChanged:[], filesRemoved:[] }
```

### 4) 绑定机台/物料
```
POST /api/v1/design-sync/bind
{ "packageId":"…", "targetType":"DEVICE|MATERIAL", "targetKey":"DEV-001" }
→ { "bound": true }
```
绑定后，现有 `/api/v1/devices/{id}/drawings` 应能返回该包内的 PDF（复用 `drawing_bindings` 或新增映射）。

### 5) 拉取（可选，用于双向）
```
GET /api/v1/design-sync/packages/{id}/download → zip 流
```

## 三、服务端改动清单

1. **新增路由文件** `app/design_sync.py`，在 `main.py` 注册；不改现有 `/api/v1/*` 行为。
2. **新增表**（SQLite，迁移脚本 `migrate.py` 增段）：
   ```sql
   CREATE TABLE design_keys (
     id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, label TEXT,
     device_scope TEXT, created_at TEXT, revoked_at TEXT
   );
   CREATE TABLE design_packages (
     id TEXT PRIMARY KEY, project_id TEXT, project_name TEXT,
     device_id TEXT, version INTEGER, manifest_json TEXT,
     bom_sha256 TEXT, zip_sha256 TEXT UNIQUE, uploaded_at TEXT
   );
   CREATE TABLE design_package_files (
     package_id TEXT, path TEXT, kind TEXT, sha256 TEXT, size INTEGER,
     PRIMARY KEY (package_id, path)
   );
   ```
3. **存储**：`data/design_packages/<packageId>/` 解压后按 manifest 校验路径（拒绝 `../`），zip 原文保留用于下载。
4. **幂等**：`zip_sha256` 唯一索引 + `Idempotency-Key` 双保险。
5. **限制**：单包 ≤200MB，manifest ≤1MB，文件数 ≤500；解压前校验 zip 条目路径与总解压体积（防 zip bomb）。
6. **审计**：写入 `audit_log`（谁、何时、哪个 device、包指纹），与现有管理台审计同表。
7. **管理台**：新增「设计包」页（列表、下载、吊销 key、生成 key），复用现有 admin 布局与 CSRF。
8. **打通图纸**：绑定后把包内 PDF 注册进 `drawings`/`drawing_bindings`，让现有 APP 端图纸接口自动可见。

## 四、兼容与回滚

- 新表与新路由独立，旧接口零改动；回滚只需下线 `design_sync` 路由。
- 若暂不想加表，可先用「BOM 导入 + 模型上传」现有管理台接口，但桌面端需模拟 CSRF 会话，**不建议**。

## 五、验收清单（服务端）

- [ ] 用错误 key 上传 → 401；吊销后 → 401
- [ ] 同一 zip 上传两次 → 第二次 `duplicated:true`，库中只有一条
- [ ] manifest 含 `../evil` → 400，且磁盘无写入
- [ ] 200MB+ 包 → 413；解压总量超限 → 400
- [ ] 绑定 DEVICE 后，`/api/v1/devices/{id}/drawings` 能查到新 PDF
- [ ] diff 对 BOM 增/删/改各返回一条正确记录

## 六、本地端到端验证（2026-10-23）

### 一键运行

```bash
cd desktop
npm run sync:e2e
```

前置条件：

- 后端仓库位于 `/root/mf-main/material-flow-backend`（可用 `MATERIAL_FLOW_BACKEND=/path/to/repo` 覆盖），且 `.venv` 已安装 `uvicorn` / `fastapi`；
- Node 22+（当前脚本直接用 Node 原生 TS 类型剥离导入 `src/sync/*.ts`）；
- 本机 `8899` 端口空闲（可用 `SYNC_E2E_PORT` 覆盖）。

### 脚本做了什么

| 脚本 | 职责 |
|------|------|
| `scripts/sync-e2e.sh` | 启动/回收后端，准备独立临时 DB 与数据，管理员登录、建设备、生成密钥 |
| `desktop/scripts/sync-e2e.mjs` | 用真实 `package.ts` / `client.ts` 跑完整客户端链路并写 JSON 日志 |

后端启动方式为：

```bash
cd /root/mf-main/material-flow-backend
MATERIAL_FLOW_DATA=/tmp/automation-cad-sync-e2e/data \
MATERIAL_FLOW_UPLOADS=/tmp/automation-cad-sync-e2e/uploads \
INITIAL_ADMIN_PASSWORD='SyncE2E@2026-init' \
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8899
```

脚本内不手写 SQL：测试机台 `DEV-TEST-01` 走 `POST /api/v1/devices`，`X-Design-Key` 走管理台 `POST /admin/design-packages/keys/create`（登录 + CSRF），与真实约束一致。首次管理员密码通过 `POST /api/v1/auth/change-password` 清除强制改密标记后，再重新登录。

客户端链路依次断言：

1. `buildDesignPackage` 打包 BOM + 最小 GLB fixture，得到固定 `zipSha256`；
2. 上传成功，返回 `packageId` 且 `duplicated=false`；
3. 原样重复上传，`duplicated=true` 且 `packageId` 不变；
4. 列表包含该包与项目号；
5. 上传改过 BOM 数量的第二版，`diff(against=latest)` 的 `bomChanged` 包含 `{no:2, field:'qty', from:2, to:5}`；
6. 下载第一版 zip，字节数、SHA-256 与上传时一致，并校验服务端 `ETag`；
7. 关闭后端再调用：返回中文错误、`stage:'上传'`、`code:'UPLOAD_FAILED'`（列表为 `LIST_FAILED`），不抛未捕获异常。

成功时退出码 0；失败时退出码 1，并保留 `/tmp/automation-cad-sync-e2e` 下的后端日志与响应文件便于排查（`SYNC_E2E_KEEP=1` 可在成功时也保留）。JSON 日志固定写入 `docs/desktop/eval/sync-e2e.json`。

### 实测输出

```text
SYNC_E2E_OK package=dsp_4f91342229f84bbc99dfef09e51257f6 dup=true diff=1 bytes=856
```

`docs/desktop/eval/sync-e2e.json` 中 9 项检查全部为 `ok:true`，覆盖上传、幂等、列表、第二版、diff、下载、断开后端、离线上传错误码与离线列表错误码。

### 已知限制

- 生产实例 `221.231.106.194:5556` 从开发机不可达，本节验证只证明 0.22.0 代码在本地临时库上可用，不代表生产已部署。
- 端到端使用 loopback + 临时 SQLite + 最小 GLB 占位文件，不覆盖真实 CAD 几何、生产网络、反向代理/HTTPS 与密钥轮换。
- 该脚本调用真实后端与真实文件系统，故意不纳入 `npm test`/`npm run smoke`；单测仍只打本地 mock。
