# Broad-phase candidate filtering and solver reuse

Continue `fix-audit-findings` from commit `c91472a`. Screening (interference / clearance) was still enumerating every part pair, and the layout solver called it redundantly. This iteration removes both without changing any reported pair, its order, or the solver's decisions.

## 1. Candidate pairs (`desktop/src/machine/broad-phase.ts`)

Both screens now ask for candidate pairs first and run the unchanged per-pair body only on those.

- Interference: a reported pair must penetrate on three axes (overlap) or on two axes while touching on the third. Both require **at least two axes with penetration > -EPS**, so that is a safe superset. Pairs are found by sorting on the X minimum and walking a window, then bucketing by the smaller original index and sorting each bucket ascending, so enumeration order is exactly the old `i < j` order (the final sort is stable, so tie order is preserved).
- Clearance: a reported pair needs the Euclidean gap < threshold, which implies every axis gap < threshold. Pairs with any axis gap ≥ threshold are therefore unreachable.
- Exactness guards: fewer than 32 parts, non-finite bounds, or a non-finite/non-positive threshold fall back to the original double loop. Partial centre data also falls back for clearance.

## 2. Solver reuse (`desktop/src/machine/resolve.ts`, `layout.ts`)

- `resolveClearance` recomputed the identical `screenClearance` call at the top of each iteration and at the end of the previous one; the result is now carried forward (same arguments, pure function).
- `resolveConflicts` carries the post-move result only when `ignorePairs` is empty, because the two calls then have identical arguments. With a non-empty ignore list the two calls genuinely differ and both still run.
- `buildAdvice` no longer runs the clearance screen for trial directions whose overlap count already exceeds the best so far: the comparison is lexicographic on overlap first, so such a direction cannot win. Order and the final selection are unchanged.

## Correctness evidence

- `desktop/test/machine/broad-phase.test.mjs` compares **complete ordered JSON** against frozen pre-change oracles (`test-support/interference-baseline.ts`, `test-support/clearance-pre-broad-phase.ts`) for six fixtures (200/1000 sparse, near-touching epsilon grid, dense cluster, mixed primitives with rotations and a cylinder inside a box, non-finite coordinates) and thresholds 20/50/0/-1/NaN/Infinity. Inputs are asserted unmutated; small inputs and unusable coordinates are asserted to match the full-enumeration path.
- Existing pinned-hash guards still pass: `interference-equivalence.test.mjs` (pre-optimization report hashes) and `clearance-performance.test.mjs` (frozen `clearance-baseline.ts`).
- Layout fingerprints (`suspects`, `clearance`, full `advice` JSON) are identical before and after the solver changes for six-station screw machine, four-station dispenser and PV turner.
- `test/machine/cli.test.mjs` goldens: 28/28 passed, including the cross-station advice and `actionable` replay cases.

## Benchmark (from desktop: `node --expose-gc scripts/bench-broad-phase.mjs`)

Node v26.7.0 / Linux x64, 7 runs, p50 ms, both implementations measured in the same process, complete reports asserted equal first. "before" = commit `c91472a`.

| Fixture | Parts | Interference before → after | Clearance 20 mm before → after |
|---|---:|---:|---:|
| 400 mm grid | 200 | 1.806 → 0.639 | 4.292 → 0.231 |
| 400 mm grid | 1000 | 60.489 → 9.027 | 147.543 → 1.692 |
| 20.4 mm near-touch | 120 | 1.588 → 0.735 | 2.966 → 0.588 |
| Dense cluster | 60 | 4.454 → 4.542 | 0.577 → 0.694 |
| Mixed primitives | 12 | 0.121 → 0.113 | 0.065 → 0.084 |
| Non-finite | 3 | 0.024 → 0.022 | 0.005 → 0.006 |

Sparse assemblies gain 2.8× (interference) to 87× (clearance); dense and tiny inputs pay a constant 0.01–0.12 ms sorting/bucketing overhead. A separate 500-part fully overlapping case improved rather than regressed (interference 97.3 → 38.8 ms, clearance 37.9 → 27.6 ms) because the X window is bounded by part size.

Layout wall clock for the 101-part six-station screw machine (`resolveLayout`, `clearanceMm: 40`): **494.5 → 284.4 ms** (measured before any change and after both solver changes). Four-station dispenser 224.4 ms and PV turner 77.7 ms were only measured after the change; no before value was captured for them.

## Verification

- New broad-phase equivalence test plus geometry rescreens: 55/55 passed.
- CLI goldens: 28/28 passed.
- Full desktop suite in an owned-process supervisor, `--test-concurrency=4`: **3903 total, 3900 passed, 0 failed, 3 skipped, 59.1 s** (previous iteration: 3889 total, 66.7 s). Every run ended with `remaining: []`.
- `./node_modules/.bin/tsc --noEmit` and `npm run build:ext` passed.

## Remaining boundaries

Pair enumeration is still O(n²) inside dense windows: the filter bounds work by spatial extent, not asymptotically. `resolveConflicts` still re-screens the whole assembly after each single-part move; incremental per-part screening is the next real step and needs its own equivalence proof. Timings are local and load-sensitive; no B-rep, Windows or remote-CI claim is made here.
