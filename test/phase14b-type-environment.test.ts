import assert from "node:assert/strict";
import test from "node:test";

import { createBudgetLedger, type ResolverBudgets } from "../src/core/graph/resolver/budgets.js";
import { createResolverMemo } from "../src/core/graph/resolver/memo.js";
import type { SourceRangeFact } from "../src/core/facts/facts.types.js";
import type {
  BindingEvidence,
  InheritanceEvidence,
  MemberEvidence,
  ReturnEvidence,
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
  const parentLocalId = { inner: "run", run: "function", function: "module" }[name];
  return { sourceUnit, localId: name, ...(parentLocalId ? { parentLocalId } : {}) };
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

test("environment keeps memo entries isolated by generation", () => {
  const memo = createResolverMemo();
  const first = environmentInput();
  const second = environmentInput();
  first.generationId = "generation:one";
  second.generationId = "generation:two";
  first.memo = memo;
  second.memo = memo;
  first.evidence = [{ ...first.evidence[0], typeAnnotations: [{ ...base, evidenceId: "type:one" as never, kind: "type_annotation", subjectLocalId: "value", type: { kind: "named", name: "First" } }] }];
  second.evidence = [{ ...second.evidence[0], typeAnnotations: [{ ...base, evidenceId: "type:two" as never, kind: "type_annotation", subjectLocalId: "value", type: { kind: "named", name: "Second" } }] }];

  const expression = { sourceUnit, localId: "value" };
  assert.deepEqual(createTypeEnvironment(first).inferType(expression), {
    status: "found", values: [{ kind: "named", name: "First" }], evidenceIds: ["type:one"],
  });
  assert.deepEqual(createTypeEnvironment(second).inferType(expression), {
    status: "found", values: [{ kind: "named", name: "Second" }], evidenceIds: ["type:two"],
  });
  assert.equal(memo.size(), 2);
});

test("environment matches expression evidence by source unit and local id", () => {
  const otherSourceUnit = { ...sourceUnit, relativePath: "src/other.ts" };
  const input = environmentInput();
  input.evidence = [{ ...input.evidence[0], typeAnnotations: [{ ...base, sourceUnit: otherSourceUnit, evidenceId: "type:other" as never, kind: "type_annotation", subjectLocalId: "value", type: { kind: "named", name: "Other" } }] }];
  assert.deepEqual(createTypeEnvironment(input).inferType({ sourceUnit, localId: "value" }), {
    status: "unknown", reason: "insufficient_evidence", evidenceIds: [],
  });
});

test("environment compares full qualified names for known inheritance types", () => {
  const input = environmentInput();
  const subject = symbol("pkg.Service", "class:service");
  const inheritance: InheritanceEvidence = {
    ...base,
    evidenceId: "inheritance:1" as never,
    kind: "inheritance",
    subject,
    target: { kind: "named", name: "Base", qualification: ["pkg"] },
    relation: "extends",
  };
  input.evidence = [{ ...input.evidence[0], inheritance: [inheritance] }];
  assert.deepEqual(createTypeEnvironment(input).resolveInheritance({ kind: "known", symbol: subject }), {
    status: "found",
    values: [{ kind: "named", name: "Base", qualification: ["pkg"] }],
    evidenceIds: ["inheritance:1"],
  });
});

test("environment traverses every enclosing scope when resolving shadowed bindings", () => {
  const input = environmentInput();
  const anchors: BindingEvidence[] = [
    { ...base, evidenceId: "binding:run" as never, kind: "binding", scope: scope("run"), name: "other", bindingId: "run" },
    { ...base, evidenceId: "binding:function" as never, kind: "binding", scope: scope("function"), name: "other", bindingId: "function" },
  ];
  input.evidence = [{ ...input.evidence[0], bindings: [...anchors, ...input.evidence[0].bindings] }];
  const result = createTypeEnvironment(input).lookupBinding(scope("inner"), "service");
  assert.equal(result.status, "found");
  if (result.status === "found") assert.deepEqual(result.values.map((value) => value.bindingId), ["outer"]);
});

test("environment canonically sorts values and evidence regardless of insertion order", () => {
  const input = environmentInput({ memberCandidates: 2 });
  const batch = input.evidence[0];
  const reversedMembers = [...batch.members].reverse();
  const reversedTypes = [
    { ...base, evidenceId: "type:2" as never, kind: "type_annotation" as const, subjectLocalId: "value", type: { kind: "named" as const, name: "Zed" } },
    { ...base, evidenceId: "type:1" as never, kind: "type_annotation" as const, subjectLocalId: "value", type: { kind: "named" as const, name: "Amy" } },
  ];
  const returns: ReturnEvidence[] = [
    { ...base, evidenceId: "return:2" as never, kind: "return", callable: symbol("run"), type: { kind: "named", name: "Zed" } },
    { ...base, evidenceId: "return:1" as never, kind: "return", callable: symbol("run"), type: { kind: "named", name: "Amy" } },
  ];
  input.evidence = [{ ...batch, members: reversedMembers, typeAnnotations: reversedTypes, returns }];
  const environment = createTypeEnvironment(input);
  const members = environment.resolveMember({ kind: "named", name: "Service" }, "refresh");
  assert.equal(members.status, "found");
  if (members.status === "found") {
    assert.deepEqual(members.values.map((value) => value.qualifiedName), ["Service.refresh1", "Service.refresh2"]);
    assert.deepEqual(members.evidenceIds, ["member:1", "member:2"]);
  }
  assert.deepEqual(environment.inferType({ sourceUnit, localId: "value" }), {
    status: "found",
    values: [{ kind: "named", name: "Amy" }, { kind: "named", name: "Zed" }],
    evidenceIds: ["type:1", "type:2"],
  });
  const returnsResult = environment.resolveReturn(symbol("run"));
  assert.equal(returnsResult.status, "found");
  if (returnsResult.status === "found") assert.deepEqual(returnsResult.values, [{ kind: "named", name: "Amy" }, { kind: "named", name: "Zed" }]);
});
