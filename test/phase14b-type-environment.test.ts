import assert from "node:assert/strict";
import test from "node:test";

import { createBudgetLedger, type ResolverBudgets } from "../src/core/graph/resolver/budgets.js";
import { createResolverMemo } from "../src/core/graph/resolver/memo.js";
import type { SourceRangeFact } from "../src/core/facts/facts.types.js";
import type {
  BindingEvidence,
  MemberEvidence,
  SemanticEvidenceBatch,
  ScopeIdentity,
  SymbolIdentity,
  TypeRef,
  TypeEnvironmentInput,
} from "../src/core/graph/resolver/types.js";
import { createTypeEnvironment } from "../src/core/graph/resolver/type-environment.js";

const sourceUnit = { repositoryId: "repo", relativePath: "src/service.ts", language: "typescript" } as const;
const range: SourceRangeFact = { startLine: 1, endLine: 1 };
const base = { evidenceId: "evidence:1" as never, sourceUnit, range };
const budgets: ResolverBudgets = {
  candidateExpansions: 10,
  bindingHops: 10,
  returnDepth: 10,
  inheritanceDepth: 10,
  memberCandidates: 10,
  expressionNodes: 10,
  propagationRounds: 10,
};

const symbol = (qualifiedName: string, discriminator = qualifiedName): SymbolIdentity => ({
  repositoryId: "repo",
  relativePath: "src/service.ts",
  language: "typescript",
  kind: "class",
  qualifiedName,
  discriminator,
});

export function scope(name: string): ScopeIdentity {
  return { sourceUnit, localId: name, ...(name === "run" ? { parentLocalId: "module" } : {}) };
}

export function environmentInput(options: { shadowedBindings?: boolean; memberCandidates?: number } = {}): TypeEnvironmentInput {
  const bindings: BindingEvidence[] = [
    { ...base, kind: "binding", scope: scope("module"), name: "service", bindingId: "outer", declaredType: { kind: "named", name: "Service" } },
  ];
  if (options.shadowedBindings) {
    bindings.push({ ...base, evidenceId: "evidence:2" as never, kind: "binding", scope: scope("run"), name: "service", bindingId: "inner", declaredType: { kind: "named", name: "Service" } });
  }

  const members: MemberEvidence[] = Array.from({ length: options.memberCandidates ?? 0 }, (_, index) => ({
    ...base,
    evidenceId: `member:${index + 1}` as never,
    kind: "member" as const,
    ownerType: { kind: "named" as const, name: "Service" },
    memberName: "refresh",
    member: symbol(`Service.refresh${index + 1}`, `method:${index + 1}`),
    access: "instance" as const,
  }));

  const empty: SemanticEvidenceBatch = {
    bindings, imports: [], exports: [], typeAnnotations: [], constructors: [], assignments: [],
    parameters: [], returns: [], members, inheritance: [], implementations: [], aliases: [],
    modules: [], calls: [], diagnostics: [],
  };
  return {
    generationId: "generation:1",
    symbols: [symbol("Service"), ...members.map((member) => member.member)],
    evidence: [empty],
    budget: createBudgetLedger(budgets),
    memo: createResolverMemo(),
  };
}

test("environment preserves shadowing and multiple member candidates", () => {
  const environment = createTypeEnvironment(environmentInput({ shadowedBindings: true, memberCandidates: 2 }));
  const binding = environment.lookupBinding(scope("run"), "service");
  assert.equal(binding.status, "found");
  if (binding.status === "found") assert.deepEqual(binding.values.map((value) => value.bindingId), ["inner"]);

  const member = environment.resolveMember({ kind: "named", name: "Service" }, "refresh");
  assert.equal(member.status, "found");
  if (member.status === "found") assert.equal(member.values.length, 2);
});

test("environment reports explicit unknown and unsupported outcomes", () => {
  const environment = createTypeEnvironment(environmentInput());
  assert.deepEqual(environment.inferType({ sourceUnit, localId: "missing" }), {
    status: "unknown", reason: "insufficient_evidence", evidenceIds: [],
  });

  const unsupportedInput = environmentInput();
  unsupportedInput.evidence = [{ ...unsupportedInput.evidence[0], diagnostics: [{ code: "language_capability_unsupported", message: "unsupported", sourceUnit }] }];
  const unsupported = createTypeEnvironment(unsupportedInput).resolveMember({ kind: "named", name: "Service" }, "refresh");
  assert.deepEqual(unsupported, {
    status: "unsupported", reason: "language_capability_unsupported", evidenceIds: [],
  });
});

test("environment returns deterministic budget exhaustion without memoizing it", () => {
  const input = environmentInput({ memberCandidates: 2 });
  input.budget = createBudgetLedger({ ...budgets, memberCandidates: 1 });
  const environment = createTypeEnvironment(input);
  const result = environment.resolveMember({ kind: "named", name: "Service" }, "refresh");
  assert.equal(result.status, "budget_exhausted");
  if (result.status === "budget_exhausted") {
    assert.equal(result.reason, "member_candidate_limit");
    assert.deepEqual(result.evidenceIds, ["member:1"]);
  }
  assert.equal(input.memo.size(), 0);
});

