import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import {
  ChunkProtocolError,
  ChunkSessionCore,
  type ChunkLimits,
  type ChunkManifest,
  type ProtocolStorage,
  sha256Hex,
  validateManifest,
} from "../src/chunk-protocol";

const encoder = new TextEncoder();
const limits: ChunkLimits = {
  maxPartBytes: 96 * 1024,
  maxCompressedBytes: 8 * 1024 * 1024,
  maxDecompressedBytes: 2 * 1024 * 1024,
  sessionTtlMs: 15 * 60 * 1000,
};

class MemoryStorage implements ProtocolStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

function digest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function manifestFor(
  original: Uint8Array,
  compressed: Uint8Array,
  totalParts: number,
): ChunkManifest {
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
    compressedSha256: digest(compressed),
    originalBytes: original.byteLength,
    originalSha256: digest(original),
    totalParts,
    partSize: 65536,
    headers: {
      accept: "text/event-stream",
      "user-agent": "Trae bridge",
    },
  };
}

function split(data: Uint8Array, partBytes = 64): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < data.byteLength; offset += partBytes) {
    parts.push(data.slice(offset, offset + partBytes));
  }
  return parts;
}

describe("chunk protocol validation", () => {
  it("accepts a valid version 1 manifest", () => {
    const original = encoder.encode('{"model":"deepseek-flash"}');
    const compressed = new Uint8Array(gzipSync(original));

    const manifest = validateManifest(
      manifestFor(original, compressed, 1),
      limits,
    );

    expect(manifest.target.path).toBe("/chat/completions");
    expect(manifest.compressedSha256).toBe(digest(compressed));
  });

  it("rejects an absolute or protocol-relative target path", () => {
    const original = encoder.encode("{}");
    const compressed = new Uint8Array(gzipSync(original));
    const manifest = manifestFor(original, compressed, 1);

    expect(() =>
      validateManifest(
        { ...manifest, target: { ...manifest.target, path: "//evil.example" } },
        limits,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ChunkProtocolError>>({
        code: "invalid_manifest",
      }),
    );
  });

  it("rejects a part count that cannot cover the compressed body", () => {
    const original = encoder.encode("{}");
    const compressed = new Uint8Array(limits.maxPartBytes * 2);
    const manifest = manifestFor(original, compressed, 1);

    expect(() => validateManifest(manifest, limits)).toThrowError(
      expect.objectContaining<Partial<ChunkProtocolError>>({
        code: "invalid_manifest",
      }),
    );
  });

  it("rejects malformed SHA-256 values", () => {
    const original = encoder.encode("{}");
    const compressed = new Uint8Array(gzipSync(original));
    const manifest = manifestFor(original, compressed, 1);

    expect(() =>
      validateManifest(
        { ...manifest, compressedSha256: "not-a-hash" },
        limits,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<ChunkProtocolError>>({
        code: "invalid_manifest",
      }),
    );
  });
});

describe("chunk session assembly", () => {
  it("assembles out-of-order parts into the exact original body", async () => {
    const original = encoder.encode(
      JSON.stringify({ messages: [{ role: "user", content: "x".repeat(500) }] }),
    );
    const compressed = new Uint8Array(gzipSync(original));
    const parts = split(compressed, Math.ceil(compressed.byteLength / 3));
    const storage = new MemoryStorage();
    const session = new ChunkSessionCore(storage, limits, () => 1_000);
    const manifest = manifestFor(original, compressed, parts.length);
    await session.create(manifest);

    for (const index of [2, 0, 1]) {
      await session.putPart(index, parts[index], digest(parts[index]));
    }

    const completed = await session.complete();

    expect(completed.manifest).toEqual(manifest);
    expect(Array.from(completed.body)).toEqual(Array.from(original));
  });

  it("treats an identical duplicate part as idempotent", async () => {
    const original = encoder.encode("{}");
    const compressed = new Uint8Array(gzipSync(original));
    const storage = new MemoryStorage();
    const session = new ChunkSessionCore(storage, limits, () => 1_000);
    await session.create(manifestFor(original, compressed, 1));

    await session.putPart(0, compressed, digest(compressed));
    const duplicate = await session.putPart(0, compressed, digest(compressed));

    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.receivedParts).toBe(1);
  });

  it("rejects different content for an already uploaded index", async () => {
    const original = encoder.encode("{}");
    const compressed = new Uint8Array(gzipSync(original));
    const storage = new MemoryStorage();
    const session = new ChunkSessionCore(storage, limits, () => 1_000);
    await session.create(manifestFor(original, compressed, 1));
    await session.putPart(0, compressed, digest(compressed));

    await expect(
      session.putPart(0, encoder.encode("different"), digest(encoder.encode("different"))),
    ).rejects.toMatchObject({ code: "chunk_conflict" });
  });

  it("reports exact missing indexes without consuming the session", async () => {
    const original = encoder.encode("{}");
    const compressed = new Uint8Array(gzipSync(original));
    const parts = split(compressed, 4);
    const storage = new MemoryStorage();
    const session = new ChunkSessionCore(storage, limits, () => 1_000);
    await session.create(manifestFor(original, compressed, parts.length));
    await session.putPart(1, parts[1], digest(parts[1]));

    await expect(session.complete()).rejects.toMatchObject({
      code: "missing_chunks",
      details: {
        missingIndexes: parts.map((_, index) => index).filter((index) => index !== 1),
      },
    });
    expect((await storage.get<{ consumedAt?: number }>("session"))?.consumedAt).toBeUndefined();
  });

  it("rejects a part whose supplied hash does not match its bytes", async () => {
    const original = encoder.encode("{}");
    const compressed = new Uint8Array(gzipSync(original));
    const storage = new MemoryStorage();
    const session = new ChunkSessionCore(storage, limits, () => 1_000);
    await session.create(manifestFor(original, compressed, 1));

    await expect(
      session.putPart(
        0,
        compressed,
        await sha256Hex(encoder.encode("wrong")),
      ),
    ).rejects.toMatchObject({ code: "invalid_chunk_hash" });
  });

  it("rejects a request after its session expires", async () => {
    const original = encoder.encode("{}");
    const compressed = new Uint8Array(gzipSync(original));
    const storage = new MemoryStorage();
    let now = 1_000;
    const session = new ChunkSessionCore(storage, limits, () => now);
    await session.create(manifestFor(original, compressed, 1));
    now += limits.sessionTtlMs + 1;

    await expect(
      session.putPart(0, compressed, digest(compressed)),
    ).rejects.toMatchObject({ code: "session_expired" });
  });

  it("allows a session to be completed only once", async () => {
    const original = encoder.encode("{}");
    const compressed = new Uint8Array(gzipSync(original));
    const storage = new MemoryStorage();
    const session = new ChunkSessionCore(storage, limits, () => 1_000);
    await session.create(manifestFor(original, compressed, 1));
    await session.putPart(0, compressed, digest(compressed));
    await session.complete();

    await expect(session.complete()).rejects.toMatchObject({
      code: "session_consumed",
    });
  });

  it("rejects a stored part that was modified after upload", async () => {
    const original = encoder.encode("{}");
    const compressed = new Uint8Array(gzipSync(original));
    const storage = new MemoryStorage();
    const session = new ChunkSessionCore(storage, limits, () => 1_000);
    await session.create(manifestFor(original, compressed, 1));
    await session.putPart(0, compressed, digest(compressed));
    storage.values.set("part:0", encoder.encode("tampered"));

    await expect(session.complete()).rejects.toMatchObject({
      code: "invalid_chunk_hash",
    });
  });
});
