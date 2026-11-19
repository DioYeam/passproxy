import { ChunkProtocolError } from "./chunk-protocol";
import { ConfigurationError, readConfig } from "./config";
import type { Env, RuntimeConfig } from "./config";
import {
  decodeRequestBody,
  InvalidGzipError,
  PayloadTooLargeError,
  UnsupportedContentEncodingError,
} from "./gzip";
import {
  forwardUpstream,
  UpstreamTimeoutError,
  UpstreamUnreachableError,
} from "./upstream";
import type { UpstreamFetch } from "./upstream";

export interface Dependencies {
  fetch?: UpstreamFetch;
}

const CREATE_SESSION_PATH = /^\/__chunks\/sessions$/;
const UPLOAD_PART_PATH =
  /^\/__chunks\/sessions\/([A-Za-z0-9_-]+)\/parts\/(\d+)$/;
const COMPLETE_SESSION_PATH =
  /^\/__chunks\/sessions\/([A-Za-z0-9_-]+)\/complete$/;
const MAX_MANIFEST_BYTES = 64 * 1024;

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
    "Authorization, Content-Type, Content-Encoding, X-Chunk-SHA256, X-Proxy-Token",
  );
  headers.set("access-control-max-age", "86400");
}

function withCors(
  response: Response,
  request: Request,
  allowedOrigin: string,
): Response {
  const headers = new Headers(response.headers);
  applyCors(headers, request, allowedOrigin);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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

function requireAuthorizedToken(
  request: Request,
  config: RuntimeConfig,
): void {
  const suppliedToken = request.headers.get("x-proxy-token") ?? "";
  if (!constantTimeEqual(suppliedToken, config.clientToken)) {
    throw new ChunkProtocolError(
      401,
      "unauthorized",
      "A valid X-Proxy-Token header is required.",
    );
  }
}

async function relayDirect(
  request: Request,
  config: RuntimeConfig,
  dependencies: Dependencies,
): Promise<Response> {
  const decodedBody = await decodeRequestBody(
    request,
    config.maxDecompressedBytes,
  );
  const incomingUrl = new URL(request.url);
  const upstreamResponse = await forwardUpstream(
    {
      baseUrl: config.upstreamBaseUrl,
      method: request.method,
      path: incomingUrl.pathname,
      query: incomingUrl.search.slice(1),
      headers: new Headers(request.headers),
      body: decodedBody,
      timeoutMs: config.upstreamTimeoutMs,
    },
    config,
    dependencies.fetch ?? ((upstreamRequest) => fetch(upstreamRequest)),
  );

  return withCors(upstreamResponse, request, config.allowedOrigin);
}

function internalChunkRequest(
  action: string,
  requestId: string,
  request: Request,
  body?: BodyInit,
  extraHeaders: Record<string, string> = {},
): Request {
  const headers = new Headers({
    "x-passproxy-chunk-action": action,
    "x-passproxy-request-id": requestId,
    ...extraHeaders,
  });
  if (body !== undefined) {
    headers.set("content-type", "application/octet-stream");
  }

  return new Request(`https://chunk-session.internal/${action}`, {
    method: action === "put-part" ? "PUT" : "POST",
    headers,
    body,
  });
}

async function handleChunkRoute(
  request: Request,
  url: URL,
  config: RuntimeConfig,
  env: Env,
): Promise<Response | null> {
  const isStart = CREATE_SESSION_PATH.test(url.pathname);
  const partMatch = UPLOAD_PART_PATH.exec(url.pathname);
  const completeMatch = COMPLETE_SESSION_PATH.exec(url.pathname);

  if (!isStart && !partMatch && !completeMatch) {
    if (url.pathname.startsWith("/__chunks/")) {
      throw new ChunkProtocolError(
        404,
        "session_not_found",
        "The chunk session endpoint does not exist.",
      );
    }
    return null;
  }

  if (!env.CHUNK_SESSIONS) {
    throw new ConfigurationError(
      "CHUNK_SESSIONS Durable Object binding is required.",
    );
  }

  if (isStart) {
    if (request.method !== "POST") {
      throw new ChunkProtocolError(
        405,
        "invalid_manifest",
        "Session creation requires POST.",
      );
    }
    const body = await request.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > MAX_MANIFEST_BYTES) {
      throw new ChunkProtocolError(
        400,
        "invalid_manifest",
        `The manifest must be between 1 and ${MAX_MANIFEST_BYTES} bytes.`,
      );
    }

    const requestId = crypto.randomUUID();
    const stub = env.CHUNK_SESSIONS.get(
      env.CHUNK_SESSIONS.idFromName(requestId),
    );
    const response = await stub.fetch(
      internalChunkRequest(
        "start",
        requestId,
        request,
        body,
        { "content-type": "application/json" },
      ),
    );
    return withCors(response, request, config.allowedOrigin);
  }

  if (partMatch) {
    if (request.method !== "PUT") {
      throw new ChunkProtocolError(
        405,
        "invalid_manifest",
        "Part upload requires PUT.",
      );
    }

    const requestId = partMatch[1] as string;
    const index = partMatch[2] as string;
    const checksum = request.headers.get("x-chunk-sha256");
    if (!checksum) {
      throw new ChunkProtocolError(
        400,
        "invalid_chunk_hash",
        "X-Chunk-SHA256 is required.",
      );
    }

    if (Number(index) >= 256) {
      throw new ChunkProtocolError(
        400,
        "invalid_manifest",
        "The chunk index is outside the protocol range.",
      );
    }

    const body = await request.arrayBuffer();
    if (body.byteLength > config.maxChunkBytes) {
      throw new ChunkProtocolError(
        413,
        "chunk_too_large",
        `A part cannot exceed ${config.maxChunkBytes} bytes.`,
      );
    }

    const stub = env.CHUNK_SESSIONS.get(
      env.CHUNK_SESSIONS.idFromName(requestId),
    );
    const response = await stub.fetch(
      internalChunkRequest("put-part", requestId, request, body, {
        "content-type": "application/octet-stream",
        "x-chunk-index": index,
        "x-chunk-sha256": checksum,
      }),
    );
    return withCors(response, request, config.allowedOrigin);
  }

  if (completeMatch) {
    if (request.method !== "POST") {
      throw new ChunkProtocolError(
        405,
        "invalid_manifest",
        "Session completion requires POST.",
      );
    }
    const requestId = completeMatch[1] as string;
    const stub = env.CHUNK_SESSIONS.get(
      env.CHUNK_SESSIONS.idFromName(requestId),
    );
    const response = await stub.fetch(
      internalChunkRequest("complete", requestId, request),
    );
    return withCors(response, request, config.allowedOrigin);
  }

  return null;
}

