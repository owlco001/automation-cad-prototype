import { readFileSync } from 'node:fs';
const root = new URL('../../../', import.meta.url);
const ledger = readFileSync(new URL('RATCHETS.yaml', import.meta.url), 'utf8');
let failed = false;
for (const section of ledger.split(/\n  - id: /).slice(1)) {
  const id = section.split('\n')[0].trim();
  const field = name => section.match(new RegExp(`^    ${name}: (.+)$`, 'm'))?.[1];
  const path = field('path');
  const literal = field('literal');
  const budget = Number(field('max_matches'));
  if (!path || !literal || !Number.isSafeInteger(budget)) throw new Error(`Invalid ratchet: ${id}`);
  const count = readFileSync(new URL(path, root), 'utf8').split(literal).length - 1;
  console.log(`${id}: ${count}/${budget} (${path})`);
  if (count > budget) failed = true;
}
if (failed) process.exitCode = 1;
