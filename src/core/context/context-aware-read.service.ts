import path from "node:path";

import { canonicalRepositoryPath } from "../repository/repository-identity.js";
import { prepareContextAwareRead } from "./context-delivery-preparation.js";
import type { ContextAwareReadResult, ContextSubject } from "./context.types.js";
import { ContextStore, ContextStoreOpenError } from "../../storage/context/context.store.js";
import { UnsupportedContextSchemaError } from "../../storage/context/context.schema.js";

export type ContextAwareReadRequest = {
  sessionId: string;
  contextGeneration: string;
  subject: ContextSubject;
  projection: string;
  ttlSeconds?: number;
};

export type ContextMetrics = {
  requestedBytes: number;
  returnedBytes: number;
  fullReads: number;
  unchangedReads: number;
  deltaReads: number;
  rehydrates: number;
  savedBytes: number;
};

const metrics: ContextMetrics = { requestedBytes: 0, returnedBytes: 0, fullReads: 0, unchangedReads: 0, deltaReads: 0, rehydrates: 0, savedBytes: 0 };

export function resetContextMetrics(): void { Object.assign(metrics, { requestedBytes: 0, returnedBytes: 0, fullReads: 0, unchangedReads: 0, deltaReads: 0, rehydrates: 0, savedBytes: 0 }); }
export function getContextMetrics(): ContextMetrics { return { ...metrics }; }

function recordMetrics(mode: ContextAwareReadResult["mode"], requestedBytes: number, returnedBytes: number): void {
  metrics.requestedBytes += requestedBytes;
  metrics.returnedBytes += returnedBytes;
  metrics.savedBytes += Math.max(0, requestedBytes - returnedBytes);
  if (mode === "full") metrics.fullReads += 1;
  if (mode === "unchanged") metrics.unchangedReads += 1;
  if (mode === "delta") metrics.deltaReads += 1;
  if (mode === "rehydrate") metrics.rehydrates += 1;
}

export async function readContextAware(repoPath: string, request: ContextAwareReadRequest): Promise<ContextAwareReadResult> {
  const root = canonicalRepositoryPath(path.resolve(repoPath));
  let store: ContextStore;
  try { store = new ContextStore(path.join(root, ".codeatlas", "context.db")); }
  catch (error) {
    if (!(error instanceof ContextStoreOpenError || error instanceof UnsupportedContextSchemaError)) throw error;
    const prepared = await prepareContextAwareRead(root, request, undefined, error);
    recordMetrics(prepared.result.mode, prepared.metrics.requestedBytes, prepared.metrics.returnedBytes);
    return prepared.result;
  }
  try {
    const prepared = await prepareContextAwareRead(root, request, store);
    store.publishPrepared(prepared);
    recordMetrics(prepared.result.mode, prepared.metrics.requestedBytes, prepared.metrics.returnedBytes);
    return prepared.result;
  } finally { store.close(); }
}
