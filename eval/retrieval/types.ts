import { canonicalIdentity, type AmbiguityExpectation, type RetrievalSelector } from "./metrics.js";

export const RETRIEVAL_DATASET_VERSION = "retrieval-eval-v2" as const;
export const RETRIEVAL_REPORT_SCHEMA_VERSION = 4 as const;

export type QueryClass = "exact-symbol" | "implementation-discovery" | "caller" | "callee" | "cross-file" | "ambiguous" | "natural-language" | "lexical-only" | "semantic-paraphrase" | "graph-dependent" | "scip-improved-cross-file" | "semantic-disabled" | "semantic-unavailable";
export type SemanticProfile = "all" | "enabled" | "disabled" | "unavailable";
export type SemanticStyle = "direct-synonym" | "weak-lexical-overlap" | "mixed" | "no-added-value";
export type ScipGraphPair = { seed: RetrievalSelector; target: RetrievalSelector; relation: "calls" | "references" | "imports" | "implements" | "extends" };
export type FrozenSemanticCase = { queryVector: number[]; candidates: Array<{ selector: RetrievalSelector; vector: number[] }> };
export type RetrievalEvalCase = {
  id: string; query: string; queryClass: QueryClass; fixture: string; split: "development" | "held-out"; profile: SemanticProfile;
  relevant: RetrievalSelector[]; supporting?: RetrievalSelector[]; irrelevant?: RetrievalSelector[]; forbidden?: RetrievalSelector[];
  exhaustive: boolean; ambiguous?: boolean; expectation?: AmbiguityExpectation; semanticStyle?: SemanticStyle;
  semanticVectors?: FrozenSemanticCase; scipPair?: ScipGraphPair;
};
export type RetrievalDataset = { datasetVersion: typeof RETRIEVAL_DATASET_VERSION; semanticVectorFixtureId: string; cases: RetrievalEvalCase[] };

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function validVector(value: unknown): value is number[] { return Array.isArray(value) && value.length > 0 && value.length <= 256 && value.every((item) => typeof item === "number" && Number.isFinite(item)); }

function validateSelector(value: unknown, label: string): RetrievalSelector {
  if (!isRecord(value) || typeof value.path !== "string" || !value.path || value.path.startsWith("/") || value.path.split(/[\\/]/).includes("..")) throw new TypeError(`Invalid ${label} selector path`);
  if (value.kind === "file") return { kind: "file", path: value.path };
  if (value.kind !== "symbol" || typeof value.name !== "string" || !value.name || typeof value.symbolKind !== "string" || !value.symbolKind) throw new TypeError(`Invalid ${label} symbol selector`);
  return { kind: "symbol", path: value.path, name: value.name, symbolKind: value.symbolKind, ...(typeof value.qualifiedName === "string" ? { qualifiedName: value.qualifiedName } : {}) };
}

