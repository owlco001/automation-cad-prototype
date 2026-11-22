# Handoff — audited fixes

## Changed
- FeatureTree now serializes per-document writes, persists candidate state before publication, isolates geometry revisions, recovers legacy undo data, and uses persisted undo/redo checkpoints.
- Added transaction and geometry publication regressions in `featuretree-service/transaction-tests.mjs`; CI runs them.
- Domain fixes: strict cost placement/finite totals, flat MQTT station normalization, complete package search, pre-commit package hash verification, and collision-count-safe layout advice.
- Agent fixes: per-request approval queue, cancellation/unknown write outcome records with bounded dedupe, origin-bound LLM credentials, maxToolCalls preservation, and MCP resource/status wiring.
- CI material gate now creates the current transfer screenshot in RUNNER_TEMP and checks only that artifact; added negative/auth regressions.

## Latest: FeatureTree lightweight reads
- `GET /v1/tree?includeHistory=0` returns the same tree without cloning the audit history, marked `historyOmitted:true`; default responses are unchanged.
- `GET /v1/revisions?limit=&offset=` pages history (`total/offset/limit/entries/nextOffset`); no params keeps the original full array; invalid params are 422.
- Measured at 1000 edits: full envelope 182,075 B → light 302 B (99.8% smaller); a 50-entry page is 9,045 B.
- New behaviour test `history-read-tests.mjs` (7 cases) plus all existing FeatureTree acceptance (transaction/storage/store/HTTP 35/MCP/multi-doc/persistence) pass.

## Latest: chunk migration ratchet
- `desktop/modules/bundled-allowlist.json` records optional modules still inside the core bundle. `npm run modules:verify` now fails when an optional module is neither chunked nor allowlisted, when an allowlisted module disappears, or when an already-chunked module is still listed. It also prints `MODULE_CHUNKS_PROGRESS chunked=1/12 stillInCore=11`.
- Guarded by `test/modules/bundled-allowlist.test.mjs`; full suite passes with no owned-process survivors.

## Latest: first module moved to a chunk (drawings.techdraw)
- The renderer UI of `drawings.techdraw` is no longer statically imported by `extension.ts`; it ships as `dist/modules/drawings.techdraw.js` and is loaded on first mount of the parametric drawer through the verified loader.
- Delivery path: preload `window.desktop.moduleChunks` -> main `modules:manifest` / `modules:chunk` (trusted main-window main-frame only, ids from the manifest only) -> `ModuleChunkReader` verifies bytes+sha256 -> renderer loader re-verifies and executes a classic script that self-registers.
- Measured: core `dist/extension.js` 2,949,013 -> 2,937,823 B (gzip 922,777 -> 919,183); chunk 22,408 B. Net on-disk is slightly larger (separate bundle duplicates shared helpers); the win is 11 KB less code parsed/executed at startup and a real on-demand path.
- Guard: `modules/chunks.json` declares `coreMustNotContain` per chunk; `npm run modules:verify` fails if that marker reappears in `dist/extension.js`. Drawings UI degrades to an explicit "module not loaded (<code>)" note when the chunk is absent/disabled/incompatible.
- Tests: chunk contract 1, loader 9, manifest 4, build 4, main reader 4; full suite result recorded below.

## Latest: module chunk infrastructure
- Optional-module code can now ship as separate classic-script chunks with a manifest carrying per-file sha256/bytes. Renderer loader enforces whitelist -> module/dependency/API state -> size -> hash -> self-registration before executing; main-process reader resolves only ids from the manifest and re-verifies before handing source over.
- Production `modules/chunks.json` is empty, so no behavioural change ships yet: this slice is the pipeline plus its gates, not a migrated module.
- `npm run build:modules` builds chunks, `npm run modules:verify` gates manifest/hash consistency and is wired into CI after `build:ext`.
- Tests: manifest 4, loader 9, build 4, main-process reader 4. Full suite 3924 total / 3921 passed / 0 failed / 3 skipped, no owned-process survivors.
- Remaining (documented in `docs/desktop/MODULE-CHUNKS.md`): move the first real module out of `extension.ts`, wire the IPC/preload surface under security review, and only then measure size/startup deltas or add independent signed packages.

## Latest: broad-phase candidate filtering
- Interference/clearance now screen only candidate pairs (X-sorted sweep + at-least-two-axis penetration test for interference, all-axes-below-threshold for clearance), while enumerating in the original `i<j` order so stable-sort tie order is unchanged. <32 parts, non-finite bounds, or non-finite/non-positive thresholds fall back to full enumeration.
- Solver loops reuse identical adjacent screening results (`resolveClearance` always; `resolveConflicts` when `ignorePairs` is empty), and `buildAdvice` skips clearance for trial directions whose overlap count cannot beat the best.
- Complete ordered reports match frozen pre-change oracles on six fixtures × six thresholds; layout fingerprints match on three machines. Sparse 1000-part screening: interference 60.5 → 9.0 ms, clearance 147.5 → 1.7 ms; six-station layout 494.5 → 284.4 ms.
- Full suite: 3903 tests, 3900 passed, 0 failed, 3 skipped, 59.1 s, no owned-process survivors; `npm run build:ext` passed. Details: `BROAD-PHASE.md`.

