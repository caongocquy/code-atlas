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

export type BudgetLedger = {
  consume(kind: BudgetKind, amount?: number): boolean;
  remaining(kind: BudgetKind): number;
  snapshot(): Readonly<ResolverBudgets>;
};

export function createBudgetLedger(budgets: ResolverBudgets): BudgetLedger {
  const state: ResolverBudgets = { ...budgets };
  return {
    consume(kind, amount = 1) {
      if (amount < 0 || state[kind] < amount) return false;
      state[kind] -= amount;
      return true;
    },
    remaining: (kind) => state[kind],
    snapshot: () => ({ ...state }),
  };
}
