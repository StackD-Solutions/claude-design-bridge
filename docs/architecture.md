# Claude Design Bridge for Codex: Architecture

Last verified: 2026-07-13

## Purpose

Claude Design Bridge for Codex gives Codex read-only access to selected Claude Design
source files through the user's authenticated Claude Code installation. It validates the
raw DesignSync result, rejects incomplete transfers, hashes the exact bytes, and writes a
reviewable snapshot under the active workspace.

The bridge deliberately separates source acquisition from validation, caching, snapshot
materialization, and Codex workflow guidance. This keeps those guarantees useful if a
documented first-party transport becomes available to non-Claude MCP clients.

## Data Flow

```text
Codex request
  -> claude-design-bridge skill
  -> local read-only MCP tool
  -> DesignSource
  -> official Claude Code CLI + DesignSync
  -> correlated raw tool result
  -> identity, truncation, encoding, and size validation
  -> SHA-256 cache and workspace snapshot
  -> Codex implementation workflow
```

## Transport Decision

| Transport | Role | Decision |
| --- | --- | --- |
| Claude Code CLI + DesignSync | Official authenticated source reads | Production backend |
| Official remote Design MCP | Potential first-party replacement transport | Gated on supported third-party auth and byte parity |

Anthropic now documents `https://api.anthropic.com/v1/design/mcp` for use from Claude
Code. The published setup still delegates login to Claude Code and does not document a
standalone Codex OAuth flow, stable tool schemas, or the raw file-result guarantees this
bridge requires. The bridge therefore does not call the endpoint directly, copy Claude
credentials, or infer unpublished protocol details.

## Source Contract

Every source implementation exposes the same immutable, read-only capabilities and four
operations:

```js
{
  id: "claude-code-designsync",
  transport: "claude-cli",
  capabilities: {
    read: true,
    write: false,
    revisions: false,
    remoteChecksums: false,
  },
  listProjects,
  getProject,
  listFiles,
  getFile,
}
```

The source obtains a correlated raw result. Shared bridge code remains responsible for
validating payload shape, explicit truncation and base64 flags, content type, byte size,
hashing, cache integrity, and snapshot safety.

## Security Invariants

1. The production remote method allowlist contains only `list_projects`, `get_project`,
   `list_files`, and `get_file`.
2. Missing, malformed, duplicate, unexpected, uncorrelated, or truncated results fail
   closed.
3. Design content is untrusted data and cannot override repository instructions,
   permissions, workspace containment, or the user's request.
4. The Claude subprocess uses `dontAsk`, safe mode, no session persistence, bounded
   output, bounded cost, bounded concurrency, and cancellation.
5. Local snapshot writes are restricted to
   `<authorized-root>/.design/claude/<projectId>`.
6. Host-injected workspace authority is evaluated on every call and is never accepted
   from model arguments or cached across calls.
7. Symlinks, junctions, traversal, reserved control paths, portable path collisions,
   oversized files, and changed local destinations are rejected.
8. Existing local edits are preserved unless `overwrite:true` is explicit.
9. Snapshot and cache bytes are verified with SHA-256 before they are trusted.
10. The core plugin remains remotely read-only even when an upstream transport exposes
    mutations.

## Snapshot and Provenance Model

Manifest schema v2 records the source transport, manifest update time, and a separate
`pulledAt` timestamp for each file. Selective pulls update freshness only for the files
actually read successfully. Version 1 manifests are migrated in memory and are rewritten
only after a successful pull.

`design_snapshot_status` is local-only. It compares manifest hashes with bounded regular
files in the existing snapshot, reports clean/modified/missing/untracked state, refuses
links, and never creates a directory or contacts Claude Design.

## Concurrency Model

- Claude subprocesses use a bounded global queue.
- Files within a pull use bounded concurrency.
- Same-process pulls for one snapshot are serialized.
- Every snapshot uses an exclusive cross-process lock.
- Manifest and destination fingerprints are revalidated immediately before replacement.
- Cache entries are content-verified, so cross-process cache races become misses rather
  than trusted incorrect bytes.

Filesystem checks reduce race exposure but cannot create an operating-system isolation
boundary against a mutually untrusted process running as the same user. Use separate OS
principals when that threat model applies.

## Batch Read Gate

Batching is not assumed safe or faster. A batch implementation may be enabled only after
an explicit live benchmark demonstrates exact byte/hash parity, strict one-result-per-path
correlation, bounded cancellation, no security relaxation, and at least a 25% median
speed improvement for pulls of three or more files. A malformed batch must fail; it must
not silently retry as individual reads and double cost.

The `0.2.0` release includes a strict experimental matcher and the opt-in
`npm run benchmark:live` harness, but production pulls remain bounded concurrent
single-file reads. No maintainer-approved sample containing at least one text file, one
binary file, and twelve explicit paths was available during the 2026-07-13 release
verification. Because byte parity and the performance threshold therefore remain
unproven, the rollout gate is a no-ship decision. The batch function is not exposed as an
MCP tool or connected to `design_pull`; a later release may reconsider it only with fresh
live evidence satisfying every gate above.

## Official MCP Adoption Gate

An official remote adapter may be added only when all of these are documented and tested:

1. stable endpoint and tool schemas;
2. supported OAuth for a non-Claude MCP client;
3. terms permitting the integration;
4. raw identity and completeness fields sufficient for parity; and
5. standard MCP cancellation and error behavior.

The MCP client must own OAuth tokens. The bridge will never read Claude Code credential
files. The existing CLI remains an explicit compatibility backend until same-project
byte and SHA-256 parity passes.

## Write Direction

Remote authoring is outside this plugin. Any future authoring capability requires a
separately installed product and its own plan, confirmation, revision/conflict,
rollback, audit, and threat-model gates. The absence of remote mutation is a core safety
property, not a missing convenience method.
