import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function readRequest(request: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function runClient(args: string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, HTTPS_PROXY: "", HTTP_PROXY: "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("chunked client example", () => {
  const cleanup: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("gzip-compresses, splits, uploads, and finalizes one identical body", async () => {
    const parts = new Map<number, Buffer>();
    let completedBody: Buffer | undefined;
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "POST" && url.pathname === "/__chunks/sessions") {
        const manifest = JSON.parse((await readRequest(request)).toString("utf8"));
        expect(manifest.target.path).toBe("/chat/completions");
        expect(manifest.contentEncoding).toBe("gzip");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          requestId: "request-1",
          protocolVersion: 1,
          expiresAt: "2026-11-19T12:30:00.000Z",
          maxPartBytes: 98304,
        }));
        return;
      }

      const partMatch = /^\/__chunks\/sessions\/request-1\/parts\/(\d+)$/.exec(
        url.pathname,
      );
      if (request.method === "PUT" && partMatch) {
        const index = Number(partMatch[1]);
        const body = await readRequest(request);
        expect(request.headers["x-chunk-sha256"]).toBe(sha256(body));
        parts.set(index, body);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          requestId: "request-1",
          index,
          receivedParts: parts.size,
          totalParts: parts.size,
          duplicate: false,
        }));
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/__chunks/sessions/request-1/complete"
      ) {
        const compressed = Buffer.concat(
          [...parts.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, value]) => value),
        );
        completedBody = gunzipSync(compressed);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            body: completedBody.toString("utf8"),
            sha256: sha256(completedBody),
          }),
        );
        return;
      }

      response.statusCode = 404;
      response.end("not found");
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );

    const directory = await mkdtemp(join(tmpdir(), "passproxy-client-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const bodyPath = join(directory, "body.json");
    const original = JSON.stringify({
      model: "deepseek-flash",
      messages: [
        {
          role: "user",
          content: randomBytes(100_000).toString("base64"),
        },
      ],
      stream: true,
    });
    await writeFile(bodyPath, original, "utf8");

    const address = server.address() as AddressInfo;
    const result = await runClient([
      "scripts/chunked-client.mjs",
      "--worker-url",
      `http://127.0.0.1:${address.port}`,
      "--token",
      "client-secret",
      "--body-file",
      bodyPath,
      "--target-path",
      "/chat/completions",
      "--part-size",
      "65536",
      "--concurrency",
      "3",
    ]);

    expect(result.code, result.stderr).toBe(0);
    const responseBody = JSON.parse(result.stdout);
    expect(responseBody.body).toBe(original);
    expect(responseBody.sha256).toBe(sha256(Buffer.from(original)));
    expect(completedBody?.equals(Buffer.from(original))).toBe(true);
    expect(parts.size).toBeGreaterThan(1);
  });
});
