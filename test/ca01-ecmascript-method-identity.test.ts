import assert from "node:assert/strict";
import test from "node:test";

import { getLanguageFactExtractor } from "../src/core/facts/language-fact-extractor.js";
import { getSemanticAdapter } from "../src/core/graph/resolver/adapter-registry.js";
import { factExtractorInput, runFixtureThroughResolver } from "./helpers/phase14b-language-fixtures.js";

test("CA-01 TypeScript method identity retains owner-qualified symbol when member resolution is exact", async () => {
  const item = {
    filePath: "phase14b/conformance/main.ts",
    language: "typescript" as const,
    source: "class Base {} interface Api {} class Child extends Base implements Api {} class Service { refresh() {} } const local = new Service(); local.refresh();\n",
  };
  const extractor = getLanguageFactExtractor(item.language);
  const adapter = getSemanticAdapter(item.language);
  assert.ok(extractor);
  assert.ok(adapter);
  const extracted = extractor.extract(factExtractorInput(item));
  assert.equal(extracted.kind, "facts");
  if (extracted.kind !== "facts") return;

  const refresh = extracted.facts.symbols.find(symbol => symbol.kind === "method" && symbol.name === "refresh");
  assert.ok(refresh);
  assert.equal(refresh.declaredQualifiedName, "Service.refresh");

  const member = extracted.facts.members.find(fact => fact.memberName === "refresh");
  assert.ok(member);
  const sourceUnit = { repositoryId: "phase14b-fixtures", relativePath: item.filePath, language: item.language };
  const resolved = await runFixtureThroughResolver({
    name: "ca01-owner-qualified-method",
    cases: [item],
    sites: [{ sourceUnit, localId: member.localId }],
  }, [extracted.facts], adapter);
  assert.equal(resolved.decisions.length, 1);
  assert.equal(resolved.decisions[0]?.status, "resolved");
  if (resolved.decisions[0]?.status === "resolved") {
    assert.equal(resolved.decisions[0].target.qualifiedName, "Service.refresh");
  }
});
