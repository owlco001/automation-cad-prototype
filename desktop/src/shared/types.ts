export interface CadMeshData {
  name: string;
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint32Array | null;
  /** 运行时工程身份标记；不写入 CAD 来源文件或通用导出数据。 */
  stableObjectId?: string;
  color?: [number, number, number];
  /** 装配层级路径（根 → 父节点名，不含网格自身名）；STEP/IGES 有层级时才有。 */
  path?: string[];
}

export interface CadImportResult {
  meshes: CadMeshData[];
  stats: {
    meshCount: number;
    triangleCount: number;
    elapsedMs: number;
    format: string;
  };
}

export interface PackRequirement {
  /** 依赖的数据包 id。 */
  pack: string;
  /** semver 范围：支持精确版本、^、~、>=、<=、>、<、= 与 ||。 */
  version: string;
}

export interface PackManifest {
  /** manifest 结构版本；1 为兼容旧包，2 为当前推荐。 */
  schemaVersion: 1 | 2;
  id: string;
  name: string;
  vendor: string;
  version: string;
  license?: string;
  description?: string;
  /** manifest 索引里的分类，用于搜索/列表在加载 parts.json 前预过滤。 */
  categories: string[];
  /** parts.json 中的条目数；加载后以实际条目数为准。 */
  partsCount: number;
  /** 可选检索关键词（系列、品牌别名），只在 manifest 索引中匹配。 */
  keywords?: string[];
  /** parts.json 原始字节的 SHA-256；加载时校验，不匹配拒绝加载。 */
  partsSha256?: string;
  /** 可选包依赖；缺失或版本不满足时校验失败。 */
  requires?: PackRequirement[];
}

export interface ComponentPart {
  id: string;
  model: string;
  category: string;
  vendor?: string;
  /** 指向已登记型号的 id；别名条目不参与列表/计数，仅用于解析到目标型号。 */
  aliasOf?: string;
  /** 原理图符号键（如 qf1/km1/a1），缺省表示暂无符号 */
  symbol?: string;
  /** 器件本体外形尺寸（宽×高×深，mm）；source 记录官方文档或同系列参照 */
  dims?: { w: number; h: number; d: number; source?: string; estimated?: true };
  /** 是否 DIN 导轨安装 */
  railMount?: boolean;
  /** 模数宽（mm，1P=18）；面板开孔件可存开孔直径 */
  moduleWidth?: number;
  specs: Record<string, string | number>;
  asset?: string;
  thumbnail?: string;
  price?: number;
  packId?: string;
  packName?: string;
}

export interface PackInfo {
  id: string;
  name: string;
  vendor: string;
  version: string;
  description?: string;
  license?: string;
  enabled: boolean;
  builtin: boolean;
  path: string;
  partCount: number;
  categories: string[];
  keywords?: string[];
  error?: string;
}
