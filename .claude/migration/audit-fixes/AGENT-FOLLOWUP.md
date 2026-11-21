# Agent write receipt follow-up

Baseline: existing uncommitted `fix-audit-findings` worktree. No commits, pushes, dependency installs or deployments.

## Changes

1. MCP proxied write schemas now require `arguments.operationId`. Missing IDs cause a no-side-effect rejection with a suggested UUID. Callers therefore hold the ID before dispatch, even if MCP SDK cancellation discards the original response. Direct DesktopRpcProxy callers remain compatible.
2. RPC business result and receipt registration no longer depend on audit storage success. An audit exception emits `AGENT_AUDIT_FAILED` without replacing a known successful or failed result.
3. Token generations own AbortControllers. Rotating credentials aborts old pending approvals immediately; already-started writes retain their original non-rollback behavior.
4. Large terminal results retain bounded summaries with `ok`, `code`, `message`, `resultOmitted`, `resultBytes` and operation ID. Queries and same-ID replays return the summary without executing again. If the result does not declare a boolean outcome, summary `ok` is null.

## Behavior tests

- `desktop/test/agent/write-receipts.test.mjs`: real HTTP RPC audit failure/replay, token rotation pending approval cancellation/new-token request, large success/failure receipts.
- `desktop/test/agent/mcp-write-receipts.test.mjs`: actual MCP SDK in-memory transport, missing-ID no-forwarding, SDK cancellation after write start, independent status lookup and same-ID replay through actual HTTP proxy/RPC.
- Existing MCP tests now explicitly provide IDs for write routing cases.

Focused run: 14 passed / 0 failed, `/root/workspace/automation-cad-agent-followup-focused-2.log`.
Build: TypeScript + Vite + Electron/MCP production bundles passed, `/root/workspace/automation-cad-agent-followup-build.log`.
Full-suite result is recorded in HANDOFF.md after completion.

## Contract and remaining boundaries

Usage is documented in desktop/README.md. Operation records are process-local, scoped to credential generation and source IP, expire after 15 minutes once terminal, and do not prove non-execution after loss/expiry. This work does not provide durable exactly-once execution across application restarts or token rotations. Hardware, Windows installation and remote GitHub CI were not exercised.
