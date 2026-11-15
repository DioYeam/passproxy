export interface Env {
  UPSTREAM_BASE_URL: string;
  CLIENT_TOKEN: string;
  UPSTREAM_API_KEY?: string;
  ALLOWED_ORIGIN?: string;
  MAX_DECOMPRESSED_BYTES?: string;
  UPSTREAM_TIMEOUT_MS?: string;
}

export interface RuntimeConfig {
  upstreamBaseUrl: URL;
  clientToken: string;
  upstreamApiKey?: string;
  allowedOrigin: string;
  maxDecompressedBytes: number;
  upstreamTimeoutMs: number;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const DEFAULT_MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024;
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
    upstreamTimeoutMs: parsePositiveInteger(
      env.UPSTREAM_TIMEOUT_MS,
      DEFAULT_UPSTREAM_TIMEOUT_MS,
      "UPSTREAM_TIMEOUT_MS",
    ),
  };
}
