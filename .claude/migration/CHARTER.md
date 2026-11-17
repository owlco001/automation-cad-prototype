# IPC boundary refactoring charter

## Mission and scope
Extract synchronization upload parsing and PLC export file validation from Electron IPC into their owning domain modules, preserving all existing behavior.

## Critical workflows and external surfaces
- Synchronize BOM, HTML, GLB, DXF and optional PLC programs via existing IPC channels.
- Export PLC source files with normalized relative ZIP paths and the existing count/UTF-8 size limits.
- Keep channel names, payloads, Chinese error messages, feature gates and downstream package validation unchanged.

## Invariants
No UI or root prototype changes. No dependency changes. Existing tests and type checks must not regress. Preserve validation order and binary view offsets.

## Non-goals
Full application rewrite; changes to Qt, geometry kernels, update installation, PDF rendering or product behavior. The large bootstrap and smoke suite are outside this bounded migration.

## Guardrails
Delete original implementations in the same slice; track touched paths in MAP.csv; run the scoped architecture guard in CI; no temporary adapters.

## Ship gate
Execute SHIP_CHECKLIST.md. Existing baseline failures must be distinguished from introduced failures. Native Windows/Electron acceptance is not claimed by this domain-only refactor.
