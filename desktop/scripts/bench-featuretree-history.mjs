import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../featuretree-service/store.mjs';

const root = await mkdtemp(join(tmpdir(), 'ft-history-bench-'));
const featureCount = 20;
const seed = { schemaVersion: 1, updatedAt: '2026-11-20T00:00:00Z', features: Array.from({ length: featureCount }, (_, index) => ({ id: `body-${index}`, type: 'box', name: `body ${index}`, params: { length: 20, width: 20, height: 10, centered: true } })) };
const s = new Store(seed, { documentId: 'bench' });
const results = [];
try {
  for (const target of [100, 500, 1000]) {
    const started = performance.now();
    const from = s.revision;
    while (s.revision < target) {
      const result = await s.applyOperation({ expectedRevision: s.revision, operation: 'renameFeature', featureId: 'body-0', name: `edited ${s.revision}` });
      if (result.error) throw new Error(JSON.stringify(result));
    }
    const batchMs = performance.now() - started;
    s.dataFile = join(root, 'bench.json');
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now(); await s.persist(); samples.push(performance.now() - t);
    }
    s.dataFile = null;
    samples.sort((a, b) => a - b);
    results.push({ edits: target, batchEdits: target - from, batchMs: +batchMs.toFixed(3), archiveBytes: (await stat(join(root, 'bench.json'))).size, persistP50Ms: +samples[2].toFixed(3), retainedDocuments: 1 + s.undoStack.length + s.redoStack.length + (s.snapshots?.length ?? 0), undoDepth: s.envelope().undoDepth, historyEntries: s.history.length });
  }
  console.log(JSON.stringify({ node: process.version, platform: process.platform, features: featureCount, persistenceSamples: 5, results }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
