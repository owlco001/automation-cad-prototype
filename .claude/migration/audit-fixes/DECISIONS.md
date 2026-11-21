# Decisions

1. Baseline is ae85fe8, not the original local branch 283b81f. The old destructive same-name project save issue is already fixed and excluded.
2. FeatureTree audit revisions remain monotonic. Undo/redo use separate persisted edit checkpoints. Multi-step jumps retain one inverse checkpoint to preserve the existing tested contract.
3. FeatureTree writes and initialization serialize per Store. Rebuilds use private geometry keys; persistence succeeds before state/geometry key publication and notifications. Discarded and superseded sidecar keys are explicitly released.
4. Authorizations must not use approximate project fingerprints as security identities. Agent scope decisions and cancellation semantics require behavior tests.
5. Windows Core is a local packaging pilot excluding Qt, not a dynamic module installation system. It has separate app metadata, local user/session data and ports, and cannot use the Full update feed. Full packaging remains unchanged; real Windows installation/coexistence and size acceptance remain pending.
6. On 2026-11-21 the user explicitly authorized committing and pushing the current reviewed work to GitHub. Push only fix-audit-findings to the explicit GitHub URL because origin also has a Gitee push URL. Do not merge main or deploy. Night runner's separate joints optimization copy is not included until separately reviewed and integrated.
