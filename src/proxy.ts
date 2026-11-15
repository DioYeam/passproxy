import { ConfigurationError, readConfig } from "./config";
import type { Env, RuntimeConfig } from "./config";
import {
  decodeRequestBody,
  InvalidGzipError,
  PayloadTooLargeError,
  UnsupportedContentEncodingError,
} from "./gzip";

type UpstreamFetch = (request: Request) => Promise<Response>;

export interface Dependencies {
  fetch?: UpstreamFetch;
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

function jsonResponse(
  body: unknown,
  status: number,
  request: Request,
  allowedOrigin: string,
  extraHeaders: HeadersInit = {},
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  applyCors(headers, request, allowedOrigin);

  return new Response(JSON.stringify(body), { status, headers });
}

function applyCors(
  headers: Headers,
  request: Request,
  allowedOrigin: string,
): void {
  const requestOrigin = request.headers.get("origin");

  if (allowedOrigin === "*") {
    headers.set("access-control-allow-origin", "*");
  } else if (requestOrigin === allowedOrigin) {
    headers.set("access-control-allow-origin", allowedOrigin);
    headers.append("vary", "Origin");
  }
}

function applyPreflightHeaders(
  headers: Headers,
  request: Request,
  allowedOrigin: string,
): void {
  applyCors(headers, request, allowedOrigin);
  headers.set(
    "access-control-allow-methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  headers.set(
    "access-control-allow-headers",
    "Authorization, Content-Type, Content-Encoding, X-Proxy-Token",
  );
  headers.set("access-control-max-age", "86400");
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

function buildUpstreamUrl(
  baseUrl: URL,
  incomingUrl: string,
): URL {
  const incoming = new URL(incomingUrl);
  const upstream = new URL(baseUrl.toString());
  const basePath = upstream.pathname.replace(/\/+$/, "");
  const incomingPath = incoming.pathname.startsWith("/")
    ? incoming.pathname
    : `/${incoming.pathname}`;

  upstream.pathname = `${basePath}${incomingPath}` || "/";
  upstream.search = incoming.search;

  return upstream;
}

function buildUpstreamHeaders(
  request: Request,
  config: RuntimeConfig,
): Headers {
  const headers = new Headers(request.headers);

  for (const name of [
    ...HOP_BY_HOP_HEADERS,
    ...CLOUDFLARE_HEADERS,
    "content-length",
    "host",
    "x-proxy-token",
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

async function relayUpstream(
  request: Request,
  env: Env,
  dependencies: Dependencies,
): Promise<Response> {
  let allowedOrigin = env.ALLOWED_ORIGIN?.trim() || "*";

  try {
    const config = readConfig(env);
    allowedOrigin = config.allowedOrigin;

    const suppliedToken = request.headers.get("x-proxy-token") ?? "";
    if (!constantTimeEqual(suppliedToken, config.clientToken)) {
      return jsonResponse(
        {
          error: {
            code: "unauthorized",
            message: "A valid X-Proxy-Token header is required.",
          },
        },
        401,
        request,
        allowedOrigin,
        { "www-authenticate": "Bearer" },
      );
    }

    const decodedBody = await decodeRequestBody(
      request,
      config.maxDecompressedBytes,
    );
    const upstreamUrl = buildUpstreamUrl(config.upstreamBaseUrl, request.url);
    const upstreamHeaders = buildUpstreamHeaders(request, config);
    const hasBody = decodedBody !== undefined;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.upstreamTimeoutMs,
    );
    const upstreamFetch: UpstreamFetch =
      dependencies.fetch ?? ((upstreamRequest) => fetch(upstreamRequest));
    let upstreamResponse: Response;

    try {
      const upstreamRequest = new Request(upstreamUrl, {
        method: request.method,
        headers: upstreamHeaders,
        body: hasBody ? decodedBody : undefined,
        signal: controller.signal,
      });
      upstreamResponse = await upstreamFetch(upstreamRequest);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return jsonResponse(
          {
            error: {
              code: "upstream_timeout",
              message: "The upstream service did not respond in time.",
            },
          },
          504,
          request,
          allowedOrigin,
        );
      }

      return jsonResponse(
        {
          error: {
            code: "upstream_unreachable",
            message: "The upstream request failed.",
          },
        },
        502,
        request,
        allowedOrigin,
      );
    } finally {
      clearTimeout(timeout);
    }

    const responseHeaders = new Headers(upstreamResponse.headers);
    applyCors(responseHeaders, request, allowedOrigin);

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return jsonResponse(
        {
          error: {
            code: "configuration_error",
            message: error.message,
          },
        },
        500,
        request,
        allowedOrigin,
      );
    }

    if (error instanceof UnsupportedContentEncodingError) {
      return jsonResponse(
        {
          error: {
            code: "unsupported_content_encoding",
            message: "Only gzip request bodies are supported.",
          },
        },
        415,
        request,
        allowedOrigin,
      );
    }

    if (error instanceof InvalidGzipError) {
      return jsonResponse(
        {
          error: {
            code: "invalid_gzip",
            message: error.message,
          },
        },
        400,
        request,
        allowedOrigin,
      );
    }

    if (error instanceof PayloadTooLargeError) {
      return jsonResponse(
        {
          error: {
            code: "payload_too_large",
            message: error.message,
          },
        },
        413,
        request,
        allowedOrigin,
      );
    }

    return jsonResponse(
      {
        error: {
          code: "internal_error",
          message: "The relay could not process the request.",
        },
      },
      500,
      request,
      allowedOrigin,
    );
  }
}

export async function handleRequest(
  request: Request,
  env: Env,
  dependencies: Dependencies = {},
): Promise<Response> {
  const url = new URL(request.url);
  const allowedOrigin = env.ALLOWED_ORIGIN?.trim() || "*";

  if (url.pathname === "/health" && request.method === "GET") {
    return jsonResponse({ ok: true }, 200, request, allowedOrigin);
  }

  if (request.method === "OPTIONS") {
    const headers = new Headers();
    applyPreflightHeaders(headers, request, allowedOrigin);
    return new Response(null, { status: 204, headers });
  }

  return relayUpstream(request, env, dependencies);
}
