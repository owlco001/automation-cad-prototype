# Handoff — audited fixes

## Changed
- FeatureTree now serializes per-document writes, persists candidate state before publication, isolates geometry revisions, recovers legacy undo data, and uses persisted undo/redo checkpoints.
- Added transaction and geometry publication regressions in `featuretree-service/transaction-tests.mjs`; CI runs them.
- Domain fixes: strict cost placement/finite totals, flat MQTT station normalization, complete package search, pre-commit package hash verification, and collision-count-safe layout advice.
- Agent fixes: per-request approval queue, cancellation/unknown write outcome records with bounded dedupe, origin-bound LLM credentials, maxToolCalls preservation, and MCP resource/status wiring.
- CI material gate now creates the current transfer screenshot in RUNNER_TEMP and checks only that artifact; added negative/auth regressions.

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
