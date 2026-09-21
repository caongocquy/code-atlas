import assert from "node:assert/strict";
import test from "node:test";

import {
  javascriptFactExtractor,
  tsxFactExtractor,
  typescriptFactExtractor,
} from "../src/core/facts/extractors/ecmascript.js";
import { ecmascriptSemanticAdapter } from "../src/core/graph/resolver/adapters/ecmascript.js";
import { factExtractorInput, runFixtureThroughResolver } from "./helpers/phase14b-language-fixtures.js";

const source = `
interface ServiceLike { refresh(): void }
type ServiceAlias = Service
class Service implements ServiceLike {
  refresh(): void { return; }
}
function use(input: Service): Service {
  const local: Service = new Service();
  const alias = local;
  alias.refresh();
  return alias;
}
export { Service };
`;

test("ECMAScript wrappers preserve exact language identity and objective syntax facts", () => {
  for (const [language, extractor] of [
    ["javascript", javascriptFactExtractor],
    ["typescript", typescriptFactExtractor],
    ["tsx", tsxFactExtractor],
  ] as const) {
    const languageSource = language === "javascript"
      ? "class Service { refresh() {} } const local = new Service(); local.refresh();"
      : source;
    const outcome = extractor.extract(factExtractorInput({
      filePath: `phase14b/ecmascript/main.${language === "javascript" ? "js" : language === "tsx" ? "tsx" : "ts"}`,
      source: languageSource,
      language,
    }));
    assert.equal(outcome.kind, "facts");
    if (outcome.kind !== "facts") return;
    assert.equal(outcome.facts.language, language);
    assert.equal(outcome.facts.parserIdentity.language, language);
    assert.ok(outcome.facts.symbols.some((item) => item.name === "Service"));
    assert.ok(outcome.facts.members.some((item) => item.memberName === "refresh"));
    assert.ok(outcome.facts.constructors.some((item) => item.constructedTypeName === "Service"));
    if (language !== "javascript") {
      assert.ok(outcome.facts.assignments.some((item) => item.assignmentKind === "alias"));
      assert.ok(outcome.facts.parameters.some((item) => item.name === "input"));
      assert.ok(outcome.facts.returns.length > 0);
      assert.ok(outcome.facts.implementations.some((item) => item.targetName === "ServiceLike"));
      assert.ok(outcome.facts.aliases.some((item) => item.aliasName === "ServiceAlias"));
    }
  }
});

test("ECMAScript adapter preserves JSX and parser uncertainty without source fallback", () => {
  const outcome = tsxFactExtractor.extract(factExtractorInput({
    filePath: "phase14b/ecmascript/view.tsx",
    source: "const view = <Widget value={missing} />;",
    language: "tsx",
  }));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;

  const evidence = ecmascriptSemanticAdapter.normalizeFile(outcome.facts, {
    generationId: "test",
    repositoryIdentity: { id: "repo", identityKey: "repo", rootPath: "/repo", displayName: "repo" },
    sourceUnit: { repositoryId: "repo", relativePath: "view.tsx", language: "tsx" },
    resolutionVersion: "14b-2",
  });
  assert.equal(evidence.diagnostics.some((item) => item.code === "parse_uncertain"), false);
  assert.equal(evidence.diagnostics.length, 0);
  assert.ok(outcome.facts.expressions.some((item) => item.kind === "other" || item.kind === "member"));
});

test("ECMAScript floor resolves typed construction and member calls without name guesses", async () => {
  const filePath = "phase14b/ecmascript/main.ts";
  const outcome = typescriptFactExtractor.extract(factExtractorInput({ filePath, source, language: "typescript" }));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const member = outcome.facts.members[0];
  assert.ok(member);
  const result = await runFixtureThroughResolver(
    { name: "ecmascript", cases: [{ filePath, source, language: "typescript" }], sites: [{ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: filePath, language: "typescript" }, localId: member.localId }] },
    [outcome.facts], ecmascriptSemanticAdapter,
  );
  assert.deepEqual(result.decisions.map((decision) => decision.status), ["resolved"]);
  assert.equal(result.decisions[0]?.status === "resolved" ? result.decisions[0].confidence : undefined, "strong");
  assert.equal(result.usedSourceSemanticFallback, false);
});

test("ECMAScript adapter carries partial parser status into diagnostics", () => {
  const outcome = typescriptFactExtractor.extract(factExtractorInput({
    filePath: "phase14b/ecmascript/broken.ts",
    source: "const broken: Service = ;",
    language: "typescript",
  }));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  assert.equal(outcome.facts.parseStatus, "deterministic_partial");
  const evidence = ecmascriptSemanticAdapter.normalizeFile(outcome.facts, {
    generationId: "test",
    repositoryIdentity: { id: "repo", identityKey: "repo", rootPath: "/repo", displayName: "repo" },
    sourceUnit: { repositoryId: "repo", relativePath: "broken.ts", language: "typescript" },
    resolutionVersion: "14b-2",
  });
  assert.ok(evidence.diagnostics.some((item) => item.code === "parse_uncertain"));
});

