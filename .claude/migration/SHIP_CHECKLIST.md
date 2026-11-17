# Ship checklist — IPC domain boundaries

Run from desktop unless specified otherwise.

- [x] Baseline `npx tsc --noEmit`: passed (empty diagnostics).
- [x] Baseline `npm test`: 3,202 total; 3,199 passed; 3 skipped; 0 failures.
- [x] `node --test test/sync/upload-payload.test.mjs test/plcgen/export-files.test.mjs`: 9 passed.
- [x] `node scripts/check-ipc-boundaries.mjs`: 0 inline declarations against budget 0; baseline 6.
- [x] Final `npm test`: 3,211 total; 3,208 passed; 3 skipped; 0 failures.
- [x] `npm run build:ext`: TypeScript, Vite, Electron bundle and MCP bundle passed.
- [x] Compare extracted function bodies to HEAD: exact match except exported entry points and imports.
- [x] Confirm unused validator imports removed and no inline replacement implementations remain.
- [x] No package or lockfile changes; root web prototype untouched.
- [x] `git diff --check` from repository root: passed.

Build observations: occt-import-js imports path/crypto that Vite externalizes for browsers; extension bundle is 23,196.69 kB (9,124.90 kB gzip). These observations are outside this validator extraction; no runtime acceptance is inferred from a successful build.

Windows/Electron interactive smoke, Qt and real geometry kernels were not exercised in this bounded domain refactor. The 3 skipped tests remain skipped as in the baseline.
