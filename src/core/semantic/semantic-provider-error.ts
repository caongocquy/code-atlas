export type SemanticProviderErrorCode =
  | "SEMANTIC_MISSING_ENV"
  | "SEMANTIC_AUTH_FAILED"
  | "SEMANTIC_PROVIDER_UNREACHABLE"
  | "SEMANTIC_INVALID_RESPONSE"
  | "SEMANTIC_DIMENSION_MISMATCH"
  | "SEMANTIC_RUNTIME_FAILED";

export class SemanticProviderError extends Error {
  constructor(
    readonly code: SemanticProviderErrorCode,
    message: string,
    options: { env?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "SemanticProviderError";
    if (options.env) this.env = options.env;
  }

  readonly env?: string;
}
