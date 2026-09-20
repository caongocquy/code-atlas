# Phase15E-A — MCP Agent Integration Hardening

**Status:** Design specification

**Scope:** Current MCP tool metadata, input guidance, and protocol contract verification

## Purpose

Help coding agents select the existing CodeAtlas MCP tools accurately, expose truthful safety hints to clients, and verify the real stdio protocol surface with the official MCP Inspector. Preserve analysis and storage semantics.

## Current behavior found in source

`createMcpServer()` registers 28 tools. `registerJsonTool()` currently passes only descriptions and Zod input schemas to the SDK. The installed MCP SDK is pinned at `1.30.0`; its `ToolAnnotationsSchema` supports `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`. The current default providers include only a local SQLite vector store; no embedding, reranking, or remote provider is wired. Tools use stdio transport.

Read-only handlers can scan/hash local repository files, inspect `.codeatlas` read-only, and run read-only Git subprocesses. They do not mutate Git or call external networks. Index and sync publish local generated index state only; they do not delete source files or Git data.

The read-only graph group (`get_symbol`, the four `find_*` relation tools, `impact`, `trace`, and the five community/intelligence tools) scans or hashes local repository state and opens the existing Atlas database read-only. Repository freshness checks may execute read-only Git status commands. The change group (`inspect_change`, `affected_tests`, `explain_incomplete`, `graph_delta`, `architecture_drift`, and `change_gate`) reads repository files/configuration and Git snapshots through `execFile`; those Git subprocesses inspect status, diffs, revisions, paths, or file contents and never write Git state. Neither group creates or writes `.codeatlas` state. `inspect_retrieval` does not run Git; `search_code`, context compilation, and task lifecycle compilation may write repository metadata as described below. `index_repository` and `sync_repository` read source/configuration, optionally run read-only Git candidate discovery, and write only generated `.codeatlas` state.

## Tool side-effect classification

Annotations are static and describe the most conservative valid input path. `R` is `readOnlyHint`, `D` is `destructiveHint`, `I` is `idempotentHint`, and `O` is `openWorldHint`. The SDK defines hints as advisory. For mutating tools, `D=true` is intentional where an existing row, lifecycle state, schema, or active generated index can be changed; the client must not interpret a local write as read-only. All current tools have `O=false` because the implemented domain is local and no registered handler makes a network call.

| Tool | R | D | I | O | Evidence-based effect |
|---|---:|---:|---:|---:|---|
| `repository_status` | false | true | false | false | Reads repository/index status; optional-capability setup may create or migrate `.codeatlas/atlas.db` and `.codeatlas/.gitignore`. |
| `search_code` | false | true | false | false | Lexical lookup updates repository metadata in `.codeatlas/atlas.db`; hybrid mode also reads local vector storage. |
| `get_symbol` | true | false | true | false | Reads indexed graph and local repository status. |
| `context_read` | false | true | false | false | Guarded source read plus `.codeatlas/context.db` session upsert and new delivery receipt/snapshot. |
| `compile_task_context` | false | true | false | false | Compiles evidence; candidate retrieval updates lexical repository metadata. |
| `start_task_context` | false | true | false | false | Creates a lifecycle in `.codeatlas/context.db`; compilation may update Atlas metadata. |
| `refresh_task_context` | false | true | false | false | Writes a new lifecycle publication/revision; compilation may update Atlas metadata. |
| `close_task_context` | false | true | true | false | Changes the lifecycle state to closed; repeated close has no further effect. |
| `find_callers` | true | false | true | false | Read-only graph relation query. |
| `find_callees` | true | false | true | false | Read-only graph relation query. |
| `find_imports` | true | false | true | false | Read-only graph relation query. |
| `find_imported_by` | true | false | true | false | Read-only graph relation query. |
| `impact` | true | false | true | false | Read-only graph blast-radius query. |
| `inspect_change` | true | false | true | false | Reads working/staged/commit/range Git snapshots; no Git writes. |
| `affected_tests` | true | false | true | false | Reads change and indexed test evidence; no writes. |
| `explain_incomplete` | true | false | true | false | Explains local evidence gaps, delegating to read-only status/change/test paths. |
| `graph_delta` | true | false | true | false | Builds transient graph comparison from read-only Git snapshots. |
| `architecture_drift` | true | false | true | false | Reads Git snapshots and local architecture policy. |
| `change_gate` | true | false | true | false | Reads change, policy, and affected-test evidence. |
| `trace` | true | false | true | false | Read-only graph execution-flow query. |
| `inspect_retrieval` | false | true | false | false | Diagnoses retrieval stages; local lexical/graph access updates repository metadata. |
| `list_communities` | true | false | true | false | Read-only graph community query. |
| `get_community` | true | false | true | false | Read-only graph community detail query. |
| `important_symbols` | true | false | true | false | Read-only graph ranking query. |
| `architectural_bridges` | true | false | true | false | Read-only graph bridge query. |
| `find_cycles` | true | false | true | false | Read-only graph cycle query. |
| `index_repository` | false | true | false | false | Writes `.codeatlas` index state, publishes a generation, and removes stale generated file/capability rows; never deletes source/Git data. |
| `sync_repository` | false | true | false | false | Writes and publishes `.codeatlas` index state, replacing the active generation and removing stale generated rows; never deletes source/Git data. |

