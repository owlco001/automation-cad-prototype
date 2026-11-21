# Pack search cache iteration

`PackRegistry.listParts({q})` now builds one lower-cased search string per part when a pack is first loaded, then reuses it for repeated queries. The cache belongs to `CachedPack`; `unloadPack`, disable and remove invalidate the loaded pack/index, so modified package contents are re-read and normalized. Manifest-only scan remains lazy, and category/pack filters and duplicate-ID precedence remain unchanged.

## Evidence

- Added regression: repeated model/spec queries reuse one parts read; after changing parts.json and unloading, new text is found and old text disappears.
- Pack lazy-loading, registry and lifecycle tests: 79/79 passed (`/root/workspace/automation-cad-pack-search-tests.log`).
- Full desktop suite under owned process supervisor: 3872 total / 3869 passed / 0 failed / 3 skipped, 57.8 seconds (`/root/workspace/automation-cad-pack-search-full.log`). No owned process descendants remained.
- TypeScript check and production build passed (`/root/workspace/automation-cad-pack-search-build.log`).
- Real built-in catalog benchmark: 612 parts, six queries, 30 rounds. Old per-query normalization p50/p95 18.991/25.787 ms; cached search 0.498/0.742 ms. Results were asserted equal for every query. Cache retains 84,031 UTF-16 characters (~164 KiB estimated) while loaded; unload releases it (`/root/workspace/automation-cad-pack-search-benchmark-final.json`).

The benchmark compares CPU work on already-loaded packs; it does not claim cold-start improvement. Search remains linear in loaded parts. A full inverted index would be a separate memory/complexity tradeoff.
