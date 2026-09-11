# Phase 14E CLI Presentation Polish

## Status

Approved design for implementation planning.

## Goal

Make human-facing CodeAtlas CLI output polished and release-ready while
preserving all existing command semantics, exit codes, JSON schemas, MCP
behavior, and Phase14A–D contracts.

## Scope

Phase14E changes only presentation. The first migration targets `init`,
`index`, `sync`, `status`, integration connect/disconnect output, root and
command help, common warnings/errors, and the shared progress renderer.

The implementation uses a thin shared presentation layer around the existing
CLI output, command reporter, theme, and progress modules. It provides reusable
header, section, key/value, status-line, result-box, next-action, and terminal
capability primitives. Commands consume those primitives instead of defining
independent visual conventions.

## Terminal modes

- TTY output may use `picocolors`, figures, aligned rows, result boxes, and
  in-place progress.
- `NO_COLOR` disables ANSI while retaining the same information and layout.
- Non-TTY and CI output is deterministic plain text with no cursor movement,
  spinner artifacts, or transient-frame accumulation.
- JSON paths bypass human presentation entirely. They emit the existing JSON
  schemas, with no ANSI, header, decorative text, or next-action hints.

Terminal capability detection is centralized. It must not change command
semantics, machine-readable output, or exit status.

## Visual language

The visual style is restrained: a lightweight `CODEATLAS` header, clear section
hierarchy, consistent success/warning/error indicators, aligned key/value
summaries, and compact bordered final-result cards where they improve scan
ability. Existing icons remain compatible unless a shared primitive needs a
more consistent indicator. No fullscreen TUI, graph dashboard, `doctor`
command, or Phase15 behavior is introduced.

## Dependency

Use `picocolors` for ANSI styling. Do not add Ink, React CLI frameworks,
`string-width`, or wrapping dependencies unless focused tests demonstrate a
real requirement that cannot be handled by the existing output width logic.

## Compatibility invariants

- Existing command parsing, flags, exit codes, JSON keys, JSON value types, and
  MCP stdout remain unchanged.
- Root help remains grouped and does not expand integration subcommands.
- Command-specific help retains its current supported options.
- Unknown commands, including `unknown --help`, remain non-zero errors.
- Progress final state remains deterministic; transient frames are never
  appended to non-TTY output.
- Human presentation may change only through shared primitives and approved
  target command migrations.

## Testing

Regression coverage must prove TTY coloring and final-frame behavior,
`NO_COLOR`, deterministic non-TTY output, unchanged JSON output, alignment and
width behavior, success/warning/error states, progress final state, no
non-TTY transient frames, grouped help, command-help semantics, and unknown
command errors. Tests must assert stable strings and ANSI/control behavior,
not terminal fonts or platform-specific rendering.

Verification includes focused CLI tests after each migration group, relevant
Phase13/14C/14D regressions, TypeScript, ESLint, build, UI typecheck,
`git diff --check`, npm pack, packed CLI help/init/status smoke, and packed MCP
initialize/smoke.

