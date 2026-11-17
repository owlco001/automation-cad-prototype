import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const outdir = resolve(root, 'dist-electron');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [resolve(root, 'electron/main.ts')],
  outfile: resolve(outdir, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  minify: true,
  keepNames: true,
  external: ['electron']
});

await build({
  entryPoints: [resolve(root, 'electron/preload.ts')],
  outfile: resolve(outdir, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  minify: true,
  keepNames: true,
  external: ['electron']
});

await cp(resolve(root, 'electron/dwg-convert.mjs'), resolve(outdir, 'dwg-convert.mjs'));

const wasmSource = resolve(root, 'node_modules/occt-import-js/dist/occt-import-js.wasm');
await cp(wasmSource, resolve(root, 'dist/occt-import-js.wasm'));
await cp(wasmSource, resolve(outdir, 'occt-import-js.wasm'));
