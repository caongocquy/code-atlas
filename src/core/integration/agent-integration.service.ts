import type {
  IntegrationAdapter,
  IntegrationContext,
  IntegrationDescriptor,
  ResolveDurableMcpLaunch,
  LegacyIntegrationChange,
  IntegrationOptions,
  IntegrationStatus,
} from "./integration.types.js";
import { IntegrationRegistry } from "./integration-registry.js";

export type StrictGuidance = {
  status(repoPath: string): Promise<boolean>;
  install(repoPath: string, strict?: boolean): Promise<boolean>;
  uninstall(repoPath: string): Promise<boolean>;
};

export class AgentIntegrationService {
  constructor(
    private readonly registry: IntegrationRegistry,
    private readonly strictGuidance: StrictGuidance,
    private readonly resolveDurableMcpLaunch: ResolveDurableMcpLaunch,
  ) {}

  listDescriptors(): readonly IntegrationDescriptor[] {
    return this.registry.list().map(({ descriptor }) => descriptor);
  }

  has(id: string): boolean {
    return this.registry.has(id);
  }

  async list(options: IntegrationOptions): Promise<IntegrationStatus[]> {
    return Promise.all(this.registry.list().map((integration) => this.statusFor(integration, options)));
  }

  async status(id: string, options: IntegrationOptions): Promise<IntegrationStatus> {
    const integration = this.get(id);
    return this.statusFor(integration, options);
  }

  async connect(id: string, options: IntegrationOptions) {
    const integration = this.get(id);
    const result = await integration.connect(options, await this.resolveDurableMcpLaunch());
    const guidanceChanged = options.noGuidance !== true
      ? await this.strictGuidance.install(options.repoPath, options.strict === true)
      : false;
    return {
      ...result,
      operation: "connect" as const,
      strictGuidanceChanged: guidanceChanged,
    };
  }

  async disconnect(id: string, options: IntegrationOptions) {
    const integration = this.get(id);
    const result = await integration.disconnect(options);
    const strictGuidanceChanged = options.noGuidance !== true
      ? await this.reconcileGuidance(options)
      : false;
    return { ...result, operation: "disconnect" as const, strictGuidanceChanged };
  }

  async reconcileGuidance(options: IntegrationOptions): Promise<boolean> {
    if (options.noGuidance === true) return false;
    const statuses = await this.list(options);
    const managed = statuses.some(({ connection }) =>
      connection.managedConfigPresent
      && (connection.state === "connected" || connection.state === "stale" || connection.state === "invalid_config"),
    );
    return managed
      ? this.strictGuidance.install(options.repoPath, options.strict === true)
      : this.strictGuidance.uninstall(options.repoPath);
  }

  async install(id: string, options: IntegrationOptions): Promise<LegacyIntegrationChange> {
    const result = await this.connect(id, options);
    return {
      ...result,
      operation: "install",
      status: await this.status(id, options),
    };
  }

  async uninstall(id: string, options: IntegrationOptions): Promise<LegacyIntegrationChange> {
    const result = await this.disconnect(id, options);
    return {
      ...result,
      operation: "uninstall",
      status: await this.status(id, options),
    };
  }

  private async statusFor(
    integration: IntegrationAdapter,
    options: IntegrationOptions,
  ): Promise<IntegrationStatus> {
    const [installation, connection] = await Promise.all([
      integration.detect({ repoPath: options.repoPath } satisfies IntegrationContext),
      integration.status(options),
    ]);
    const configPath = connection.configPath ?? "";
    const scope = connection.scope ?? integration.descriptor.scopes[0] ?? "project";
    return {
      id: integration.descriptor.id,
      displayName: integration.descriptor.displayName,
      installation,
      connection,
      state: legacyState(installation.state, connection.state),
      detected: installation.state === "installed",
      configPath,
      scope,
      codeAtlasMcpConfigured: connection.state === "connected",
      configurationValid: connection.state !== "invalid_config" && connection.state !== "stale",
      command: "code-atlas",
      args: ["mcp"],
      warnings: [...connection.warnings],
      strictGuidanceConfigured: await this.strictGuidance.status(options.repoPath),
    };
  }

  private get(id: string): IntegrationAdapter {
    const integration = this.registry.get(id);
    if (!integration) {
      const ids = this.registry.list().map(({ descriptor }) => descriptor.id).join(", ");
      throw new Error(`Unknown integration id \`${id}\`. Registered integrations: ${ids || "none"}.`);
    }
    return integration;
  }
}

function legacyState(
  installation: "installed" | "not_detected" | "unavailable",
  connection: "connected" | "disconnected" | "stale" | "invalid_config",
): IntegrationStatus["state"] {
  if (connection === "stale" || connection === "invalid_config") return connection;
  if (connection === "connected") return "installed";
  return installation === "installed" ? "not_installed" : "unavailable";
}
