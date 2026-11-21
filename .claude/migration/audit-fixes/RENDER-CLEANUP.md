# Render task lifecycle iteration

## Problem and scope

A stale SwiftShader GPU process from November 18 consumed approximately 6.8 logical CPU cores on the 8-core host. Existing E2E cleanup checked the launcher exit code/CDP availability rather than descendants; its watchdog killed only the launcher. Parametric sidecars deliberately create independent process groups, so killing only the Xvfb launcher group could leave test stubs alive.

This iteration changes the test launch/cleanup paths, not production CAD geometry or the sidecar process policy. User-owned November 17 instances were preserved. The separately identified previous audit-owned Node stub was terminated after verifying its exact executable and script identity.

## Implementation

- `scripts/lib/owned-process.mjs`: unique inherited ownership markers, hierarchical across nested launchers. Linux /proc discovery finds marker-bearing descendants even after reparenting or detached sidecar launch. Signals recheck PID start time and executable identity. Cleanup waits for spawn acknowledgement, is idempotent, bounded, sends TERM then KILL, and fails if live members remain. It never skips cleanup merely because the launcher already exited. A separate read-only ownership query enables supervisors to verify before emergency cleanup.
- `scripts/electron-run.mjs`: tracks Electron ownership and awaits descendant cleanup on normal exit, spawn failure, SIGINT and SIGTERM.
- `scripts/machine-e2e.mjs`: uses owned launches; aborts startup/CDP waits/tool-result waits on cancellation/watchdog/early launcher exit; closes local HTTP connections; attempts Electron's normal Browser.close before bounded final cleanup; emits success only after cleanup succeeds. Screenshot/evidence directories are preserved; optional userData deletion is restricted to the verified task temp directory and only after process cleanup succeeds.
- CDP calls have bounded deadlines, pending calls reject on disconnect/abort, and listeners/timers are removed on termination.
- `scripts/verify-render-cleanup.mjs`: actual Electron + Xvfb + local model/geometry stubs; isolated owner/userData/ports; supervisor checks no owned descendants and no responding task CDP/model ports before its separate emergency cleanup. Scenarios: success, SIGTERM after model build, launcher SIGKILL after model build, startup timeout. Screenshot validation is retained.
- CI smoke job runs the real lifecycle verification after the current-build material gate.

## Verification

- Five lightweight ownership tests cover ordinary descendants, immediate cancellation, already-exited launcher with stubborn detached worker, unrelated same-name instance preservation, invalid/unregistered handles and spawn errors (the orphan/identity cases are Linux-specific).
- Focused ownership/material script tests passed.
- Full desktop suite with fixed concurrency=4: 3871 total, 3868 passed, 0 failed, 3 skipped, 63.4 seconds. `/root/workspace/automation-cad-cleanup-full.log`.
- TypeScript/Vite/Electron/MCP production build passed: `/root/workspace/automation-cad-cleanup-build.log`.
- Initial actual lifecycle verification passed all four scenarios with zero survivors: `/root/workspace/automation-cad-render-cleanup-final.log`.
- Final-built lifecycle verification and process inventory are recorded in HANDOFF.md after completion.

## Boundaries

Linux process identity/ownership and real rendering paths were exercised. Windows uses taskkill /T for a live root and other POSIX platforms use process-group cleanup; they were not exercised here and do not have the same detached-orphan /proc verification. Arbitrary children that deliberately remove the ownership environment marker require another ownership mechanism (such as a cgroup/job object). SIGKILL of every supervisor at once cannot execute a finally handler. No OS-wide name-based kill or deletion of user project data is used.

Reproduce from desktop:

- `node --test test/scripts/owned-process.test.mjs test/meta/transfer-material-gate.test.mjs`
- `node scripts/verify-render-cleanup.mjs`
- `node --test --test-concurrency=4`
- `npm run build:ext`
