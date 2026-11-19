/**
 * 原始装配树回读 + 逐实体身份判定（R12 第 7 类证据的底座）。
 *
 * 为什么单独一个模块：App 的导入路径（`step.ts` 的 `parseOcctBuffer` + `part-naming.ts` 的
 * `readablePartNames`）有两处**正好会抹平身份作弊**的行为 ——
 *   1) `meshPathsFromRoot` 在「网格名 == 节点名」时把叶剥掉（件号就在这一条上丢掉）；
 *   2) `readablePartNames` 把重名件改写成 `-2`，重号件表因此会**假绿**。
 * 所以门禁的回读走这里：直接吃 occt-import-js 的原始 `root` / `meshes`，**保留完整装配路径、
 * 保留原始名字、不重命名、不去重、不合并**。`parseOcctBuffer` 一个字不改（App 导入语义与
 * 既有测试都在它上面）。
 *
 * ── 回读的受限格式契约（写清，不许当成无条件事实）────────────────────────────
 * 本模块的「一 solid 一 mesh」假设**只对 R12 的身份伴生成物**成立：
 *   `bd.Compound(children=placed)`，无布尔、无 fuse，root label=assembly，
 *   每个子节点 label=归一化件号。
 * 实测探针（`~/.hermes/cache/scratch/cad-r12-probe/`，build123d 0.13.0 + 同一份
 * occt-import-js）：
 *   - `compound-named.step`：3 件 → 3 mesh（含 1 件完全被包住件，照样是独立实体）；
 *   - `scale146.step`：146 件 / 154 `MANIFOLD_SOLID_BREP` → **154 mesh、146 个路径叶**；
 *   - `twosolid.step`：1 个两实体件 + 1 个单实体件 → 3 mesh（两个无名、路径叶仍是件号）。
 * 换到普通 STEP（布尔并、B 样条面、reader 因偏折把实体拆成多 mesh）就**不成立**：
 * 因此 `meshCount` 一律叫「回读网格数」，只有在 identity 伴生成物这条受限路径上才与
 * `MANIFOLD_SOLID_BREP` 对照（并且是**双向**对照：文本数 == 回读网格数）。
 *
 * ── 判别力边界（不许升级成「实体认证」）──────────────────────────────────────
 * 这一层是**导出侧身份**：证明「件表里每一件，在 identity STEP 里都有一个具名（装配路径叶
 * 逐字相等）、包络对得上、实体数对得上的实体」。它**不证明**：
 *   - identity.step 与融合制造 STEP 内部拓扑 / 形状等价（两者不是同一个产物，只做包络核对）；
 *   - 材质、面法向、侧车里的 box/cylinder 近似是否真是该件的特征；
 *   - 可制造性。
 * bbox 只是**包络核对**，不是唯一几何指纹。源码级伪造（改 `app.py` 让 label 与几何无关）
 * 仍然能过 —— 守的是「数据放大 / 批造件号 / 丢件 / 把实体从一件搬到另一件 / 贴标签」，
 * 不是「有人改源码」。
 */
import type { OcctModule, OcctNode } from 'occt-import-js';

/** 装配树深度上限：超限即判红（拒绝「截断后当成完整树」的假绿）。 */
export const ENTITY_DEPTH_LIMIT = 64;
/** 逐件非退化下界：三角面数与三轴最小尺寸。 */
export const ENTITY_MIN_TRIANGLES = 12;
export const ENTITY_MIN_EXTENT_MM = 0.1;
/** 逐件包络 / 并集包络默认容差（mm）。 */
export const ENTITY_DEFAULT_TOLERANCE_MM = 1;

/** 与 `step.ts` 同一组三角化参数（同一份产物、同一把尺子）。 */
const STEP_READ_PARAMS: Record<string, unknown> = {
  linearUnit: 'millimeter',
  linearDeflectionType: 'bounding_box_ratio',
  linearDeflection: 0.001,
  angularDeflection: 0.5
};

export interface EntityBBox {
  min: [number, number, number];
  max: [number, number, number];
}

/** 一个**装配节点实例**（不是「一个件号」）的回读事实。 */
export interface StepEntity {
  /** 装配路径（根 → 叶，空名节点跳过）；保留原始顺序与原始名字，不重命名、不去重。 */
  path: string[];
  /** 路径叶 = 件号来源；根层直接挂网格时为 null（判红：无归属）。 */
  leaf: string | null;
  /** 节点原始名（只 trim；不加 `-2` 后缀、不做 decode）。 */
  rawName: string;
  /** 该实例上报的网格数（**回读网格数**，不是无条件的 BRep 实体数，见文件头）。 */
  meshCount: number;
  triangles: number;
  bbox: EntityBBox;
}

export interface ReadStepEntitiesResult {
  /** false = 回读本身不可信（结构错误），不是「件少了」——两者在下游都要红。 */
  ok: boolean;
  /** 非空即红：无归属网格 / 网格被多节点引用 / 坏索引 / NaN / Infinity / 深度截断。 */
  errors: string[];
  entities: StepEntity[];
  /** 回读网格总数（= occt 给的 meshes 数，供与文本实体数对照）。 */
  meshCount: number;
  triangleCount: number;
  /** 全部网格的顶点包络（并集；用于和制造 STEP 的包络核对）。 */
  bbox: EntityBBox | null;
  rootName: string | null;
  depthLimit: number;
}

interface MeshFacts {
  triangles: number;
  bbox: EntityBBox;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyReadback(errors: string[]): ReadStepEntitiesResult {
  return {
    ok: false,
    errors,
    entities: [],
    meshCount: 0,
    triangleCount: 0,
    bbox: null,
    rootName: null,
    depthLimit: ENTITY_DEPTH_LIMIT
  };
}

/**
 * 单个网格的几何事实 + 合法性。
 *
 * 坏 indices / NaN / Infinity 一律收集成错误并返回 null（该节点不产出实体）：
 * 「有限的验证失败即红」——不许让一个含 NaN 的网格悄悄参与包络计算（NaN 会毒化
 * 全部比较，让 `<= tolerance` 恒 false 或恒 true 这种假绿/假红都变得不可解释）。
 */
function meshFactsOf(mesh: unknown, index: number, errors: string[]): MeshFacts | null {
  const raw = mesh as
    | { attributes?: { position?: { array?: unknown } }; index?: { array?: unknown } }
    | null
    | undefined;
  const positions = raw?.attributes?.position?.array;
  if (!Array.isArray(positions) || positions.length === 0 || positions.length % 3 !== 0) {
    errors.push(
      `mesh ${index} 顶点数组非法（长度 ${Array.isArray(positions) ? positions.length : '缺失'}，必须是非空 3 的倍数）`
    );
    return null;
  }
  const vertexCount = positions.length / 3;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let offset = 0; offset + 2 < positions.length; offset += 3) {
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      errors.push(`mesh ${index} 第 ${offset / 3} 个顶点含 NaN/Infinity：不许参与包络核对`);
      return null;
    }
    const fx = Number(x);
    const fy = Number(y);
    const fz = Number(z);
    if (fx < minX) minX = fx;
    if (fy < minY) minY = fy;
    if (fz < minZ) minZ = fz;
    if (fx > maxX) maxX = fx;
    if (fy > maxY) maxY = fy;
    if (fz > maxZ) maxZ = fz;
  }
  const indexArray = raw?.index?.array;
  let triangles: number;
  if (Array.isArray(indexArray) && indexArray.length > 0) {
    if (indexArray.length % 3 !== 0) {
      errors.push(`mesh ${index} 索引数组长度 ${indexArray.length} 不是 3 的倍数（坏 indices）`);
      return null;
    }
    for (let offset = 0; offset < indexArray.length; offset += 1) {
      const value = indexArray[offset];
      if (!Number.isInteger(value) || Number(value) < 0 || Number(value) >= vertexCount) {
        errors.push(
          `mesh ${index} 索引第 ${offset} 项非法（${String(value)}；顶点数 ${vertexCount}）：坏 indices 不许静默丢面`
        );
        return null;
      }
    }
    triangles = indexArray.length / 3;
  } else if (indexArray === undefined || (Array.isArray(indexArray) && indexArray.length === 0)) {
    if (vertexCount % 3 !== 0) {
      errors.push(`mesh ${index} 无索引数组且顶点数 ${vertexCount} 不是 3 的倍数（三角面不完整）`);
      return null;
    }
    triangles = vertexCount / 3;
  } else {
    errors.push(`mesh ${index} 的 index.array 不是数组（${typeof indexArray}）`);
    return null;
  }
  return { triangles, bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } };
}

