export type IntegrationId = "codex" | "opencode" | "claude" | "gemini" | "cursor" | "cline" | "windsurf" | "zoo";

/** @deprecated Use IntegrationId. */
export type AgentId = IntegrationId;

export type IntegrationScope = "user" | "project";

export type InstallationState = "installed" | "not_detected" | "unavailable";

export type ConnectionState = "connected" | "disconnected" | "stale" | "invalid_config";

export type IntegrationDescriptor = {
  id: IntegrationId;
  displayName: string;
  scopes: readonly IntegrationScope[];
  configFormat: "json" | "jsonc" | "toml";
  supportsEnablement: boolean;
};

export type IntegrationContext = {
  repoPath: string;
};

export type DurableMcpLaunch = {
  command: string;
  args: string[];
};

export type ResolveDurableMcpLaunch = () => Promise<DurableMcpLaunch>;

export type IntegrationOptions = {
  repoPath: string;
  scope?: IntegrationScope;
  strict?: boolean;
  noGuidance?: boolean;
};

export type InstallationDetection = {
  state: InstallationState;
  evidence?: string;
};

export type ConnectionStatus = {
  state: ConnectionState;
  configPath?: string;
  scope?: IntegrationScope;
  managedConfigPresent: boolean;
  warnings: string[];
};

export type IntegrationStatus = {
  id: IntegrationId;
  displayName: string;
  installation: InstallationDetection;
  connection: ConnectionStatus;

  /** @deprecated Use installation.state and connection.state. */
  state: "installed" | "not_installed" | "unavailable" | "stale" | "invalid_config";
  /** @deprecated Use installation.state. */
  detected: boolean;
  /** @deprecated Use connection.configPath. */
  configPath: string;
  /** @deprecated Use connection.scope. */
  scope: IntegrationScope;
  /** @deprecated Use connection.state. */
  codeAtlasMcpConfigured: boolean;
  /** @deprecated Use connection.state. */
  configurationValid: boolean;
  command: string;
  args: string[];
  strictGuidanceConfigured?: boolean;
  warnings: string[];
};

export type IntegrationChange = {
  id: IntegrationId;
  displayName: string;
  operation: "connect" | "disconnect";
  changed: boolean;
  status: ConnectionStatus;
  strictGuidanceChanged: boolean;
};

export type LegacyIntegrationChange = {
  id: IntegrationId;
  displayName: string;
  operation: "install" | "uninstall";
  changed: boolean;
  status: IntegrationStatus;
  strictGuidanceChanged: boolean;
};

export type IntegrationAdapter = {
  readonly descriptor: IntegrationDescriptor;
  detect(context: IntegrationContext): Promise<InstallationDetection>;
  status(options: IntegrationOptions): Promise<ConnectionStatus>;
  connect(options: IntegrationOptions, launch: DurableMcpLaunch): Promise<IntegrationChange>;
  disconnect(options: IntegrationOptions): Promise<IntegrationChange>;
};

/** @deprecated Use IntegrationAdapter. */
export type AgentIntegration = IntegrationAdapter;

export type HookName = "post-commit" | "post-checkout";

export type HookOptions = {
  repoPath: string;
  hooks?: HookName[];
};

export type HookStatus = {
  repoPath: string;
  hooksPath?: string;
  helperPath: string;
  hooks: Record<HookName, {
    installed: boolean;
    path: string;
  }>;
  warnings: string[];
};
