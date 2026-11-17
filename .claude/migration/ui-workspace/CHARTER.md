# Workspace UI improvement

Mission: unify navigation, persistent project context/save status and CAD inspector layout without replacing existing functional buttons or event handlers.

Scope: desktop extension/UI styles and controllers, UI behavioral tests and Electron smoke. Preserve root prototype files, all module gates, project save/recovery, keyboard reachability and original tool IDs.

Workflows: choose design/electrical/PLC/delivery context; activate existing tools; open CAD and switch inspection/kinematics/parametric panels; see project identity/geometry source/save failures in all workspaces; save/recover project.

Ship gate: UI unit tests, TypeScript, complete suite, desktop build, real Electron recovery smoke plus navigation/panel layout checks at wide/narrow sizes and screenshots. Changes layer on prior local recovery feature; do not discard it.
