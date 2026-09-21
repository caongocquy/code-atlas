import assert from "node:assert/strict";
import test from "node:test";

import {
  pythonFactExtractor,
} from "../src/core/facts/extractors/python.js";
import type { ParsedFactsBlob } from "../src/core/facts/facts.types.js";
import { createBudgetLedger } from "../src/core/graph/resolver/budgets.js";
import { createGenerationResolverContext } from "../src/core/graph/resolver/generation-context.js";
import { symbolIdentity } from "../src/core/graph/resolver/identities.js";
import { createResolverMemo } from "../src/core/graph/resolver/memo.js";
import { pythonSemanticAdapter } from "../src/core/graph/resolver/adapters/python.js";
import { resolveSite } from "../src/core/graph/resolver/resolver.js";
import { createTypeEnvironment } from "../src/core/graph/resolver/type-environment.js";
import { factExtractorInput, runFixtureThroughResolver } from "./helpers/phase14b-language-fixtures.js";

const source = `
from services import Service as ImportedService
import tools.helpers as helpers

class Service:
    total: int = 0
    label: str

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
    source: "setattr(target, name, value)\ngetattr(target, name)\neval(code)\nexec(code)\n",
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

test("Python class annotations and self assignments retain class-owned member evidence", async () => {
  const annotationSource = `
class Service:
    label: str

    def __init__(self, value: int) -> None:
        self.value: int = value

    def read(self) -> str:
        return self.label
