import type { SearchResult } from "./code-search.service.js";
import { buildContext } from "./context.js";

const MAX_CONTEXT_TOKENS = 4_000;

export type ContextBudgetResult = {
  chunks: SearchResult[];
  usedTokens: number;
};

export type ContextBudgetDecision = {
  chunk: SearchResult;
  tokens: number;
  included: boolean;
  reason?: "token-budget";
};

export type DetailedContextBudgetResult = ContextBudgetResult & {
  decisions: ContextBudgetDecision[];
  budget: number;
};

export type TokenCounter = (text: string) => Promise<number>;

export async function applyContextBudget(
  chunks: SearchResult[],
  maxTokens = MAX_CONTEXT_TOKENS,
  tokenCounter?: TokenCounter,
): Promise<ContextBudgetResult> {
  const result = await applyContextBudgetDetailed(chunks, maxTokens, tokenCounter);

  return {
    chunks: result.chunks,
    usedTokens: result.usedTokens,
  };
}

export async function applyContextBudgetDetailed(
  chunks: SearchResult[],
  maxTokens = MAX_CONTEXT_TOKENS,
  tokenCounter?: TokenCounter,
): Promise<DetailedContextBudgetResult> {
  const selected: SearchResult[] = [];
  const decisions: ContextBudgetDecision[] = [];
  let usedTokens = 0;

  for (const chunk of chunks) {
    // ponytail: O(n²) render checks, candidate count is bounded by retrieval caps.
    const tokenCount = await countContextTokens(buildContext([...selected, chunk]), tokenCounter);

    if (usedTokens + tokenCount > maxTokens) {
      decisions.push({
        chunk,
        tokens: tokenCount,
        included: false,
        reason: "token-budget",
      });
      continue;
    }

    selected.push(chunk);
    usedTokens = tokenCount;
    decisions.push({
      chunk,
      tokens: tokenCount,
      included: true,
    });
  }

  return {
    chunks: selected,
    usedTokens,
    decisions,
    budget: maxTokens,
  };
}

async function countContextTokens(text: string, tokenCounter?: TokenCounter): Promise<number> {
  return tokenCounter
    ? tokenCounter(text)
    : text.trim() ? text.trim().split(/\s+/).length : 0;
}
