# CodeAtlas Repository Instructions

This repository is **CodeAtlas**.

## Local project guidance

@docs/plan.md

Before making changes:

- Follow only the currently requested migration phase.
- Do not start a later phase unless explicitly requested.
- Preserve existing behavior unless the current task explicitly changes it.
- Do not change index/storage semantics or bump index versions without an explicit reason.
- Preserve the existing CLI progress UX:
  - `listr2`
  - colors
  - icons
  - `ProgressReporter`
  - TTY/non-TTY behavior
  - `NO_COLOR`

## Git workflow

@docs/git-workflow.md

Before modifying any tracked file:

- Check the current Git branch.
- If the current branch is `main` or `develop`, do not edit files yet.
- Follow the Git workflow rules and create the appropriate task branch first.
- Confirm the task branch is active before making changes.

When a task/phase is complete, follow the documented phase completion workflow before starting the next task.

Never implement normal work directly on `main` or `develop`.

## Repository safety

Never commit:

- `.env`
- `.code-rag/`
- `.codeatlas/`
- `docs/plan.md`
- `docs/git-workflow.md`
- generated databases
- model artifacts
- cache/build output

Do not rewrite unrelated user changes.

## CodeAtlas architecture rules

- CodeAtlas core must work without mandatory external vector databases, Docker, embedding models, or LLMs.
- CLI, HTTP, UI, and MCP should reuse shared core services.
- Git-aware sync is an optimization; content hashes remain the correctness check.
- Resolution v2 is precision-first / unique-or-drop.
- `.codeatlas/` is generated local state.
- Public/shareable configuration must live outside `.codeatlas/`.

<!-- gitnexus:start -->

# GitNexus — Code Intelligence

This project is indexed by GitNexus as **code-atlas** (604 symbols, 1692 relationships, 47 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "master"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource                                    | Use for                                  |
| ------------------------------------------- | ---------------------------------------- |
| `gitnexus://repo/code-atlas/context`        | Codebase overview, check index freshness |
| `gitnexus://repo/code-atlas/clusters`       | All functional areas                     |
| `gitnexus://repo/code-atlas/processes`      | All execution flows                      |
| `gitnexus://repo/code-atlas/process/{name}` | Step-by-step execution trace             |

## CLI

| Task                                         | Read this skill file                                        |
| -------------------------------------------- | ----------------------------------------------------------- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md`       |
| Blast radius / "What breaks if I change X?"  | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?"             | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md`       |
| Rename / extract / split / refactor          | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md`     |
| Tools, resources, schema reference           | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md`           |
| Index, status, clean, wiki CLI commands      | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md`             |

<!-- gitnexus:end -->
