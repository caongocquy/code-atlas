# Phase15E-B — CLI Self-Upgrade

**Status:** Design specification  
**Scope:** Explicit `code-atlas upgrade` and `code-atlas upgrade --check`

## Purpose and behavior

Add an opt-in self-upgrade command. Ordinary commands never check for or install updates. `upgrade --check` reports the current package version and registry's current `latest` version without changing the installation. `upgrade` resolves the exact current `latest` version, installs that exact version globally through the detected supported manager, then verifies the installed CLI version.

Both commands use the existing `--json` convention for success output. Existing top-level error handling remains responsible for JSON errors when `--json` is present; no second JSON flag is introduced.

## Current evidence and supported scope

The executable is `dist/cli.js`; CLI dispatch is a switch in `src/cli.ts`, and version is loaded from the package manifest. README and an isolated-prefix release smoke test support global npm installation. README documents global pnpm installation, but no pnpm smoke test exists. The package's `packageManager` field identifies repository tooling, not the user's installation source. The package has no shared process-runner abstraction.

Automatic upgrades support only an unambiguous global npm or global pnpm installation on POSIX systems (macOS/Linux), identified by comparing the running CodeAtlas package path with each manager's `root -g` package path. Local project dependencies, links, Homebrew, wrappers, ambiguous managers, and Windows command shims are unsupported and never mutated. Windows receives a clear manual command because invoking `.cmd` requires shell mediation that conflicts with the shell-free execution requirement and available repository evidence does not establish a safe cross-platform shim strategy.

For `--check`, use the detected manager to query its configured registry where possible; on supported POSIX systems, an unsupported source may use npm's configured registry if the npm executable is available. If no shell-free manager invocation is available, return an actionable lookup error. Registry errors never fall through to installation. Upgrade refuses to mutate unsupported/ambiguous sources and prints a manual global command when safe.

## Architecture

Keep the command lazy-loaded from the CLI dispatch. Put the workflow in one focused module with narrow injectable functions for install-source detection, registry lookup, command execution, and post-install version verification. Production adapters use Node `execFile` without `shell: true`, manager `root -g`/`view` commands, and filesystem realpath checks. Tests supply fakes and temporary package roots; they never inspect or modify the developer's actual global install.

Resolve the manager's configured registry `latest` tag, validate its output as an exact SemVer value, compare versions by SemVer precedence, and install `@showdar2112/code-atlas@<resolved-version>` with global and exact-save flags. Never pass `latest` to the install command. On success, launch the installed `dist/cli.js --version` using `process.execPath` and require exact equality with the target. Any failure returns non-zero with the detected source and actionable remediation; no sudo, force, cleanup, local project manifest write, or background update is permitted.

## Outputs

Human output reports current and available/installed versions, manager, and next action. JSON success includes stable fields `currentVersion`, `latestVersion`, `updateAvailable`, `manager`, `upgraded`, and `verifiedVersion` (null when no installation was attempted). Unsupported source can be represented as `manager: null`; errors follow current top-level JSON error behavior.

## Tests

Use fakes/temp roots to cover: npm detection; pnpm detection; local/link/ambiguous unsupported detection; already latest; update available; manager-configured registry lookup; registry/network failure; install command failure; post-install mismatch; successful exact upgrade; and JSON output. Assert command arguments contain an exact version and no shell execution; tests never run real npm/pnpm global commands.

## Non-goals and limitations

- No implicit/background update or general command telemetry.
- No Homebrew, source checkout, local dependency, link, arbitrary wrapper, or Windows automatic-upgrade support.
- No direct public registry HTTP, hard-coded registry URL, sudo, force, package cleanup, project dependency edits, or external release action.
- No unrelated CLI progress UX changes.

## Spec self-review

- [x] Explicit command only; ordinary command dispatch has no auto-update path.
- [x] npm/pnpm installation detection is based on actual global package roots, not `packageManager` metadata or PATH guesses.
- [x] Unsupported/ambiguous sources fail closed and can still check a configured npm registry without mutating.
- [x] Exact resolved version, shell-free invocation, and post-install verification are defined.
- [x] Tests do not use the machine's real global install state.
- [x] Windows is an explicit limitation, not an unsupported safety assumption.
