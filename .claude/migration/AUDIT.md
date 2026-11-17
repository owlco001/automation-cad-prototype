# IPC boundary audit

## Method and inventory
Inspected repository README, desktop package scripts, TypeScript configuration, CI, main process bootstrap and IPC helpers; ranked JS/TS files by line count; searched tests for direct helper coverage. Repository has 1,000+ tracked/source assets spanning the web prototype, Electron, Qt and geometry services.

## Findings and leverage
- High: existing domain modules and Node behavioral tests; preserve their contracts and dependency versions.
- Medium: desktop/electron/ipc.ts (2,459 baseline lines) combines channel registration and domain input validation. Six inline synchronization/PLC validator declarations can move with no Electron dependency.
- Low: testability of those inline validators: no direct boundary tests found. Replace this constraint with independently imported domain modules and behavioral tests.
- Deferred hotspot: desktop/electron/main.ts (5,952 baseline lines) embeds a large headless smoke suite in window startup. Extracting that suite needs a separate migration with Electron coverage.
- Other candidate: PDF helpers in IPC; deferred because their window lifecycle and module-gate behavior require native smoke verification.

## Frozen metric
Pattern `^function (?:syncBytes|syncText|syncBom|parseSyncPlcPayload|parseSyncPayload|plcExportFiles)\(` scoped to desktop/electron/ipc.ts: 6 baseline declarations, final budget 0. Each regex match counts once. RATCHETS.yaml is consumed by desktop/scripts/check-ipc-boundaries.mjs and CI.

## Critical workflows and edge cases
Sync upload must preserve strings, ArrayBuffer input and byteOffset/byteLength for typed views. BOM normalization trims text and defaults missing/nonfinite quantities; downstream package validators retain responsibility for positive integer quantities. Optional PLC fields preserve validation order and existing Chinese messages. PLC export counts all UTF-8 bytes across files, accepts at most 200 files and at most 20 MiB, and normalizes ZIP-relative paths.

## Translation reference
| Before | After |
| --- | --- |
| Inline parseSyncPayload in Electron IPC | Import from src/sync/upload-payload.ts |
| Inline plcExportFiles in Electron IPC | Import from src/plcgen/export-files.ts |
| Electron-only test access | Node direct imports of domain modules |

Implementations are extracted verbatim. Do not consolidate syncBytes with exportPayload: their Uint8Array handling and accepted string inputs differ. Do not tighten BOM or PLC target validation in this behavior-preserving slice.

## Evidence
Baseline: TypeScript check passed; 3,202 tests total, 3,199 passed, 3 skipped, 0 failures. New tests failed before extraction (missing modules), then all 9 passed after extraction. Full final verification is recorded in HANDOFF.md and SHIP_CHECKLIST.md.

## Manual-only surfaces
Native Windows application installation, real CAD kernels and Electron visual/PDF flows are outside this domain-only slice; no acceptance claim is made for those surfaces.
