import fs from "node:fs/promises";
import path from "node:path";

import { parseSemanticProviderConfig, type SemanticProviderConfig } from "../../core/config/codeatlas-config.js";
import { probeEmbeddingProvider } from "../../core/semantic/provider-probe.js";
import { SemanticProviderError } from "../../core/semantic/semantic-provider-error.js";
import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import { createDefaultProviders } from "../provider-defaults.js";
import { getRepositoryStatusReadOnly } from "../../core/repository/repository-status.service.js";
import { canonicalRepositoryPath, getRepositoryIdentity } from "../../core/repository/repository-identity.js";
import { VECTOR_INDEX_VERSION } from "../../config/constants.js";
import { createSemanticEmbeddingProvider } from "./provider-factory.js";
import { ensureEnvExampleVariable, readRepositoryConfig, writeRepositoryConfig } from "./semantic-config.store.js";
import {
  managedSemanticRuntimeDirectory,
  markManagedModelInstalled,
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  createTransformersLocalEmbeddingProvider,
  type TransformersLocalProviderOptions,
} from "./transformers-local-embedding-provider.js";

export type SemanticLifecycleOptions = TransformersLocalProviderOptions;

function providerDetails(provider: SemanticProviderConfig): Record<string, unknown> {
  return {
    type: provider.type,
    ...(provider.model ? { model: provider.model } : {}),
    ...(provider.type === "builtin-local" && provider.revision ? { revision: provider.revision } : {}),
    ...(provider.type === "openai-compatible" ? {
      baseUrl: provider.baseUrl,
      ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : {}),
      ...(provider.dimensions ? { dimensions: provider.dimensions } : {}),
    } : provider.dimensions ? { dimensions: provider.dimensions } : {}),
  };
}

export async function setupSemanticProvider(repoPath: string, rawProvider: unknown, options: SemanticLifecycleOptions = {}) {
  const root = canonicalRepositoryPath(path.resolve(repoPath));
  const providerConfig = parseSemanticProviderConfig(rawProvider);
  const existing = await readRepositoryConfig(root);
  let provider;
  let localProvider: ReturnType<typeof createTransformersLocalEmbeddingProvider> | undefined;
  try {
    if (providerConfig.type === "builtin-local") {
      localProvider = createTransformersLocalEmbeddingProvider(providerConfig, { ...options, allowRemoteModels: true });
      provider = localProvider;
    } else provider = createSemanticEmbeddingProvider(providerConfig, options);
  } catch (error) {
    if (error instanceof SemanticProviderError && error.code === "SEMANTIC_MISSING_ENV" && error.env) {
      await ensureEnvExampleVariable(root, error.env);
      return {
        status: "missing_env" as const,
        code: error.code,
        env: error.env,
        configChanged: false,
        indexChanged: false,
      };
    }
    throw error;
  }

  const probe = await probeEmbeddingProvider(provider);
  const persistedProvider: SemanticProviderConfig = providerConfig.type === "builtin-local"
    ? {
      type: "builtin-local",
      model: localProvider?.model ?? providerConfig.model ?? DEFAULT_LOCAL_EMBEDDING_MODEL,
      revision: localProvider?.revision ?? providerConfig.revision!,
      dimensions: probe.dimensions,
    }
    : { ...providerConfig, dimensions: probe.dimensions };
  const next = {
    ...existing,
    semantic: { enabled: true, provider: persistedProvider },
  };
  const configChanged = JSON.stringify(existing) !== JSON.stringify(next);
  if (configChanged) await writeRepositoryConfig(root, next);
  if (providerConfig.type === "builtin-local") {
    const localProvider = persistedProvider as Extract<SemanticProviderConfig, { type: "builtin-local" }>;
    try {
      await markManagedModelInstalled(options.runtimeDirectory ?? managedSemanticRuntimeDirectory(), {
        model: localProvider.model!,
        revision: localProvider.revision!,
        dimensions: probe.dimensions,
      });
    } catch (error) {
      if (configChanged) await writeRepositoryConfig(root, existing);
      throw error;
    }
  }
  return {
    status: "configured" as const,
    provider: providerDetails(persistedProvider),
    probe,
    configChanged,
    indexChanged: false,
  };
}

export async function testSemanticProvider(repoPath: string, options: SemanticLifecycleOptions = {}) {
  const config = await readRepositoryConfig(repoPath);
  if (!config.semantic) throw new SemanticProviderError("SEMANTIC_RUNTIME_FAILED", "No semantic provider is configured.");
  const provider = createSemanticEmbeddingProvider(config.semantic.provider, options);
  return {
    status: "passed" as const,
    provider: providerDetails(config.semantic.provider),
    probe: await probeEmbeddingProvider(provider),
    configChanged: false,
    indexChanged: false,
  };
}

