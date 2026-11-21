# Verification checklist

- [ ] FeatureTree: `node --test featuretree-service/transaction-tests.mjs`
- [ ] FeatureTree existing acceptance: `node featuretree-service/store-tests.mjs && node featuretree-service/tests.mjs && node featuretree-service/mcp-tests.mjs && node featuretree-service/multidoc-tests.mjs && node featuretree-service/persistence-tests.mjs`
- [ ] FeatureTree sidecar geometry version tests and real-kernel acceptance if runtime exists; record unavailable kernel explicitly.
- [ ] Run teammate-provided focused domain/Agent/CI behavioral regressions.
- [ ] In desktop: `npm test`.
- [ ] In desktop: `npm run build:ext` (includes TypeScript, Vite, Electron/MCP bundle and size checks).
- [ ] In desktop: `npm run packs:validate`.
- [ ] Generate a current transfer screenshot in a temporary output directory and run the material gate on that image.
- [ ] `git diff --check`; inspect final diff and ensure original checkout changes were preserved.
- [ ] Document exact evidence, remaining limitations and handoff. Do not claim Windows/hardware validation without running it.
