# Project recovery delivery

## Changed
Implemented staged/journaled project save with rollback and interrupted-save recovery, unique parts and collision-safe project names; versioned workspace snapshots; optimistic session revisions, fsync/rename state writes, prior valid backup and explicit repair preserving corrupt bytes; serialized comparison-based autosave; renderer state restore and startup recovery button; pure browser-compatible machine validator. Added behavioral tests and real Electron cold-restart smoke. Existing machine E2E now reports load errors explicitly.

## Now true
Final full suite: 3,255 total, 3,252 passed, 3 skipped, 0 failed. TypeScript and production Vite/Electron/MCP builds passed. IPC boundary guard and diff whitespace check passed. Standalone real Electron smoke exited 0, verifying save-as/poll/IO/features/kinematics/camera/reopen/cold recovery/Node isolation. Native machine E2E steps1–11 pass including 85→106 mesh switch.

## Remains
No unfinished work in the supported local project-state contract. Excluded: arbitrary unsaved base mesh edits, global infinite-canvas/design drafts, live hardware state, global module settings and portable archive apply. Parameter JSON recovery is not proof of successful real-kernel rebuild. Windows installer/native hardware acceptance not run.

## Shipping blockers
None for this supported feature scope. Whole existing machine E2E is not green: step12 transfer PLC precheck rejects missing emergency-stop data; safety refusal is preserved and reported, not bypassed. No full-product release acceptance is claimed. Feature changes are local; not committed/pushed.

## Exact next steps
Review diff and feature scope. From desktop run `npm test && npm run build:ext && node scripts/project-session-smoke.mjs && node scripts/check-ipc-boundaries.mjs`. For full existing machine E2E, define valid emergency-stop signals in its transfer fixture/requirements before expecting PLC generation. Commit/push through authorized process.
