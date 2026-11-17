import { build } from 'esbuild';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

await build({
  entryPoints: [resolve(root, 'src/agent/mcp-cli.ts')],
  outfile: resolve(root, 'dist-electron/mcp.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  minify: true,
  keepNames: true,
  logLevel: 'info'
});
