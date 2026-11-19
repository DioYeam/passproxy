export const CHUNK_PROTOCOL_VERSION = 1;
export const MAX_CHUNK_PARTS = 256;

export interface ChunkLimits {
  maxPartBytes: number;
  maxCompressedBytes: number;
  maxDecompressedBytes: number;
  sessionTtlMs: number;
}

export interface ChunkManifest {
  protocolVersion: 1;
  target: {
    method: "POST";
    path: string;
    query: string;
  };
  contentType: string;
  contentEncoding: "gzip";
  compressedBytes: number;
  compressedSha256: string;
  originalBytes: number;
  originalSha256: string;
  totalParts: number;
  partSize: number;
  headers: Record<string, string>;
}

export interface CompletedChunkRequest {
  body: Uint8Array<ArrayBuffer>;
  manifest: ChunkManifest;
}

export interface PartUploadResult {
  index: number;
  receivedParts: number;
  totalParts: number;
  duplicate: boolean;
}

export interface ProtocolStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface SessionRecord {
  manifest: ChunkManifest;
  expiresAt: number;
  consumedAt?: number;
}

interface PartMetadata {
  sha256: string;
  bytes: number;
}

export class ChunkProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ChunkProtocolError";
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SESSION_KEY = "session";
const MAX_HEADER_BYTES = 16 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidManifest(message: string): never {
  throw new ChunkProtocolError(400, "invalid_manifest", message);
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    invalidManifest(`${field} must be a positive integer.`);
  }
  return value;
}

function normalizeSha256(value: unknown, field: string): string {
  if (typeof value !== "string") {
    invalidManifest(`${field} must be a SHA-256 string.`);
  }

  const normalized = value.toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    invalidManifest(`${field} must contain exactly 64 hexadecimal characters.`);
  }
  return normalized;
}

function validateTargetPath(path: unknown): string {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("\r") ||
    path.includes("\n")
  ) {
    invalidManifest("target.path must be a safe absolute path.");
  }

  const parsed = new URL(path, "https://passproxy.invalid");
  if (parsed.origin !== "https://passproxy.invalid" || parsed.pathname !== path) {
    invalidManifest("target.path must not change origin or contain dot segments.");
  }
  return path;
}

function validateHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    invalidManifest("headers must be an object of string values.");
  }

  const headers: Record<string, string> = {};
  let totalBytes = 0;

  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim().toLowerCase();
    if (
      !name ||
      name.includes("\r") ||
      name.includes("\n") ||
      name.includes("\0") ||
      typeof rawValue !== "string" ||
      rawValue.includes("\r") ||
      rawValue.includes("\n") ||
      rawValue.includes("\0")
    ) {
      invalidManifest("headers contain an invalid name or value.");
    }

    headers[name] = rawValue;
    totalBytes += new TextEncoder().encode(name).byteLength;
    totalBytes += new TextEncoder().encode(rawValue).byteLength;
  }

  if (totalBytes > MAX_HEADER_BYTES) {
    invalidManifest(`headers exceed ${MAX_HEADER_BYTES} bytes.`);
  }

  return headers;
}

export function validateManifest(
  value: unknown,
  limits: ChunkLimits,
): ChunkManifest {
  if (!isRecord(value)) {
    invalidManifest("The manifest must be a JSON object.");
  }
  if (value.protocolVersion !== CHUNK_PROTOCOL_VERSION) {
    invalidManifest("protocolVersion must be 1.");
  }
  if (!isRecord(value.target)) {
    invalidManifest("target must be an object.");
  }
  if (value.target.method !== "POST") {
    invalidManifest("target.method must be POST.");
  }

  const path = validateTargetPath(value.target.path);
  if (
    typeof value.target.query !== "string" ||
    value.target.query.startsWith("?") ||
    value.target.query.includes("#") ||
    value.target.query.includes("\r") ||
    value.target.query.includes("\n")
  ) {
    invalidManifest("target.query must be an encoded query string without '?'.");
  }

  if (value.contentEncoding !== "gzip") {
    invalidManifest("contentEncoding must be gzip.");
  }
  if (
    typeof value.contentType !== "string" ||
    value.contentType.trim() === "" ||
    value.contentType.includes("\r") ||
    value.contentType.includes("\n")
  ) {
    invalidManifest("contentType must be a non-empty header value.");
  }

  const compressedBytes = positiveSafeInteger(
    value.compressedBytes,
    "compressedBytes",
  );
  const originalBytes = positiveSafeInteger(value.originalBytes, "originalBytes");
  const totalParts = positiveSafeInteger(value.totalParts, "totalParts");
  const partSize = positiveSafeInteger(value.partSize, "partSize");

  if (compressedBytes > limits.maxCompressedBytes) {
    throw new ChunkProtocolError(
      413,
      "compressed_payload_too_large",
      `The compressed request exceeds ${limits.maxCompressedBytes} bytes.`,
    );
  }
  if (originalBytes > limits.maxDecompressedBytes) {
    throw new ChunkProtocolError(
      413,
      "payload_too_large",
      `The decompressed request exceeds ${limits.maxDecompressedBytes} bytes.`,
    );
  }
  if (partSize > limits.maxPartBytes) {
    invalidManifest(`partSize must not exceed ${limits.maxPartBytes}.`);
  }
  if (totalParts > MAX_CHUNK_PARTS) {
    invalidManifest(`totalParts must not exceed ${MAX_CHUNK_PARTS}.`);
  }
  if (totalParts < Math.ceil(compressedBytes / limits.maxPartBytes)) {
    invalidManifest("totalParts cannot cover the compressed request within the part limit.");
  }
  if (totalParts > compressedBytes) {
    invalidManifest("totalParts cannot exceed compressedBytes.");
  }

  return {
    protocolVersion: 1,
    target: {
      method: "POST",
      path,
      query: value.target.query,
    },
    contentType: value.contentType,
    contentEncoding: "gzip",
    compressedBytes,
    compressedSha256: normalizeSha256(
      value.compressedSha256,
      "compressedSha256",
    ),
    originalBytes,
    originalSha256: normalizeSha256(value.originalSha256, "originalSha256"),
    totalParts,
    partSize,
    headers: validateHeaders(value.headers),
  };
}

