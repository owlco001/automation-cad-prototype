import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// JSON is a YAML subset; keep budgets machine-readable without another dependency.
const root = new URL('../../', import.meta.url);
const { ratchets } = JSON.parse(readFileSync(new URL('.claude/migration/RATCHETS.yaml', root), 'utf8'));
for (const ratchet of ratchets) {
  const source = readFileSync(new URL(ratchet.scope, root), 'utf8');
  const count = [...source.matchAll(new RegExp(ratchet.pattern, 'gm'))].length;
  assert.ok(count <= ratchet.budget, `${ratchet.id}: ${count} > budget ${ratchet.budget} (${ratchet.scope})`);
  console.log(`${ratchet.id}: ${count}/${ratchet.budget} (baseline ${ratchet.baseline})`);
}
