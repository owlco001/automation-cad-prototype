# Performance ship checks

- [x] Full Node suite:3316 tests,3313 pass,3 skipped,0 fail.
- [x] TypeScript and production Vite/Electron/MCP build.
- [x] Build budget guard: extension <=4MB and gzip <=1.3MB, external WASM matches dependency SHA-256, embedded WASM rejected.
- [x] Motion output deep equality with frozen original implementation on generated/random/adversarial fixtures including rounding timestamp behavior.
- [x] Reproducible 20-sample/6-warmup benchmark; measured p50/p95 in REPORT.md.
- [x] Real Electron file:// Worker STEP import and complete UI/session recovery smoke, exit0.
- [x] git diff --check.

No startup-latency or full installer-size measurement claimed. No remote push.
