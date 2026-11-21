# Interaction performance iteration

## Scope
Continue `fix-audit-findings` from its validated 3853-test state. Optimize repeated AABB work in clearance screening and frame/persistence scheduling during enclosure drags. No geometric policy changes, no dependency changes, no push/deployment.

## Clearance approach and evidence
- Freeze the original implementation in `desktop/test-support/clearance-baseline.ts` as a test-only comparison oracle.
- Construct lazy per-call bounds; skip ID-less/declared pairs before bounds access as before. No cross-call caching, so in-place edits cannot leave stale geometry.
- Reject distant pairs when one positive axis separation already reaches the threshold. Preserve pair ordering, rounding, contacts and connection exemptions.
- Compare full result objects on deterministic mixed box/cylinder/rotated fixtures and boundary cases, and verify inputs remain unchanged.
- Benchmark includes cache construction, 2 warmups and 7 measured calls for each implementation on the same generated fixture. Node v24.18.0 / Linux. Local CPU measurements, not a universal latency claim.

| Parts | Original p50 / p95 ms | Optimized p50 / p95 ms | p50 speedup |
|---:|---:|---:|---:|
| 100 | 11.502 / 20.499 | 3.729 / 4.561 | 3.08x |
| 500 | 224.254 / 226.287 | 72.310 / 102.326 | 3.10x |
| 1000 | 879.211 / 942.560 | 285.960 / 291.804 | 3.07x |

Reproduce from desktop: `node scripts/bench-clearance.mjs 7`.

## Acceptance
- Targeted clearance equivalence, existing clearance and layout tests.
- Actual canvas class interaction regression with controlled pointer, RAF and storage adapters: no-op, multiple moves/frame, final pointerup, cancel, close/dispose, rail carry-along.
- Full desktop suite and production build.
- Final diff review, no stale scheduling callbacks or subscriptions.

## Enclosure drag changes and evidence

- Placement and rail coordinates update immediately in memory. Snapping/clamping no-ops do not schedule work.
- Render is coalesced to one pending animation frame. The collision/utilization/SVG implementation remains the same and refreshes with that frame.
- Dirty drag state is persisted once on pointer release, cancellation, lost capture or panel closure. Pointerup applies its final coordinates; cancellation retains the last valid coordinates.
- Dispose flushes active changes, cancels render/focus frames, aborts event subscriptions and disconnects ResizeObserver.
- A real Canvas-class VM regression drives 100 same-frame pointer moves: latest x=110, one queued frame, no immediate render or storage writes, one render after flush, exactly one storage write on release.
- 24 enclosure tests including 8 new interaction tests passed (`/root/workspace/automation-cad-drag-final.log`). This is controlled event/RAF/storage evidence, not a measured browser FPS improvement.
- TypeScript and production build passed (`/root/workspace/automation-cad-performance-build.log`).

## Full-suite timing observation

The first full run passed (3865 total / 3862 passed / 3 skipped). After adding the 100-event drag regression, a default-concurrency full run had one unrelated timing failure: existing cold package search took 140.2 ms against its unchanged 120 ms limit (3866 total / 3862 passed / 1 failed / 3 skipped). No search implementation or threshold was modified in this iteration. Isolated package tests then passed 32/32 (cold-search case total 21.5 ms). Final full run with fixed concurrency=4 passed 3866 total / 3863 passed / 0 failed / 3 skipped in 124.8 seconds (`/root/workspace/automation-cad-performance-controlled-full.log`). This is evidence of timing variability; default-concurrency performance gates remain potentially flaky and were not relaxed.

## Remaining boundaries
The pair enumeration remains O(n²); spatial indexing is a separately measurable follow-up. This iteration does not claim layout actions are geometrically certified or add B-rep/hardware acceptance.
