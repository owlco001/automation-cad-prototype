import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const script = readFileSync(new URL('dist/extension.js', root));
const wasm = readFileSync(new URL('dist/occt-import-js.wasm', root));
const source = readFileSync(new URL('node_modules/occt-import-js/dist/occt-import-js.wasm', root));
// Leave measured headroom for features, while preventing duplicate WASM embedding.
assert.ok(script.length <= 4_000_000, `extension.js exceeds 4 MB budget: ${script.length}`);
assert.ok(gzipSync(script).length <= 1_300_000, 'extension.js exceeds 1.3 MB gzip budget');
assert.equal(createHash('sha256').update(wasm).digest('hex'), createHash('sha256').update(source).digest('hex'), 'external WASM must match installed OCCT runtime');
assert.ok(!script.includes(source.subarray(0, 4096).toString('base64')), 'WASM must not be embedded in extension or inline worker');
const nativeBytes = {};
for (const [file, budget] of [['main.cjs', 8_000_000], ['mcp.cjs', 1_700_000], ['preload.cjs', 25_000]]) {
  const bytes = readFileSync(new URL(`dist-electron/${file}`, root)).length;
  assert.ok(bytes <= budget, `${file} exceeds ${budget} byte budget: ${bytes}`);
  nativeBytes[file] = bytes;
}
console.log(JSON.stringify({ extensionBytes: script.length, extensionGzipBytes: gzipSync(script).length, wasmBytes: wasm.length, totalBytes: script.length + wasm.length, nativeBytes }));
