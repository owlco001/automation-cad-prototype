/** Bind local index annotations to the exact persisted STL sequence, with framed names. */
export async function projectMeshSignature(parts: readonly { name: string; data: Uint8Array }[]): Promise<string> {
  const encoder = new TextEncoder();
  const hashes: string[] = [];
  for (const part of parts) {
    const bytes = new Uint8Array(part.data);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    hashes.push(JSON.stringify([part.name, bytes.byteLength, [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('')]));
  }
  const result = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(hashes)));
  return [...new Uint8Array(result)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
