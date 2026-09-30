export type ContinuationIdentity = {
  repositoryId: string;
  generationId: string;
  operation: string;
  normalizedSemanticInput: string;
  orderingIdentity: string;
  projectionVersion: string;
};

export function buildContinuationIdentity(
  input: Omit<ContinuationIdentity, "generationId"> & { generationId?: string },
): ContinuationIdentity | undefined {
  if (!input.generationId) return undefined;
  return {
    repositoryId: input.repositoryId,
    generationId: input.generationId,
    operation: input.operation,
    normalizedSemanticInput: input.normalizedSemanticInput,
    orderingIdentity: input.orderingIdentity,
    projectionVersion: input.projectionVersion,
  };
}