`;
  const filePath = "phase14b/python/annotation-members.py";
  const outcome = pythonFactExtractor.extract(factExtractorInput({ filePath, source: annotationSource, language: "python" }));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const classSymbol = outcome.facts.symbols.find((item) => item.kind === "class" && item.name === "Service");
  assert.ok(classSymbol);
  const labelSymbol = outcome.facts.symbols.find((item) => item.kind === "variable" && item.name === "label");
  const valueSymbol = outcome.facts.symbols.find((item) => item.kind === "variable" && item.name === "value");
  assert.equal(labelSymbol?.scopeId, classSymbol?.scopeId);
  assert.equal(valueSymbol?.scopeId, classSymbol?.scopeId);
  assert.ok(outcome.facts.declaredTypeAnnotations.some((item) => item.ownerId === labelSymbol?.localId && item.text === "str"));
  assert.ok(outcome.facts.declaredTypeAnnotations.some((item) => item.ownerId === valueSymbol?.localId && item.text === "int"));
  assert.ok(outcome.facts.assignments.some((item) => item.targetId === valueSymbol?.localId));
  const selfLabel = outcome.facts.members.find((item) => item.memberName === "label");
  assert.ok(selfLabel);
  const result = await runFixtureThroughResolver(
    { name: "python-annotation-members", cases: [{ filePath, source: annotationSource, language: "python" }], sites: [{ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: filePath, language: "python" }, localId: selfLabel.localId }] },
    [outcome.facts], pythonSemanticAdapter,
  );
  assert.equal(result.decisions[0]?.status, "resolved");
});

test("Python direct calls resolve declared functions and duplicate declarations remain ambiguous", async () => {
  const directSource = "def helper() -> int:\n    return 1\n\nhelper()\n";
  const directPath = "phase14b/python/direct-call.py";
  const directOutcome = pythonFactExtractor.extract(factExtractorInput({ filePath: directPath, source: directSource, language: "python" }));
  assert.equal(directOutcome.kind, "facts");
  if (directOutcome.kind !== "facts") return;
  const directCall = directOutcome.facts.callSites.find((item) => item.calleeText === "helper");
  assert.ok(directCall);
  const direct = await runFixtureThroughResolver(
    { name: "python-direct-call", cases: [{ filePath: directPath, source: directSource, language: "python" }], sites: [{ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: directPath, language: "python" }, localId: directCall.localId }] },
    [directOutcome.facts], pythonSemanticAdapter,
  );
  assert.equal(direct.decisions[0]?.status, "resolved");

  const ambiguousSource = "def helper() -> int:\n    return 1\n\ndef helper() -> int:\n    return 2\n\nhelper()\n";
  const ambiguousPath = "phase14b/python/ambiguous-call.py";
  const ambiguousOutcome = pythonFactExtractor.extract(factExtractorInput({ filePath: ambiguousPath, source: ambiguousSource, language: "python" }));
  assert.equal(ambiguousOutcome.kind, "facts");
  if (ambiguousOutcome.kind !== "facts") return;
  const ambiguousCall = ambiguousOutcome.facts.callSites.find((item) => item.calleeText === "helper");
  assert.ok(ambiguousCall);
  const ambiguous = await runFixtureThroughResolver(
    { name: "python-ambiguous-call", cases: [{ filePath: ambiguousPath, source: ambiguousSource, language: "python" }], sites: [{ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: ambiguousPath, language: "python" }, localId: ambiguousCall.localId }] },
    [ambiguousOutcome.facts], pythonSemanticAdapter,
  );
  assert.equal(ambiguous.decisions[0]?.status, "ambiguous");
});

test("Python resolver reports budget exhaustion and repeats cold/warm deterministically", async () => {
  const outcome = pythonFactExtractor.extract(input);
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const call = outcome.facts.callSites.find((item) => item.calleeText === "local.refresh");
  assert.ok(call);
  const repositoryIdentity = { id: "phase14b-fixtures", identityKey: "phase14b-fixtures", rootPath: "/phase14b-fixtures", displayName: "phase14b-fixtures" };
  const sourceUnit = { repositoryId: repositoryIdentity.id, relativePath: input.filePath, language: "python" as const };
  const symbols = outcome.facts.symbols.map((item) => symbolIdentity({ repositoryId: sourceUnit.repositoryId, relativePath: sourceUnit.relativePath, language: sourceUnit.language, kind: item.kind, qualifiedName: item.declaredQualifiedName ?? item.name, discriminator: item.localId }));
  const evidence = pythonSemanticAdapter.normalizeFile(outcome.facts, { generationId: "python-budget", repositoryIdentity, sourceUnit, resolutionVersion: "14b-2" });
  const budget = createBudgetLedger({ candidateExpansions: 0, bindingHops: 100, returnDepth: 100, inheritanceDepth: 100, memberCandidates: 100, expressionNodes: 100, propagationRounds: 100 });
  const environment = createTypeEnvironment({ generationId: "python-budget", symbols, evidence: [evidence], budget, memo: createResolverMemo() });
  const context = createGenerationResolverContext({ generationId: "python-budget", repositoryIdentity, parsedFactsView: [outcome.facts], languageRegistry: [pythonSemanticAdapter], typeEnvironment: environment, budget, memo: createResolverMemo(), resolutionVersion: "14b-2" });
  const exhausted = resolveSite({ facts: outcome.facts, evidence, environment, context }, { sourceUnit, localId: call.localId });
  assert.equal(exhausted.status, "budget_exhausted");

  const repeated = pythonFactExtractor.extract(input);
  assert.deepEqual(repeated, outcome);
  const member = outcome.facts.members.find((item) => item.memberName === "total" && item.receiverId);
  assert.ok(member);
  const fixture = { name: "python-repeat", cases: [{ filePath: input.filePath, source, language: "python" as const }], sites: [{ sourceUnit, localId: member.localId }] };
  const cold = await runFixtureThroughResolver(fixture, [outcome.facts], pythonSemanticAdapter, "cold", false);
  assert.ok(cold.resolverState.memo.size() > 0);
  const warm = await runFixtureThroughResolver(fixture, [outcome.facts], pythonSemanticAdapter, "warm", true, cold.resolverState);
  assert.strictEqual(warm.resolverState, cold.resolverState);
  assert.ok(warm.resolverState.memoHitCount > 0);
  assert.deepEqual(warm.decisions, cold.decisions);
  assert.deepEqual(warm.normalizedFacts, cold.normalizedFacts);
});
