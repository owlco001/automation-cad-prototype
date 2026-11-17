# Native bundle optimization — round 2

Measured main bundle composition with esbuild metafile. Largest dependency groups include OPC UA types/address-space/server and client code. They were not removed or externalized: runtime/installer dependency behavior requires independent protocol testing. Applied esbuild minify:true and keepNames:true to main/preload/MCP to reduce bytes while preserving reflected names and source maps (maps already excluded from installer).

| File | Before bytes | After bytes | Reduction |
|---|---:|---:|---:|
|main.cjs|12718779|6796610|46.56%|
|mcp.cjs|2042838|1419520|30.51%|
|preload.cjs|17694|13299|24.84%|

Cold V8 compilation measured with12 separate Node processes each, read file before timer, new vm.Script(source): main unminified p50 139.38ms/p95 170.17ms; minified p50 90.39ms/p95 122.75ms. Median reduction35.15%. This is script compilation only, not application launch latency. Same-process initial measurement was discarded because V8 caching invalidated it.

Validation: production TypeScript/Vite/Electron/MCP build; real Electron external-WASM STEP import plus full save/poll/reopen/cold recovery smoke; MCP smoke; all exit0. Build guard now caps main8MB/MCP1.7MB/preload25KB in addition to renderer/WASM checks. No new dependencies or package exclusions. No full installer size claim.
