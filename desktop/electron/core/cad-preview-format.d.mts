export const CAD_PREVIEW_EXTENSIONS: readonly ['.glb', '.stl'];
export const CAD_PREVIEW_MAX_BYTES: number;
export const CAD_PREVIEW_MAX_TRIANGLES: number;
export const CAD_PREVIEW_MAX_MESHES: number;
export const CAD_PREVIEW_MAX_VERTICES: number;
export interface CorePreviewMesh {
  name: string;
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint32Array | null;
  color: number[] | null;
}
export interface CorePreviewNode {
  name: string;
  mesh?: number;
  children: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
export interface CorePreviewModel {
  format: 'STL' | 'GLB';
  meshes: CorePreviewMesh[];
  meshGroups: number[][];
  nodes: CorePreviewNode[];
  sceneRoots: number[];
  triangleCount: number;
  meshCount: number;
}
export function parseCadPreview(input: ArrayBuffer | ArrayBufferView, extension: string): CorePreviewModel;
export class CorePreviewSession {
  constructor(commit: (candidate: CorePreviewModel) => void);
  readonly current: CorePreviewModel | null;
  open(input: ArrayBuffer | ArrayBufferView, extension: string): CorePreviewModel;
}
