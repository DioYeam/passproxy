import type { Env } from "./config";
import { readConfig } from "./config";
import {
  ChunkProtocolError,
  ChunkSessionCore,
  type ChunkLimits,
} from "./chunk-protocol";
import {
  forwardUpstream,
  UpstreamTimeoutError,
  UpstreamUnreachableError,
} from "./upstream";

function json(
  body: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(error: ChunkProtocolError): Response {
  return json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ?? {}),
      },
    },
    error.status,
  );
}

function limitsFromEnv(env: Env): ChunkLimits {
  const config = readConfig(env);
  return {
    maxPartBytes: config.maxChunkBytes,
    maxCompressedBytes: config.maxCompressedBytes,
    maxDecompressedBytes: config.maxDecompressedBytes,
    sessionTtlMs: config.chunkSessionTtlMs,
  };
}

export class ChunkSession implements DurableObject {
  private readonly core: ChunkSessionCore;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.core = new ChunkSessionCore(
      state.storage,
      limitsFromEnv(env),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const action = request.headers.get("x-passproxy-chunk-action");
    const requestId = request.headers.get("x-passproxy-request-id");

    if (!requestId) {
      return errorResponse(
        new ChunkProtocolError(
          400,
          "invalid_manifest",
          "The internal request ID is missing.",
        ),
      );
    }

    try {
      if (action === "start") {
        return await this.start(request, requestId);
      }
      if (action === "put-part") {
        return await this.putPart(request, requestId);
      }
      if (action === "complete") {
        return await this.complete(requestId);
      }

      return errorResponse(
        new ChunkProtocolError(
          400,
          "invalid_manifest",
          "Unknown chunk action.",
        ),
      );
    } catch (error) {
      if (error instanceof ChunkProtocolError) {
        return errorResponse(error);
      }
      return json(
        {
          error: {
            code: "internal_error",
            message: "The chunk session could not process the request.",
          },
        },
        500,
      );
    }
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }

  private async start(
    request: Request,
    requestId: string,
  ): Promise<Response> {
    let manifest: unknown;
    try {
      manifest = await request.json();
    } catch {
      throw new ChunkProtocolError(
        400,
        "invalid_manifest",
        "The request body must be valid JSON.",
      );
    }

    const record = await this.core.create(manifest);
    await this.state.storage.setAlarm(record.expiresAt);
    const config = readConfig(this.env);

    return json(
      {
        requestId,
        protocolVersion: 1,
        expiresAt: new Date(record.expiresAt).toISOString(),
        maxPartBytes: config.maxChunkBytes,
      },
      201,
    );
  }

  private async putPart(
    request: Request,
    requestId: string,
  ): Promise<Response> {
    const indexValue = request.headers.get("x-chunk-index");
    const checksum = request.headers.get("x-chunk-sha256") ?? "";
    const index = Number(indexValue);

    if (indexValue === null || !Number.isInteger(index)) {
      throw new ChunkProtocolError(
        400,
        "invalid_manifest",
        "The chunk index is invalid.",
      );
    }

    const data = new Uint8Array(await request.arrayBuffer());
    const result = await this.core.putPart(index, data, checksum);

    return json({ requestId, ...result });
  }

  private async complete(requestId: string): Promise<Response> {
    const completed = await this.core.complete();
    const config = readConfig(this.env);
    const headers = new Headers(completed.manifest.headers);
    headers.set("content-type", completed.manifest.contentType);

    try {
      const response = await forwardUpstream(
        {
          baseUrl: config.upstreamBaseUrl,
          method: completed.manifest.target.method,
          path: completed.manifest.target.path,
          query: completed.manifest.target.query,
          headers,
          body: completed.body,
          timeoutMs: config.upstreamTimeoutMs,
        },
        config,
        (request) => fetch(request),
      );
      this.state.waitUntil(this.core.cleanupParts());
      return response;
    } catch (error) {
      if (error instanceof UpstreamTimeoutError) {
        return errorResponse(
          new ChunkProtocolError(
            504,
            "upstream_timeout",
            "The upstream service did not respond in time.",
          ),
        );
      }
      if (error instanceof UpstreamUnreachableError) {
        return errorResponse(
          new ChunkProtocolError(
            502,
            "upstream_unreachable",
            "The upstream request failed.",
          ),
        );
      }
      throw error;
    }
  }
}
