export type RetrievalIdentity =
  | { kind: "file"; path: string }
  | { kind: "symbol"; path: string; name: string; symbolKind: string; qualifiedName?: string; startLine?: number };

export type RetrievalSelector =
  | { kind: "file"; path: string }
  | { kind: "symbol"; path: string; name: string; symbolKind: string; qualifiedName?: string };

export type RankedCandidate = { identity: RetrievalIdentity; startLine?: number; effectiveRelevance?: number };
export type AmbiguityExpectation = "no-promotion" | "unique-promotion";

export type RetrievalJudgments = {
  relevant: readonly RetrievalSelector[];
  supporting?: readonly RetrievalSelector[];
  irrelevant?: readonly RetrievalSelector[];
  forbidden?: readonly RetrievalSelector[];
  exhaustive: boolean;
  ambiguous?: boolean;
  expectation?: AmbiguityExpectation;
};

export type RankingMetrics = {
  hitAt1: number | null;
  hitAt3: number | null;
  hitAt5: number | null;
  mrrAt5: number | null;
  recallAt5: number | null;
  recallAt10: number | null;
  precisionAt5?: number | null;
  ambiguityFalsePromotion: number;
  ambiguityCaseCount: number;
  canonicalDuplicateRate: number;
  chunkDuplicateRate: number;
  judgedNoiseRate: number;
  judgedCount: number;
  unjudgedCount: number;
  judgedCoverageAt5: number;
  judgedCoverageAt10: number;
  unjudgedAt5: number;
  unjudgedAt10: number;
  relevantSymbolCoverage: number | null;
};

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function canonicalIdentity(identity: RetrievalIdentity | RetrievalSelector): string {
  return identity.kind === "file"
    ? JSON.stringify(["file", normalizedPath(identity.path)])
    : JSON.stringify(["symbol", normalizedPath(identity.path), identity.symbolKind, identity.name]);
}

export function matchesSelector(identity: RetrievalIdentity, selector: RetrievalSelector): boolean {
  if (identity.kind !== selector.kind || normalizedPath(identity.path) !== normalizedPath(selector.path)) return false;
  if (selector.kind === "file" || identity.kind === "file") return true;
  return identity.symbolKind === selector.symbolKind
    && identity.name === selector.name
    && (selector.qualifiedName === undefined || identity.qualifiedName === undefined || identity.qualifiedName === selector.qualifiedName);
}

function matchesAny(identity: RetrievalIdentity, selectors: readonly RetrievalSelector[]): boolean {
  return selectors.some((selector) => matchesSelector(identity, selector));
}