The MCP server itself uses stdio. No current registered handler makes an external network call, and optional provider construction wires only the local SQLite vector store. Existing file reads, repository scans, and Git process execution remain local.

## Agent-facing descriptions

Every tool description states the operation and its best use. Where a nearby tool could be confused, distinguish its role:

- `search_code` finds matching code; `get_symbol` retrieves one known symbol; `compile_task_context` assembles bounded evidence for a task; `context_read` safely reads/delivers a selected file or range and records delivery; `inspect_retrieval` diagnoses retrieval stages and ranking rather than serving as default search.
- `repository_status` checks index and capability readiness when freshness or availability is unknown.
- `inspect_change` describes a change snapshot; `impact` follows structural graph dependencies; `graph_delta` compares graph structure between snapshots; `architecture_drift` checks policy-level architecture changes; `change_gate` combines change checks; `affected_tests` identifies relevant tests; `explain_incomplete` explains missing or uncertain evidence.
- `trace` follows a graph path; `list_communities` discovers groups; `get_community` expands a known group; `important_symbols` ranks central symbols; `architectural_bridges` finds cross-community links; `find_cycles` reports cycles.
- Relation tools say which edge direction they return. Index/sync descriptions say they write local generated index state.

Descriptions must not mention internal phase labels or claim natural-language agent routing is verified.

## Input schema descriptions

Add descriptions only where they resolve a meaningful choice: `repoPath` identifies the local repository; `detail` explains `compact` bounded output versus `full`; search/retrieval `mode` distinguishes lexical from hybrid; semantic/reranker flags describe currently available local configuration without promising remote models; `graphEnabled` controls graph expansion; `tokenBudget` caps context; `skipGit` opts out of Git candidate discovery; `maxDepth` bounds traversal; `commit`, `base`, and `head` identify snapshot revisions; `anchors` and `changedPaths` provide known task/change evidence; lifecycle IDs and generation fields identify the exact context state to read, refresh, or close. The `working`, `staged`, `commit`, and `range` enum values must explain their required inputs.

## Inspector contract

Add the official `@modelcontextprotocol/inspector` v2 CLI as an exact-version dev dependency and lockfile entry; never invoke `latest`. Add a stable `test:mcp:inspector` script. The integration launches the actual CodeAtlas MCP stdio server in a temporary fixture repository and checks initialize, tools/list, all expected tool names, descriptions/schemas/annotations, one safe read-only call, and an invalid-input tool error. It must not touch a developer `.codeatlas` directory. The harness records actual protocol responses rather than testing only a registration helper.

## Non-goals and invariants

- No MCP handler analysis or index semantics change.
- No built-in semantic provider, external network access, agent harness claim, or future-phase metadata.
- No change to source files or Git data by index/sync.
- No assumption that Inspector proves Codex/Claude/OpenCode tool selection quality.

## Verification

Focused Node tests assert classifications and useful descriptions through real MCP `tools/list`. The Inspector contract asserts the actual process protocol. Existing Phase15D behavior remains covered by its evaluator and acceptance suite.

## Spec self-review

- [x] All 28 registered tools are classified from handler/service behavior, including conditional writes.
- [x] Read-only, local-write, idempotency, destructive, and open-world hints reflect current code, not roadmap intent.
- [x] Tool overlaps have distinct selection guidance and no natural-language routing claim.
- [x] Inspector is exact-pinned, uses v2 CLI semantics, and operates on a fixture.
- [x] No source/Git mutation or real developer index is part of contract verification.
- [x] SDK semantics and the conservative destructive classifications are explicit for independent review.
