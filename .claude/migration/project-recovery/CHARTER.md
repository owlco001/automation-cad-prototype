# Project session recovery

Mission: make saved CAD-library projects preserve editable document state and durably autosave subsequent state changes, with a visible restart recovery entry.

Supported scope: project-owned per-part STL, commissioning machine configuration and full available machine design, editable IO point addresses, parameter documents, kinematics bound to the exact saved mesh sequence, and viewport camera. Explicitly exclude live PLC connections/writes, running simulation, credentials, global module preferences, global infinite-canvas/design drafts and portable archive application. Disabled parameter modules retain inert saved documents until enabled.

Invariants: no automatic hardware connection; no mismatched geometry/kinematics application; failed saves preserve previous project; revision conflicts do not overwrite; stale asynchronous opens/saves cannot replace a newer session; auto-save does not rewrite mesh assets. Old projects still open with a clear legacy-state notice. Existing portable archive remains read-only preview.

Slices: atomic project storage; validated session contract and revisioned session store; renderer autosave controller; renderer capture/apply and startup recovery; closeout.

Ship gate: targeted behavioral tests (snapshot, storage, autosave, project save failures); full Node suite; TypeScript; desktop build; headless Electron recovery smoke when environment supports Electron. Record any unverified native surfaces explicitly.
