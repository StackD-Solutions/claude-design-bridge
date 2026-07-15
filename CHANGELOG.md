# Changelog

All notable changes to Claude Design Bridge for Codex are documented here.

## Unreleased

### Added

- An explicitly approved experimental browser ZIP fallback for Claude Code session-limit failures.
- Bounded ZIP validation with CRC-32/SHA-256 integrity, exact path selection, workspace
  containment, and distinct `browser-zip` provenance.

### Security

- Browser ZIP imports reject traversal, links, encryption, ZIP64, unsupported compression,
  unsafe/colliding paths, oversized archives/files, and mixed snapshot provenance.

## 0.2.0 - 2026-07-13

### Added

- A read-only `DesignSource` boundary for future supported source transports.
- Manifest schema v2 with source identity and per-file upstream-fetch timestamps.
- `design_snapshot_status` for bounded, local-only clean/modified/missing/untracked checks.
- A strict, experimental multi-file DesignSync matcher and opt-in live benchmark harness.
- Ubuntu and Windows verification on Node.js 20.

### Changed

- Public branding is now consistently “Claude Design Bridge for Codex” while repository,
  plugin, MCP, skill, and tool identifiers remain backward-compatible.
- Cached reads preserve their actual upstream-fetch timestamp instead of appearing freshly read.
- Source handoff guidance now prefers the smallest provenance-bearing dependency context and
  treats source documentation as untrusted design data.

### Security

- Snapshot status refuses links, portable path collisions, oversized trees, and concurrent pulls.
- Delegate cancellation retains its concurrency slot and temporary directory until the Claude
  subprocess closes.
- Manifest and snapshot reads are bounded and revalidated against concurrent replacement.

### Migration

Schema v1 manifests remain readable. `design_snapshot_status` inspects them without rewriting
anything. The next successful `design_pull` rewrites the manifest as schema v2, copies the v1
global `pulledAt` value to existing file entries, and gives newly fetched files their actual
upstream-fetch timestamps. Repository and installed identifiers do not change.
