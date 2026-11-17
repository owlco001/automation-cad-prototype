import { parseOcctBuffer } from './step';

interface ParseRequest {
  id: number;
  kind: 'occt';
  name: string;
  buffer: ArrayBuffer;
  wasmUrl: string;
}

self.onmessage = async (event: MessageEvent<ParseRequest>) => {
  const request = event.data;
  try {
    const result = await parseOcctBuffer(request.buffer, request.name, {
      wasmUrl: request.wasmUrl
    });
    const transfers: ArrayBuffer[] = [];
    for (const mesh of result.meshes) {
      transfers.push(mesh.positions.buffer as ArrayBuffer);
      if (mesh.normals) transfers.push(mesh.normals.buffer as ArrayBuffer);
      if (mesh.indices) transfers.push(mesh.indices.buffer as ArrayBuffer);
    }
    self.postMessage({ id: request.id, ok: true, result }, { transfer: transfers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    self.postMessage({ id: request.id, ok: false, error: message });
  }
};