function unionMeshBox(target: EntityBBox, source: EntityBBox): void {
  for (let axis = 0; axis < 3; axis += 1) {
    const lo = source.min[axis] as number;
    const hi = source.max[axis] as number;
    if (lo < (target.min[axis] as number)) target.min[axis] = lo;
    if (hi > (target.max[axis] as number)) target.max[axis] = hi;
  }
}

/**
 * 同口径网格包络（**制造 STEP 侧专用**）。
 *
 * 为什么不能拿 `readStepEntities` 去读制造 STEP：那条路要的是**身份树**（每个装配节点挂网格、
 * 路径叶=件号）。制造 STEP 是 fuse 之后的一个整机实体，root 下没有逐件节点，路径叶必然为空，
 * 于是「无归属网格」一路判红 —— 那是判据用错了地方，不是文件有问题。所以这里抽出一个**只读**
 * 的包络辅助：只吃 occt-import-js 的原始 `meshes`，不碰节点/名字/归属，结构错误照样 fail-closed。
 *
 * 为什么一定要走这里而不是拓扑顶点包络（C7 真实翻车的原因）：`VERTEX_POINT` 是**拓扑**顶点，
 * 圆柱/回转面上真正的极值点多数不是拓扑顶点（圆柱只有一条缝合线两个点，y 向极值 ±r 一个都不在），
 * 拿它当「制造整体包络」会系统性缩小 19.85mm 量级（16 层真塔实测）。两侧都用同一份回读参数
 * 的**网格**包络，才叫同口径比较。
 *
 * 与 `readStepEntities` 共用 `STEP_READ_PARAMS`（同一把尺子）；两份文件必须用同一个参数对象，
 * 不同参数算出来的三角化偏折不同，比出来的差值就不再是「几何差」。
 */
export interface StepMeshEnvelope {
  /** false = 回读本身不可信（导入失败 / 空网格 / 坏 indices / NaN）：下游必须判红。 */
  ok: boolean;
  errors: string[];
  /** 全部网格顶点包络（并集）；结构错误时为 null。 */
  bbox: EntityBBox | null;
  /** 回读网格数（不是无条件的 BRep 实体数）。 */
  meshCount: number;
  triangleCount: number;
}

export function readStepMeshEnvelope(bytes: Uint8Array, occt: OcctModule): StepMeshEnvelope {
  const envelope: StepMeshEnvelope = { ok: false, errors: [], bbox: null, meshCount: 0, triangleCount: 0 };
  let raw: unknown;
  try {
    raw = occt.ReadStepFile(bytes, STEP_READ_PARAMS);
  } catch (error) {
    envelope.errors.push(`制造 STEP 读入抛错：${describeError(error)}`);
    return envelope;
  }
  const result = raw as { success?: boolean; meshes?: unknown[] } | null | undefined;
  if (!result || result.success !== true) {
    envelope.errors.push('制造 STEP 导入失败（occt-import-js success=false）：窗口两侧就没法同口径比较');
    return envelope;
  }
  const meshes = Array.isArray(result.meshes) ? result.meshes : [];
  envelope.meshCount = meshes.length;
  if (meshes.length === 0) {
    envelope.errors.push('制造 STEP 回读到 0 个网格：空集合不许当「包络一致」');
    return envelope;
  }
  const errors: string[] = [];
  const box: EntityBBox = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity]
  };
  let triangles = 0;
  let meshed = false;
  meshes.forEach((mesh, index) => {
    const fact = meshFactsOf(mesh, index, errors);
    if (!fact) return;
    meshed = true;
    triangles += fact.triangles;
    unionMeshBox(box, fact.bbox);
  });
  envelope.errors = errors;
  envelope.triangleCount = triangles;
  envelope.bbox = meshed ? box : null;
  envelope.ok = errors.length === 0 && meshed;
  return envelope;
}

/**
 * 回读 identity STEP：按**装配节点实例**分组网格。
 *
 * 关键一点：**不能按件号分组**。两个同名兄弟节点（重号件）如果先按名字合并，就会变成
 * 「一个名字挂 2 个网格」，`dup` 永远查不出来 —— 那是本门禁最容易被打穿的地方。
 * 所以每个访问到的节点各自成一个实例（`nodeCount` 自增），路径只用于报告；
 * 重号在下游按叶统计（`matchEntityIdentity` 的 `duplicateIds`）判红。
 */
