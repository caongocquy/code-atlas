export type ResolverBudgets = {
  candidateExpansions: number;
  bindingHops: number;
  returnDepth: number;
  inheritanceDepth: number;
  memberCandidates: number;
  expressionNodes: number;
  propagationRounds: number;
};

export type BudgetKind = keyof ResolverBudgets;

const budgetKinds: readonly BudgetKind[] = [
  "candidateExpansions",
  "bindingHops",
  "returnDepth",
  "inheritanceDepth",
  "memberCandidates",
  "expressionNodes",
  "propagationRounds",
];

export type BudgetLedger = {
  consume(kind: BudgetKind, amount?: number): boolean;
  remaining(kind: BudgetKind): number;
  snapshot(): Readonly<ResolverBudgets>;
};

function assertValidOperationCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

export function createBudgetLedger(budgets: ResolverBudgets): BudgetLedger {
  for (const kind of budgetKinds) {
    assertValidOperationCount(budgets[kind], kind);
  }
  const state: ResolverBudgets = { ...budgets };
  return {
    consume(kind, amount = 1) {
      assertValidOperationCount(amount, "amount");
      if (state[kind] < amount) return false;
      state[kind] -= amount;
      return true;
    },
    remaining: (kind) => state[kind],
    snapshot: () => ({ ...state }),
  };
}
