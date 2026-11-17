# Workspace UI decisions

1. Reuse existing tool buttons via live proxy clicks; preserve their IDs, listeners, module gates and toggle behavior. Five menu groups mirror workflows; four primary workflow buttons select domain/context shortcuts.
2. Keep existing mechanical/electrical mode controls on a secondary row instead of removing reachable modes. Avoid changing the root prototype HTML/JS/CSS.
3. One project-context bar moves between the shell and CAD overlay. It shows current document stage, geometry provenance and real autosave error/status; it moves original status/recovery buttons rather than cloning them. CAD includes workflow proxies to exit into shell contexts.
4. CAD right panels remain their existing nodes, controlled by one accessible tab strip; only inspection, kinematics or parametric is visible. A collapse action returns viewport space. Existing close/open APIs synchronize through a mutation observer. Disabled modules disappear and select a valid fallback.
5. New responsive desktop stylesheet is injected by the extension. At narrow sizes, wrap navigation and status controls rather than showing unlabeled icons. Keep focus outlines, text status and source qualification.
6. Screenshot artifact captured in real Electron. Current model cannot ingest images, so claims are based on DOM/layout assertions and native functional checks, not an unperformed visual aesthetic review.