export function readStepEntities(bytes: Uint8Array, occt: OcctModule): ReadStepEntitiesResult {
  let raw: unknown;
  try {
    raw = occt.ReadStepFile(bytes, STEP_READ_PARAMS);
  } catch (error) {
    return emptyReadback([`STEP 读入抛错：${describeError(error)}`]);
  }
  const result = raw as
    | { success?: boolean; meshes?: unknown[]; root?: OcctNode }
    | null
    | undefined;
  if (!result || result.success !== true) {
    return emptyReadback(['STEP 读入失败（occt-import-js success=false）：坏文件不许当成 0 件通过']);
  }
  const meshes = Array.isArray(result.meshes) ? result.meshes : [];
  if (meshes.length === 0) {
    return emptyReadback(['回读到 0 个网格：空集合不许当通过（`.every` 在空数组上恒真）']);
  }
  const errors: string[] = [];
  const facts: (MeshFacts | null)[] = meshes.map((mesh, index) => meshFactsOf(mesh, index, errors));

  const root = result.root;
  if (!root || typeof root !== 'object') {
    return emptyReadback([...errors, 'occt 没有给出装配根节点（root 缺失）：无法判归属']);
  }

  /** 每个网格的归属节点实例号；null = 没被任何节点引用。 */
  const owner: (number | null)[] = meshes.map(() => null);
  const entities: StepEntity[] = [];
  let nodeCount = 0;
  let truncated = false;

  const walk = (node: OcctNode, ancestors: string[], depth: number): void => {
    if (truncated) return;
    if (depth > ENTITY_DEPTH_LIMIT) {
      truncated = true;
      errors.push(`装配树深度超过 ${ENTITY_DEPTH_LIMIT} 层：拒绝「截断后当成完整树」`);
      return;
    }
    const rawName = typeof node.name === 'string' ? node.name.trim() : '';
    const here = rawName ? [...ancestors, rawName] : ancestors;
    const instance = nodeCount;
    nodeCount += 1;
    const where = here.length > 0 ? here.join('/') : '(根)';
    if (node.meshes !== undefined && !Array.isArray(node.meshes)) {
      errors.push(`节点「${where}」的 meshes 不是数组（${typeof node.meshes}）`);
    }
    const meshIndexes = Array.isArray(node.meshes) ? node.meshes : [];
    if (meshIndexes.length > 0) {
      let triangles = 0;
      let valid = true;
      let used = 0;
      const seen = new Set<number>();
      const box: EntityBBox = {
        min: [Infinity, Infinity, Infinity],
        max: [-Infinity, -Infinity, -Infinity]
      };
      for (const value of meshIndexes) {
        if (!Number.isInteger(value) || Number(value) < 0 || Number(value) >= meshes.length) {
          errors.push(`节点「${where}」引用了不存在的 mesh ${String(value)}（共 ${meshes.length} 个）`);
          valid = false;
          continue;
        }
        const index = Number(value);
        if (seen.has(index)) {
          errors.push(`节点「${where}」重复引用 mesh ${index}：同一网格算两次=实体数放大`);
          valid = false;
          continue;
        }
        seen.add(index);
        const previous = owner[index];
        if (previous !== null && previous !== instance) {
          errors.push(
            `mesh ${index} 被多个装配节点引用（节点实例 ${previous} 与 ${instance}，路径「${where}」）：` +
              '一条网格挂两个件号，不许先合并'
          );
          valid = false;
          continue;
        }
        owner[index] = instance;
        used += 1;
        const fact = facts[index];
        if (!fact) {
          valid = false;
          continue;
        }
        triangles += fact.triangles;
        unionMeshBox(box, fact.bbox);
      }
      if (valid && used > 0) {
        entities.push({
          path: here,
          leaf: here.length > 0 ? (here[here.length - 1] as string) : null,
          rawName,
          meshCount: used,
          triangles,
          bbox: box
        });
      }
    }
    const children = Array.isArray(node.children) ? node.children : [];
    if (node.children !== undefined && !Array.isArray(node.children)) {
      errors.push(`节点「${where}」的 children 不是数组（${typeof node.children}）`);
    }
    for (const child of children) walk(child, here, depth + 1);
  };

  walk(root, [], 0);

  const unowned: number[] = [];
  owner.forEach((value, index) => {
    if (value === null) unowned.push(index);
  });
  if (unowned.length > 0) {
    const head = unowned.slice(0, 8).join(',');
    errors.push(
      `${unowned.length} 个网格没有装配归属（mesh ${head}${unowned.length > 8 ? '…' : ''}）：` +
        '无名网格不许当成件，也不许静默丢弃'
    );
  }

  const globalBox: EntityBBox = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity]
  };
  let triangleCount = 0;
  let meshed = false;
  for (const fact of facts) {
    if (!fact) continue;
    meshed = true;
    triangleCount += fact.triangles;
    unionMeshBox(globalBox, fact.bbox);
  }

  return {
    ok: errors.length === 0,
    errors,
    entities,
    meshCount: meshes.length,
    triangleCount,
    bbox: meshed ? globalBox : null,
    rootName: typeof root.name === 'string' && root.name.trim() ? root.name.trim() : null,
    depthLimit: ENTITY_DEPTH_LIMIT
  };
}

// ---------------------------------------------------------------------------
// 纯文本证据：PRODUCT 名（C8 防污染）与 MANIFOLD_SOLID_BREP 计数（不信自报数字）
// ---------------------------------------------------------------------------

/**
 * 解 STEP 字符串里的转义（`\X2\<UTF-16BE hex>\X0\`、`\X4\<hex>\X0\`、`\S\c`、`\X\hh`）。
 *
 * 为什么必须解：OCCT 对非 ASCII 名会写成 `\X2\4F3A670D7535673A\X0\_400W`（kinematics 夹具
 * 实证）。不解就等于「中文名永远不参与比较」—— C8（制造件不许带件号）与重名检查都会被
 * 一串转义绕过。注意这是**文本侧**的保守解码，只用于名字集合比较，不用于几何。
 */
export function decodeStepString(value: string): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value
    .replace(/\\X2\\([0-9A-Fa-f]*)\\X0\\/g, (_match, hex: string) => {
      let out = '';
      for (let index = 0; index + 4 <= hex.length; index += 4) {
        out += String.fromCharCode(Number.parseInt(hex.slice(index, index + 4), 16));
      }
      return out;
    })
    .replace(/\\X4\\([0-9A-Fa-f]*)\\X0\\/g, (_match, hex: string) => {
      let out = '';
      for (let index = 0; index + 8 <= hex.length; index += 8) {
        const code = Number.parseInt(hex.slice(index, index + 8), 16);
        if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) out += String.fromCodePoint(code);
      }
      return out;
    })
    .replace(/\\S\\(.)/g, (_match, char: string) => String.fromCharCode(char.charCodeAt(0) + 128))
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/**
 * 读 STEP 文本里所有 `PRODUCT('name', …)` 的名字（**解码后**）。
 *
 * 只匹配 `PRODUCT(` 后面紧跟引号的形式：`PRODUCT_DEFINITION(` / `PRODUCT_CONTEXT(` 等
 * 不会被吞进来（名字只在 PRODUCT 行）。子装配名也在里面 —— C8 只要「制造件里出现了件号」
 * 这一件事，多收一层父名不影响判据方向（出现即红）。
 */
export function readStepProductNames(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const names: string[] = [];
  const pattern = /\bPRODUCT\s*\(\s*'((?:[^']|'')*)'\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = (match[1] ?? '').replace(/''/g, "'");
    const decoded = decodeStepString(raw).trim();
    if (decoded) names.push(decoded);
  }
  return names;
}

/** `MANIFOLD_SOLID_BREP` 实体数（读回文件本身，不信回执自报的 products/solids）。 */
export function readStepManifoldSolidCount(text: string): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const pattern = /^\s*#\d+\s*=\s*MANIFOLD_SOLID_BREP\s*\(/gm;
  let count = 0;
  while (pattern.exec(text) !== null) count += 1;
  return count;
}

// ---------------------------------------------------------------------------
// 逐实体身份判定（C1~C8，纯函数）
// ---------------------------------------------------------------------------

export interface EntityIdentityPartInput {
  id?: unknown;
  bboxMin?: unknown;
  bboxMax?: unknown;
  solids?: unknown;
}

