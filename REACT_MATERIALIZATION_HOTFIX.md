# React materialization hotfix candidate

Base: immutable v1.6.1, `af42204f6daf9ba301b2c93ae967987fc59f4516`.
Branch: `fix/react-materialization-v162`. Commit and push are approved. No package
version change, publication, application-code edit, or Phase 17 implementation.
The CLI ASCII logo fix and Agent Guidance v2 are excluded.

## Root cause and exact invariant

`AtlasStore.assertCandidateFrameworkComplete()` throws
`Candidate framework materialization is incomplete` when candidate state/version,
snapshot normalization, or `canPublishFramework()` validation fails. The check
runs immediately after framework staging and again inside the publication
transaction. `publishCandidateGeneration()` also rejects stale parent generations.

Two separate defects caused this reproduction:

1. `verifiedLazyNamedExport()` only recognized calls without a trailing comma.
   The consumer's 18 `lazyRouteNamed(() => import("literal"), "Export",)` calls
   therefore produced `framework_target_unknown` diagnostics. The existing test
   used the same wrapper without the comma, hiding the defect.
2. `canPublishFramework()` rejected any coverage row with `unknown` or
   `ambiguous`, even when the attempted JSX site survived as structured unresolved
   evidence. It only exempted narrowly explained unsupported constructs.

The error's `representedSites` counted output provenance only, omitting
diagnostic provenance. Its `resolvedSites` counted unique relationships rather
than sites. `unresolvedByReason` mixed overlapping coverage categories and
diagnostic reasons: the reproduction's 23 unresolved sites appeared as counts
summing to 51 (unsupported sites occurred in three categories).

## Evidence pipeline

Native Tree-sitter JSX opening/self-closing observations are collected by
`createObjectiveSyntaxCollector()` into parsed `frameworkSyntax` facts, including
site ID, range and owner. The candidate manifest binds path-neutral fact blobs to
files. React `analyze()` selects non-intrinsic JSX, resolves imports/aliases,
barrels and verified named lazy exports, then emits site evidence and dependency
lookups. Declared external package JSX is intentionally excluded from local
component-usage resolution.

`resolveFrameworkEvidence()` applies unique-or-drop: exact endpoints create
relationships; unknown, ambiguous and unsupported observations create diagnostics.
Repeated sites may merge into one relationship while retaining evidence IDs.
`analyzeFramework()` combines recomputed/reused materialization. The indexing
pipeline stages graph, framework and reliability, checks framework integrity,
then stages lexical/optional semantic data. Publication switches the active
generation in one SQLite transaction; failed candidates do not become active.

## Site contract

For React component-usage coverage:

- **Attempted:** applicable local JSX observations submitted to resolution;
  intrinsic tags and declared external components are outside this denominator.
- **Represented:** distinct attempted evidence IDs persisted in relationships or
  structured diagnostics. This must equal attempted for publication.
- **Resolved:** distinct site IDs represented by accepted relationship provenance.
- **Unresolved:** distinct site IDs represented by diagnostics, with no accepted
  relationship for the same evidence ID.
- **Unsupported:** an unresolved subset explicitly outside the adapter's supported
  static constructs; it is not dropped evidence.
- **Unknown/ambiguous:** supported observations for which a unique endpoint cannot
  be proven; they remain unresolved, without speculative edges.
- **Unique relations:** deduplicated graph outputs. Existing persisted
  `FrameworkCoverage.resolved` remains this output counter for compatibility;
  it must not be interpreted as a site counter.

The additive site identity is `attempted = represented = resolved + unresolved`.
Coverage flags such as `coverage_not_supported` overlap outcome categories;
`coverageByCategory` is explicitly separate from diagnostic `unresolvedByReason`.
Neither histogram is a replacement for distinct evidence counts.

The React publication exemption requires expected strategy/code/outcome/reason,
complete inputs, attempted/applicable equality, matching output counts, matching
diagnostic outcome counts, and complete evidence accounting. Newly publishable
unknown/ambiguous JSX must additionally match a real candidate fact's JSX site,
range and canonical evidence ID. Resolved JSX IDs also require persisted syntax
proof; legacy file-only output refs remain usable. Validated deterministic-partial
fact blobs remain usable when their framework syntax is complete. Missing snapshots, wrong versions, missing
records/facts, forged site IDs, dangling endpoints, budget exhaustion, weak dropped
evidence and stale parents retain fail-closed behavior. Other framework policies
are unchanged. Partial coverage remains `mayBeIncomplete=true` with no
authoritative negative results.

## Lazy and dynamic shape audit

The verified named-wrapper path still requires literal import/export arguments,
a unique imported helper implementation, React `lazy`, and the named-export to
default adapter shape. A trailing comma is accepted as equivalent syntax; extra
arguments, computed imports/exports and unverified wrappers are not guessed.

General `React.lazy`, arbitrary import wrapper functions and route configuration
objects do not gain a general compiler-style lazy resolver. Their JSX observations
are represented as unknown if a unique language endpoint is unavailable. Props,
map lookups and conditional dynamic component selections remain unsupported.
JSX nested in a route object is collected even when it has no callable source
owner. The regression asserts these sites publish diagnostics without edges.

## Actual consumer reproduction

Read source from `/Users/quycaongoc/agent-workspace`; index isolated copies only.
529 source files. Original application checkout remains unchanged. Native host:
macOS arm64, Node v22.23.2; reused local dependency/parser payload. This is source
and built-CLI evidence, not clean consumer-install or native Windows evidence.