function protocolErrorResponse(
  error: ChunkProtocolError,
  request: Request,
  allowedOrigin: string,
): Response {
  return jsonResponse(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ?? {}),
      },
    },
    error.status,
    request,
    allowedOrigin,
    error.code === "unauthorized"
      ? { "www-authenticate": "Bearer" }
      : {},
  );
}

export async function handleRequest(
  request: Request,
  env: Env,
  dependencies: Dependencies = {},
): Promise<Response> {
  const url = new URL(request.url);
  const initialOrigin = env.ALLOWED_ORIGIN?.trim() || "*";

  if (url.pathname === "/health" && request.method === "GET") {
    return jsonResponse({ ok: true }, 200, request, initialOrigin);
  }

  if (request.method === "OPTIONS") {
    const headers = new Headers();
    applyPreflightHeaders(headers, request, initialOrigin);
    return new Response(null, { status: 204, headers });
  }

  let config: RuntimeConfig;
  try {
    config = readConfig(env);
    requireAuthorizedToken(request, config);
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
        initialOrigin,
      );
    }
    if (error instanceof ChunkProtocolError) {
      return protocolErrorResponse(error, request, initialOrigin);
    }
    throw error;
  }

  try {
    const chunkResponse = await handleChunkRoute(request, url, config, env);
    if (chunkResponse) {
      return chunkResponse;
    }
    return await relayDirect(request, config, dependencies);
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
        config.allowedOrigin,
      );
    }
    if (error instanceof ChunkProtocolError) {
      return protocolErrorResponse(error, request, config.allowedOrigin);
    }
    if (
      error instanceof InvalidGzipError ||
      error instanceof PayloadTooLargeError ||
      error instanceof UnsupportedContentEncodingError
    ) {
      const status =
        error instanceof InvalidGzipError
          ? 400
          : error instanceof PayloadTooLargeError
            ? 413
            : 415;
      const code =
        error instanceof InvalidGzipError
          ? "invalid_gzip"
          : error instanceof PayloadTooLargeError
            ? "payload_too_large"
            : "unsupported_content_encoding";
      return jsonResponse(
        { error: { code, message: error.message } },
        status,
        request,
        config.allowedOrigin,
      );
    }
    if (error instanceof UpstreamTimeoutError) {
      return jsonResponse(
        {
          error: {
            code: "upstream_timeout",
            message: error.message,
          },
        },
        504,
        request,
        config.allowedOrigin,
      );
    }
    if (error instanceof UpstreamUnreachableError) {
      return jsonResponse(
        {
          error: {
            code: "upstream_unreachable",
            message: error.message,
          },
        },
        502,
        request,
        config.allowedOrigin,
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
      config.allowedOrigin,
    );
  }
}
