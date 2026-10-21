# CA-01 same-target differential CI

Pinned baseline: `d2570bd789095d82442ff332beb36a5ddd998194`.
Current release recommendation: **NO-GO**. Strict full-suite and differential
zero-regression results are independent. Policy B is recommended but unapproved;
a differential PASS is not merge/release authorization or a Done criterion.

The existing parser-platform workflow detects CA-01 MCP/test/eval/CI/doc changes
on push and pull_request, then calls tree-sitter-installation with ca01=true and
assemble_only=true. Existing native parser preparation and universal package
assembly are reused. Existing release comparison against 8f3c2d7 is untouched and
is not run by this CA-01 call; no publish workflow or tag trigger is added.

The additive job spans darwin-arm64, darwin-x64, linux-x64/glibc and win32-x64 on
Node22.23.3 and24.21.0. It restores identical pinned parsers into candidate and
clean baseline, verifies package/lock/parser inputs have not drifted, builds both,
requires CA-01 focused checks/legacy parity, records both full suites, compares
all test identities, complete errors and skips, then tests a freshly installed
packed consumer (no install scripts required). No model download or native agent
session is part of this offline contract gate.

The test runner records process exit and runtime separately; test exit1 is
retained rather than converted to strict PASS. Comparator rejects incomplete
summaries, duplicate/missing identities, new/changed failures, new/changed skips,
new todos, cancellation and mismatched runtimes. New passing tests are allowed.
Allowed normalization: explicitly supplied checkout roots, recorded OS temporary
root and mkdtemp's six-character path suffix, identity-preserving UUID bijection
within each error. Codes, assertion values/messages, nested causes and remaining
stack content are compared unchanged. No universal baseline failure count.

Artifacts per platform/Node contain baseline/candidate structured test records,
process results and stderr, comparison JSON, focused TAP, parity log, consumer
install and packed MCP smoke. Standard CI artifacts have normal repository access
controls; they are not included as raw source-control transcripts. Publication
requires a separate explicit action. The workflow never changes acceptance policy.

Local reproduction, from two prepared matching source trees:

```sh
# In BASELINE_ROOT, run the candidate's dependency-free recorder.
node CANDIDATE_ROOT/scripts/run-ca01-suite.mjs EVIDENCE_ROOT/baseline
# In CANDIDATE_ROOT:
node scripts/run-ca01-suite.mjs EVIDENCE_ROOT/candidate
node scripts/compare-ca01-tests.mjs EVIDENCE_ROOT/baseline EVIDENCE_ROOT/candidate EVIDENCE_ROOT/comparison.json BASELINE_ROOT CANDIDATE_ROOT OS_TEMP_ROOT
node --import tsx/esm --test test/ca01-ci-regression.test.ts
node scripts/ca01-packed-mcp-smoke.mjs CLEAN_CONSUMER_ROOT EVIDENCE_ROOT/packed.json
```

Use native absolute roots from Node path.resolve/process.cwd (including Windows),
not Git Bash's POSIX drive alias. OS_TEMP_ROOT comes from node:os.tmpdir(). Recheck
remote master before integrating; advancement requires a newly approved target
and baseline qualification, not reinterpretation of this frozen comparison.

Remote matrix status remains **NOT RUN** until the exact candidate is committed,
pushed and actually executed with separate authorization. Local patch replay is
not remote CI proof. Baseline debt requires explicit owner/policy approval;
Claude/Cursor infrastructure gaps require explicit scope or waiver decisions.

The differential comparator rejects absent or unusable failure evidence,
duplicate or incomplete summaries, and any mismatch in tests/pass/fail/skipped/todo
counts. Cancelled suites cannot qualify. Reporter failures abort evidence capture;
equivalent missing-error markers never qualify as equivalent baseline debt.