export interface EntityIdentityFacts {
  /** 构建时**真实目标件表**的件号（`buildBufferTowerParts` / `buildConveyorParts` 的 `part.id`）。 */
  partTableIds: readonly string[];
  /** `/build` 回执的 `files.parts[]` 原样（id / bboxMin / bboxMax / solids）。 */
  parts: readonly unknown[];
  /** `readStepEntities()` 的回读结果（identity.step 的真实 bytes）。 */
  readback: ReadStepEntitiesResult;
  /** identity.step 文本里的 `MANIFOLD_SOLID_BREP` 计数（读回文件，不信自报）。 */
  identitySolids: number | null;
  /** 内核 `stats.partSolids`（逐件实体合计的自报值，只用来交叉核对）。 */
  partSolids: number | null;
  /**
   * 制造 STEP 的**同口径网格包络**（`readStepMeshEnvelope`，与 identity 同一份 occt 回读参数）。
   *
   * C7 修复点：以前这里传的是 `evaluateStepTower().stepBox`（拓扑 `VERTEX_POINT` 包络）。
   * 圆柱/回转面的极值点大多不是拓扑顶点，那条口径会把制造包络缩小一个半径量级（16 层真塔
   * y 差 19.85mm）。**不许**再把拓扑顶点包络当制造整体曲面包络传进来。
   */
  mergedBBox: { min: readonly number[]; max: readonly number[] } | null;
  /** 制造 STEP 回读的结构错误（非空即红：导入失败 / 空网格 / 坏 indices / NaN）。 */
  mergedReadbackErrors?: readonly string[];
  /** 制造 STEP 回读网格数（只报告，不参与判定）。 */
  mergedReadbackMeshCount?: number | null;
  /**
   * 制造 STEP 的拓扑 `VERTEX_POINT` 包络（旧口径）。**只作参考写进 JSON**，不参与判定 ——
   * 留着它就是为了让「旧口径 vs 同口径」的差值一眼可见，而不是悄悄消失。
   */
  mergedVertexPointBBox?: { min: readonly number[]; max: readonly number[] } | null;
  /** 制造 STEP 的 PRODUCT 名（`readStepProductNames`，已 decode）。 */
  mergedProductNames: readonly string[];
  /** `files.identity.path`（原样，未 resolve）。 */
  identityPath: string | null;
  /** `files.step.path`（原样）。 */
  stepPath: string | null;
  /**
   * `realpathSync` 之后的真实路径（调用方解析；本模块不引 `node:fs`）。
   *
   * 只比字符串会同时出错在两个方向（review P1-2）：符号链接的 identity 实际在**别的目录**时
   * `sameDir` 仍然 true；软链指回制造 STEP 时「≠ 自身」也拦不住；反过来 `plain/./identity.step`
   * 又是假红。所以归属判定优先用真实路径，字符串只做兜底。
   */
  identityRealPath?: string | null;
  stepRealPath?: string | null;
  /**
   * identity 路径本身是不是符号链接（`lstatSync().isSymbolicLink()`）。true 即红：
   * 真实归属不可信 —— 拒绝「软链越界 / 软链指回制造 STEP」这类绕法。
   */
  identityPathIsSymlink?: boolean | null;
  /** identity 文件**实际**字节数（脚本 stat/read 得到的，不是回执自报）。 */
  identityBytes: number;
  toleranceMm?: number | undefined;
}

export interface EntityIdentityCheck {
  label: string;
  ok: boolean;
  expected: string;
  actual: string;
  note?: string;
}

export interface EntityIdentitySummary {
  applicable: true;
  ok: boolean;
  expectedParts: number;
  actualParts: number;
  expectedSolids: number | null;
  actualSolids: number | null;
  meshCount: number;
  /** identity 侧实际生效容差（固定 1mm 上限，与 CLI --tolerance 解耦）。 */
  toleranceMm: number;
  /** 容差来源：fixed / tightened（调用方更紧）/ capped（调用方想放大，被钉回 1mm）。 */
  tolerancePolicy: 'fixed' | 'tightened' | 'capped';
  /** 调用方传入的容差原值（未传 = null）。 */
  requestedToleranceMm: number | null;
  /** 容差本身非法时的原因（非空即红）。 */
  toleranceError: string | null;
  /** identity 侧的网格包络（同口径两侧之一）。 */
  identityBBox: { min: [number, number, number]; max: [number, number, number] } | null;
  /** 制造 STEP 侧的**同口径网格包络**（occt 回读，与 identity 同一份参数）。 */
  mergedReadbackBBox: { min: [number, number, number]; max: [number, number, number] } | null;
  /** 制造 STEP 的拓扑 `VERTEX_POINT` 包络（旧口径，仅参考：不参与判定）。 */
  mergedVertexPointBBox: { min: [number, number, number]; max: [number, number, number] } | null;
  /** 制造 STEP 回读网格数（只报告）。 */
  mergedReadbackMeshCount: number | null;
  /** 制造 STEP 回读失败原因（空数组 = 回读正常）。 */
  mergedReadbackErrors: string[];
  unionDeltaMm: [number, number, number] | null;
  bboxMaxDeltaMm: number | null;
  missingIds: string[];
  unknownIds: string[];
  duplicateIds: string[];
  invalidIds: string[];
  perPartSolidsMismatch: { id: string; expected: number; actual: number }[];
  bboxMismatches: { id: string; axis: number; delta: number }[];
  degenerate: string[];
  pollutionIds: string[];
  sameDir: boolean | null;
  readbackErrors: string[];
  boundaries: string[];
}

export interface EntityIdentityResult {
  ok: boolean;
  checks: EntityIdentityCheck[];
  entityIdentity: EntityIdentitySummary;
}

/**
 * 残余能力与判别力边界：**逐字**进回执与 JSON。
 * 不许因为这些字符串就声称「制造认证 / 逐实体拓扑认证 / 几何等价」。
 */
export const ENTITY_IDENTITY_BOUNDARIES: readonly string[] = Object.freeze([
  '只证明「件表里每一件在 identity.step 里有一个具名、包络与实体数都对得上的实体」，是导出侧身份，不是制造认证',
  '不证明 identity.step 与融合制造 STEP 内部拓扑或形状等价：两者不是同一产物，只做包络（±容差）核对',
  '包络核对是同口径网格包络（两份文件同一份 occt 回读参数）；拓扑 VERTEX_POINT 包络不能当制造整体曲面包络（曲面上多数极值点不是拓扑顶点）',
  'bbox 只是包络核对，不是唯一几何指纹；同包络不同内部结构仍可全绿',
  'meshCount 视为实体数只在受限格式成立（compound、无布尔、root label=assembly、每节点 label=件号；实测一 solid 一 mesh），普通 STEP 不成立',
  '不认证材质/面法向/侧车 box·cylinder 近似是否真是该件特征，也不认证可制造性',
  '源码级伪造（改导出侧让 label 与几何无关）仍可过：守的是数据放大/批造件号/丢件/实体搬家/贴标签'
]);

function finiteVector3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isFinite(item)) return null;
    out.push(item);
  }
  return [out[0] as number, out[1] as number, out[2] as number];
}

/**
 * 纯字符串路径规范化：折叠 `./`、`//`、`a/../`，统一分隔符。
 *
 * 为什么需要：`plain/./identity.step` 与 `plain/identity.step` 是同一个文件，字符串直比会假红
 * （review E6）。真正的归属判断靠调用方给的 realpath（`identityRealPath` / `stepRealPath`）；
 * 这里的规范化只是没有 realpath 时的兜底，**不能**替代 softlink 检测。
 */