test("ECMAScript imports and exports preserve every named specifier and identity", () => {
  const outcome = typescriptFactExtractor.extract(factExtractorInput({
    filePath: "phase14b/ecmascript/names.ts",
    source: 'import { alpha as beta, gamma } from "mod"; export { beta as renamed, gamma };',
    language: "typescript",
  }));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  assert.deepEqual(outcome.facts.imports.map((item) => [item.importedName, item.localName]), [["alpha", "beta"], ["gamma", "gamma"]]);
  assert.deepEqual(outcome.facts.exports.map((item) => [item.exportedName, item.localName]), [["renamed", "beta"], ["gamma", "gamma"]]);
});

test("ECMAScript nested chains keep AST-local receivers and remain uncertain when receiver type is unknown", () => {
  const outcome = javascriptFactExtractor.extract(factExtractorInput({
    filePath: "phase14b/ecmascript/chains.js",
    source: "root.child().leaf();",
    language: "javascript",
  }));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  assert.equal(outcome.facts.callSites.length, 2);
  assert.equal(outcome.facts.members.length, 2);
  assert.notEqual(outcome.facts.members[0]?.receiverId, outcome.facts.members[1]?.receiverId);
  const evidence = ecmascriptSemanticAdapter.normalizeFile(outcome.facts, {
    generationId: "test",
    repositoryIdentity: { id: "repo", identityKey: "repo", rootPath: "/repo", displayName: "repo" },
    sourceUnit: { repositoryId: "repo", relativePath: "chains.js", language: "javascript" },
    resolutionVersion: "14b-2",
  });
  assert.equal(evidence.members.length, 0);
  assert.ok(evidence.diagnostics.some((item) => item.code === "receiver_type_unknown"));
});

test("ECMAScript parameters and returns use their containing callable identities", () => {
  const outcome = typescriptFactExtractor.extract(factExtractorInput({
    filePath: "phase14b/ecmascript/nested.ts",
    source: "function outer() { function inner(input: Service): Service { return input; } }",
    language: "typescript",
  }));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const inner = outcome.facts.symbols.find((item) => item.name === "inner");
  assert.ok(inner);
  assert.equal(outcome.facts.parameters[0]?.ownerSymbolId, inner?.localId);
  assert.equal(outcome.facts.returns[0]?.ownerSymbolId, inner?.localId);
});

test("ECMAScript wrappers reject a mismatched singular language", () => {
  const input = factExtractorInput({ filePath: "phase14b/ecmascript/main.ts", source: "const value = 1;", language: "typescript" });
  const outcome = javascriptFactExtractor.extract(input);
  assert.equal(outcome.kind, "infrastructure_failure");
});

test("malformed ECMAScript cannot resolve a strong member/call authoritatively", async () => {
  const filePath = "phase14b/ecmascript/malformed.ts";
  const malformed = "class Service { refresh() {} } const broken: Service = ; broken.refresh();";
  const outcome = typescriptFactExtractor.extract(factExtractorInput({ filePath, source: malformed, language: "typescript" }));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  assert.equal(outcome.facts.parseStatus, "deterministic_partial");
  const member = outcome.facts.members[0];
  assert.ok(member);
  const result = await runFixtureThroughResolver(
    { name: "ecmascript-malformed", cases: [{ filePath, source: malformed, language: "typescript" }], sites: [{ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: filePath, language: "typescript" }, localId: member.localId }] },
    [outcome.facts], ecmascriptSemanticAdapter,
  );
  assert.notEqual(result.decisions[0]?.status, "resolved");
  assert.equal(result.decisions[0]?.status, "unsupported");
});

test("anonymous functions and arrows get deterministic AST-local callable ownership", () => {
  const filePath = "phase14b/ecmascript/anonymous.ts";
  const anonymous = "const first = (input: Service): Service => input; const second = (value: Service): Service => value;";
  const outcome = typescriptFactExtractor.extract(factExtractorInput({ filePath, source: anonymous, language: "typescript" }));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  assert.equal(outcome.facts.parameters.length, 2);
  assert.equal(outcome.facts.returns.length, 2);
  const parameterOwners = outcome.facts.parameters.map((item) => item.ownerSymbolId);
  const returnOwners = outcome.facts.returns.map((item) => item.ownerSymbolId);
  assert.deepEqual(parameterOwners, returnOwners);
  assert.equal(new Set(parameterOwners).size, 2);
  assert.ok(parameterOwners.every((owner) => owner !== "symbol:0"));
  assert.ok(parameterOwners.every((owner) => owner.startsWith("symbol:arrow_function:")));
});
