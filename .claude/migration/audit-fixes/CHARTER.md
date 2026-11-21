# Audit fixes charter

## Mission
Fix the twelve confirmed findings from the deep review against main ae85fe8 without changing unrelated product behavior.

## Critical workflows and external surfaces
FeatureTree HTTP/MCP edits, optimistic revisions and geometry readback; undo/redo and restart recovery; cost JSON import/report/export; component search and ZIP installation; MQTT browse/read/subscribe; layout advice; Agent UI/RPC/MCP approval and cancellation; model settings; CI-generated material screenshots.

## Invariants
Preserve the original checkout and its uncommitted files. Work only on fix-audit-findings in the independent main worktree. No push/deployment. No new dependency without justification. Invalid writes never publish state; requests must not silently repeat effects. Existing valid inputs remain compatible unless the old behavior contradicts a confirmed contract.

## Non-goals
Qt redesign, hardware commissioning, new CAD kernel features and unmeasured performance rewrites. Existing performance hotspots are follow-up work after correctness.

## Guardrails
Independent task write scopes; Lead owns FeatureTree, integration and closeout. Add behavioral regressions before claiming a finding fixed. Remove replaced paths in the same slice. No source-shape assertion as sole proof of runtime behavior.

## Ship gate
Run SHIP_CHECKLIST.md and report skipped hardware/native coverage. Completion means all twelve findings have a fix and relevant evidence, with no required unfinished teammate work.
