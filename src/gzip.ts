export class UnsupportedContentEncodingError extends Error {
  constructor(contentEncoding: string) {
    super(`Unsupported content encoding: ${contentEncoding}.`);
    this.name = "UnsupportedContentEncodingError";
  }
}

export class InvalidGzipError extends Error {
  constructor() {
    super("The request body is not valid gzip data.");
    this.name = "InvalidGzipError";
  }
}

export class PayloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`The decoded request body exceeds ${maxBytes} bytes.`);
    this.name = "PayloadTooLargeError";
  }
}

function concatenate(
  chunks: Uint8Array<ArrayBuffer>[],
  totalBytes: number,
): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}

async function readLimitedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
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
        throw new PayloadTooLargeError(maxBytes);
      }

      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }

  return concatenate(chunks, totalBytes);
}

export async function decodeRequestBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (request.body === null || request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  const contentEncoding = request.headers
    .get("content-encoding")
    ?.trim()
    .toLowerCase();

  if (!contentEncoding || contentEncoding === "identity") {
    return readLimitedStream(request.body, maxBytes);
  }

  if (contentEncoding !== "gzip" && contentEncoding !== "x-gzip") {
    throw new UnsupportedContentEncodingError(contentEncoding);
  }

  const compressed = new Uint8Array(await request.arrayBuffer());
  const decodedStream = new Response(compressed).body?.pipeThrough(
    new DecompressionStream("gzip"),
  );

  if (!decodedStream) {
    throw new InvalidGzipError();
  }

  try {
    return await readLimitedStream(decodedStream, maxBytes);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      throw error;
    }
    throw new InvalidGzipError();
  }
}
