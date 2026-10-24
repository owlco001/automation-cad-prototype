import * as THREE from 'three';
import type { CadImportResult, CadMeshData } from '../shared/types.ts';
import { buildPartMeta, type PartMeta } from './render-plan.ts';

export interface LoadedPart {
  data: CadMeshData;
  mesh: THREE.Mesh;
  triangleCount: number;
  partId?: string;
  qty?: number;
  note?: string;
}

export interface CadLoadCandidate {
  parts: LoadedPart[];
  metas: PartMeta[];
  dispose(): void;
}

const DEFAULT_COLORS = [0x7f8b96, 0x9aa6b2, 0xb5a078, 0x6f9e9a, 0xa77e8d, 0x8e9b74];

/**
 * Build a replacement model without mutating the active scene. If any geometry or
 * material construction fails, release every staged resource and leave the caller's
 * current model untouched.
 */
export function stageCadLoad(result: CadImportResult, wireframe: boolean): CadLoadCandidate {
  const parts: LoadedPart[] = [];
  const metas: PartMeta[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const materials = new Map<string, THREE.MeshStandardMaterial>();

  const dispose = (): void => {
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
  };

  try {
    result.meshes.forEach((data, index) => {
      const geometry = new THREE.BufferGeometry();
      geometries.push(geometry);
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      if (data.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
      if (data.indices) geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      if (!data.normals) geometry.computeVertexNormals();
      geometry.computeBoundingBox();

      const colorKey = data.color ? data.color.map((value) => value.toFixed(3)).join(',') : 'default';
      let material = materials.get(colorKey);
      if (!material) {
        const color = data.color
          ? new THREE.Color(data.color[0], data.color[1], data.color[2])
          : new THREE.Color(DEFAULT_COLORS[index % DEFAULT_COLORS.length]!);
        material = new THREE.MeshStandardMaterial({
          color,
          metalness: 0.2,
          roughness: 0.62,
          wireframe,
          side: THREE.DoubleSide
        });
        materials.set(colorKey, material);
      }

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = data.name;
      mesh.userData.partIndex = index;
      mesh.userData.kinematicsBasePosition = mesh.position.clone();
      mesh.userData.kinematicsBaseQuaternion = mesh.quaternion.clone();
      const triangleCount = data.indices
        ? Math.floor(data.indices.length / 3)
        : Math.floor(data.positions.length / 9);
      parts.push({ data, mesh, triangleCount });

      if (data.positions.length >= 9) {
        const meta = buildPartMeta(
          {
            name: data.name,
            positions: data.positions,
            indices: data.indices ?? null,
            ...(data.color ? { color: data.color } : {})
          },
          index
        );
        if (meta.triangleCount > 0) metas.push(meta);
      }
    });
  } catch (error) {
    dispose();
    throw error;
  }

  return { parts, metas, dispose };
}