Original v1.6.1 error reproduced exactly: 1091 attempted, 1068 output-represented,
749 reported resolved/unique relations. All 23 absent-from-output sites had
diagnostics: 18 unknown lazy routes and five unsupported dynamic JSX. There was
no JSX extraction loss in this reproduction.

| Metric using the explicit contract | Before | After |
| --- | ---: | ---: |
| Attempted sites | 1091 | 1091 |
| Represented sites, including diagnostics | 1091 | 1091 |
| Resolved site evidence | 1068 | 1086 |
| Unknown sites | 18 | 0 |
| Unsupported sites | 5 | 5 |
| Unique relations | 749 | 767 |
| Publication | failed | succeeded |

`src/app/router/routes.tsx`: 40 attempted; before 22 resolved sites, 18 unknown,
four unique relations; after 40 resolved sites, zero unknown, 22 unique relations.
AppShell, product-icon, ToastProvider, badge and button retain one unsupported
diagnostic each. Graph and lexical are both ready; framework coverage truthfully
remains partial. Built CLI `init --no-guidance --json` succeeded on the indexed
copy. A fresh CLI fixture separately exercises actual init and index processes.

## Regression and validation evidence

Evidence is local under `.evidence/`; it includes consumer copies and must not be
published as a CI artifact or committed. Native CI uses synthetic fixtures only.

- Red test: 18 trailing-comma lazy routes fail on v1.6.1; synthetic 18 React.lazy
  route-object sites plus five dynamic JSX sites also fail before the gate fix.
- Targeted: `node --import tsx/esm --test test/react-lazy-route-framework.test.ts
  test/react-materialization-contract.test.ts test/framework-semantic-fail-fast.test.ts
  test/phase14c-react-components.test.ts test/phase14c-storage.test.ts
  test/phase14c-publication.test.ts test/phase14a-generation.test.ts`:
  **53 passed, zero failed/skipped** (`targeted-final.log`).
- Tests cover exact named lazy targets, changed exports and alias invalidation,
  computed imports/exports, fake wrappers, source site refs, diagnostic/output
  and coverage deletion, forged resolved/unresolved evidence IDs, missing facts,
  legacy file-only refs, stale parents, atomic candidate
  visibility, and fresh built CLI init/index with unresolved JSX.
- The CLI regression also runs sync. Two valid candidates with the same active
  parent exercise CAS: the first publishes; the second cannot replace it.
- `node_modules/.bin/tsc --noEmit`: passed. CLI compilation with `tsc`: passed.
- `node_modules/.bin/eslint . --ignore-pattern '.evidence/**'`: passed. The ignored
  tree consists solely of local evidence copies, not product code.
- `git diff --check`: passed. Workflow YAML parsed with Ruby's standard YAML parser.
- Vite default build was blocked by a write to the reused dependency directory
  outside the workspace. `vite build --config web/vite.config.ts --configLoader
  runner` succeeded without changing build configuration.

Equivalent full suites ran on independently built immutable v1.6.1 and candidate,
with identical native parser payload and test concurrency 2:

| Suite | Tests | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Immutable v1.6.1 | 1414 | 1341 | 70 | 3 |
| Candidate | 1417 | 1344 | 70 | 3 |

`regression-final.json`: zero added failure identities/skips; one changed assertion
whose sole difference is the random filename in the same npm cache EPERM error.
`regression-final-normalized.json`: **passed, zero added/changed failures or new
skips**, after normalizing only those two observed ephemeral paths in addition to
checkout roots. Raw TAP logs (`baseline-equivalent.log`, `candidate-qualified.log`)
and both comparison reports are retained.
`inherited-failures.json` lists every retained failure; the full suite is not green.

## Native Windows and v1.6.2 recommendation

Independent review caught the initially missing resolved-site provenance check;
the regression failed before that check and passes after it. A remaining baseline
limitation is that storage validates completeness, site provenance and live graph
endpoints, rather than independently recomputing the adapter's semantic target
selection. Swapping a resolved endpoint to another existing symbol while preserving
genuine site evidence was already accepted by v1.6.1; this hotfix does not add a
second resolver to storage. Real indexing regressions verify that unknown targets
produce diagnostics and no guessed edges.

`.github/workflows/react-materialization-hotfix.yml` prepares native parsers,
builds and tests on Windows Server 2022 / Node 24, including actual CLI init/index,
then compares the full suite with immutable v1.6.1 and uploads synthetic-test
evidence. It has read-only repository permissions and no release step.
The local consumer snapshot is authenticated AES-256-GCM ciphertext staged through
temporary CI secrets. Only source/config inputs needed for indexing are copied;
no application source, payload or key is committed or uploaded in artifacts.
The Windows probe pins source commit `7d57f9d588404cb16ef7924f9368824a8ff40350`
and snapshot digest, runs actual built CLI init and sync, and asserts 1091/1091
represented, 1086 resolved, 18 lazy routes, five unsupported diagnostics, and ready
graph/lexical indexes. The probe itself refuses to qualify a non-Windows host.
Pushing `fix/react-materialization-v162` triggers this workflow automatically.

At commit preparation, native Windows execution is pending. Its exact candidate
SHA, CI URL, consumer metrics and comparison result must be reported after the
run; historical v1.6.1 CI does not qualify the hotfix.

Recommend the change for a v1.6.2 hotfix after native Windows qualification and
review of retained baseline failures. Local reproduction is fixed; release remains
NO-GO pending native CI. Do not tag, publish, or merge as part of this investigation.
