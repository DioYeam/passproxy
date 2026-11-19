import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/config";
import { handleRequest } from "../src/proxy";

const encoder = new TextEncoder();
const baseEnv: Env = {
  UPSTREAM_BASE_URL: "https://llm.example.com",
  CLIENT_TOKEN: "client-secret",
  UPSTREAM_API_KEY: "upstream-secret",
  ALLOWED_ORIGIN: "*",
};

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function validManifest(compressed: Uint8Array, totalParts = 1): object {
  const original = encoder.encode('{"model":"deepseek-flash"}');
  return {
    protocolVersion: 1,
    target: {
      method: "POST",
      path: "/chat/completions",
      query: "",
    },
    contentType: "application/json",
    contentEncoding: "gzip",
    compressedBytes: compressed.byteLength,
    compressedSha256: sha256(compressed),
    originalBytes: original.byteLength,
    originalSha256: sha256(original),
    totalParts,
    partSize: 65536,
    headers: { accept: "text/event-stream" },
  };
}

function fakeChunkNamespace(
  responder: (request: Request) => Promise<Response>,
) {
  const names: string[] = [];
  const requests: Request[] = [];
  const fetchStub = vi.fn(async (request: Request) => {
    requests.push(request);
    return responder(request);
  });
  const stub = { fetch: fetchStub };
  const namespace = {
    idFromName: vi.fn((name: string) => {
      names.push(name);
      return { name };
    }),
    get: vi.fn(() => stub),
  } as unknown as DurableObjectNamespace;

  return { namespace, names, requests, fetchStub };
}

describe("chunk routes", () => {
  it("delegates session creation to a generated Durable Object", async () => {
    const compressed = new Uint8Array(gzipSync(encoder.encode("{}")));
    const fake = fakeChunkNamespace(async (request) => {
      expect(request.headers.get("x-passproxy-chunk-action")).toBe("start");
      expect(request.headers.get("x-passproxy-request-id")).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      expect(await request.json()).toMatchObject({ protocolVersion: 1 });
      return Response.json(
        {
          requestId: request.headers.get("x-passproxy-request-id"),
          protocolVersion: 1,
          expiresAt: "2026-11-19T12:30:00.000Z",
          maxPartBytes: 98304,
        },
        { status: 201 },
      );
    });

    const response = await handleRequest(
      new Request("https://passproxy.example.workers.dev/__chunks/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-proxy-token": "client-secret",
        },
        body: JSON.stringify(validManifest(compressed)),
      }),
      { ...baseEnv, CHUNK_SESSIONS: fake.namespace },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(fake.fetchStub).toHaveBeenCalledTimes(1);
    expect(fake.names).toHaveLength(1);
    expect(fake.names[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("delegates a part upload with its index and checksum", async () => {
    const part = encoder.encode("part-two");
    const fake = fakeChunkNamespace(async (request) => {
      expect(request.headers.get("x-passproxy-chunk-action")).toBe("put-part");
      expect(request.headers.get("x-passproxy-request-id")).toBe("request-123");
      expect(request.headers.get("x-chunk-index")).toBe("2");
      expect(request.headers.get("x-chunk-sha256")).toBe(sha256(part));
      expect(Array.from(new Uint8Array(await request.arrayBuffer()))).toEqual(
        Array.from(part),
      );
      return Response.json({
        requestId: "request-123",
        index: 2,
        receivedParts: 3,
        totalParts: 4,
        duplicate: false,
      });
    });

    const response = await handleRequest(
      new Request(
        "https://passproxy.example.workers.dev/__chunks/sessions/request-123/parts/2",
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "x-proxy-token": "client-secret",
            "x-chunk-sha256": sha256(part),
          },
          body: part,
        },
      ),
      { ...baseEnv, CHUNK_SESSIONS: fake.namespace },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ index: 2 });
    expect(fake.names).toEqual(["request-123"]);
  });

  it("streams the completed upstream response through the Worker", async () => {
    const events = ["data: first\n\n", "data: second\n\n"];
    const fake = fakeChunkNamespace(async (request) => {
      expect(request.headers.get("x-passproxy-chunk-action")).toBe("complete");
      expect(request.headers.get("x-passproxy-request-id")).toBe("request-123");
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) {
            controller.enqueue(encoder.encode(event));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    });

    const response = await handleRequest(
      new Request(
        "https://passproxy.example.workers.dev/__chunks/sessions/request-123/complete",
        {
          method: "POST",
          headers: { "x-proxy-token": "client-secret" },
        },
      ),
      { ...baseEnv, CHUNK_SESSIONS: fake.namespace },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(events.join(""));
  });

  it("rejects chunk routes before touching a Durable Object when auth fails", async () => {
    const fake = fakeChunkNamespace(async () => new Response("unexpected"));

    const response = await handleRequest(
      new Request("https://passproxy.example.workers.dev/__chunks/sessions", {
        method: "POST",
        headers: { "x-proxy-token": "wrong" },
        body: "{}",
      }),
      { ...baseEnv, CHUNK_SESSIONS: fake.namespace },
    );

    expect(response.status).toBe(401);
    expect(fake.fetchStub).not.toHaveBeenCalled();
  });

  it("returns a configuration error when the chunk binding is missing", async () => {
    const response = await handleRequest(
      new Request("https://passproxy.example.workers.dev/__chunks/sessions", {
        method: "POST",
        headers: { "x-proxy-token": "client-secret" },
        body: "{}",
      }),
      baseEnv,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "configuration_error" },
    });
  });
});
