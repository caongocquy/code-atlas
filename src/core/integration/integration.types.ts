export type AgentId = "codex" | "opencode" | "claude";

export type IntegrationScope = "user" | "project";

export type IntegrationState =
  | "available"
  | "installed"
  | "not_installed"
  | "unavailable"
  | "unsupported"
  | "stale"
  | "invalid_config";

export type IntegrationOptions = {
  repoPath: string;
  scope?: IntegrationScope;
  strict?: boolean;
  noGuidance?: boolean;
};

export type IntegrationStatus = {
  id: AgentId;
  displayName: string;
  state: IntegrationState;
  detected: boolean;
  configPath: string;
  scope: IntegrationScope;
  codeAtlasMcpConfigured: boolean;
  configurationValid: boolean;
  command: string;
  args: string[];
  strictGuidanceConfigured?: boolean;
  warnings: string[];
};

export type IntegrationChange = {
  id: AgentId;
  displayName: string;
  operation: "install" | "uninstall";
  changed: boolean;
  status: IntegrationStatus;
  strictGuidanceChanged: boolean;
};

export type AgentIntegration = {
  id: AgentId;
  displayName: string;
  status(options: IntegrationOptions): Promise<IntegrationStatus>;
  install(options: IntegrationOptions): Promise<IntegrationChange>;
  uninstall(options: IntegrationOptions): Promise<IntegrationChange>;
};

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
