import {
  LEXICAL_INDEX_VERSION,
  RESOLUTION_VERSION,
  VECTOR_INDEX_VERSION,
} from "../../config/constants.js";
import type { IndexVersionDomains } from "../facts/facts.types.js";

export type GraphRefreshMode = "full-rebuild" | "incremental";
export type VectorRefreshMode = "semantic-reindex" | "incremental";

export const INDEX_SCHEMA_VERSION = "1.0.0";
export const FACTS_SCHEMA_VERSION = "3.0.0";
export const FACTS_VERSION = "3.0.0";
export const FRAMEWORK_RESOLUTION_VERSION = "1.0.0";

export const CURRENT_INDEX_VERSION_DOMAINS: IndexVersionDomains = {
  schemaVersion: INDEX_SCHEMA_VERSION,
  factsSchemaVersion: FACTS_SCHEMA_VERSION,
  factsVersion: FACTS_VERSION,
  resolutionVersion: RESOLUTION_VERSION,
  frameworkResolutionVersion: FRAMEWORK_RESOLUTION_VERSION,
  derivedVersion: `${LEXICAL_INDEX_VERSION}:${VECTOR_INDEX_VERSION}`,
};

export function graphRefreshMode(
  storedVersion: string | undefined,
  currentVersion: string,
): GraphRefreshMode {
  return storedVersion === currentVersion ? "incremental" : "full-rebuild";
}

export function vectorRefreshMode(
  storedVersion: string | undefined,
  currentVersion: string,
): VectorRefreshMode {
  return storedVersion === currentVersion ? "incremental" : "semantic-reindex";
}
