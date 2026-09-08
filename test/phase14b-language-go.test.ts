import assert from "node:assert/strict";
import test from "node:test";

import { extractGoFacts, goFactExtractor } from "../src/core/facts/extractors/go.js";
import { GO_CAPABILITIES, goSemanticAdapter } from "../src/core/graph/resolver/adapters/go.js";
import { factExtractorInput, runFixtureThroughResolver } from "./helpers/phase14b-language-fixtures.js";

const source = `
package demo

import "fmt"

type Reader interface { Dispatch() error }
type FileReader struct{}
type NetReader struct{}
func (FileReader) Dispatch() error { return nil }
func (NetReader) Dispatch() error { return nil }
type Service struct { reader Reader }
func (s *Service) Read() error { return nil }
func (s Service) Direct() { fmt.Println(s.reader) }
func use(s *Service, r Reader) { s.Read(); r.Dispatch() }
`;

const input = factExtractorInput({ filePath: "phase14b/go/main.go", source, language: "go" });

test("Go extracts package/imports, receivers, interfaces, method sets, and direct calls", () => {
  const result = extractGoFacts(input);
  assert.equal(result.kind, "facts");
  if (result.kind !== "facts") return;
  assert.equal(result.facts.parseStatus, "complete");
  assert.deepEqual(result.facts.modules.map((item) => item.name), ["demo", input.filePath]);
  assert.deepEqual(result.facts.imports.map((item) => item.moduleSpecifier), ["fmt"]);
  assert.ok(result.facts.symbols.some((item) => item.kind === "interface" && item.name === "Reader"));
  assert.ok(result.facts.parameters.some((item) => item.receiverKind === "go_receiver" && item.typeText === "*Service"));
  assert.ok(result.facts.members.some((item) => item.memberName === "Read" && item.memberKind === "method"));
  assert.ok(result.facts.implementations.some((item) => item.targetName === "Reader"));
  assert.ok(result.facts.callSites.some((item) => item.calleeText === "s.Read"));
});

test("Go resolves concrete receivers and keeps interface dispatch ambiguous", async () => {
  const result = extractGoFacts(input);
  assert.equal(result.kind, "facts");
  if (result.kind !== "facts") return;
  const calls = result.facts.members.filter((item) => item.receiverId && ["Read", "Dispatch"].includes(item.memberName));
  assert.equal(calls.length, 2);
  const resolved = await runFixtureThroughResolver(
    {
      name: "go",
      cases: [{ filePath: input.filePath, source, language: "go" }],
      sites: calls.map((item) => ({ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: input.filePath, language: "go" }, localId: item.localId })),
      expectedDecisionStatuses: ["resolved", "ambiguous"],
    },
    [result.facts],
    goSemanticAdapter,
  );
  assert.deepEqual(resolved.decisions.map((item) => item.status), ["resolved", "ambiguous"]);
  assert.equal(resolved.usedSourceSemanticFallback, false);
  assert.equal(resolved.floorPassed, true);
});

test("Go adapter exposes capabilities and explicit uncertainty", () => {
  assert.deepEqual(goSemanticAdapter.capabilities("go"), GO_CAPABILITIES);
  const outcome = goFactExtractor.extract(factExtractorInput({ filePath: "bad.go", source: "package demo\nfunc (", language: "go" }));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const evidence = goSemanticAdapter.normalizeFile(outcome.facts, {
    generationId: "go-uncertain",
    repositoryIdentity: { id: "repo", identityKey: "repo", rootPath: "/repo", displayName: "repo" },
    sourceUnit: { repositoryId: "repo", relativePath: "bad.go", language: "go" },
    resolutionVersion: "14b-2",
  });
  assert.ok(evidence.diagnostics.some((item) => item.code === "parse_uncertain"));
  assert.ok(evidence.diagnostics.some((item) => item.code === "language_capability_unsupported"));
});

test("Go extraction is deterministic and does not use a source semantic fallback", async () => {
  const first = extractGoFacts(input);
  const second = extractGoFacts(input);
  assert.deepEqual(first, second);
  assert.equal(first.kind, "facts");
  if (first.kind !== "facts") return;
  const member = first.facts.members.find((item) => item.memberName === "Read");
  assert.ok(member);
  const result = await runFixtureThroughResolver({ name: "go", cases: [{ filePath: input.filePath, source, language: "go" }], sites: [{ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: input.filePath, language: "go" }, localId: member.localId }] }, [first.facts], goSemanticAdapter);
  assert.equal(result.usedSourceSemanticFallback, false);
});