export async function sha256Hex(
  value: Uint8Array | string,
): Promise<string> {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function concatParts(
  parts: Uint8Array<ArrayBuffer>[],
  totalBytes: number,
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

async function decompressGzip(
  compressed: Uint8Array<ArrayBuffer>,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Response(compressed).body?.pipeThrough(
    new DecompressionStream("gzip"),
  );
  if (!stream) {
    throw new ChunkProtocolError(400, "invalid_gzip", "The gzip body is invalid.");
  }

  const reader = stream.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ChunkProtocolError(
          413,
          "payload_too_large",
          `The decompressed request exceeds ${maxBytes} bytes.`,
        );
      }
      chunks.push(new Uint8Array(value));
    }
  } catch (error) {
    if (error instanceof ChunkProtocolError) {
      throw error;
    }
    throw new ChunkProtocolError(
      400,
      "invalid_gzip",
      "The gzip body is invalid.",
    );
  } finally {
    reader.releaseLock();
  }

  return concatParts(chunks, totalBytes);
}

export class ChunkSessionCore {
  constructor(
    private readonly storage: ProtocolStorage,
    private readonly limits: ChunkLimits,
    private readonly now: () => number = Date.now,
  ) {}

  async create(manifestValue: unknown): Promise<SessionRecord> {
    const manifest = validateManifest(manifestValue, this.limits);
    const record: SessionRecord = {
      manifest,
      expiresAt: this.now() + this.limits.sessionTtlMs,
    };
    await this.storage.put(SESSION_KEY, record);
    return record;
  }

  async putPart(
    index: number,
    dataValue: Uint8Array,
    suppliedSha256: string,
  ): Promise<PartUploadResult> {
    const record = await this.loadSession();
    const { manifest } = record;

    if (!Number.isInteger(index) || index < 0 || index >= manifest.totalParts) {
      throw new ChunkProtocolError(
        400,
        "invalid_manifest",
        "The part index is outside the session range.",
      );
    }
    if (dataValue.byteLength === 0) {
      throw new ChunkProtocolError(400, "invalid_chunk_hash", "A part cannot be empty.");
    }
    if (dataValue.byteLength > this.limits.maxPartBytes) {
      throw new ChunkProtocolError(
        413,
        "chunk_too_large",
        `A part cannot exceed ${this.limits.maxPartBytes} bytes.`,
      );
    }

    const normalizedSha = suppliedSha256.toLowerCase();
    if (!SHA256_PATTERN.test(normalizedSha)) {
      throw new ChunkProtocolError(
        400,
        "invalid_chunk_hash",
        "X-Chunk-SHA256 must contain exactly 64 hexadecimal characters.",
      );
    }
    const actualSha = await sha256Hex(dataValue);
    if (actualSha !== normalizedSha) {
      throw new ChunkProtocolError(
        400,
        "invalid_chunk_hash",
        "The part SHA-256 does not match its bytes.",
      );
    }

    const metadataKey = `part-meta:${index}`;
    const existing = await this.storage.get<PartMetadata>(metadataKey);
    if (existing) {
      if (existing.sha256 === actualSha && existing.bytes === dataValue.byteLength) {
        return {
          index,
          receivedParts: await this.countReceivedParts(manifest.totalParts),
          totalParts: manifest.totalParts,
          duplicate: true,
        };
      }
      throw new ChunkProtocolError(
        409,
        "chunk_conflict",
        "A different part is already stored at this index.",
      );
    }

    await this.storage.put<PartMetadata>(metadataKey, {
      sha256: actualSha,
      bytes: dataValue.byteLength,
    });
    await this.storage.put(`part:${index}`, new Uint8Array(dataValue));

    return {
      index,
      receivedParts: await this.countReceivedParts(manifest.totalParts),
      totalParts: manifest.totalParts,
      duplicate: false,
    };
  }

