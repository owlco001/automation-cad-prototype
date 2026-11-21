# FeatureTree history storage iteration

## Scope and decision

After the transaction fixes, runtime undo/redo used dedicated persisted checkpoints but the Store continued to retain and save a second full document array indexed by audit revision. No runtime call site consumed that array; only legacy archive migration needed it. This iteration removes the redundant runtime array and disk field without limiting edit history or changing HTTP/MCP envelope fields.

New storage records declare `formatVersion:2` and contain current document, revision, complete audit history and undo/redo checkpoints. FeatureDoc `schemaVersion` stays unchanged. The old unversioned format remains readable, including archives before checkpoints existed. Explicit checkpoints take precedence when present. Migration only changes the disk format on the next successful write; reading never rewrites the original file. Unsupported future versions, invalid new metadata and corrupt new checkpoints/documents are rejected before live-state publication.

The `snapshots` array is retained only as a local variable in the legacy reader. A zero-budget ratchet prohibits reintroducing `this.snapshots` to the runtime Store.

## Measurement

Same Linux host / Node v26.7.0, 20 valid box features, rename edits, 5 repeated saves at each checkpoint, actual JSON write + rename included. Both versions retain the same number of undo checkpoints and audit entries. Each benchmark uses a private temporary directory and removes it in finally.

| Edits | Before archive bytes | After archive bytes | Before save p50 ms | After save p50 ms |
|---:|---:|---:|---:|---:|
| 100 | 1,024,147 | 525,129 | 5.775 | 3.819 |
| 500 | 5,084,147 | 2,608,329 | 22.111 | 12.105 |
| 1000 | 10,159,149 | 5,212,331 | 47.927 | 25.364 |

At 1000 edits, archive size decreased 48.7% and measured save latency decreased 47.1% (about 1.89x). Retained full-document instances decreased from 2002 to 1001; this is an object count, not a measured heap-byte claim. Local filesystem timings vary; no universal latency guarantee is implied.

Reproduce from desktop: `node scripts/bench-featuretree-history.mjs`.
Raw records: `/root/workspace/automation-cad-history-before.json`, `/root/workspace/automation-cad-history-after.json`.

## Verification

- Five new storage cases: compact archive round-trip, pre-checkpoint migration with undo history, explicit-stack legacy migration, unsupported/corrupt archive atomic rejection, failed-save preservation.
- New storage and existing transaction tests: 14/14 passed. `/root/workspace/automation-cad-history-final-targeted.log`.
- Store, HTTP, MCP, multi-document and persistence acceptances passed; real build123d geometry check remains explicitly skipped when no kernel configured.
- Full desktop suite in an owned-process supervisor: 3871 total / 3868 passed / 0 failed / 3 skipped, concurrency=4, 62.5 seconds. `/root/workspace/automation-cad-history-full.log`.
- TypeScript/Vite/Electron/MCP production build passed. `/root/workspace/automation-cad-history-build.log`.
- CI includes storage-tests.mjs with the transaction regressions. No remote CI run, push or deployment was performed.

## Remaining boundaries

Storage still grows linearly with retained edit checkpoints and audit history, and each save still serializes a complete archive. HTTP envelopes still include complete audit history. Append-only journaling, bounded undo policies and paginated history APIs are separate changes with larger contract implications; this iteration deliberately does not truncate user history or alter those public interfaces. Real Windows persistence and power-loss/fsync guarantees were not newly tested.
