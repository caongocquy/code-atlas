export type CodeAtlasRepositoryConfig = {
  version: 1;
  architecture?: Record<string, unknown>;
  gate?: Record<string, unknown>;
  semantic?: SemanticConfig;
};

export type SemanticProviderConfig =
  | { type: "builtin-local"; model?: string; revision?: string; dimensions?: number }
  | { type: "openai-compatible"; baseUrl: string; model: string; apiKeyEnv?: string; dimensions?: number };

export type SemanticConfig = {
  enabled: boolean;
  provider: SemanticProviderConfig;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function modelId(value: unknown, label: string): string {
  const model = nonEmptyString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) {
    throw new Error(`${label} must be a Hugging Face model ID in namespace/name form.`);
  }
  return model;
}

function normalizeBaseUrl(value: unknown): string {
  const text = nonEmptyString(value, "semantic.provider.baseUrl");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("semantic.provider.baseUrl must be a valid HTTP or HTTPS URL.");
  }
  if (!(["http:", "https:"].includes(url.protocol)) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("semantic.provider.baseUrl must be an HTTP or HTTPS URL without credentials, query, or fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

export function parseSemanticProviderConfig(raw: unknown): SemanticProviderConfig {
  const provider = object(raw, "semantic.provider");
  if (provider.type === "builtin-local") {
    for (const key of Object.keys(provider)) if (!["type", "model", "revision", "dimensions"].includes(key)) throw new Error(`semantic.provider.${key} is not supported.`);
    const dimensions = provider.dimensions;
    if (dimensions !== undefined && (!Number.isSafeInteger(dimensions) || Number(dimensions) <= 0)) {
      throw new Error("semantic.provider.dimensions must be a positive integer.");
    }
    return {
      type: "builtin-local",
      ...(provider.model === undefined ? {} : { model: modelId(provider.model, "semantic.provider.model") }),
      ...(provider.revision === undefined ? {} : { revision: nonEmptyString(provider.revision, "semantic.provider.revision") }),
      ...(dimensions === undefined ? {} : { dimensions: dimensions as number }),
    };
  }
  if (provider.type === "openai-compatible") {
    for (const key of Object.keys(provider)) if (!["type", "baseUrl", "model", "apiKeyEnv", "dimensions"].includes(key)) throw new Error(`semantic.provider.${key} is not supported.`);
    const apiKeyEnv = provider.apiKeyEnv === undefined ? undefined : nonEmptyString(provider.apiKeyEnv, "semantic.provider.apiKeyEnv");
    if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error("semantic.provider.apiKeyEnv must be an environment variable name.");
    const dimensions = provider.dimensions;
    if (dimensions !== undefined && (!Number.isSafeInteger(dimensions) || Number(dimensions) <= 0)) {
      throw new Error("semantic.provider.dimensions must be a positive integer.");
    }
    return {
      type: "openai-compatible",
      baseUrl: normalizeBaseUrl(provider.baseUrl),
      model: nonEmptyString(provider.model, "semantic.provider.model"),
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(dimensions === undefined ? {} : { dimensions: dimensions as number }),
    };
  }
  throw new Error('semantic.provider.type must be "builtin-local" or "openai-compatible".');
}

function parseSemanticConfig(raw: unknown): SemanticConfig {
  const semantic = object(raw, "semantic");
  for (const key of Object.keys(semantic)) if (!["enabled", "provider"].includes(key)) throw new Error(`semantic.${key} is not supported.`);
  if (typeof semantic.enabled !== "boolean") throw new Error("semantic.enabled must be a boolean.");
  return { enabled: semantic.enabled, provider: parseSemanticProviderConfig(semantic.provider) };
}

export function parseCodeAtlasRepositoryConfig(raw: unknown): CodeAtlasRepositoryConfig {
  const root = object(raw, "codeatlas.config.json");
  for (const key of Object.keys(root)) {
    if (!["version", "architecture", "gate", "semantic"].includes(key)) {
      throw new Error(`codeatlas.config.json.${key} is not supported.`);
    }
  }
  if (root.version !== 1) throw new Error("codeatlas.config.json version must be 1.");
  return {
    version: 1,
    ...(root.architecture === undefined ? {} : { architecture: object(root.architecture, "architecture") }),
    ...(root.gate === undefined ? {} : { gate: object(root.gate, "gate") }),
    ...(root.semantic === undefined ? {} : { semantic: parseSemanticConfig(root.semantic) }),
  };
}
