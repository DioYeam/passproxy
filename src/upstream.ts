import type { RuntimeConfig } from "./config";

export type UpstreamFetch = (request: Request) => Promise<Response>;

export interface UpstreamRequestSpec {
  baseUrl: URL;
  method: string;
  path: string;
  query: string;
  headers: Headers;
  body?: Uint8Array<ArrayBuffer>;
  timeoutMs: number;
}

export class UpstreamTimeoutError extends Error {
  constructor() {
    super("The upstream service did not respond in time.");
    this.name = "UpstreamTimeoutError";
  }
}

export class UpstreamUnreachableError extends Error {
  constructor() {
    super("The upstream request failed.");
    this.name = "UpstreamUnreachableError";
  }
}

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const CLOUDFLARE_HEADERS = [
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cdn-loop",
  "x-forwarded-proto",
  "x-real-ip",
];

export function buildUpstreamUrl(
  baseUrl: URL,
  path: string,
  query: string,
): URL {
  const upstream = new URL(baseUrl.toString());
  const basePath = upstream.pathname.replace(/\/+$/, "");
  const requestPath = path.startsWith("/") ? path : `/${path}`;

  upstream.pathname = `${basePath}${requestPath}` || "/";
  upstream.search = query ? `?${query}` : "";
  return upstream;
}

export function sanitizeUpstreamHeaders(
  source: Headers,
  config: RuntimeConfig,
): Headers {
  const headers = new Headers(source);

  for (const name of [
    ...HOP_BY_HOP_HEADERS,
    ...CLOUDFLARE_HEADERS,
    "content-length",
    "host",
    "x-proxy-token",
    "x-passproxy-chunk-action",
    "x-passproxy-request-id",
    "x-chunk-index",
    "x-chunk-sha256",
  ]) {
    headers.delete(name);
  }

  headers.delete("content-encoding");
  headers.set("accept-encoding", "identity");

  if (config.upstreamApiKey) {
    headers.set("authorization", `Bearer ${config.upstreamApiKey}`);
  }

  return headers;
}

export async function forwardUpstream(
  spec: UpstreamRequestSpec,
  config: RuntimeConfig,
  fetchImpl: UpstreamFetch,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), spec.timeoutMs);

  try {
    const request = new Request(
      buildUpstreamUrl(spec.baseUrl, spec.path, spec.query),
      {
        method: spec.method,
        headers: sanitizeUpstreamHeaders(spec.headers, config),
        body: spec.body,
        signal: controller.signal,
      },
    );
    return await fetchImpl(request);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new UpstreamTimeoutError();
    }
    throw new UpstreamUnreachableError();
  } finally {
    clearTimeout(timeout);
  }
}
