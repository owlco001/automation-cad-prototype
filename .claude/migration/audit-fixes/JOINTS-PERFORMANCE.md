# Joint-rule precomputation iteration

## Scope
Continue `fix-audit-findings` from the current worktree. Optimize `declaredJoints` so naming rules and sensor ownership are evaluated once per part instead of once per part pair. No external interface, first-match priority, sensor-stem semantics, output order, duplicate-ID behavior, tolerances or geometry policy changed. No spatial index, layout counting mode, FeatureTree pagination, dependency change, commit, push or deployment.

## Approach
- Freeze the old implementation in `desktop/test-support/joints-baseline.ts` as a test-only oracle.
- Build one profile per input index: a six-bit `a` mask, a six-bit `b` mask, `sensor-<key>-bracket` stem and `sensor-*` body flag. Regexes run once per part per rule side, never per pair.
- For a pair, `(aMask & b.bMask) | (b.aMask & a.bMask)` is the set of matching rules; the lowest set bit is the old `RULES.find(...)` first match. The sensor rule is checked only when no naming rule matches.
- Enumerate only parts that can be one end of a connection: a rule side, a sensor bracket, or a sensor body whose stem exists in the input. Candidates stay in original input order, so the `i<j` output order is unchanged. Duplicate IDs remain separate indices and are not deduplicated.
- No cross-call cache: in-place edits cannot leave stale rule/sensor profiles.

## Correctness evidence
`desktop/test/machine/joints-equivalence.test.mjs` compares complete ordered arrays against the frozen oracle for:
- both orientations of all six naming rules;
- parts whose IDs belong to multiple rule sides (`frame-leg-*`, `*-upright-[lr]`) and first-match reasons;
- same-stem sensor bodies, `-tx`/`-rx`, foreign stems, bracket×bracket, body×body and `sensor-*` lookalikes;
- duplicate IDs, missing/null/numeric IDs and empty strings;
- 300 deterministic random inputs (0–35 parts, mixed valid/invalid IDs);
- sparse and named fixtures at 0/1/2/17/80/500 parts, named dense 80/120, and four real machine samples (screw, assembly with light curtains, PV turner, PV transfer).

The same test pins SHA-256 hashes of the complete interference and clearance JSON captured with the old joints implementation for the screw, assembly, PV turner, PV transfer and named-dense-120 cases. All inputs are checked unmutated.

`desktop/scripts/bench-joints.mjs` mounts the frozen oracle as `src/machine/joints.ts` in a temporary copy, then compares complete ordered joints/interference/clearance reports (full JSON SHA-256 and pair counts) for every benchmark scenario. The temporary copy is inside the workspace and removed in `finally`/on exit; no Git metadata or dependency symlink is written.

## Benchmark
Command (from `desktop`):

```
JOINTS_BENCH_ITERATIONS=7 node --expose-gc --max-old-space-size=4096 scripts/bench-joints.mjs
```

Node v26.7.0 / Linux x64. Two warmups per implementation, 7 measured calls, baseline/current order alternated, GC available. p50 milliseconds; “candidate” is participant parts / candidate pairs (out of all pairs). All 12 scenarios reported `equivalent: true` for complete joints, interference and clearance JSON. The host load average was about 1.6 during the final run; old/new are compared within the same interleaved run. An initial quick pre-change measurement of sparse `declaredJoints` was 41.04 ms (500) and 146.58 ms (1000), consistent with the formal baseline below.

