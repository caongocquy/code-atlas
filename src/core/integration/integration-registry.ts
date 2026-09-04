import type { IntegrationAdapter, IntegrationId } from "./integration.types.js";

export class IntegrationRegistry {
  private readonly adapters: readonly IntegrationAdapter[];
  private readonly byId: ReadonlyMap<IntegrationId, IntegrationAdapter>;

  constructor(adapters: readonly IntegrationAdapter[]) {
    const byId = new Map<IntegrationId, IntegrationAdapter>();
    for (const adapter of adapters) {
      if (byId.has(adapter.descriptor.id)) {
        throw new Error(`Duplicate integration id: ${adapter.descriptor.id}`);
      }
      byId.set(adapter.descriptor.id, adapter);
    }
    this.adapters = [...adapters];
    this.byId = byId;
  }

  list(): readonly IntegrationAdapter[] {
    return this.adapters;
  }

  get(id: string): IntegrationAdapter | undefined {
    return this.byId.get(id as IntegrationId);
  }

  has(id: string): boolean {
    return this.byId.has(id as IntegrationId);
  }
}
