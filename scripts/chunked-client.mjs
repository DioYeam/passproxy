#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const MAX_PART_BYTES = 96 * 1024;
const DEFAULT_PART_BYTES = 64 * 1024;

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function splitCompressedBody(compressed, partBytes) {
  if (!Number.isInteger(partBytes) || partBytes <= 0) {
    throw new Error("partBytes must be a positive integer.");
  }
  if (partBytes > MAX_PART_BYTES) {
    throw new Error(`partBytes cannot exceed ${MAX_PART_BYTES}.`);
  }

  const parts = [];
  for (let offset = 0; offset < compressed.byteLength; offset += partBytes) {
    parts.push(compressed.subarray(offset, offset + partBytes));
  }
  return parts;
}

export function buildChunkManifest({
  original,
  compressed,
  targetPath,
  query = "",
  partBytes = DEFAULT_PART_BYTES,
  headers = {},
}) {
  const parts = splitCompressedBody(compressed, partBytes);
  return {
    manifest: {
      protocolVersion: 1,
      target: {
        method: "POST",
        path: targetPath,
        query,
      },
      contentType: "application/json",
      contentEncoding: "gzip",
      compressedBytes: compressed.byteLength,
      compressedSha256: sha256(compressed),
      originalBytes: original.byteLength,
      originalSha256: sha256(original),
      totalParts: parts.length,
      partSize: partBytes,
      headers,
    },
    parts,
  };
}

async function createFetch() {
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;

  if (!proxy) {
    return fetch;
  }

  const { fetch: undiciFetch, ProxyAgent } = await import("undici");
  const dispatcher = new ProxyAgent(proxy);
  return (input, init) =>
    undiciFetch(input, {
      ...init,
      dispatcher,
    });
}

async function parseResponseError(response) {
  const text = await response.text();
  if (!text) {
    return `HTTP ${response.status} ${response.statusText}`;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.error?.code) {
      return `HTTP ${response.status} ${parsed.error.code}: ${parsed.error.message}`;
    }
  } catch {
    // Return the raw body below.
  }
  return `HTTP ${response.status}: ${text}`;
}

export async function sendChunkedRequest({
  workerUrl,
  token,
  original,
  targetPath,
  query = "",
  partBytes = DEFAULT_PART_BYTES,
  concurrency = 3,
  headers = {},
  fetchImpl = fetch,
  log = () => {},
}) {
  const parsedWorkerUrl = new URL(workerUrl);
  if (!["https:", "http:"].includes(parsedWorkerUrl.protocol)) {
    throw new Error("workerUrl must use HTTP or HTTPS.");
  }
  if (!token) {
    throw new Error("token is required.");
  }
  if (!original || original.byteLength === 0) {
    throw new Error("original request body is empty.");
  }

  const compressed = gzipSync(original, { level: 9 });
  const { manifest, parts } = buildChunkManifest({
    original,
    compressed,
    targetPath,
    query,
    partBytes,
    headers,
  });

  const sessionEndpoint = new URL(
    "/__chunks/sessions",
    parsedWorkerUrl,
  );
  const createResponse = await fetchImpl(sessionEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-proxy-token": token,
    },
    body: JSON.stringify(manifest),
  });
  if (!createResponse.ok) {
    throw new Error(await parseResponseError(createResponse));
  }

  const session = await createResponse.json();
  if (typeof session.requestId !== "string") {
    throw new Error("Session response did not include requestId.");
  }
  log(
    `session=${session.requestId} parts=${parts.length} original=${original.byteLength}B gzip=${compressed.byteLength}B`,
  );

  let nextIndex = 0;
  const uploadWorker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= parts.length) {
        return;
      }

      const part = parts[index];
      const endpoint = new URL(
        `/__chunks/sessions/${encodeURIComponent(session.requestId)}/parts/${index}`,
        parsedWorkerUrl,
      );
      const response = await fetchImpl(endpoint, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-proxy-token": token,
          "x-chunk-sha256": sha256(part),
        },
        body: part,
      });
      if (!response.ok) {
        throw new Error(`Part ${index}: ${await parseResponseError(response)}`);
      }
      log(`uploaded part=${index + 1}/${parts.length}`);
    }
  };

  const workerCount = Math.max(
    1,
    Math.min(Number(concurrency), parts.length),
  );
  await Promise.all(
    Array.from({ length: workerCount }, () => uploadWorker()),
  );

  const completeEndpoint = new URL(
    `/__chunks/sessions/${encodeURIComponent(session.requestId)}/complete`,
    parsedWorkerUrl,
  );
  const completeResponse = await fetchImpl(completeEndpoint, {
    method: "POST",
    headers: {
      "content-length": "0",
      "x-proxy-token": token,
    },
  });

  if (!completeResponse.ok) {
    throw new Error(await parseResponseError(completeResponse));
  }

  return completeResponse;
}

function parseArgs(argv) {
  const values = {
    workerUrl: process.env.WORKER_URL,
    token: process.env.CLIENT_TOKEN,
    bodyFile: process.env.BODY_FILE || "body.json",
    targetPath: process.env.TARGET_PATH || "/chat/completions",
    query: process.env.TARGET_QUERY || "",
    partSize: Number(process.env.PART_SIZE || DEFAULT_PART_BYTES),
    concurrency: Number(process.env.CONCURRENCY || 3),
    headers: {},
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--header") {
      if (!value || !value.includes("=")) {
        throw new Error("--header must use NAME=VALUE.");
      }
      const separator = value.indexOf("=");
      values.headers[value.slice(0, separator)] = value.slice(separator + 1);
      index += 1;
      continue;
    }

    const known = {
      "--worker-url": "workerUrl",
      "--token": "token",
      "--body-file": "bodyFile",
      "--target-path": "targetPath",
      "--query": "query",
      "--part-size": "partSize",
      "--concurrency": "concurrency",
    };
    const key = known[flag];
    if (!key) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    if (value === undefined) {
      throw new Error(`${flag} requires a value.`);
    }
    values[key] =
      key === "partSize" || key === "concurrency" ? Number(value) : value;
    index += 1;
  }

  return values;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.workerUrl) {
    throw new Error("--worker-url or WORKER_URL is required.");
  }
  if (!options.token) {
    throw new Error("--token or CLIENT_TOKEN is required.");
  }

  const original = await readFile(options.bodyFile);
  const fetchImpl = await createFetch();
  console.error(
    `Reading ${options.bodyFile}, target ${options.targetPath}`,
  );
  const response = await sendChunkedRequest({
    ...options,
    original,
    fetchImpl,
    log: (message) => console.error(message),
  });

  if (!response.body) {
    return;
  }
  for await (const chunk of response.body) {
    process.stdout.write(chunk);
  }
}

const invokedDirectly =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
