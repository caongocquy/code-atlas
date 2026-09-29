import type { CompileTaskContextInput, TaskContextBudget, TaskContextFullItem } from "./task-context.types.js";

export const DEFAULT_TASK_CONTEXT_BUDGET = { maxItems: 20, maxEstimatedTokens: 4_000 } as const;

export function resolveTaskContextBudget(
  request?: CompileTaskContextInput["budget"],
): { maxItems: number; maxEstimatedTokens: number } {
  const maxItems = request?.maxItems ?? DEFAULT_TASK_CONTEXT_BUDGET.maxItems;
  const maxEstimatedTokens = request?.maxEstimatedTokens ?? DEFAULT_TASK_CONTEXT_BUDGET.maxEstimatedTokens;
  if (!Number.isInteger(maxItems) || maxItems <= 0 || !Number.isInteger(maxEstimatedTokens) || maxEstimatedTokens <= 0) throw new TypeError("budget limits must be positive integers");
  return { maxItems, maxEstimatedTokens };
}

export function budgetTaskContext(
  items: readonly TaskContextFullItem[],
  request?: CompileTaskContextInput["budget"],
): { items: TaskContextFullItem[]; budget: TaskContextBudget; diagnostics: string[] } {
  const { maxItems, maxEstimatedTokens } = resolveTaskContextBudget(request);
  const selected: TaskContextFullItem[] = [];
  let estimatedTokens = 0;
  for (const item of items) {
    const cost = item.estimatedTokens ?? 256;
    const required = item.priority === "required";
    if (required || (selected.length < maxItems && estimatedTokens + cost <= maxEstimatedTokens)) {
      selected.push(item);
      estimatedTokens += cost;
    }
  }
  const budgetExceeded = selected.some((item) => item.priority === "required" && (selected.length > maxItems || estimatedTokens > maxEstimatedTokens));
  return {
    items: selected,
    budget: { maxItems, maxEstimatedTokens, selectedItems: selected.length, estimatedTokens, omittedItems: items.length - selected.length, budgetExceeded },
    diagnostics: budgetExceeded ? ["required subjects exceed the requested budget"] : [],
  };
}
