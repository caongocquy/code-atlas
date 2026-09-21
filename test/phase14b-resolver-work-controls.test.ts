import test from "node:test";
import assert from "node:assert/strict";
import {
  createBudgetLedger,
  type BudgetKind,
  type ResolverBudgets,
} from "../src/core/graph/resolver/budgets.js";
import {
  createResolverMemo,
  type MemoEntry,
} from "../src/core/graph/resolver/memo.js";
import type { SymbolIdentity, TypeRef } from "../src/core/graph/resolver/types.js";

const budgetKinds: readonly BudgetKind[] = [
  "candidateExpansions",
  "bindingHops",
  "returnDepth",
  "inheritanceDepth",
  "memberCandidates",
  "expressionNodes",
  "propagationRounds",
];

const validBudgets: ResolverBudgets = {
  candidateExpansions: 2,
  bindingHops: 1,
  returnDepth: 1,
  inheritanceDepth: 1,
  memberCandidates: 1,
  expressionNodes: 2,
  propagationRounds: 1,
};

const invalidNumbers = [
  Number.NaN,
  -1,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  1.5,
  Number.MAX_SAFE_INTEGER + 1,
];

test("budget ledger is deterministic and memo stores only stable entries", () => {
  const ledger = createBudgetLedger(validBudgets);

  assert.equal(ledger.consume("candidateExpansions"), true);
  assert.equal(ledger.consume("candidateExpansions"), true);
  assert.equal(ledger.consume("candidateExpansions"), false);

  const memo = createResolverMemo();
  memo.set("k", {
    kind: "unknown",
    reason: "dynamic_expression",
    evidenceIds: [],
    stable: true,
  });
  assert.equal(memo.get("k")?.kind, "unknown");
});

test("budget ledger rejects invalid initial budgets and consumption amounts", () => {
  for (const kind of budgetKinds) {
    for (const value of invalidNumbers) {
      assert.throws(
        () => createBudgetLedger({ ...validBudgets, [kind]: value }),
        RangeError,
        `${kind} should reject ${String(value)} as an initial budget`,
      );
    }
  }

  const ledger = createBudgetLedger(validBudgets);
  assert.equal(ledger.consume("candidateExpansions", 0), true);
  assert.equal(ledger.remaining("candidateExpansions"), 2);
  assert.equal(ledger.consume("candidateExpansions", 2), true);
  assert.equal(ledger.remaining("candidateExpansions"), 0);
  assert.equal(ledger.consume("candidateExpansions"), false);

  for (const kind of budgetKinds) {
    for (const value of invalidNumbers) {
      assert.throws(
        () => ledger.consume(kind, value),
        RangeError,
        `${kind} should reject ${String(value)} as a consumption amount`,
      );
    }
  }
});

test("budget ledger accepts zero and safe-integer boundaries", () => {
  const zeroLedger = createBudgetLedger({
    candidateExpansions: 0,
    bindingHops: 0,
    returnDepth: 0,
    inheritanceDepth: 0,
    memberCandidates: 0,
    expressionNodes: 0,
    propagationRounds: 0,
  });
  assert.deepEqual(zeroLedger.snapshot(), {
    candidateExpansions: 0,
    bindingHops: 0,
    returnDepth: 0,
    inheritanceDepth: 0,
    memberCandidates: 0,
    expressionNodes: 0,
    propagationRounds: 0,
  });

  const maximumLedger = createBudgetLedger({
    ...validBudgets,
    candidateExpansions: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(maximumLedger.remaining("candidateExpansions"), Number.MAX_SAFE_INTEGER);
  assert.equal(maximumLedger.consume("candidateExpansions", Number.MAX_SAFE_INTEGER), true);
  assert.equal(maximumLedger.remaining("candidateExpansions"), 0);
});

test("memo clones caller-owned entries and freezes returned snapshots", () => {
  const symbol: SymbolIdentity = {
    repositoryId: "repo",
    relativePath: "src/service.ts",
    language: "typescript",
    kind: "class",
    qualifiedName: "Service",
    discriminator: "class:1",
  };
  const type: TypeRef = { kind: "known", symbol };
  const entry: MemoEntry = {
    kind: "types",
    values: [type],
    evidenceIds: ["evidence-1" as never],
  };
  const memo = createResolverMemo();

  memo.set("types", entry);
  (entry.values as TypeRef[]).push({ kind: "unknown", reason: "dynamic_expression" });
  (entry.evidenceIds as string[]).push("evidence-2");
  symbol.qualifiedName = "MutatedService";

  const snapshot = memo.get("types");
  assert.equal(snapshot?.kind, "types");
  if (snapshot?.kind !== "types") return;
  assert.equal(snapshot.values.length, 1);
  assert.deepEqual(snapshot.evidenceIds, ["evidence-1"]);
  assert.equal((snapshot.values[0] as { kind: "known"; symbol: SymbolIdentity }).symbol.qualifiedName, "Service");
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.values), true);
  assert.equal(Object.isFrozen(snapshot.values[0]), true);
  assert.equal(Object.isFrozen((snapshot.values[0] as { kind: "known"; symbol: SymbolIdentity }).symbol), true);
  assert.throws(() => (snapshot.values as TypeRef[]).push({ kind: "unknown", reason: "dynamic_expression" }), TypeError);
  assert.throws(() => {
    (snapshot.values[0] as { kind: "known"; symbol: SymbolIdentity }).symbol.qualifiedName = "Changed";
  }, TypeError);
});

test("budget ledger records failed operations separately from remaining capacity", () => {
  const ledger = createBudgetLedger({ candidateExpansions: 1, bindingHops: 1, returnDepth: 1, inheritanceDepth: 1, memberCandidates: 1, expressionNodes: 1, propagationRounds: 1 });
  assert.equal(ledger.remaining("candidateExpansions"), 1);
  assert.equal(ledger.failed("candidateExpansions"), false);
  assert.equal(ledger.consume("candidateExpansions"), true);
  assert.equal(ledger.remaining("candidateExpansions"), 0);
  assert.equal(ledger.failed("candidateExpansions"), false);
  assert.equal(ledger.consume("candidateExpansions"), false);
  assert.equal(ledger.failed("candidateExpansions"), true);
  assert.deepEqual(ledger.failedOperations(), ["candidateExpansions"]);
});
