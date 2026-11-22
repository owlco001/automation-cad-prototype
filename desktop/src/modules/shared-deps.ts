/**
 * 分块共享依赖：three 命名空间的显式白名单。
 *
 * 分块是独立 IIFE，构建时把 `three` 标成 external，运行时从
 * `globalThis.__cadSharedDeps.THREE` 取核心已加载的同一份实例。这里只显式具名
 * 导入「核心与已迁移分块真正用到」的符号，再组装成命名空间对象；禁止整包命名
 * 空间导入、`export *` 或对象展开，否则 Rollup 无法摇树，three 的全部导出都会
 * 被留在每次启动都要加载的核心包里。
 *
 * 维护约定：核心或分块新增 `THREE.Xxx` 时，在这里补上同名导入与属性；
 * `test/modules/shared-deps.test.mjs` 会核对两侧并集，漏加或多加都会失败。
 */
import {
  AmbientLight,
  Box3,
  Box3Helper,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Controls,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Euler,
  Float32BufferAttribute,
  FrontSide,
  GridHelper,
  Group,
  HemisphereLight,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  MOUSE,
  MathUtils,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Quaternion,
  Ray,
  Raycaster,
  SRGBColorSpace,
  Scene,
  Sphere,
  SphereGeometry,
  Spherical,
  TOUCH,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer
} from 'three';

/**
 * 暴露给分块的 three 命名空间对象。
 *
 * 属性值就是 three 的具名导出本身，与核心其它 `THREE.Xxx` 用法共享同一引用，
 * 不会产生第二份类定义或第二套常量。只放实际用到的符号；不要为了“以后可能用”
 * 把 Loader / PMREM / WebGPU 之类重型导出加进来。
 */
export const SHARED_THREE = {
  AmbientLight,
  Box3,
  Box3Helper,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Controls,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Euler,
  Float32BufferAttribute,
  FrontSide,
  GridHelper,
  Group,
  HemisphereLight,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  MOUSE,
  MathUtils,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OctahedronGeometry,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Quaternion,
  Ray,
  Raycaster,
  SRGBColorSpace,
  Scene,
  Sphere,
  SphereGeometry,
  Spherical,
  TOUCH,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer
} as const;

export type SharedThree = typeof SHARED_THREE;
export type SharedThreeSymbol = keyof SharedThree;