export function evaluateRanking(candidates: readonly RankedCandidate[], judgments: RetrievalJudgments): RankingMetrics {
  const noPromotionOnly = judgments.expectation === "no-promotion" && judgments.ambiguous === true;
  if (!judgments.relevant.length && (!noPromotionOnly || (judgments.forbidden?.length ?? 0) < 2)) {
    throw new TypeError("Zero-relevant judgments require a no-promotion ambiguity case with at least two forbidden selectors");
  }
  const positiveSelectors = [...judgments.relevant, ...(judgments.supporting ?? [])];
  const relevant = new Set(positiveSelectors.map(canonicalIdentity));
  const negatives = [...(judgments.forbidden ?? []), ...(judgments.irrelevant ?? [])];
  const seenCanonical = new Set<string>();
  const seenChunks = new Set<string>();
  let canonicalDuplicates = 0;
  let chunkDuplicates = 0;
  let judgedCount = 0;
  let noiseCount = 0;
  let unjudgedCount = 0;
  const isJudged = (candidate: RankedCandidate): boolean => matchesAny(candidate.identity, positiveSelectors)
    || matchesAny(candidate.identity, negatives)
    || judgments.exhaustive;
  const ranked = candidates.map((candidate) => {
    const key = canonicalIdentity(candidate.identity);
    const line = candidate.startLine ?? candidate.identity.startLine ?? null;
    const chunkKey = JSON.stringify([key, line]);
    if (seenCanonical.has(key)) canonicalDuplicates += 1;
    else seenCanonical.add(key);
    if (seenChunks.has(chunkKey)) chunkDuplicates += 1;
    else seenChunks.add(chunkKey);
    if (isJudged(candidate)) {
      judgedCount += 1;
      if (!matchesAny(candidate.identity, positiveSelectors)) noiseCount += 1;
    } else unjudgedCount += 1;
    return { candidate, key, judged: isJudged(candidate) };
  });
  const firstRelevantRank = ranked.findIndex(({ candidate }) => matchesAny(candidate.identity, positiveSelectors)) + 1;
  const hit = (k: number): number => firstRelevantRank > 0 && firstRelevantRank <= k ? 1 : 0;
  const recall = (k: number): number => relevant.size
    ? new Set(ranked.slice(0, k).filter(({ key }) => relevant.has(key)).map(({ key }) => key)).size / relevant.size
    : 0;
  const scoredByIdentity = new Map<string, RankedCandidate>();
  for (const { candidate } of ranked) {
    if (candidate.effectiveRelevance === undefined) continue;
    const key = canonicalIdentity(candidate.identity);
    const prior = scoredByIdentity.get(key);
    if (!prior || candidate.effectiveRelevance > prior.effectiveRelevance!) scoredByIdentity.set(key, candidate);
  }
  const topScore = Math.max(...[...scoredByIdentity.values()].map((candidate) => candidate.effectiveRelevance!));
  const topCandidates = [...scoredByIdentity.values()].filter((candidate) => candidate.effectiveRelevance === topScore);
  const topCandidate = topCandidates.length === 1 ? topCandidates[0] : undefined;
  const winningIdentity = topCandidate ? canonicalIdentity(topCandidate.identity) : "";
  const competingJudged = ranked.filter(({ candidate, judged }) => judged && canonicalIdentity(candidate.identity) !== winningIdentity);
  const ambiguityFalsePromotion = judgments.ambiguous && topCandidate && matchesAny(topCandidate.identity, judgments.forbidden ?? [])
    && competingJudged.every(({ candidate }) => candidate.effectiveRelevance !== undefined
      && candidate.effectiveRelevance < topCandidate.effectiveRelevance!) ? 1 : 0;
  const precisionAt5 = new Set(ranked.slice(0, 5).filter(({ key }) => relevant.has(key)).map(({ key }) => key)).size / 5;
  const judgedCoverageAt = (k: number): number => {
    const pool = ranked.slice(0, k);
    return pool.length ? pool.filter((candidate) => candidate.judged).length / pool.length : 0;
  };
  const noTargetMetrics = noPromotionOnly;
  return {
    hitAt1: noTargetMetrics ? null : hit(1),
    hitAt3: noTargetMetrics ? null : hit(3),
    hitAt5: noTargetMetrics ? null : hit(5),
    mrrAt5: noTargetMetrics ? null : firstRelevantRank > 0 && firstRelevantRank <= 5 ? 1 / firstRelevantRank : 0,
    recallAt5: noTargetMetrics ? null : recall(5),
    recallAt10: noTargetMetrics ? null : recall(10),
    ...(judgments.exhaustive ? { precisionAt5: noTargetMetrics ? null : precisionAt5 } : {}),
    ambiguityFalsePromotion,
    ambiguityCaseCount: judgments.ambiguous ? 1 : 0,
    canonicalDuplicateRate: candidates.length ? canonicalDuplicates / candidates.length : 0,
    chunkDuplicateRate: candidates.length ? chunkDuplicates / candidates.length : 0,
    judgedNoiseRate: judgedCount ? noiseCount / judgedCount : 0,
    judgedCount,
    unjudgedCount,
    judgedCoverageAt5: judgedCoverageAt(5),
    judgedCoverageAt10: judgedCoverageAt(10),
    unjudgedAt5: ranked.slice(0, 5).filter((candidate) => !candidate.judged).length,
    unjudgedAt10: ranked.slice(0, 10).filter((candidate) => !candidate.judged).length,
    relevantSymbolCoverage: noTargetMetrics ? null : recall(10),
  };
}

export function aggregateRankingMetrics(metrics: readonly RankingMetrics[]): Record<string, number | null> {
  const rankingKeys = ["hitAt1", "hitAt3", "hitAt5", "mrrAt5", "recallAt5", "recallAt10", "relevantSymbolCoverage"] as const;
  const result: Record<string, number | null> = {};
  for (const key of rankingKeys) {
    const defined = metrics.map((item) => item[key]).filter((value): value is number => value !== null);
    result[key] = defined.length ? defined.reduce((sum, value) => sum + value, 0) / defined.length : null;
  }
  for (const key of ["canonicalDuplicateRate", "chunkDuplicateRate", "judgedNoiseRate", "judgedCoverageAt5", "judgedCoverageAt10"] as const) {
    result[key] = metrics.length ? metrics.reduce((sum, item) => sum + item[key], 0) / metrics.length : 0;
  }
  const ambiguityCases = metrics.filter((item) => item.ambiguityCaseCount > 0);
  result.ambiguityCaseCount = ambiguityCases.length;
  result.ambiguityFalsePromotion = ambiguityCases.length ? ambiguityCases.reduce((sum, item) => sum + item.ambiguityFalsePromotion, 0) / ambiguityCases.length : 0;
  const precision = metrics.map((item) => item.precisionAt5).filter((value): value is number => value !== undefined && value !== null);
  result.precisionAt5 = precision.length ? precision.reduce((sum, value) => sum + value, 0) / precision.length : null;
  result.judgedCount = metrics.reduce((sum, item) => sum + item.judgedCount, 0);
  result.unjudgedCount = metrics.reduce((sum, item) => sum + item.unjudgedCount, 0);
  result.unjudgedAt5 = metrics.reduce((sum, item) => sum + item.unjudgedAt5, 0);
  result.unjudgedAt10 = metrics.reduce((sum, item) => sum + item.unjudgedAt10, 0);
  return result;
}