export async function getSemanticStatus(repoPath: string) {
  const root = canonicalRepositoryPath(path.resolve(repoPath));
  const config = await readRepositoryConfig(root);
  const semantic = config.semantic;
  const databasePath = path.join(root, ".codeatlas", "atlas.db");
  let databaseExists = true;
  try {
    await fs.access(databasePath);
  } catch {
    databaseExists = false;
  }

  let providers: ReturnType<typeof createDefaultProviders> | undefined;
  let providerError: unknown;
  let repositoryStatus;
  try {
    if (databaseExists) providers = createDefaultProviders(root, { readOnly: true });
    if (semantic && providers) {
      try {
        providers.embeddingProvider = createSemanticEmbeddingProvider(semantic.provider);
      } catch (error) {
        providerError = error;
      }
    }
    repositoryStatus = await getRepositoryStatusReadOnly(root, providers);
  } catch (error) {
    providerError ??= error;
  } finally {
    providers?.vectorStore && "close" in providers.vectorStore && typeof providers.vectorStore.close === "function"
      ? providers.vectorStore.close()
      : undefined;
  }

  const capability = repositoryStatus?.capabilities.semantic;
  let indexState: "missing" | "ready" | "stale";
  let reason: string | undefined;
  if (!capability || (!capability.storedVersion && capability.indexedFiles === 0)) {
    indexState = "missing";
  } else if (!semantic) {
    indexState = "stale";
    reason = "Semantic provider configuration is missing.";
  } else if (providerError) {
    indexState = capability.indexedFiles > 0 || capability.storedVersion ? "stale" : "missing";
    reason = providerError instanceof Error ? providerError.message : String(providerError);
  } else if (capability.state === "ready") {
    indexState = "ready";
  } else if (capability.state === "not_indexed") {
    indexState = "missing";
  } else {
    indexState = "stale";
    reason = capability.lastError ?? `Semantic index is ${capability.state}; source hashes, provider identity, or index version changed.`;
  }

  return {
    configured: semantic !== undefined,
    enabled: semantic?.enabled ?? false,
    ...(semantic ? { provider: providerDetails(semantic.provider) } : {}),
    index: { state: indexState, ...(reason ? { reason } : {}), version: capability?.storedVersion ?? VECTOR_INDEX_VERSION, files: capability?.indexedFiles ?? 0, vectors: capability?.itemCount ?? 0 },
  };
}

export async function disableSemanticProvider(repoPath: string) {
  const config = await readRepositoryConfig(repoPath);
  if (!config.semantic) return { status: "not_configured" as const, configChanged: false, indexChanged: false };
  if (!config.semantic.enabled) return { status: "disabled" as const, configChanged: false, indexChanged: false };
  await writeRepositoryConfig(repoPath, { ...config, semantic: { ...config.semantic, enabled: false } });
  return { status: "disabled" as const, configChanged: true, indexChanged: false };
}

export async function cleanSemanticIndex(repoPath: string) {
  const root = canonicalRepositoryPath(path.resolve(repoPath));
  const databasePath = path.join(root, ".codeatlas", "atlas.db");
  try {
    await fs.access(databasePath);
  } catch {
    return { status: "cleaned" as const, vectors: 0, files: 0, indexChanged: false };
  }

  const store = new AtlasStore(databasePath);
  try {
    const repository = store.findRepository(getRepositoryIdentity(root));
    if (!repository) return { status: "cleaned" as const, vectors: 0, files: 0, indexChanged: false };
    const removed = store.deleteSemanticIndex(repository.id);
    return { status: "cleaned" as const, ...removed, indexChanged: removed.vectors > 0 || removed.files > 0 };
  } finally {
    store.close();
  }
}

export async function upgradeSemanticProvider(repoPath: string, options: SemanticLifecycleOptions = {}) {
  const config = await readRepositoryConfig(repoPath);
  if (!config.semantic) throw new SemanticProviderError("SEMANTIC_RUNTIME_FAILED", "No semantic provider is configured.");
  if (config.semantic.provider.type === "openai-compatible") {
    return { status: "externally_managed" as const, message: "OpenAI-compatible providers are externally managed; use semantic setup to change the endpoint or model." };
  }
  const root = canonicalRepositoryPath(path.resolve(repoPath));
  const previous = config.semantic.provider;
  const candidate: Extract<SemanticProviderConfig, { type: "builtin-local" }> = {
    type: "builtin-local",
    model: previous.model ?? DEFAULT_LOCAL_EMBEDDING_MODEL,
    revision: "main",
  };
  const provider = createTransformersLocalEmbeddingProvider(candidate, {
    ...options,
    allowRemoteModels: true,
  });
  const probe = await probeEmbeddingProvider(provider);
  const upgraded: Extract<SemanticProviderConfig, { type: "builtin-local" }> = {
    type: "builtin-local",
    model: provider.model,
    revision: provider.revision,
    dimensions: probe.dimensions,
  };
  if (upgraded.revision === previous.revision && upgraded.dimensions === previous.dimensions) {
    return { status: "up_to_date" as const, provider: providerDetails(upgraded), probe, configChanged: false, indexChanged: false };
  }
  await writeRepositoryConfig(root, { ...config, semantic: { ...config.semantic, provider: upgraded } });
  try {
    await markManagedModelInstalled(options.runtimeDirectory ?? managedSemanticRuntimeDirectory(), {
      model: upgraded.model!, revision: upgraded.revision!, dimensions: probe.dimensions,
    });
  } catch (error) {
    await writeRepositoryConfig(root, config);
    throw error;
  }
  return { status: "upgraded" as const, provider: providerDetails(upgraded), probe, configChanged: true, indexChanged: false };
}
