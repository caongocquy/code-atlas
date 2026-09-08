import assert from "node:assert/strict";
import test from "node:test";

import {
  pythonFactExtractor,
} from "../src/core/facts/extractors/python.js";
import { pythonSemanticAdapter } from "../src/core/graph/resolver/adapters/python.js";
import { factExtractorInput, runFixtureThroughResolver } from "./helpers/phase14b-language-fixtures.js";

const source = `
from services import Service as ImportedService
import tools.helpers as helpers

class Service:
    total: int = 0

    def __init__(self, value: int) -> None:
        self.value: int = value

    def refresh(self) -> int:
        self.total = self.value
        return self.total

def use(item: Service) -> Service:
    local = Service(1)
    alias = local
    local.refresh()
    return item

obj.dynamic = plugin.make()
`;

const input = factExtractorInput({ filePath: "phase14b/python/main.py", source, language: "python" });

test("Python floor extracts AST-backed imports, members, types, calls, and flow facts", () => {
  const outcome = pythonFactExtractor.extract(input);
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;

  assert.equal(outcome.facts.language, "python");
  assert.equal(outcome.facts.parseStatus, "complete");
  assert.deepEqual(outcome.facts.imports.map((item) => [item.moduleSpecifier, item.importedName, item.localName]), [
    ["services", "Service", "ImportedService"],
    ["tools.helpers", undefined, "helpers"],
  ]);
  assert.ok(outcome.facts.symbols.some((item) => item.kind === "class" && item.name === "Service"));
  assert.ok(outcome.facts.symbols.some((item) => item.kind === "method" && item.name === "__init__"));
  assert.ok(outcome.facts.members.some((item) => item.memberName === "value" && item.receiverId));
  assert.ok(outcome.facts.members.some((item) => item.memberName === "total"));
  assert.ok(outcome.facts.declaredTypeAnnotations.some((item) => item.text === "int"));
  assert.ok(outcome.facts.parameters.some((item) => item.name === "item" && item.typeText === "Service"));
  assert.ok(outcome.facts.returns.some((item) => item.typeText === "Service"));
  assert.ok(outcome.facts.constructors.some((item) => item.constructedTypeName === "Service"));
  assert.ok(outcome.facts.callSites.some((item) => item.calleeText === "local.refresh"));
  assert.ok(outcome.facts.assignments.some((item) => item.assignmentKind === "alias"));
});

test("Python floor resolves annotation-backed self members and preserves dynamic uncertainty", async () => {
  const outcome = pythonFactExtractor.extract(input);
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const typedMember = outcome.facts.members.find((item) => item.memberName === "total" && item.receiverId);
  const dynamicMember = outcome.facts.members.find((item) => item.memberName === "dynamic");
  assert.ok(typedMember);
  assert.ok(dynamicMember);

  const result = await runFixtureThroughResolver(
    {
      name: "python",
      cases: [{ filePath: input.filePath, source, language: "python" }],
      sites: [
        { sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: input.filePath, language: "python" }, localId: typedMember.localId },
        { sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: input.filePath, language: "python" }, localId: dynamicMember.localId },
      ],
    },
    [outcome.facts], pythonSemanticAdapter,
  );
  assert.equal(result.decisions[0]?.status, "resolved");
  assert.equal(result.decisions[1]?.status, "unknown");
  assert.equal(result.usedSourceSemanticFallback, false);
});

test("Python runtime-dependent constructs are explicit unsupported diagnostics", () => {
  const outcome = pythonFactExtractor.extract(factExtractorInput({
    filePath: "phase14b/python/runtime.py",
    language: "python",
    source: "setattr(target, name, value)\neval(code)\nexec(code)\n",
  }));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const evidence = pythonSemanticAdapter.normalizeFile(outcome.facts, {
    generationId: "test",
    repositoryIdentity: { id: "repo", identityKey: "repo", rootPath: "/repo", displayName: "repo" },
    sourceUnit: { repositoryId: "repo", relativePath: "runtime.py", language: "python" },
    resolutionVersion: "14b-2",
  });
  assert.ok(evidence.diagnostics.some((item) => item.code === "compiler_semantics_required"));
});
