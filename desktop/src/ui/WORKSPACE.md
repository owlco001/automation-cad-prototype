# Desktop workspace navigation

The desktop shell adds four workflow contexts: Design/Assembly, Electrical, PLC/Commissioning, and Checks/Delivery. Each shows currently available shortcuts to existing tools; the Tools menu retains every registered entry under five named groups. Legacy mode tabs stay on a secondary row. Entry IDs and click listeners are preserved, including module gates and drawer toggles.

A shared project context bar follows the user into the CAD overlay and back. It distinguishes unsaved imports, saved projects and conceptual geometry; save status is the actual autosave result, with retry/repair actions retained. Names are rendered as text. Geometry badges describe provenance rather than promising a passed geometry check.

CAD uses exclusive Inspection/Kinematics/Parametric panels and Collapse. Arrow/Home/End keys move among available tabs. External drawer APIs update the tab selection; disabling parametric falls back to inspection. Collapsing or switching panels preserves their existing contents.

Controllers: workspace-nav.ts, project-status.ts and cad-inspector.ts. Styling: workspace.css injected by extension.ts. Root web prototype files are unchanged. Real Electron smoke additionally verifies panel exclusivity, context-bar mounting and no document overflow at 1100px while preserving the project recovery scenario.