## Latest: joints rule precomputation
- `declaredJoints` now profiles each part once (two 6-bit rule masks, sensor stem, sensor-body flag) and enumerates only parts that can be one end of a connection. First-match priority, sensor same-stem semantics, duplicate IDs and output order are unchanged; the frozen pre-optimization oracle and the pinned interference/clearance hashes both pass.
- Re-run benchmark (`allEquivalent: true`, 12 scenarios): joints matching 1000 sparse 171.6 → 0.4 ms, 1000 named dense 188.6 → 6.2 ms; end-to-end interference 1000 sparse 217.1 → 47.5 ms, named dense 361.3 → 185.4 ms. Pair enumeration remains quadratic.
- Integrated from the night run's isolated copy by porting only the joints files after review. Full suite in the main worktree: 3889 tests, 3886 passed, 0 failed, 3 skipped, no owned-process survivors; `npm run build:ext` passed.
- Details and raw data: `JOINTS-PERFORMANCE.md`, `.claude/migration/audit-fixes/baselines/joints-benchmark-2026-11-20.json`.

## Latest: interference screening
- Reused per-part bounds and extent volume in exact checks and displacement suggestions. Replaced repeated pair membership scans with one aggregation pass in existing sort order.
- Three deterministic assemblies retained identical full ordered JSON fingerprints. Local median (9 samples): 100 sparse parts 3.528 → 2.845 ms; 500 sparse parts 49.145 → 49.131 ms; 200 dense parts with 18,204 hits 112.543 → 54.484 ms. Pair enumeration is still quadratic.
- Focused geometry tests: 63/63. Supervised desktop suite: 3875 total, 3872 passed, 3 skipped, 0 failed, no owned survivors. Production build passed. Logs: `/root/workspace/automation-cad-interference-{tests,full,build}.log`.
- Release checks still pending: remote CI, Windows and real kernel/hardware acceptance. Next local benchmark: `node desktop/scripts/bench-interference.mjs`.

## Prior evidence
- Pack search iteration: loaded packs now cache normalized search text; unloading/disable/remove invalidates it. 612-part repeated-query benchmark improved p50 18.991ms to 0.498ms with equal results and ~164KiB loaded cache. Details in `PACK-SEARCH.md` and `/root/workspace/automation-cad-pack-search-benchmark-final.json`.
- Latest full desktop suite: 3872 tests, 3869 passed, 0 failed, 3 skipped; `/root/workspace/automation-cad-pack-search-full.log`.
- Render cleanup iteration: owned-process tracking includes detached/reparented sidecars; success, cancellation, launcher crash and startup timeout all passed on final built Electron with no descendants/ports left. `/root/workspace/automation-cad-cleanup-release-check.log`; details in `RENDER-CLEANUP.md`.
- Latest iteration: clearance screening about 3.1x faster in local 100/500/1000-part benchmark; enclosure drag coalesces frame renders and persists once at completion. See `INTERACTION-PERFORMANCE.md` for raw measurements, equivalence tests and default-concurrency timing fluctuation.
- Prior Agent follow-up full suite: 3853 tests, 3850 passed, 0 failed, 3 skipped; `/root/workspace/automation-cad-agent-followup-full.log`.
- Agent follow-up: caller-known MCP write IDs, cancellation/status integration, audit failure isolation, token-generation abort, bounded large-result terminal summaries; see `AGENT-FOLLOWUP.md`.
- Latest TypeScript/Vite/Electron/MCP build passed; `/root/workspace/automation-cad-pack-search-build.log`.
- Agent focused suite: 31 tests, 31 passed after removing Node strip-only parameter properties.
- Domain + material focused suite: 234 tests, 234 passed; `/root/workspace/automation-cad-fix-domain-tests-2.log`.
- FeatureTree transaction and existing acceptance all passed.
- Current transfer Electron E2E: steps=4, failed=0, 106 parts rendered/colored; all material pixel thresholds passed; `/root/workspace/automation-cad-fix-material-run-3.log`.
- Audit guard and `git diff --check` passed.

## Remaining
- No GitHub Actions post-change run was triggered.
- Real Windows installer, PLC/broker hardware and B-rep kernel acceptance were not run. Material gate proves the current Electron CAD canvas pixel output, not B-rep truth.
- Full suite includes expected diagnostic stderr from negative tests; no failed assertions.

## Next steps
1. Review the diff on branch `fix-audit-findings` in `/root/workspace/automation-cad-audit-main`.
2. Run the repository's CI workflow on GitHub when ready.
3. Perform platform-specific Windows/native-kernel acceptance before release.
4. Commit/push only after maintainer review; no commit or push was performed in this task.
