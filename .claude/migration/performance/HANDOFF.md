# Performance optimization handoff

## Changed
Externalized duplicate OCCT WASM with no-inline URL, required worker URL and pure format helper. Optimized motion envelope hot loop with exact behavior reference tests and benchmark. Added optional native smoke CAD import input. Production build enforces 4 MB raw / 1.3 MB gzip extension budgets, matching external WASM digest and no embedded WASM prefix.

## Now true
Extension23.25MB→2.91MB; JS+WASM30.85MB→10.51MB. Motion p50 3.24–4.12x on generated33–137 part cases,14.31x on937 part static-detail case. Full3316 tests:3313 pass/3 skip/0 fail. Build and native STEP+recovery smoke pass. Full metrics REPORT.md.

## Remains
No unfinished work in this bounded scope. Future separate measurements: main bundle/package dependencies, startup parse timing, lazy loading architecture. No installer full-byte or startup latency claim was measured.

## Shipping blockers
None for current optimization. Local uncommitted changes only; no push.

## Exact next steps
Review patch; npm test; npm run build:ext; root `node scripts/bench-motion-envelope.mjs 20 6`. Run native optional CAD smoke as REPORT specifies. Commit/push when authorized.
