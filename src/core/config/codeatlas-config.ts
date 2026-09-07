export type CodeAtlasRepositoryConfig = {
  version: 1;
  architecture?: Record<string, unknown>;
  gate?: Record<string, unknown>;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function parseCodeAtlasRepositoryConfig(raw: unknown): CodeAtlasRepositoryConfig {
  const root = object(raw, "codeatlas.config.json");
  for (const key of Object.keys(root)) {
    if (!["version", "architecture", "gate"].includes(key)) {
      throw new Error(`codeatlas.config.json.${key} is not supported.`);
    }
  }
  if (root.version !== 1) throw new Error("codeatlas.config.json version must be 1.");
  return {
    version: 1,
    ...(root.architecture === undefined ? {} : { architecture: object(root.architecture, "architecture") }),
    ...(root.gate === undefined ? {} : { gate: object(root.gate, "gate") }),
  };
}
