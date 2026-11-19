export interface Env {
  UPSTREAM_BASE_URL: string;
  CLIENT_TOKEN: string;
  CHUNK_SESSIONS?: DurableObjectNamespace;
  UPSTREAM_API_KEY?: string;
  ALLOWED_ORIGIN?: string;
  MAX_DECOMPRESSED_BYTES?: string;
  MAX_COMPRESSED_BYTES?: string;
  MAX_CHUNK_BYTES?: string;
  CHUNK_SESSION_TTL_MS?: string;
  UPSTREAM_TIMEOUT_MS?: string;
}

export interface RuntimeConfig {
  upstreamBaseUrl: URL;
  clientToken: string;
  upstreamApiKey?: string;
  allowedOrigin: string;
  maxDecompressedBytes: number;
  maxCompressedBytes: number;
  maxChunkBytes: number;
  chunkSessionTtlMs: number;
  upstreamTimeoutMs: number;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const DEFAULT_MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_CHUNK_BYTES = 96 * 1024;
const DEFAULT_CHUNK_SESSION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

function parsePositiveInteger(
  rawValue: string | undefined,
  fallback: number,
  variableName: string,
): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigurationError(
      `${variableName} must be a positive integer.`,
    );
  }

  return value;
}

function parseUpstreamBaseUrl(rawValue: string): URL {
  if (!rawValue || rawValue.trim() === "") {
    throw new ConfigurationError("UPSTREAM_BASE_URL is required.");
  }

  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new ConfigurationError(
      "UPSTREAM_BASE_URL must be an absolute URL.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigurationError(
      "UPSTREAM_BASE_URL must use HTTP or HTTPS.",
    );
  }

  return url;
}

export function readConfig(env: Env): RuntimeConfig {
  if (!env.CLIENT_TOKEN || env.CLIENT_TOKEN.trim() === "") {
    throw new ConfigurationError("CLIENT_TOKEN is required.");
  }

  return {
    upstreamBaseUrl: parseUpstreamBaseUrl(env.UPSTREAM_BASE_URL),
    clientToken: env.CLIENT_TOKEN,
    upstreamApiKey: env.UPSTREAM_API_KEY || undefined,
    allowedOrigin:
      env.ALLOWED_ORIGIN === undefined || env.ALLOWED_ORIGIN.trim() === ""
        ? "*"
        : env.ALLOWED_ORIGIN.trim(),
    maxDecompressedBytes: parsePositiveInteger(
      env.MAX_DECOMPRESSED_BYTES,
      DEFAULT_MAX_DECOMPRESSED_BYTES,
      "MAX_DECOMPRESSED_BYTES",
    ),
    maxCompressedBytes: parsePositiveInteger(
      env.MAX_COMPRESSED_BYTES,
      DEFAULT_MAX_COMPRESSED_BYTES,
      "MAX_COMPRESSED_BYTES",
    ),
    maxChunkBytes: parsePositiveInteger(
      env.MAX_CHUNK_BYTES,
      DEFAULT_MAX_CHUNK_BYTES,
      "MAX_CHUNK_BYTES",
    ),
    chunkSessionTtlMs: parsePositiveInteger(
      env.CHUNK_SESSION_TTL_MS,
      DEFAULT_CHUNK_SESSION_TTL_MS,
      "CHUNK_SESSION_TTL_MS",
    ),
    upstreamTimeoutMs: parsePositiveInteger(
      env.UPSTREAM_TIMEOUT_MS,
      DEFAULT_UPSTREAM_TIMEOUT_MS,
      "UPSTREAM_TIMEOUT_MS",
    ),
  };
}