| Scenario | Parts | Participants / candidate pairs / all pairs | Joints old → new | Interference old → new | Clearance old → new |
|---|---:|---:|---:|---:|---:|
| sparse | 500 | 0 / 0 / 124,750 | 40.270 → 0.243 ms | 64.269 → 13.139 ms | 85.564 → 43.112 ms |
| sparse | 1000 | 0 / 0 / 499,500 | 158.235 → 0.409 ms | 201.386 → 44.924 ms | 342.689 → 191.717 ms |
| dense | 500 | 0 / 0 / 124,750 | 39.567 → 0.197 ms | 88.353 → 49.470 ms | 118.559 → 74.491 ms |
| dense | 1000 | 0 / 0 / 499,500 | 154.141 → 0.413 ms | 287.229 → 132.600 ms | 425.030 → 274.963 ms |
| named sparse | 500 | 473 / 111,628 / 124,750 | 45.881 → 1.765 ms | 60.008 → 18.130 ms | 92.032 → 49.693 ms |
| named sparse | 1000 | 942 / 443,211 / 499,500 | 172.215 → 5.682 ms | 241.907 → 66.139 ms | 414.734 → 246.223 ms |
| named dense | 500 | 473 / 111,628 / 124,750 | 44.272 → 1.653 ms | 97.629 → 55.130 ms | 127.965 → 82.826 ms |
| named dense | 1000 | 942 / 443,211 / 499,500 | 170.216 → 5.956 ms | 332.465 → 170.026 ms | 521.355 → 335.426 ms |
| real screw | 56 | 39 / 741 / 1,540 | 0.721 → 0.084 ms | 1.782 → 1.017 ms | 2.380 → 1.834 ms |
| real assembly | 45 | 24 / 276 / 990 | 0.400 → 0.060 ms | 1.470 → 1.125 ms | 1.030 → 0.621 ms |
| real PV turner | 87 | 1 / 0 / 3,741 | 1.251 → 0.055 ms | 2.695 → 1.643 ms | 2.821 → 1.741 ms |
| real PV transfer | 109 | 2 / 1 / 5,886 | 1.965 → 0.054 ms | 3.774 → 2.019 ms | 3.964 → 2.279 ms |

An earlier interleaved run under host load ~5 produced higher absolute values (sparse 500 joints 55.642 → 0.323 ms; named dense 1000 joints 178.974 → 6.033 ms) with the same equality results; p50 values are local and load-sensitive.

The PV turner has no rule-matching joint pairs; its interference delta (2.695 vs 1.643 ms) is timing noise on a no-match workload, and the complete report is identical. Interference/clearance remain O(n²); the end-to-end gain comes from removing tens to hundreds of milliseconds of per-pair regex work before those loops.

Raw artifact: `.claude/migration/audit-fixes/baselines/joints-benchmark-2026-11-20.json`.

## Verification

Executed in the main `fix-audit-findings` worktree after porting only the joints files (the isolated night copy predates the Core packaging work and was not merged wholesale):

- New equivalence test: 7/7 passed.
- Joints/interference/clearance/layout targeted set: 43/43 passed, including `interference-equivalence.test.mjs`, which pins the complete pre-optimization report hashes and therefore also proves the joints change left interference/clearance output byte-identical.
- `./node_modules/.bin/tsc --noEmit`: passed.
- `npm run build:ext` (tsc, Vite, Electron/MCP bundles, bundle-size gate): passed. The night copy could not run this because Vite's bundled-config loader writes `node_modules/.vite-temp` through a read-only dependency symlink there; that restriction does not apply to the main worktree.
- Benchmark re-run with `JOINTS_BENCH_ITERATIONS=5`: `allEquivalent: true` for all 12 scenarios, and the temporary source copy was removed (no `.bench-joints-*` remained).
- Full desktop suite in an owned-process supervisor, `node --test --test-concurrency=4`: 3889 total, 3886 passed, 0 failed, 3 skipped, 66.7 s. Every run reported `remaining: []`, so no test-owned processes survived.
- `git diff --check` passed.

## Remaining boundaries
Pair enumeration is still quadratic for participant-heavy inputs; a spatial index or rule-group enumeration is a separate change. This iteration does not claim B-rep truth, Windows/native-kernel acceptance, remote CI, or a full performance improvement in layout optimization beyond the measured screening calls. Local timings are host-load sensitive and are not a universal latency claim.
