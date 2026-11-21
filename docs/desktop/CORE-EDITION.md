# Windows Core pilot

This is a local packaging pilot, not an independently downloadable module system. Existing Full packaging/release settings remain unchanged. Core excludes the bundled Qt native workbench and retains the desktop workspace, CAD viewer/WASM, data packs, DWG resources and machine pipeline. The desktop JavaScript features are still bundled together.

## Commands (from desktop)

- `npm run build:ext`: build current application bundles.
- `npm run dist:win:core -- --dry-run`: inspect effective standalone Core config/arguments, without invoking packaging or downloading tools.
- `npm run dist:win:core`: prepare local pipeline/DWG inputs and run Windows x64 NSIS packaging. Electron Builder may need platform tools; this command was not exercised for a Windows artifact in the current Linux environment.
- Existing `npm run dist:win` remains the Full target and still requires Qt.

Core uses a standalone Electron Builder config file, rather than an object overlay which would concatenate `extraResources` and accidentally bring Qt back. Core appId is `cn.automationcad.desktop.core`; product/executable/installer names and `release-core` output are separate. Package metadata declares `automationCadEdition: "core"`. Publishing is disabled at root, Windows and NSIS levels and CLI forces `--publish never`; Full update feed metadata is not generated for Core.

Qt open attempts use the actual packaged resources check. Missing Qt produces a clear notice while other desktop features remain usable. Packaged applications do not trust `AUTOMATIONCAD_QT_EXE` to launch an arbitrary executable. This pilot does not install a Qt extension afterward; use the trusted Full installer if Qt is required. It does not measure compressed installer savings, and an app-level module switch still does not uninstall its code.

## Release acceptance still required

No Windows NSIS installer was built, installed or uninstalled during this pilot. Before distributing Core:

1. Inspect actual unpacked resources: no `qt/` and no `app-update.yml`; required packs/web/WASM/DWG/pipeline resources present. Inspect asar metadata and ensure reused output cannot inject stale update files.
2. Install Full and Core on a Windows test machine, verify separate install/uninstall entries, userData/session directories and service ports; uninstall Core and confirm Full remains usable.
3. Open/save existing projects offline, use CAD viewing, and attempt Qt launch to confirm truthful missing-runtime guidance.
4. Confirm Core update operations remain unavailable and never contact the Full update feed.
5. Measure installer download size, installed footprint, cold startup and first feature use against Full. Do not infer those savings from resource-folder sizes.

This pilot does not migrate Full user settings or projects automatically, introduce executable plugin loading, claim code signing, or publish a release.
