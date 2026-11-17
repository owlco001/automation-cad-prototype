# Performance results

Environment: Node v26.7.0, Linux x64. Motion benchmark60 frames,6 warmups,20 measured calls per implementation; timings include cache construction. Local measurements, not universal hardware guarantees.

## Bundle

| Artifact | Before bytes | After bytes | Reduction |
|---|---:|---:|---:|
| dist/extension.js |23250506|2910351|87.48%|
| extension.js gzip |9170681|896729|90.22%|
| dist/occt-import-js.wasm |7604031|7604031|0%|
| dist total JS+WASM |30854537|10514382|65.92%|

Removed repeated base64 WASM by ?url&no-inline and eliminating worker fallback asset import. Kept classic IIFE and inline worker for existing file:// injection. Extracted pure format dispatch so renderer doesn't pull OCCT runtime merely to inspect extensions. External WASM still ships once in dist. dist-electron copy was already excluded from packaging; no installer savings claim from that copy. Main/MCP byte counts unchanged.

## Motion envelope

| Fixture | Parts | Baseline p50/p95 ms | Optimized p50/p95 ms | p50 speedup |
|---|---:|---:|---:|---:|
|2 stations|33|1.499 / 2.814|0.364 / 0.532|4.12x|
|6 stations|71|3.752 / 3.972|1.127 / 1.684|3.33x|
|12 stations|137|11.878 / 13.173|3.664 / 3.892|3.24x|
|Adversarial seeded|160|36.769 / 39.760|14.428 / 15.355|2.55x|
|12 stations +800 static details|937|335.949 / 348.311|23.477 / 25.892|14.31x|

Cache boxes/half extents; update only moving/posed boxes; enumerate only candidate moving-vs-other pairs in original order; scalar overlap avoids temporary objects. Preserve old rounding/timestamp/order semantics including adversarial sparse jaw IDs.

## Validation

Full suite3316 total:3313 passed,3 skipped,0 failures. Production TypeScript/Vite/Electron/MCP build passed. Real Electron Worker imported cube-mm.step with external WASM and continued entire UI/session save/poll/reopen/cold-recovery smoke, exit0. Deep equality on generated, randomized and adversarial fixtures against frozen original algorithm. git diff --check passed.

Reproduce: desktop `npm test && npm run build:ext`; repository root `node scripts/bench-motion-envelope.mjs 20 6`; desktop `PROJECT_SESSION_SMOKE_CAD=$PWD/node_modules/occt-import-js/test/testfiles/cube-units/cube-mm.step node scripts/project-session-smoke.mjs`.
