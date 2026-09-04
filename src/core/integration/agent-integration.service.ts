import type {
  AgentId,
  AgentIntegration,
  IntegrationChange,
  IntegrationOptions,
  IntegrationStatus,
} from "./integration.types.js";

export type StrictGuidance = {
  status(repoPath: string): Promise<boolean>;
  install(repoPath: string, strict?: boolean): Promise<boolean>;
  uninstall(repoPath: string): Promise<boolean>;
};

export class AgentIntegrationService {
  private readonly byId: Map<AgentId, AgentIntegration>;

  constructor(
    integrations: readonly AgentIntegration[],
    private readonly strictGuidance: StrictGuidance,
  ) {
    this.byId = new Map(integrations.map((integration) => [integration.id, integration]));
  }

  async list(options: IntegrationOptions): Promise<IntegrationStatus[]> {
    return Promise.all([...this.byId.values()].map((integration) => this.statusFor(integration, options)));
  }

  async status(id: AgentId, options: IntegrationOptions): Promise<IntegrationStatus> {
    const integration = this.get(id);
    return this.statusFor(integration, options);
  }

  async install(id: AgentId, options: IntegrationOptions): Promise<IntegrationChange> {
    const integration = this.get(id);
    const result = await integration.install(options);
    const guidanceChanged = options.noGuidance !== true
      ? await this.strictGuidance.install(options.repoPath, options.strict === true)
      : false;
    return {
      ...result,
      status: { ...result.status, strictGuidanceConfigured: await this.strictGuidance.status(options.repoPath) },
      strictGuidanceChanged: guidanceChanged,
    };
  }

  async uninstall(id: AgentId, options: IntegrationOptions): Promise<IntegrationChange> {
    const integration = this.get(id);
    const result = await integration.uninstall(options);
    const strictGuidanceChanged = options.noGuidance !== true
      ? await this.strictGuidance.uninstall(options.repoPath)
      : false;
    return { ...result, strictGuidanceChanged };
  }

  private async statusFor(
    integration: AgentIntegration,
    options: IntegrationOptions,
  ): Promise<IntegrationStatus> {
    const status = await integration.status(options);
    return {
      ...status,
      strictGuidanceConfigured: await this.strictGuidance.status(options.repoPath),
    };
  }

  private get(id: AgentId): AgentIntegration {
    const integration = this.byId.get(id);
    if (!integration) throw new Error(`Unsupported agent integration: ${id}`);
    return integration;
  }
}