function validateCase(value: unknown, index: number): RetrievalEvalCase {
  const label = `case ${index + 1}`;
  const classes: QueryClass[] = ["exact-symbol", "implementation-discovery", "caller", "callee", "cross-file", "ambiguous", "natural-language", "lexical-only", "semantic-paraphrase", "graph-dependent", "scip-improved-cross-file", "semantic-disabled", "semantic-unavailable"];
  const validCase = isRecord(value) && typeof value.id === "string" && !!value.id && typeof value.query === "string" && !!value.query.trim()
    && typeof value.fixture === "string" && !!value.fixture && !value.fixture.startsWith("/") && !value.fixture.split(/[\\/]/).includes("..")
    && classes.includes(value.queryClass as QueryClass) && (value.split === "development" || value.split === "held-out")
    && ["all", "enabled", "disabled", "unavailable"].includes(String(value.profile)) && typeof value.exhaustive === "boolean"
    && Array.isArray(value.relevant);
  if (!validCase) throw new TypeError(`Invalid retrieval ${label}`);
  const selectors = (field: unknown, name: string): RetrievalSelector[] => {
    if (field === undefined) return [];
    if (!Array.isArray(field)) throw new TypeError(`Invalid ${name} judgments in ${label}`);
    return field.map((item) => validateSelector(item, name));
  };
  const relevant = selectors(value.relevant, "relevant");
  const supporting = selectors(value.supporting, "supporting");
  const irrelevant = selectors(value.irrelevant, "irrelevant");
  const forbidden = selectors(value.forbidden, "forbidden");
  const ambiguous = value.ambiguous === true;
  const expectation = value.expectation as AmbiguityExpectation | undefined;
  if (value.ambiguous !== undefined && typeof value.ambiguous !== "boolean") throw new TypeError(`Invalid ambiguity flag in ${label}`);
  if (ambiguous && expectation !== "no-promotion" && expectation !== "unique-promotion") throw new TypeError(`Ambiguous ${label} needs an explicit expectation`);
  if (!ambiguous && expectation !== undefined) throw new TypeError(`Expectation is only valid for ambiguous ${label}`);
  if (expectation === "no-promotion" && (relevant.length || forbidden.length < 2)) throw new TypeError(`No-promotion ${label} needs zero relevant selectors and at least two forbidden selectors`);
  if (expectation === "unique-promotion" && !relevant.length) throw new TypeError(`Unique-promotion ${label} needs a relevant selector`);
  if (!relevant.length && expectation !== "no-promotion") throw new TypeError(`Zero-relevant ${label} requires a no-promotion expectation`);
  if (value.exhaustive && (!relevant.length || (!irrelevant.length && !forbidden.length))) throw new TypeError(`Exhaustive ${label} needs relevant and negative judgments`);
  if (value.semanticStyle !== undefined && !["direct-synonym", "weak-lexical-overlap", "mixed", "no-added-value"].includes(String(value.semanticStyle))) throw new TypeError(`Invalid semantic style in ${label}`);
  if (value.semanticStyle !== undefined && value.semanticVectors === undefined) throw new TypeError(`Semantic style in ${label} requires frozen vectors`);
  const allJudgments = [...relevant, ...supporting, ...irrelevant, ...forbidden].map(canonicalIdentity);
  if (new Set(allJudgments).size !== allJudgments.length) throw new TypeError(`Duplicate or conflicting judgments in ${label}`);

  let semanticVectors: FrozenSemanticCase | undefined;
  if (value.semanticVectors !== undefined) {
    if (!isRecord(value.semanticVectors) || !validVector(value.semanticVectors.queryVector) || !Array.isArray(value.semanticVectors.candidates)) throw new TypeError(`Invalid semantic vectors in ${label}`);
    semanticVectors = { queryVector: value.semanticVectors.queryVector, candidates: value.semanticVectors.candidates.map((candidate) => {
      if (!isRecord(candidate) || !validVector(candidate.vector)) throw new TypeError(`Invalid semantic candidate in ${label}`);
      if (candidate.vector.length !== value.semanticVectors.queryVector.length) throw new TypeError(`Mismatched semantic vector dimensions in ${label}`);
      return { selector: validateSelector(candidate.selector, "semantic"), vector: candidate.vector };
    }) };
  }
  let scipPair: ScipGraphPair | undefined;
  if (value.scipPair !== undefined) {
    if (!isRecord(value.scipPair) || !["calls", "references", "imports", "implements", "extends"].includes(String(value.scipPair.relation))) throw new TypeError(`Invalid SCIP graph pair in ${label}`);
    scipPair = { seed: validateSelector(value.scipPair.seed, "SCIP seed"), target: validateSelector(value.scipPair.target, "SCIP target"), relation: value.scipPair.relation as ScipGraphPair["relation"] };
  }
  return {
    id: value.id, query: value.query, queryClass: value.queryClass as QueryClass, fixture: value.fixture, split: value.split, profile: value.profile as SemanticProfile,
    relevant, supporting, irrelevant, forbidden, exhaustive: value.exhaustive, ...(ambiguous ? { ambiguous: true } : {}),
    ...(expectation ? { expectation } : {}), ...(value.semanticStyle ? { semanticStyle: value.semanticStyle as SemanticStyle } : {}),
    ...(semanticVectors ? { semanticVectors } : {}), ...(scipPair ? { scipPair } : {}),
  };
}

export function validateRetrievalDataset(value: unknown): RetrievalDataset {
  if (!isRecord(value) || value.datasetVersion !== RETRIEVAL_DATASET_VERSION || typeof value.semanticVectorFixtureId !== "string" || !value.semanticVectorFixtureId || !Array.isArray(value.cases)) throw new TypeError("Invalid retrieval dataset header");
  const cases = value.cases.map(validateCase);
  const ids = new Set<string>();
  const queryKeys = new Set<string>();
  const splits = new Map<string, string>();
  for (const item of cases) {
    if (ids.has(item.id)) throw new TypeError(`Duplicate retrieval case id: ${item.id}`);
    ids.add(item.id);
    const prior = splits.get(item.fixture);
    if (prior && prior !== item.split) throw new TypeError(`Fixture ${item.fixture} crosses dataset splits`);
    splits.set(item.fixture, item.split);
    const queryKey = `${item.fixture}\0${item.profile}\0${item.query.trim().toLowerCase().replace(/\\s+/g, " ")}`;
    if (queryKeys.has(queryKey)) throw new TypeError(`Duplicate retrieval query in fixture/profile: ${item.fixture}/${item.profile}/${item.query}`);
    queryKeys.add(queryKey);
  }
  const heldOutFamilies = [...splits.values()].filter((split) => split === "held-out").length;
  const heldOutCases = cases.filter((item) => item.split === "held-out").length;
  if (splits.size < 4 || ![...splits.values()].includes("development") || heldOutFamilies < 2 || heldOutCases < 10) throw new TypeError("Retrieval dataset needs four fixture families, two held-out families, and ten held-out cases");
  const included = new Set(cases.map((item) => item.queryClass));
  const required: QueryClass[] = ["exact-symbol", "implementation-discovery", "caller", "callee", "cross-file", "ambiguous", "natural-language", "lexical-only", "semantic-paraphrase", "graph-dependent", "scip-improved-cross-file", "semantic-disabled", "semantic-unavailable"];
  for (const queryClass of required) if (!included.has(queryClass)) throw new TypeError(`Retrieval dataset is missing query class ${queryClass}`);
  if (cases.filter((item) => item.semanticStyle).length < 4) throw new TypeError("Retrieval dataset needs four frozen semantic styles");
  if (cases.filter((item) => item.scipPair).length < 3) throw new TypeError("Retrieval dataset needs at least three fixed SCIP pairs");
  return { datasetVersion: RETRIEVAL_DATASET_VERSION, semanticVectorFixtureId: value.semanticVectorFixtureId, cases };
}
