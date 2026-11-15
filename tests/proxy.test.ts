import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/config";
import { handleRequest } from "../src/proxy";

const encoder = new TextEncoder();

const env: Env = {
  UPSTREAM_BASE_URL: "https://llm.example.com/openai",
  CLIENT_TOKEN: "client-secret",
  UPSTREAM_API_KEY: "upstream-secret",
  ALLOWED_ORIGIN: "https://app.example.com",
  MAX_DECOMPRESSED_BYTES: "1024",
  UPSTREAM_TIMEOUT_MS: "1000",
};

function makeRequest(
  body: BodyInit | null = null,
  extraHeaders: Record<string, string> = {},
  path = "/v1/chat/completions",
): Request {
  return new Request(`https://relay.example.workers.dev${path}`, {
    method: body === null ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "x-proxy-token": "client-secret",
      ...extraHeaders,
    },
    body,
  });
}

describe("gzip relay worker", () => {
  it("reports health without requiring a proxy token", async () => {
    const response = await handleRequest(
      new Request("https://relay.example.workers.dev/health"),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers browser preflight requests with the configured origin", async () => {
    const response = await handleRequest(
      new Request("https://relay.example.workers.dev/v1/chat/completions", {
        method: "OPTIONS",
        headers: { origin: "https://app.example.com" },
      }),
      env,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "X-Proxy-Token",
    );
  });

  it("rejects requests with an invalid proxy token before contacting upstream", async () => {
    const upstreamFetch = vi.fn<(request: Request) => Promise<Response>>();

    const response = await handleRequest(
      makeRequest(null, { "x-proxy-token": "wrong-token" }),
      env,
      { fetch: upstreamFetch },
    );

    expect(response.status).toBe(401);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("decompresses a gzip body and forwards the decoded request", async () => {
    const payload = JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "压缩请求测试" }],
    });
    const compressed = gzipSync(encoder.encode(payload));
    let forwarded: Request | undefined;
    const upstreamFetch = vi.fn(async (request: Request) => {
      forwarded = request;
      return new Response("upstream accepted", {
        status: 201,
        headers: { "content-type": "text/plain" },
      });
    });

    const response = await handleRequest(
      makeRequest(compressed, {
        "content-encoding": "gzip",
        authorization: "Bearer browser-auth",
        origin: "https://app.example.com",
      }, "/v1/chat/completions?stream=true"),
      env,
      { fetch: upstreamFetch },
    );

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("upstream accepted");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(forwarded).toBeDefined();
    expect(forwarded?.url).toBe(
      "https://llm.example.com/openai/v1/chat/completions?stream=true",
    );
    expect(forwarded?.headers.get("content-encoding")).toBeNull();
    expect(forwarded?.headers.get("content-length")).toBeNull();
    expect(forwarded?.headers.get("x-proxy-token")).toBeNull();
    expect(forwarded?.headers.get("authorization")).toBe(
      "Bearer upstream-secret",
    );
    expect(forwarded?.headers.get("accept-encoding")).toBe("identity");
    expect(await forwarded?.text()).toBe(payload);
  });

  it("forwards uncompressed bodies without changing their contents", async () => {
    const payload = '{"model":"test-model"}';
    const upstreamFetch = vi.fn(async (request: Request) => {
      expect(await request.text()).toBe(payload);
      return new Response("ok");
    });

    const response = await handleRequest(
      makeRequest(payload),
      env,
      { fetch: upstreamFetch },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("rejects unsupported content encodings", async () => {
    const upstreamFetch = vi.fn<(request: Request) => Promise<Response>>();

    const response = await handleRequest(
      makeRequest("encoded", { "content-encoding": "br" }),
      env,
      { fetch: upstreamFetch },
    );

    expect(response.status).toBe(415);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("rejects a decompressed body that exceeds the configured limit", async () => {
    const compressed = gzipSync(encoder.encode("x".repeat(1025)));
    const upstreamFetch = vi.fn<(request: Request) => Promise<Response>>();

    const response = await handleRequest(
      makeRequest(compressed, { "content-encoding": "gzip" }),
      env,
      { fetch: upstreamFetch },
    );

    expect(response.status).toBe(413);
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it("returns a clear configuration error when the upstream URL is missing", async () => {
    const response = await handleRequest(
      makeRequest("{}"),
      { ...env, UPSTREAM_BASE_URL: "" },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "configuration_error" },
    });
  });

  it("passes through streamed upstream events without buffering the response", async () => {
    const chunks = ["data: first\n\n", "data: second\n\n"];
    const upstreamFetch = vi.fn(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    });

    const response = await handleRequest(
      makeRequest("{}"),
      env,
      { fetch: upstreamFetch },
    );

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(chunks.join(""));
  });
});
