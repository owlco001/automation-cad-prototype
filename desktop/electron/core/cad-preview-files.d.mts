export interface CoreCadPreviewFile {
  cancelled: false;
  name: string;
  extension: '.stl' | '.glb';
  byteLength: number;
  bytes: Uint8Array;
}
export function validateCadPreviewExtension(filePath: string): '.stl' | '.glb';
export function readCadPreviewFile(filePath: string): Promise<CoreCadPreviewFile>;
