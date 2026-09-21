import { getLanguageAdapter } from "../parsers/registry.js";
import { LANGUAGE_IDS, type LanguageAdapter } from "../parsers/types.js";
import { cFamilySemanticAdapter } from "./adapters/c-family.js";
import { dartSemanticAdapter } from "./adapters/dart.js";
import { ecmascriptSemanticAdapter } from "./adapters/ecmascript.js";
import { goSemanticAdapter } from "./adapters/go.js";
import { jvmSemanticAdapter } from "./adapters/jvm.js";
import { pythonSemanticAdapter } from "./adapters/python.js";
import { rustSemanticAdapter } from "./adapters/rust.js";
import { swiftSemanticAdapter } from "./adapters/swift.js";
import type { LanguageId, LanguageSemanticAdapter } from "./types.js";

export { getLanguageAdapter };
export type { LanguageAdapter };

export const semanticAdapters = [
  ecmascriptSemanticAdapter,
  pythonSemanticAdapter,
  jvmSemanticAdapter,
  goSemanticAdapter,
  rustSemanticAdapter,
  swiftSemanticAdapter,
  dartSemanticAdapter,
  cFamilySemanticAdapter,
] as const satisfies readonly LanguageSemanticAdapter[];

export type LanguageFloorState = "passed" | "failed" | "unverified";
export type LanguageFloorDecision = "resolved" | "unknown" | "unsupported" | "ambiguous";
export type LanguageFloorEvidence = {
  readonly state: LanguageFloorState;
  readonly suite: "phase14b-independent-floor";
  readonly fixture: string;
  readonly semanticSiteCount: number;
  readonly decisionCount: number;
  readonly evidenceBatchCount: number;
  readonly decisionStatuses: readonly LanguageFloorDecision[];
};
export type LanguageFloorRegistry = Readonly<Record<LanguageId, LanguageFloorEvidence>>;

/** Release-owned evidence gate; runtime test modules must not be imported by production code. */
export const LANGUAGE_FLOOR_EVIDENCE: LanguageFloorRegistry = Object.freeze({
  typescript: { state: "passed", suite: "phase14b-independent-floor", fixture: "capability-typescript", semanticSiteCount: 1, decisionCount: 1, evidenceBatchCount: 1, decisionStatuses: ["resolved"] },
  tsx: { state: "passed", suite: "phase14b-independent-floor", fixture: "capability-tsx", semanticSiteCount: 1, decisionCount: 1, evidenceBatchCount: 1, decisionStatuses: ["resolved"] },
  javascript: { state: "passed", suite: "phase14b-independent-floor", fixture: "capability-javascript", semanticSiteCount: 1, decisionCount: 1, evidenceBatchCount: 1, decisionStatuses: ["resolved"] },
  python: { state: "passed", suite: "phase14b-independent-floor", fixture: "capability-python", semanticSiteCount: 1, decisionCount: 1, evidenceBatchCount: 1, decisionStatuses: ["resolved"] },
  java: { state: "passed", suite: "phase14b-independent-floor", fixture: "capability-java", semanticSiteCount: 1, decisionCount: 1, evidenceBatchCount: 1, decisionStatuses: ["resolved"] },
  kotlin: { state: "passed", suite: "phase14b-independent-floor", fixture: "capability-kotlin", semanticSiteCount: 1, decisionCount: 1, evidenceBatchCount: 1, decisionStatuses: ["unknown"] },
  go: { state: "passed", suite: "phase14b-independent-floor", fixture: "go", semanticSiteCount: 2, decisionCount: 2, evidenceBatchCount: 1, decisionStatuses: ["resolved", "ambiguous"] },
  rust: { state: "passed", suite: "phase14b-independent-floor", fixture: "capability-rust", semanticSiteCount: 1, decisionCount: 1, evidenceBatchCount: 1, decisionStatuses: ["unknown"] },
  swift: { state: "passed", suite: "phase14b-independent-floor", fixture: "capability-swift", semanticSiteCount: 1, decisionCount: 1, evidenceBatchCount: 1, decisionStatuses: ["resolved"] },
  dart: { state: "passed", suite: "phase14b-independent-floor", fixture: "capability-dart", semanticSiteCount: 1, decisionCount: 1, evidenceBatchCount: 1, decisionStatuses: ["resolved"] },
  c: { state: "passed", suite: "phase14b-independent-floor", fixture: "capability-c", semanticSiteCount: 1, decisionCount: 1, evidenceBatchCount: 1, decisionStatuses: ["resolved"] },
  cpp: { state: "passed", suite: "phase14b-independent-floor", fixture: "capability-cpp", semanticSiteCount: 1, decisionCount: 1, evidenceBatchCount: 1, decisionStatuses: ["resolved"] },
});

function createSemanticAdapterIndex(): ReadonlyMap<LanguageId, LanguageSemanticAdapter> {
  const index = new Map<LanguageId, LanguageSemanticAdapter>();
  for (const adapter of semanticAdapters) {
    for (const language of adapter.languages) {
      if (index.has(language)) {
        throw new Error(`Semantic adapter already registered for ${language}`);
      }
      index.set(language, adapter);
    }
  }
  return index;
}

const semanticAdapterByLanguage = createSemanticAdapterIndex();

export function getSemanticAdapter(language: LanguageId): LanguageSemanticAdapter | undefined {
  return semanticAdapterByLanguage.get(language);
}

export function isLanguageFloorPassed(
  language: LanguageId,
  floorRegistry: LanguageFloorRegistry = LANGUAGE_FLOOR_EVIDENCE,
): boolean {
  const evidence = floorRegistry[language];
  return evidence?.state === "passed"
    && evidence.suite === "phase14b-independent-floor"
    && evidence.fixture.length > 0
    && evidence.semanticSiteCount > 0
    && evidence.decisionCount === evidence.semanticSiteCount
    && evidence.evidenceBatchCount > 0
    && evidence.decisionStatuses.length === evidence.decisionCount;
}

export function isLanguageAdvertised(
  language: LanguageId,
  floorRegistry: LanguageFloorRegistry = LANGUAGE_FLOOR_EVIDENCE,
): boolean {
  return isLanguageFloorPassed(language, floorRegistry) && semanticAdapterByLanguage.has(language);
}

export function getSupportedLanguages(
  floorRegistry: LanguageFloorRegistry = LANGUAGE_FLOOR_EVIDENCE,
): readonly LanguageId[] {
  return LANGUAGE_IDS.filter((language) => isLanguageAdvertised(language, floorRegistry));
}
