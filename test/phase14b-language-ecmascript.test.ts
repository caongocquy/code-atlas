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