export function normalizeStepPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) return '';
  const raw = path.replace(/\\/g, '/');
  const absolute = raw.startsWith('/');
  const out: string[] = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  const joined = out.join('/');
  if (absolute) return `/${joined}`.replace(/\/+$/, '') || '/';
  return joined || '.';
}

/** 纯字符串的父目录（不引 `node:path`：本模块要能在渲染进程/测试里跑）。 */
function parentOf(path: string): string {
  const normalized = normalizeStepPath(path);
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return index === 0 ? '/' : '';
  return normalized.slice(0, index);
}

/**
 * 身份门禁的固定容差（mm）。
 *
 * 合同要求「逐件 bbox ≤ 1mm、不放宽」，而 CLI 的 `--tolerance` 同时服务旧判据（顶点并集那条
 * 本来就有按轴 20mm 的回转体外扩）。把 CLI 值直接递给身份判据等于给了一条「假修」后门
 * （review E10：`--tolerance 20` 能把 19.85mm 的口径差判绿）。所以身份判据**自持**这个常量：
 * 只许收紧，不许放大。
 */
export const ENTITY_IDENTITY_TOLERANCE_MM = 1;

export interface IdentityTolerance {
  /** 实际生效的容差（0 ≤ value ≤ 1）。 */
  value: number;
  /** `fixed` = 没传；`tightened` = 调用方要求更紧；`capped` = 调用方想放大，被钉回 1mm。 */
  policy: 'fixed' | 'tightened' | 'capped';
  /** 非空 = 容差本身非法（NaN/Infinity/负数/非数字）：下游必须判红，不许兜底成绿。 */
  error: string | null;
  /** 调用方原样传进来的值（给回执对账）。 */
  requested: number | null;
}

/**
 * 解算身份判据容差：非法值一律**判红**（不静默退回 1mm 冒充通过），超 1mm 一律钉回 1mm。
 */
export function resolveIdentityTolerance(requested: unknown): IdentityTolerance {
  if (requested === undefined || requested === null) {
    return { value: ENTITY_IDENTITY_TOLERANCE_MM, policy: 'fixed', error: null, requested: null };
  }
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    const shown = typeof requested === 'number' ? String(requested) : typeof requested;
    return {
      value: ENTITY_IDENTITY_TOLERANCE_MM,
      policy: 'fixed',
      error: `身份判据容差非法（${shown}）：NaN/Infinity/非数字一律判红，不许兜底成 1mm 假绿`,
      requested: typeof requested === 'number' ? requested : null
    };
  }
  if (requested < 0) {
    return {
      value: ENTITY_IDENTITY_TOLERANCE_MM,
      policy: 'fixed',
      error: `身份判据容差为负（${requested}）：阈值必须有限非负，一律判红`,
      requested
    };
  }
  if (requested > ENTITY_IDENTITY_TOLERANCE_MM) {
    return { value: ENTITY_IDENTITY_TOLERANCE_MM, policy: 'capped', error: null, requested };
  }
  return {
    value: requested,
    policy: requested < ENTITY_IDENTITY_TOLERANCE_MM ? 'tightened' : 'fixed',
    error: null,
    requested
  };
}

interface ParsedExpected {
  id: string;
  solids: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}

function parseExpectedParts(parts: readonly unknown[]): {
  list: ParsedExpected[];
  invalid: string[];
  duplicateIds: string[];
  ids: string[];
} {
  const list: ParsedExpected[] = [];
  const invalid: string[] = [];
  const seen = new Map<string, number>();
  const duplicateIds: string[] = [];
  parts.forEach((entry, index) => {
    const item = (entry ?? {}) as EntityIdentityPartInput;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const solids = typeof item.solids === 'number' && Number.isInteger(item.solids) && item.solids > 0
      ? item.solids
      : null;
    const min = finiteVector3(item.bboxMin);
    const max = finiteVector3(item.bboxMax);
    if (!id) {
      invalid.push(`parts[${index}] 件号为空/非字符串（${JSON.stringify(item.id)}）`);
      return;
    }
    if (solids === null) {
      invalid.push(`${id} solids 不是正整数（${JSON.stringify(item.solids)}）`);
      return;
    }
    if (!min || !max) {
      invalid.push(`${id} bboxMin/bboxMax 不是有限三维向量`);
      return;
    }
    for (let axis = 0; axis < 3; axis += 1) {
      if ((max[axis] as number) < (min[axis] as number)) {
        invalid.push(`${id} bbox 轴 ${'xyz'[axis]} 的 max < min`);
        return;
      }
    }
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    if (count === 2) duplicateIds.push(id);
    list.push({ id, solids, bboxMin: min, bboxMax: max });
  });
  return { list, invalid, duplicateIds, ids: list.map((item) => item.id) };
}

function formatDelta(value: number | null): string {
  return value === null ? '(未算)' : `${value.toFixed(2)}mm`;
}

/**
 * 逐实体身份判定（C1~C8）。纯函数：**所有**输入显式传入，能从回执 + 真实文件复算。
 *
 * 4 条 check（与既有 `printChecks` 同形，任一红即整条身份判红）：
 *   1) 身份伴生成物：同目录、非制造 STEP 自身、实际 bytes>0、回读无结构错误、
 *      文本实体数 == 回读网格数（受限格式）；
 *   2) 件号集合：**件表 / `files.parts[]` / 回读路径叶**三方严格相等，
 *      missing / unknown / dup / 非法值全为 0（空集合一律判红）；
 *   3) 逐件实体与包络：总实体 == 逐件合计 == `stats.partSolids`，逐件
 *      `meshCount == kernelSolids`（防「实体从一件搬到另一件、总数不变」），
 *      逐件包络每轴 ≤ 容差，且非退化（三角数 / 三轴尺寸）；
 *   4) 并集与污染：identity **网格包络** == 制造 STEP 的**同口径网格包络**（两侧都是
 *      occt-import-js 回读，同一份 `STEP_READ_PARAMS`，每轴 ≤ 容差；制造侧导入失败即红）+
 *      制造 STEP 的 PRODUCT 名不许出现任何件号（C8，fuse 会继承 `parts[0].label`）。
 *
 * 为什么第 4 条必须同口径：制造侧的极值常常落在曲面（圆柱/回转体）上，而 `VERTEX_POINT` 是
 * **拓扑**顶点，圆柱只有缝合线上两个点，y 向极值 ±r 一个都不在。旧实现拿拓扑包络当制造整体
 * 包络，等于拿一把短尺量圆 —— 16 层真塔因此 y 差 19.85mm（正好一个半径），被误判为红。
 * 现在两侧都过 occt 回读（`readStepMeshEnvelope` / `readStepEntities`），容差仍是 1mm 不放宽。
 *
 * 为什么把「件表」也当输入：`files.parts[]` 是**内核自报**，拿它既当 expected 又当 actual
 * 等于自比较。目标件号集合必须来自构建时的真实件表，三方对不上就红（少件、多件、改名都现形）。
 */
