# Performance and bundle size optimization

Mission: remove duplicate inlined OCCT WASM and optimize repeated motion envelope computation with measured, behavior-preserving evidence.

Scope: external WASM asset URL with existing IIFE/inline-worker architecture; pure CAD format dispatch; motion envelope caches and moving-pair iteration; equivalence tests and reproducible benchmark. No CAD kernel removal, module splitting/CORS redesign or installation-size claim from dev-only duplicate files.

Invariants: exact motion result/order/rounding vs frozen baseline; real Electron file:// Worker STEP import remains valid; existing project/UI recovery remains functional; same exported APIs.

Ship gate: full tests and build, deep equality on generated/random/adversarial geometries, benchmark p50/p95, exact file/gzip measurements and actual STEP import via Electron.
