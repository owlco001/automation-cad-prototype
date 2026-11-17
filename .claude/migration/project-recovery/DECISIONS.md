# Decisions

1. Local project recovery uses a separate schema1 snapshot/envelope, keeping strict portable archive v2 candidate-only compatibility.
2. Saved STL sequence is content-bound; local index annotations are restored only against exact signature. Library projects clear imported CAD identity and object mappings. Portable export stays unavailable until a real source CAD identity is loaded.
3. Geometry save stages a complete directory and uses journal/backup rollback. State autosave uses atomic fsync/rename and prior valid backup. Synchronous one-main-process writers are supported; cross-process lock and complete-directory power-loss durability are not claimed.
4. Preserve corrupt session bytes; backup repair requires explicit user action and revision match. Reject invalid snapshots without silently overwriting them.
5. Polling compares lightweight state and serializes writes; baseline is acknowledged persisted data, not a new live capture after asynchronous save. Session epochs invalidate stale completions.
6. Hardware connections, live values/writes, credentials, global module settings, infinite-canvas drafts and arbitrary unsaved scene mesh edits are excluded. Parameter JSON is retained when its module is disabled.
7. Renderer requires pure machine validation: move existing bodies unchanged from machine/store to design-validation, keeping public reexports. Normalize partial electrical bridge summaries with current config before saving.
8. Native machine E2E passes 85→106 part model switch after snapshot allowlist and bridge normalization fixes; later transfer PLC test rejects missing emergency-stop definitions. This precheck remains enabled; no bypass or success claim for that downstream step.
