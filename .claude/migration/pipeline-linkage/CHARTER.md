# Pipeline and linkage correctness

Mission: remove falsely aligned/successful pipeline and PLC results, preserve coherent activation and cancellation, and make installed linkage execution and playback reliable.

Invariants: opposing outputs never energize together; parallel timed previews are never silently converted into equivalent serial PLC programs; missing waits/safety evidence fail audit; final geometry owns all derived checks; canceled committed work remains undoable; packaged app uses packaged pipeline. Live hardware acceptance is not claimed.

Slices: PLC conversion/audit; command activation/cancellation/rollback; installed bridge; linkage direction/timing and sparse playback; CLI finalization and version binding; convergence (tests/build/native smoke/documentation).

External surfaces: CLI JSON, mapping/PLC files, IPC linkage response, current machine pointer, undo stack, playback frames. Retain compatible reads where meaningful, explicitly reject previously ambiguous unsafe conversions.

Verification: focused regression tests including dual coils, parallel schedules, missing waits/comment-only safety, A/B/A, false-to-true artifact options, cancel-after-commit, installed bundle fixture, sparse poses, short cycles and combined geometry flags; full Node suite; build and real Electron recovery/UI smoke.
