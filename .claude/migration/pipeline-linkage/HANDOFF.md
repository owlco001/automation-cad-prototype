# Pipeline/linkage delivery

## Changed
Direction-specific opposed-coil preview steps; invalid/short timing rejection; structured PLC drive/wait/safety audit; overlap conversion refusal; final geometry phase ordering/revision and shared linkage/motion; preview timing CSV semantics; packaged Electron pipeline resolution/output budgets/timeout cleanup; sparse zero interpolation and concurrent highlights; coherent idempotent activation/artifact completion; rollback and committed cancellation undo.

## Now true
Full suite 3,308 total, 3,305 pass, 3 skipped, 0 failed. Focused final contract46 pass. Desktop TypeScript/Vite/Electron/MCP build passed. Actual build-pipeline bundle smoke passed. Real Electron project/UI recovery smoke passed. IPC guard0 and diff check passed.

## Remains
Full parallel PLC scheduler, scan-level clock-equivalence with 3D, cumulative multi-cycle rotary motion, actual hardware commissioning and safety certification are not implemented or claimed. Current linkage is explicit schematic preview; serial PLC is event-driven and cannot silently accept overlap. Portable old fixtures with unlabelled dual limit sensors must supply directional roles rather than rely on first-sensor guessing.

## Shipping blockers
None for corrected supported contract. Do not market timed parallel preview as executable equivalent PLC. Feature changes remain local atop prior recovery/UI work, not committed or pushed.

## Exact next steps
Review combined patch. From desktop npm test; npm run build:ext; node scripts/build-pipeline.mjs; node scripts/project-session-smoke.mjs. Before hardware usage, complete application-specific sensor/coil semantics, safety design and independent commissioning validation.
