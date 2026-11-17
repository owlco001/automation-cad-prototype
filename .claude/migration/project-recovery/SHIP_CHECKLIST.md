# Verification checklist

- [x] Targeted session/project storage/controller tests passed (60 before generated-feature regression addition).
- [x] Generated real conveyor assembly snapshot regression passed (7 snapshot tests).
- [x] Pure snapshot bundled with esbuild platform=browser without Node imports.
- [x] TypeScript check passed.
- [x] Desktop Vite/Electron/MCP build passed.
- [x] Real Electron standalone project-session smoke exited 0: save-as, polling, IO, feature tree, kinematics, camera, reopen, cold restart recovery and renderer Node isolation.
- [x] Native machine E2E steps 1–11 passed, including 85-part turning model and 106-part transfer model switch. Full machine E2E is NOT counted as pass: step12 PLC precheck refuses missing emergency-stop definition.
- [x] Unrelated screenshot fixtures restored; test screenshots redirected outside repository.
- [x] Final full suite: 3,255 total; 3,252 passed; 3 skipped; 0 failed. Final production build passed.
- [x] Final git diff --check and IPC boundary guard: passed; inline validator budget remains 0.

Limits: no Windows native installer acceptance; no real CAD kernel reconstruction acceptance (native machine E2E uses its existing kernel stub); no live hardware tests. Global drafts and arbitrary unsaved mesh edits are outside the recovery contract.