  async complete(): Promise<CompletedChunkRequest> {
    const record = await this.loadSession();
    const { manifest } = record;
    const metadata: (PartMetadata | undefined)[] = [];

    for (let index = 0; index < manifest.totalParts; index += 1) {
      metadata.push(
        await this.storage.get<PartMetadata>(`part-meta:${index}`),
      );
    }

    const missingIndexes = metadata
      .map((item, index) => (item ? -1 : index))
      .filter((index) => index >= 0);
    if (missingIndexes.length > 0) {
      throw new ChunkProtocolError(
        409,
        "missing_chunks",
        "The request is missing one or more parts.",
        { missingIndexes },
      );
    }

    const consumed: SessionRecord = {
      ...record,
      consumedAt: this.now(),
    };
    await this.storage.put(SESSION_KEY, consumed);

    const parts: Uint8Array<ArrayBuffer>[] = [];
    let compressedBytes = 0;

    for (let index = 0; index < manifest.totalParts; index += 1) {
      const stored = await this.storage.get<Uint8Array<ArrayBuffer>>(
        `part:${index}`,
      );
      if (!stored) {
        throw new ChunkProtocolError(
          409,
          "missing_chunks",
          "A stored part disappeared before completion.",
          { missingIndexes: [index] },
        );
      }

      const part = new Uint8Array(stored);
      const expected = metadata[index] as PartMetadata;
      if (
        part.byteLength !== expected.bytes ||
        (await sha256Hex(part)) !== expected.sha256
      ) {
        throw new ChunkProtocolError(
          400,
          "invalid_chunk_hash",
          `Part ${index} failed integrity verification.`,
        );
      }

      parts.push(part);
      compressedBytes += part.byteLength;
    }

    const compressed = concatParts(parts, compressedBytes);
    if (compressed.byteLength !== manifest.compressedBytes) {
      throw new ChunkProtocolError(
        400,
        "invalid_manifest",
        "The assembled compressed length does not match the manifest.",
      );
    }
    if ((await sha256Hex(compressed)) !== manifest.compressedSha256) {
      throw new ChunkProtocolError(
        400,
        "invalid_chunk_hash",
        "The assembled gzip SHA-256 does not match the manifest.",
      );
    }

    const body = await decompressGzip(
      compressed,
      this.limits.maxDecompressedBytes,
    );
    if (body.byteLength !== manifest.originalBytes) {
      throw new ChunkProtocolError(
        400,
        "invalid_manifest",
        "The decompressed length does not match the manifest.",
      );
    }
    if ((await sha256Hex(body)) !== manifest.originalSha256) {
      throw new ChunkProtocolError(
        400,
        "invalid_chunk_hash",
        "The decompressed SHA-256 does not match the manifest.",
      );
    }

    return { body, manifest };
  }

  async cleanup(): Promise<void> {
    const record = await this.storage.get<SessionRecord>(SESSION_KEY);
    if (!record) {
      return;
    }
    for (let index = 0; index < record.manifest.totalParts; index += 1) {
      await this.storage.delete(`part:${index}`);
      await this.storage.delete(`part-meta:${index}`);
    }
    await this.storage.delete(SESSION_KEY);
  }

  private async loadSession(): Promise<SessionRecord> {
    const record = await this.storage.get<SessionRecord>(SESSION_KEY);
    if (!record) {
      throw new ChunkProtocolError(
        404,
        "session_not_found",
        "The chunk session does not exist.",
      );
    }
    if (this.now() >= record.expiresAt) {
      throw new ChunkProtocolError(
        410,
        "session_expired",
        "The chunk session has expired.",
      );
    }
    if (record.consumedAt !== undefined) {
      throw new ChunkProtocolError(
        409,
        "session_consumed",
        "The chunk session has already been completed.",
      );
    }
    return record;
  }

  private async countReceivedParts(totalParts: number): Promise<number> {
    let received = 0;
    for (let index = 0; index < totalParts; index += 1) {
      if (await this.storage.get<PartMetadata>(`part-meta:${index}`)) {
        received += 1;
      }
    }
    return received;
  }
}
