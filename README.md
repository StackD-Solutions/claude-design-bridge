<!--suppress HtmlDeprecatedAttribute -->
<h1 align="center">
  <br>
  <a href="https://www.stackd-solutions.io"><img src="https://raw.githubusercontent.com/StackD-Solutions/claude-design-bridge/main/docs/logo.svg" alt="StackD Solutions" width="250"></a>
  <br>Claude Design Bridge for Codex
  <br>
</h1>

<p align="center">
  <a href="https://github.com/StackD-Solutions/claude-design-bridge/actions/workflows/verify.yml"><img src="https://img.shields.io/github/actions/workflow/status/StackD-Solutions/claude-design-bridge/verify.yml?branch=main&label=verify" alt="verify"></a>
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="Apache License">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20">
  <img src="https://img.shields.io/badge/codex-plugin-black" alt="Codex Plugin">
  <img src="https://img.shields.io/badge/MCP-server-8A2BE2" alt="MCP Server">
</p>

**Claude Design Bridge for Codex** is a read-only [Codex](https://developers.openai.com/codex) plugin for fetching official [Claude Design](https://claude.ai/design) source through your authenticated [Claude Code](https://claude.com/claude-code). It computes SHA-256 provenance, validates cached and written bytes, and writes a reviewable local snapshot — so the implementation follows the real design source rather than a screenshot or a re-typed approximation.

```text
"Fetch https://claude.ai/design/p/<id>?file=Settings.dc.html and implement it here."
"Apply the cards and spacing from my OLED Care Claude Design to this dashboard."
"List my Claude Design projects."
```

No slash command, tool name, or separate Codex authentication is required. A bundled skill recognizes Claude Design links and explicit Claude Design requests; a local MCP server reads the selected source through Claude Code.

> [!IMPORTANT]
> **The official [Claude Code](https://claude.com/claude-code) CLI is required on the same device.** The bridge has no design credentials or transport of its own — every read goes through your installed, logged-in Claude Code. Without it, design tools stop with `CLAUDE_CODE_NOT_INSTALLED` and no design source is fetched, recreated, or approximated.

## Features

- Implicit activation from plain prompts — no slash command or tool name to remember
- Integrity-tagged reads: SHA-256, byte length, and content type recorded for every file
- Local snapshots at `<workspace>/.design/claude/<projectId>` with a provenance manifest
- Local-only drift status for clean, modified, missing, and untracked snapshot files
- Binary assets preserved as bytes, never reconstructed from base64 text or screenshots
- Truncated reads rejected rather than silently replaced with generated content
- Read-only remote access — no design write, finalize, delete, or asset-registration tools
- Reuses your existing Claude Code login with no separate Codex sign-in

## Why this bridge exists

Anthropic documents the Claude Design remote MCP endpoint for Claude Code, including a Claude Code-specific `/design-login` flow. It does not currently document a standalone OAuth flow for Codex, stable Design tool schemas, or a raw file-result contract that this bridge can validate independently. Authentication, project consent, service discovery, and the current DesignSync tool therefore remain owned by Claude Code. This plugin keeps that boundary intact:

```text
Codex prompt
  -> implicitly selected claude-design-bridge skill
  -> local MCP read tool
  -> official Claude Code in safe, non-persistent print mode
  -> raw DesignSync tool result
  -> validated bytes + SHA-256
  -> local workspace snapshot
  -> Codex implementation
```

The bridge does not call Anthropic's private design endpoint, read OAuth credential files, bundle Claude Code, or copy leaked/proprietary Claude source.

### Official upstream status

Last verified: **2026-07-13**.

Anthropic's [Claude Design guide](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) now documents `https://api.anthropic.com/v1/design/mcp` for Claude Code and directs users to authenticate with `/design-login`. An earlier [Claude Code issue](https://github.com/anthropics/claude-code/issues/69310) recorded 404 responses after that login flow. The endpoint is now a known first-party migration path, but the bridge will adopt it only after Anthropic documents supported non-Claude-client OAuth and tool/result schemas and same-project byte-parity tests pass.

The bridge never scrapes Claude Code credential files, replays proprietary tokens, or guesses unpublished methods. See [the architecture and transport decision](docs/architecture.md) for the adoption gate and security invariants.

## Prerequisites

- Codex with plugin support
- Node.js 20 or newer
- **The official [Claude Code](https://claude.com/claude-code) CLI on the same machine — required**
- A logged-in Claude account with Claude Design access

Install Claude Code first. The bridge fails closed with `CLAUDE_CODE_NOT_INSTALLED` whenever no Claude Code executable can be found, and reports it as a hard stop rather than falling back to a guessed or recreated design. When Claude Code is installed outside the discovered locations, set `CLAUDE_BIN` to its native executable (`claude.exe` on Windows).

Run these once in interactive Claude Code:

```text
/design login
/design consent
```

`/design consent` is needed only when Claude asks for agent access. Older Claude Code versions use `/design-login` for the login command.

## Installation

The canonical repository identifier is
[`StackD-Solutions/claude-design-bridge`](https://github.com/StackD-Solutions/claude-design-bridge).

```powershell
git clone https://github.com/StackD-Solutions/claude-design-bridge.git
codex plugin marketplace add ./claude-design-bridge
codex plugin add claude-design-bridge@stackd-solutions
codex plugin list
```

Start a new Codex task after installation. Then paste a design link or explicitly refer to a Claude Design project; no command is needed in the prompt.

## Configuration

The plugin works with no configuration. Every setting below is an optional environment variable.

| Variable                                 | Type     | Default                                                        | Description                                           |
| ---------------------------------------- | -------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| `CLAUDE_BIN`                             | `string` | Native executable discovered beside the Claude PATH shim       | Exact Claude executable; a missing absolute path fails closed |
| `DESIGN_BRIDGE_MODEL`                    | `string` | `haiku`                                                        | Claude model used only to initiate the read tool call |
| `DESIGN_BRIDGE_TIMEOUT_MS`               | `number` | `120000`                                                       | Maximum time for one delegated read                   |
| `DESIGN_BRIDGE_MAX_BUDGET_USD`           | `number` | `0.25`                                                         | Claude print-call budget ceiling                      |
| `DESIGN_BRIDGE_CACHE_DIR`                | `string` | Plugin data dir or `~/.codex/plugin-data/claude-design-bridge` | Validated raw-byte cache                              |
| `DESIGN_BRIDGE_CACHE_TTL_MS`             | `number` | `600000`                                                       | Maximum cache age when `refresh:false`; `0` disables reuse |
| `DESIGN_BRIDGE_CACHE_RETENTION_MS`       | `number` | `604800000`                                                    | Maximum object age enforced by cache pruning          |
| `DESIGN_BRIDGE_CACHE_MAX_BYTES`          | `number` | `536870912`                                                    | Maximum combined cache data and metadata bytes        |
| `DESIGN_BRIDGE_CACHE_MAX_ENTRIES`        | `number` | `1024`                                                         | Maximum cached project-path entries                   |
| `DESIGN_BRIDGE_INLINE_MAX_BYTES`         | `number` | `65536`                                                        | Inline text byte limit; `0` omits inline content       |
| `DESIGN_BRIDGE_MAX_FILE_BYTES`           | `number` | `2097152`                                                      | Local defense-in-depth file limit                     |
| `DESIGN_BRIDGE_MAX_PULL_BYTES`           | `number` | `33554432`                                                     | Total bytes allowed in one pull                       |
| `DESIGN_BRIDGE_PULL_CONCURRENCY`         | `number` | `3`                                                            | Maximum parallel reads within one pull                |
| `DESIGN_BRIDGE_MAX_CONCURRENT_DELEGATES` | `number` | `4`                                                            | Maximum Claude subprocess reads across calls          |
| `DESIGN_BRIDGE_MAX_STATUS_ENTRIES`       | `number` | `1024`                                                         | Maximum local entries inspected by snapshot status    |
| `DESIGN_BRIDGE_ALLOWED_ROOTS`            | `string` | Unset                                                          | Root override; invalid entries fail closed            |

## Tools

| Tool                   | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `design_doctor`        | Diagnose Claude CLI, login, consent, raw access, and workspace roots |
| `design_list_projects` | List writable Claude Design projects                                |
| `design_resolve_link`  | Validate a Claude URL and return its project ID and linked file     |
| `design_get_project`   | Read project metadata                                               |
| `design_list_files`    | List normalized project paths                                       |
| `design_get_file`      | Fetch/hash the latest file; inline only small text                  |
| `design_pull`          | Refresh selected files and maintain a SHA-256 provenance snapshot   |
| `design_snapshot_status` | Inspect managed or user-provided local files without remote access    |

### Freshness and Pull Behavior

Files you have not edited locally update in place. Locally edited or untracked files are preserved unless you explicitly ask Codex to replace them.

`design_pull` reads each selected file from Claude Design by default and computes its SHA-256. Identical files report `unchanged: true`. When a remote file changed and the local snapshot still matches its previous manifest SHA, the bridge atomically updates that same path without creating a sibling copy. A locally edited or untracked differing file is preserved and reported as `FILE_EXISTS`; pass `overwrite: true` only to force its replacement. Omitting `overwrite` and passing `overwrite: false` have the same safe behavior.

Claude DesignSync does not expose a revision ID, ETag, or remote checksum in the validated file contract, so the bridge cannot perform a metadata-only freshness check. It fetches each selected file and compares the resulting SHA-256 with the local manifest instead.

Manifest schema v2 records the source transport, manifest update time, and a separate `pulledAt` timestamp for every file. Selective pulls advance only the entries successfully fetched and written. A deliberate `refresh:false` cache hit preserves the original upstream-fetch timestamp instead of presenting cached bytes as newly read. Existing schema v1 manifests are migrated in memory and rewritten as v2 only after a successful pull.

Upgrading from 0.1.x requires no manual snapshot conversion. Status checks leave schema v1 files
untouched; the next successful pull migrates them while preserving their prior global `pulledAt`
as the per-file timestamp for entries that were not refetched. See [CHANGELOG.md](CHANGELOG.md).

`design_snapshot_status` performs no remote call and never creates or extracts files. With a manifest, it rejects links and unsafe entries and reports clean, modified, missing, and untracked paths. Without a manifest, an existing non-empty snapshot directory is reported as unverified `user-provided-local` source with bounded local hashes. Those files must never be described as fetched, current, or verified against Claude Design.

After a Claude Code session limit, the user may explicitly choose **use local snapshot**. Managed files may be stale and retain their local-change protection. The bridge does not unzip downloads; a user who supplies a design manually must extract it into the exact `.design/claude/<projectId>` directory. When remote access returns, pull the selected unverified paths with `overwrite:true`: identical files are verified unchanged, differing files are replaced with DesignSync bytes, and only then is a DesignSync provenance manifest written. Invalid, empty, linked, unsafe, or oversized local snapshots remain fail-closed.

Production pulls use bounded concurrent single-file reads. Version 0.2.0 contains an experimental strict batch matcher, but batching is not exposed or enabled because its live byte-parity and performance gate has not yet been completed. Maintainers can run the explicit, cost-confirmed `npm run benchmark:live -- --help` harness with a private selected sample; the harness redacts project IDs, paths, source, credentials, and hashes from its report. See the [architecture decision](docs/architecture.md#batch-read-gate).

You normally do not need to mention refresh. Ask Codex to "force-refresh this Claude Design" when you explicitly want a new source read. Omitting `refresh` or passing `refresh: true` reads from Claude Design. Passing `refresh: false` explicitly opts into validated TTL-cache reuse, with a remote read on cache miss, expiry, or failed integrity validation. Selected files are freshly fetched whenever they are read or pulled; this is not a background watcher. A multi-file pull is not a server-side revision transaction, so a design edited during the pull can span revisions. Renamed or remotely deleted files are not automatically removed from the local snapshot. Each pull accepts at most 12 selected files; pull additional referenced dependencies in another reviewable batch.

### Workspace Roots

Callers may provide `dir` for compatibility, but it must equal `<authorized-root>/.design/claude/<projectId>` exactly. When `DESIGN_BRIDGE_ALLOWED_ROOTS` is present, its existing absolute directories are the complete allowlist: it overrides other root sources, and an empty or invalid configuration fails closed. Without that override, standard MCP Roots are used when the client advertises them.

Codex does not advertise standard MCP Roots (verified through 0.144.1). As the final fallback, the server advertises the supported `codex/sandbox-state-meta` capability, and Codex injects the current turn's `sandboxCwd` after model arguments on every tool call. This host-injected metadata is the trust authority for that call, is never cached, and is not controlled by model tool arguments. Other MCP hosts must preserve that boundary or configure `DESIGN_BRIDGE_ALLOWED_ROOTS` explicitly.

## Natural-Language Routing

The skill implicitly activates for:

- a `claude.ai/design` URL;
- the phrase "Claude Design";
- a clearly named design in your Claude Design projects; or
- requests to fetch, implement, apply, match, port, or recreate those sources.

It intentionally does not activate for generic UI work that has no Claude Design provenance.

When a URL contains `?file=Collapsible+App.dc.html`, the resolver returns the decoded file path and the skill pulls that file first. It does not list or fetch hundreds of unrelated project files.

## Fidelity Model

The bridge reads Claude Code's structured `stream-json` events and captures the top-level raw `tool_use_result`. It does not ask a model to repeat HTML, CSS, or assets in its final answer.

For every file, the bridge:

- correlates the observed DesignSync call and result IDs;
- requires the expected read method, project ID, and path;
- rejects unexpected or multiple tool calls;
- preserves UTF-8 or decodes base64 binary bytes;
- rejects `truncated: true` rather than substituting generated content;
- records byte length, content type, and SHA-256;
- writes atomically under an approved workspace root; and
- creates or updates `.claude-design.json` in the snapshot directory.

The legacy DesignSync reader itself truncates decoded text above 256 KiB. The plugin reports `FILE_TRUNCATED` and does not cache or write that partial result. A future adapter can use the newer ClaudeDesign direct-read surface after Claude Code exposes it to the account and its raw contract is verified.

## Security Boundary

The Claude subprocess runs with:

```text
--tools DesignSync
--permission-mode dontAsk
--safe-mode
--no-session-persistence
--output-format stream-json
--verbose
```

The bridge deliberately omits blanket `--allowedTools DesignSync` approval. Current Claude Code requires interactive approval and an in-memory plan token for design writes, while each bridge read uses a fresh process and stops after the first validated raw result. The remaining trust boundary is the user-installed official Claude Code binary; the CLI does not provide an independent method-field deny rule.

Local writes require an explicitly configured allowed root, an MCP workspace root, or Codex sandbox metadata; use only the dedicated `.design/claude/<projectId>` snapshot directory; reject reserved names, portable path collisions, traversal, and Windows special names; serialize same-process pulls; acquire an exclusive cross-process snapshot lock; and verify the written SHA-256. Write-parent paths are walked and revalidated immediately before directory creation and snapshot/cache writes, and observed symlinks or junctions are rejected. Cache directories receive the same component-by-component validation.

These path checks are defense in depth, not an operating-system security boundary against another same-user process racing to replace a validated directory. The bridge also revalidates snapshot and manifest bytes immediately before replacement. Node does not expose an atomic cross-platform compare-and-swap for regular files, so a concurrent edit can still race after that final check; avoid editing the snapshot while a pull is running. Use separate OS principals or equivalent isolation when mutually untrusted local processes share a workspace.

On Codex, the local workspace authority comes from host-injected per-call sandbox metadata, not a model-provided path. A supplied `dir` cannot widen that authority.

## Privacy and Retention

Claude Code reads the design from Anthropic. The plugin then stores selected bytes locally and Codex may send the portions it reads to OpenAI as task context. Use only projects you are permitted to process with both services.

Pulled snapshots remain in the directory chosen inside the workspace. Keep them for review or remove them according to the repository's data policy. Add the chosen snapshot directory to the target repository's `.gitignore` when design source should not be committed.

The cache uses raw bytes plus integrity metadata. TTL controls reuse only for calls that explicitly pass `refresh: false`, while retention, byte, and entry settings drive best-effort pruning. The server removes retention-expired, crash-leftover, and oldest over-limit entries at startup, on a coalesced schedule after successful cache writes, and periodically while it runs; failed removals are logged and retried by a later sweep. Cache filesystem paths are internal and are not returned by bridge tools or `design_doctor`; remove the configured cache directory directly when local retention is no longer desired.

## Troubleshooting

| Error                        | Resolution                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `CLAUDE_CODE_NOT_INSTALLED`  | Install Claude Code from <https://claude.com/claude-code>, or set `CLAUDE_BIN` to an installed executable |
| `CLAUDE_SESSION_LIMIT`       | Show the reset time, then offer wait-and-retry, bounded local snapshot use, or abort                  |
| `NEEDS_DESIGN_LOGIN`         | Run `/design login` in Claude Code (`/design-login` on legacy builds)                              |
| `NEEDS_DESIGN_CONSENT`       | Run `/design consent` in Claude Code                                                               |
| `DELEGATE_SPAWN_FAILED`      | Claude Code was found but could not start; repair the installation or fix `CLAUDE_BIN`             |
| `DESIGNSYNC_UNAVAILABLE`     | Update/restart Claude Code and confirm the account has Design access                               |
| `WORKSPACE_ROOT_UNAVAILABLE` | Restart after installing the current plugin; for unusual hosts, set `DESIGN_BRIDGE_ALLOWED_ROOTS`  |
| `FILE_TRUNCATED`             | The legacy 256 KiB reader limit was reached; no partial file was written                          |
| `FILE_EXISTS`                | Local bytes differ from the latest design and are untracked or changed since the prior snapshot; inspect before `overwrite:true` |
| `FILE_CHANGED`               | A local file changed during replacement; finish the local edit, then retry the design path        |
| `MANIFEST_INVALID`           | Repair or remove an invalid `.claude-design.json` after reviewing the local snapshot              |
| `SNAPSHOT_EMPTY`             | Add already extracted local design files, wait for remote access, or abort                         |
| `MANIFEST_VERSION_UNSUPPORTED` | Upgrade the bridge or migrate the manifest with a supported version                             |
| `MANIFEST_TOO_LARGE`         | Split or clean the managed snapshot before adding more manifest entries                           |
| `MANIFEST_CONFLICT`          | The snapshot manifest belongs to another project; move it or use the correct project directory    |
| `MANIFEST_CHANGED`           | The manifest changed during the pull; retry the original design paths after the other writer stops |
| `SNAPSHOT_BUSY`              | Another process owns `.claude-design.lock`; wait, or remove it only after confirming no pull is active |
| `SNAPSHOT_STALE`             | The recorded same-host owner exited; inspect the lock, then remove it manually                    |
| `STATUS_LIMIT_EXCEEDED`      | Reduce snapshot contents or raise the bounded status limit within the supported maximum           |
| `PARTIAL_PULL`               | Inspect `data.errors`; if the manifest failed, retry the original successful design paths after fixing it |

## Development

```powershell
npm run check
npm test
npm run verify
```

Run the optional live byte-integrity test with a design URL and expected result:

```powershell
$env:DESIGN_BRIDGE_LIVE_URL = 'https://claude.ai/design/p/<id>?file=<path>'
$env:DESIGN_BRIDGE_LIVE_BYTES = '<expected-byte-count>'
$env:DESIGN_BRIDGE_LIVE_SHA256 = '<expected-sha256>'
npm run test:live
```

Validate the plugin manifest:

```powershell
python "$env:USERPROFILE/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" `
  .
```

After changing an installed local plugin, update its cachebuster and reinstall it:

```powershell
python "$env:USERPROFILE/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py" `
  .
codex plugin add claude-design-bridge@stackd-solutions
```

Use a fresh Codex task after reinstalling so it loads the new skill and MCP process.

## Layout

```text
.codex-plugin/plugin.json
.mcp.json
.agents/plugins/marketplace.json
skills/claude-design-bridge/SKILL.md
server/claude-delegate.mjs
server/design-bridge.mjs
server/design-source.mjs
server/design-validation.mjs
docs/
  architecture.md
__tests__/
  fixtures/
  unit/
  integration/
  live/
```

## License

Apache 2.0
