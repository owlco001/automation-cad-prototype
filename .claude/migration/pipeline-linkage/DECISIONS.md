# Pipeline/linkage decisions

1. Timed parallel preview is not silently converted to serial PLC. Event-driven serial conversion rejects overlap. Full parallel PLC scheduling and scan-equivalence remain explicitly unsupported; no claim of hardware-ready equivalence.
2. Dual extend/retract coils get direction-specific half-cycle preview phases. PLC conversion selects one known drive and resets its opposite, rejects ambiguous outputs, and chooses only explicit/unique direction-bound sensors.
3. Audit uses generated structured sets/waits and typed usage. Missing waits or evidence fail; comments/tokens do not establish a safety gate. Static reset coverage is not wiring or safety certification.
4. All geometry mutation stages precede boolean/motion/linkage derived outputs. Final geometry revision binds linkage/motion audit; one linkage and motion calculation are reused. Preview CSV remains available even if PLC generation is rejected and labels its semantics.
5. Identical design content does not imply active selection or requested artifacts are complete. Shared apply path preserves bytes but updates pointer and fills outputs; BOM batches track successful appends per command bus. File failures compensate and late successful cancellation retains undo and committed status.
6. Installed Electron uses packaged pipeline resolver, bounded child output, actual timeout and close-settlement. Caller passes explicit packaged/resources context.
7. Sparse pose fields mean baseline zero. Playback interpolation uses zero for omitted fields and supports activeStepNos for parallel highlight.