export function matchEntityIdentity(facts: EntityIdentityFacts): EntityIdentityResult {
  const tolerances = resolveIdentityTolerance(facts.toleranceMm);
  const tolerance = tolerances.value;
  const readback = facts.readback;
  const readbackErrors = Array.isArray(readback?.errors) ? readback.errors : [];
  const entities = Array.isArray(readback?.entities) ? readback.entities : [];

  // ---- 期望件集合：真实件表 + files.parts[] 严格交叉（不接受只有一边）----
  const tableIds = Array.isArray(facts.partTableIds)
    ? facts.partTableIds.filter((id): id is string => typeof id === 'string').map((id) => id)
    : [];
  const tableSeen = new Map<string, number>();
  const tableDuplicates: string[] = [];
  const tableInvalid: string[] = [];
  for (const id of tableIds) {
    const trimmed = id.trim();
    if (!trimmed) {
      tableInvalid.push('件表里有空件号');
      continue;
    }
    const count = (tableSeen.get(trimmed) ?? 0) + 1;
    tableSeen.set(trimmed, count);
    if (count === 2) tableDuplicates.push(trimmed);
  }
  const tableSet = new Set(tableSeen.keys());

  const parsed = parseExpectedParts(Array.isArray(facts.parts) ? facts.parts : []);
  const partsSet = new Set(parsed.ids);

  const missingInParts: string[] = [];
  tableSet.forEach((id) => {
    if (!partsSet.has(id)) missingInParts.push(id);
  });
  const unknownInParts: string[] = [];
  partsSet.forEach((id) => {
    if (!tableSet.has(id)) unknownInParts.push(id);
  });

  // ---- 回读侧：路径叶（保留原始名，不合并、不改名）----
  const leafCounts = new Map<string, number>();
  const unownedEntities: string[] = [];
  for (const entity of entities) {
    const leaf = typeof entity?.leaf === 'string' ? entity.leaf.trim() : '';
    if (!leaf) {
      unownedEntities.push(entity?.path?.join('/') ?? '(未知)');
      continue;
    }
    leafCounts.set(leaf, (leafCounts.get(leaf) ?? 0) + 1);
  }
  // 重号按**叶出现次数**算：两个同名节点各自成实例，绝不先按件号合并（合并就查不出 dup）
  const duplicateIds: string[] = [];
  leafCounts.forEach((count, id) => {
    if (count > 1) duplicateIds.push(id);
  });
  const missingInReadback: string[] = [];
  const expectedListForCoverage = parsed.list;
  for (const item of expectedListForCoverage) {
    if (!leafCounts.has(item.id)) missingInReadback.push(item.id);
  }
  const unknownInReadback: string[] = [];
  leafCounts.forEach((_count, id) => {
    if (!partsSet.has(id)) unknownInReadback.push(id);
  });
  const idToEntity = new Map<string, StepEntity>();
  for (const entity of entities) {
    const leaf = typeof entity?.leaf === 'string' ? entity.leaf.trim() : '';
    if (leaf && !idToEntity.has(leaf)) idToEntity.set(leaf, entity);
  }

  const expectedParts = tableSet.size;
  const declaredSolids = parsed.list.length === parsed.ids.length && parsed.list.length > 0
    ? parsed.list.reduce((sum, item) => sum + item.solids, 0)
    : null;
  const identitySolids = typeof facts.identitySolids === 'number' && Number.isInteger(facts.identitySolids)
    ? facts.identitySolids
    : null;
  const partSolids = typeof facts.partSolids === 'number' && Number.isInteger(facts.partSolids)
    ? facts.partSolids
    : null;

  // ---- 逐件：实体数（受限格式）+ 包络 + 非退化 ----
  const perPartSolidsMismatch: { id: string; expected: number; actual: number }[] = [];
  const bboxMismatches: { id: string; axis: number; delta: number }[] = [];
  const degenerate: string[] = [];
  let bboxMaxDeltaMm: number | null = null;
  let comparableParts = 0;
  let sawNonFiniteDelta = false;
  let maxDeltaSeen = -Infinity;
  for (const item of parsed.list) {
    const entity = idToEntity.get(item.id);
    if (!entity) continue; // 缺件由「件号集合」那一条点名，不在这里重复
    comparableParts += 1;
    if (entity.meshCount !== item.solids) {
      perPartSolidsMismatch.push({ id: item.id, expected: item.solids, actual: entity.meshCount });
    }
    if (!(entity.triangles >= ENTITY_MIN_TRIANGLES)) degenerate.push(`${item.id}(三角数 ${entity.triangles})`);
    for (let axis = 0; axis < 3; axis += 1) {
      const extent = (entity.bbox.max[axis] as number) - (entity.bbox.min[axis] as number);
      if (!Number.isFinite(extent) || extent <= ENTITY_MIN_EXTENT_MM) {
        degenerate.push(`${item.id}(${'xyz'[axis]} 尺寸 ${Number.isFinite(extent) ? extent.toFixed(3) : 'NaN'}mm)`);
      }
      const lowDelta = Math.abs((entity.bbox.min[axis] as number) - (item.bboxMin[axis] as number));
      const highDelta = Math.abs((entity.bbox.max[axis] as number) - (item.bboxMax[axis] as number));
      const delta = Math.max(lowDelta, highDelta);
      if (Number.isFinite(delta)) {
        if (delta > maxDeltaSeen) maxDeltaSeen = delta;
      } else {
        sawNonFiniteDelta = true;
      }
      if (!Number.isFinite(delta) || delta > tolerance + 1e-6) {
        bboxMismatches.push({ id: item.id, axis, delta: Number.isFinite(delta) ? delta : Number.NaN });
      }
    }
  }
  // 有可比对件就必须给出数（0.00 是「完全吻合」，不是「没算」）；NaN 一律不冒充数字
  if (comparableParts > 0) {
    bboxMaxDeltaMm = sawNonFiniteDelta ? null : (Number.isFinite(maxDeltaSeen) ? maxDeltaSeen : null);
  }

  // ---- 并集：identity 网格包络 vs 制造 STEP 的**同口径**网格包络 ----
  // 两边都是 occt-import-js 回读出来的网格顶点包络（同一份 STEP_READ_PARAMS）。
  // 旧实现拿制造 STEP 的拓扑 VERTEX_POINT 包络比：圆柱/回转面的真极值点不是拓扑顶点，
  // 制造侧会被系统性缩小一个半径量级（16 层真塔 y 差 19.85mm = 圆柱半径）。容差仍是 1mm。
  const identityBox = readback?.bbox ?? null;
  const mergedMin = finiteVector3(facts.mergedBBox?.min);
  const mergedMax = finiteVector3(facts.mergedBBox?.max);
  const mergedErrors = Array.isArray(facts.mergedReadbackErrors)
    ? facts.mergedReadbackErrors.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
  const mergedReadbackMeshCount = typeof facts.mergedReadbackMeshCount === 'number'
    && Number.isInteger(facts.mergedReadbackMeshCount)
    ? facts.mergedReadbackMeshCount
    : null;
  let unionDeltaMm: [number, number, number] | null = null;
  let unionWithinTolerance: boolean | null = null;
  if (identityBox && mergedMin && mergedMax) {
    const deltas: [number, number, number] = [0, 0, 0];
    let within = true;
    for (let axis = 0; axis < 3; axis += 1) {
      const delta = Math.max(
        Math.abs((identityBox.min[axis] as number) - (mergedMin[axis] as number)),
        Math.abs((identityBox.max[axis] as number) - (mergedMax[axis] as number))
      );
      deltas[axis] = Number.isFinite(delta) ? delta : Number.NaN;
      if (!Number.isFinite(delta) || delta > tolerance + 1e-6) within = false;
    }
    unionDeltaMm = deltas;
    unionWithinTolerance = within;
  }

  // ---- C8：制造件不许带任何件号（含解码后的中文名；fuse 会继承 parts[0].label）----
  const mergedNames = Array.isArray(facts.mergedProductNames)
    ? facts.mergedProductNames.filter((name): name is string => typeof name === 'string')
    : [];
  const pollution = new Set<string>();
  for (const name of mergedNames) {
    const trimmed = name.trim();
    if (trimmed && partsSet.has(trimmed)) pollution.add(trimmed);
    else if (trimmed && tableSet.has(trimmed)) pollution.add(trimmed);
  }
  const pollutionIds = [...pollution];

  // ---- 路径归属（真实路径优先；同目录 / 不许指向制造件自身 / 不许是软链）----
  const identityPath = typeof facts.identityPath === 'string' && facts.identityPath.trim() ? facts.identityPath.trim() : null;
  const stepPath = typeof facts.stepPath === 'string' && facts.stepPath.trim() ? facts.stepPath.trim() : null;
  const identityReal = typeof facts.identityRealPath === 'string' && facts.identityRealPath.trim()
    ? normalizeStepPath(facts.identityRealPath.trim())
    : (identityPath !== null ? normalizeStepPath(identityPath) : null);
  const stepReal = typeof facts.stepRealPath === 'string' && facts.stepRealPath.trim()
    ? normalizeStepPath(facts.stepRealPath.trim())
    : (stepPath !== null ? normalizeStepPath(stepPath) : null);
  const sameDir = identityReal !== null && stepReal !== null ? parentOf(identityReal) === parentOf(stepReal) : null;
  const aliasOfStep = identityReal !== null && stepReal !== null && identityReal === stepReal;
  const identityIsSymlink = facts.identityPathIsSymlink === true;

  // ------------------------------------------------ check 1：产物与回读完整性
  const artifactProblems: string[] = [];
  if (identityPath === null) artifactProblems.push('缺 files.identity（内核没导出身份件：旧内核/未请求 identityStep）');
  if (stepPath === null) artifactProblems.push('缺 files.step.path');
  if (identityPath !== null && stepPath !== null) {
    if (sameDir !== true) {
      artifactProblems.push(
        `不同目录（真实路径 identity=${parentOf(identityReal ?? '') || '(空)'} step=${parentOf(stepReal ?? '') || '(空)'}）`
      );
    }
    if (aliasOfStep) artifactProblems.push('identity 真实路径就是制造 STEP 自身（软链/别名指向自身不算产物）');
  }
  if (identityIsSymlink) {
    artifactProblems.push('identity 路径是符号链接（真实归属不可信）：拒绝软链越界与软链指回制造 STEP');
  }
  if (!Number.isFinite(facts.identityBytes) || facts.identityBytes <= 0) {
    artifactProblems.push(`实际字节数非法（${String(facts.identityBytes)}）`);
  }
  if (readback?.ok !== true) artifactProblems.push(`回读不可信：${readbackErrors.slice(0, 3).join('；') || 'ok!=true'}`);
  if (readbackErrors.length > 0) artifactProblems.push(`回读结构错误 ${readbackErrors.length} 条`);
  if (entities.length === 0) artifactProblems.push('回读得到 0 个装配节点实体');
  // 结构性守卫：分组后逐节点网格数之和必须等于回读网格数。文本实体数==回读网格数是**传递**
  // 闭包（靠 check3 的逐件合计兜），一旦重构让分组丢/多算网格，闭包会同时断；这里直接钉死。
  const entityMeshSum = entities.reduce((sum, entity) => (
    Number.isInteger(entity?.meshCount) && Number(entity.meshCount) > 0 ? sum + Number(entity.meshCount) : sum
  ), 0);
  if (entityMeshSum !== readback.meshCount) {
    artifactProblems.push(
      `Σ节点网格数 ${entityMeshSum} ≠ 回读网格数 ${readback.meshCount}（分组丢了/多算了网格）`
    );
  }
  if (identitySolids === null) artifactProblems.push(`文本实体数不可解析（${String(facts.identitySolids)}）`);
  if (identitySolids !== null && identitySolids !== readback.meshCount) {
    artifactProblems.push(`文本实体数 ${identitySolids} ≠ 回读网格数 ${readback.meshCount}（回读漏/多了网格）`);
  }
  const artifactOk = artifactProblems.length === 0;

  // ------------------------------------------------ check 2：件号集合（三方）
  const setProblems: string[] = [];
  // 回读结构不可信时，任何「集合相等」都不成立：宁可四条一起红，也不让坏回读换一条绿
  if (readback?.ok !== true) setProblems.push('回读不可信（结构错误），件号集合判不了');
  if (expectedParts === 0) setProblems.push('期望件号为空集合（空集合 .every 恒真，一律判红）');
  if (tableInvalid.length > 0) setProblems.push(`件表非法 ${tableInvalid.length} 条`);
  if (tableDuplicates.length > 0) setProblems.push(`件表重号 ${tableDuplicates.slice(0, 3).join(',')}`);
  if (parsed.invalid.length > 0) setProblems.push(`files.parts[] 非法 ${parsed.invalid.length} 条（${parsed.invalid.slice(0, 2).join('；')}）`);
  if (parsed.duplicateIds.length > 0) setProblems.push(`files.parts[] 重号 ${parsed.duplicateIds.slice(0, 3).join(',')}`);
  if (missingInParts.length > 0) setProblems.push(`件表有、files.parts[] 无：${missingInParts.slice(0, 4).join(',')}`);
  if (unknownInParts.length > 0) setProblems.push(`files.parts[] 有、件表无：${unknownInParts.slice(0, 4).join(',')}`);
  if (unownedEntities.length > 0) setProblems.push(`回读有 ${unownedEntities.length} 个实体无件号叶`);
  if (duplicateIds.length > 0) setProblems.push(`回读叶重号 ${duplicateIds.slice(0, 3).join(',')}`);
  if (missingInReadback.length > 0) setProblems.push(`回读缺件 ${missingInReadback.slice(0, 4).join(',')}`);
  if (unknownInReadback.length > 0) setProblems.push(`回读多出未知件 ${unknownInReadback.slice(0, 4).join(',')}`);
  const setOk = setProblems.length === 0;

  // ------------------------------------------------ check 3：逐件实体 + 包络 + 非退化
  const perPartProblems: string[] = [];
  if (tolerances.error) perPartProblems.push(tolerances.error);
  if (readback?.ok !== true) perPartProblems.push('回读不可信（结构错误），逐件实体与包络判不了');
  if (parsed.list.length === 0) perPartProblems.push('没有可比对的期望件（空集合）');
  if (declaredSolids === null) perPartProblems.push('逐件 solids 缺失/非法（不许按 1 计）');
  if (partSolids === null) perPartProblems.push(`stats.partSolids 缺失/非法（${String(facts.partSolids)}）`);
  if (declaredSolids !== null && partSolids !== null && declaredSolids !== partSolids) {
    perPartProblems.push(`逐件合计 ${declaredSolids} ≠ stats.partSolids ${partSolids}`);
  }
  if (identitySolids !== null && declaredSolids !== null && identitySolids !== declaredSolids) {
    perPartProblems.push(`文本实体数 ${identitySolids} ≠ 逐件合计 ${declaredSolids}`);
  }
  if (perPartSolidsMismatch.length > 0) {
    perPartProblems.push(
      `逐件实体数不等 ${perPartSolidsMismatch.length} 件（${perPartSolidsMismatch
        .slice(0, 3)
        .map((item) => `${item.id} 期望 ${item.expected}/回读 ${item.actual}`)
        .join('；')}）`
    );
  }
  if (degenerate.length > 0) perPartProblems.push(`退化 ${degenerate.length} 处（${degenerate.slice(0, 3).join('；')}）`);
  if (bboxMismatches.length > 0) {
    perPartProblems.push(
      `包络超差 ${bboxMismatches.length} 处（${bboxMismatches
        .slice(0, 3)
        .map((item) => `${item.id} ${'xyz'[item.axis]} ${formatDelta(item.delta)}`)
        .join('；')}）`
    );
  }
  const perPartOk = perPartProblems.length === 0;

  // ------------------------------------------------ check 4：并集（同口径）+ 制造件污染
  const unionProblems: string[] = [];
  if (tolerances.error) unionProblems.push(tolerances.error);
  if (readback?.ok !== true) unionProblems.push('回读不可信（结构错误），并集核对判不了');
  if (mergedErrors.length > 0) {
    unionProblems.push(`制造 STEP 同口径回读失败：${mergedErrors.slice(0, 2).join('；')}`);
  }
  if (unionDeltaMm === null) {
    unionProblems.push(
      mergedErrors.length > 0
        ? '制造 STEP 导入/回读失败，没有可比的包络（缺边即红，不退回拓扑顶点包络）'
        : '并集缺一边（identity 网格包络或制造 STEP 同口径网格包络为 null）'
    );
  } else if (unionWithinTolerance !== true) {
    unionProblems.push(`并集超差 Δ=${unionDeltaMm.map((value) => formatDelta(value)).join('/')}`);
  }
  if (expectedParts === 0) unionProblems.push('件号集合为空，污染判据无意义');
  if (pollutionIds.length > 0) unionProblems.push(`制造 STEP 出现件号 ${pollutionIds.slice(0, 3).join(',')}（贴标签/污染）`);
  const unionOk = unionProblems.length === 0;

  const checks: EntityIdentityCheck[] = [
    {
      label: '身份伴生成物（entityIdentity）',
      ok: artifactOk,
      expected: 'files.identity 与制造 STEP 同目录、≠制造 STEP 自身、实际 bytes>0、回读无结构错误、文本实体数==回读网格数',
      actual: artifactOk
        ? `同目录、bytes=${facts.identityBytes}、回读网格=${readback.meshCount}、文本实体=${identitySolids}、节点实体=${entities.length}`
        : artifactProblems.join('；'),
      note: '回读走 occt-import-js 原始装配树（不重命名/不去重/不按件号合并）；受限格式见文件头'
    },
    {
      label: '身份件号集合（件表×files.parts×回读叶）',
      ok: setOk,
      expected: `三方严格相等，期望 ${expectedParts} 件，missing=0 unknown=0 dup=0 非法值=0`,
      actual: setOk
        ? `expected=${expectedParts} parts=${parsed.list.length} readback=${leafCounts.size} missing=0 unknown=0 dup=0`
        : setProblems.join('；')
    },
    {
      label: '逐件实体数与包络（回读网格数 vs 件表实体数）',
      ok: perPartOk,
      expected: `总实体==逐件合计==stats.partSolids，逐件 meshCount==solids，逐件包络每轴≤${tolerance}mm 且非退化(≥${ENTITY_MIN_TRIANGLES} 面、每轴>${ENTITY_MIN_EXTENT_MM}mm)`,
      actual: perPartOk
        ? `solids=${identitySolids}/${declaredSolids}/${partSolids} bboxMaxΔ=${formatDelta(bboxMaxDeltaMm)} 件数=${parsed.list.length}`
        : perPartProblems.join('；'),
      note: '受限格式：compound 无布尔导出实测一 solid 一 mesh（探针 154/154、3/3）；普通 STEP 下 meshCount 不等于 BRep 实体数'
    },
    {
      label: '并集核对与制造件污染',
      ok: unionOk,
      expected: `identity 网格包络 == 制造 STEP 同口径网格包络（两份文件同一份 occt 回读参数，每轴≤${tolerance}mm；导入失败即红）且制造 STEP PRODUCT 名不含任何件号`,
      actual: unionOk
        ? `unionΔ=${unionDeltaMm?.map((value) => value.toFixed(2)).join('/') ?? '(未算)'}mm `
          + `mergedReadbackMesh=${mergedReadbackMeshCount ?? '(未知)'} pollution=0`
        : unionProblems.join('；'),
      note: '同口径：两侧都用 occt-import-js 网格包络（不再拿拓扑 VERTEX_POINT 包络当制造整体曲面包络）；'
        + '只叫包络核对，不是唯一几何指纹，不证明两份 STEP 内部拓扑/形状等价'
    }
  ];

  const ok = checks.every((check) => check.ok);
  return {
    ok,
    checks,
    entityIdentity: {
      applicable: true,
      ok,
      expectedParts,
      actualParts: leafCounts.size,
      expectedSolids: declaredSolids,
      actualSolids: identitySolids,
      meshCount: readback?.meshCount ?? 0,
      toleranceMm: tolerance,
      tolerancePolicy: tolerances.policy,
      requestedToleranceMm: tolerances.requested,
      toleranceError: tolerances.error,
      identityBBox: identityBox ? { min: [...(identityBox.min as [number, number, number])], max: [...(identityBox.max as [number, number, number])] } : null,
      mergedReadbackBBox: mergedMin && mergedMax ? { min: mergedMin, max: mergedMax } : null,
      mergedVertexPointBBox: (() => {
        const min = finiteVector3(facts.mergedVertexPointBBox?.min);
        const max = finiteVector3(facts.mergedVertexPointBBox?.max);
        return min && max ? { min, max } : null;
      })(),
      mergedReadbackMeshCount,
      mergedReadbackErrors: [...mergedErrors],
      unionDeltaMm,
      bboxMaxDeltaMm,
      missingIds: [...missingInParts, ...missingInReadback],
      unknownIds: [...unknownInParts, ...unknownInReadback],
      duplicateIds: [...tableDuplicates, ...parsed.duplicateIds, ...duplicateIds],
      invalidIds: [...tableInvalid, ...parsed.invalid, ...unownedEntities],
      perPartSolidsMismatch,
      bboxMismatches,
      degenerate,
      pollutionIds,
      sameDir,
      readbackErrors,
      boundaries: [...ENTITY_IDENTITY_BOUNDARIES]
    }
  };
}
