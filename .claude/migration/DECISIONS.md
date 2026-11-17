# Decisions

## 1. Bound the migration to two IPC domain boundaries
Keep product behavior and channel registration intact. Move synchronization parsing into src/sync/upload-payload.ts and PLC export validation into src/plcgen/export-files.ts. Native window/report logic and bootstrap restructuring require their own acceptance coverage and remain outside this charter.

## 2. Preserve existing input semantics
Extract bodies verbatim, including error order, BOM fallback semantics and view offsets. Additional validation would be a behavior change and needs a separate decision and tests.

## 3. Guard the ownership boundary without a dependency
Store ratchets as JSON-compatible YAML and load them with Node's JSON parser. CI prevents the removed inline declarations from returning. New tests exercise boundary behavior rather than source layout.
