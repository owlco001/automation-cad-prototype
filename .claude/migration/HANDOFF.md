# Handoff — IPC domain boundary refactor

## What changed
Extracted six inline validators from desktop/electron/ipc.ts into desktop/src/sync/upload-payload.ts and desktop/src/plcgen/export-files.ts. Added 9 behavioral tests, a zero-budget architecture guard and a CI step. Recorded audit, scope, decisions and verification in this directory.

## What is now true
IPC imports the two domain entry points. Original function bodies are preserved exactly except export keywords. Binary offsets, BOM defaults, error messages, file count and UTF-8 byte limits are covered without starting Electron. Full suite: 3,211 tests, 3,208 passed, 3 skipped, 0 failed. TypeScript and desktop/MCP builds passed. Both slices are done.

## What remains
Outside the charter: large bootstrap/headless smoke suite in main.ts, PDF helper extraction, browser bundle sizing. No unfinished work in this bounded migration. Native Windows, Qt and real CAD kernel acceptance was not run.

## What blocks shipping right now
None for review of this bounded refactor. Full product release acceptance still requires its platform-specific checks. Changes are local and have not been pushed to GitHub.

## Exact next steps
1. Review the patch and the two extracted modules.
2. From desktop: `node scripts/check-ipc-boundaries.mjs && npm test && npm run build:ext`.
3. Merge or push through the repository's usual review process when authorized.
