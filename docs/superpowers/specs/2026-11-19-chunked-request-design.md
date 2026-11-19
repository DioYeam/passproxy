# Chunked Request Protocol Design

## Goal

Allow a client-side bridge to split a large DeepSeek request into independently uploadable HTTP parts, each small enough for the 100 KB network limit. PassProxy reassembles the exact gzip byte stream, validates its integrity, decompresses it, and forwards one logical request to DeepSeek.

## Non-goals

- Do not change the existing direct request API.
- Do not transform OpenAI Chat Completions into another protocol.
- Do not hide compressed content from network inspection.
- Do not retry a completed upstream request automatically.

## Architecture

Each logical request is represented by a server-generated `requestId`. The Worker routes all operations for that ID to one Cloudflare Durable Object. The Durable Object stores the manifest and individual body parts in durable storage, so requests may arrive out of order and may be handled by different Worker instances.

The client compresses the complete request body once, splits the resulting gzip bytes, uploads the parts, and then calls `complete`. The Durable Object concatenates the parts, verifies hashes and lengths, decompresses the gzip stream, reconstructs the upstream request, and streams the DeepSeek response back through the `complete` HTTP response.

## Authentication

Every upload or completion endpoint requires the existing `X-Proxy-Token` header. The bridge is responsible for adding it.

The reconstructed upstream request uses `UPSTREAM_API_KEY`. Client authorization and chunk protocol headers are not forwarded.

## Endpoint 1: Create Session

```http
POST /__chunks/sessions
Content-Type: application/json
X-Proxy-Token: <CLIENT_TOKEN>
```

Request body:

```json
{
  "protocolVersion": 1,
  "target": {
    "method": "POST",
    "path": "/chat/completions",
    "query": ""
  },
  "contentType": "application/json",
  "contentEncoding": "gzip",
  "compressedBytes": 524288,
  "compressedSha256": "64 lowercase hex characters",
  "originalBytes": 1572864,
  "originalSha256": "64 lowercase hex characters",
  "totalParts": 8,
  "partSize": 65536,
  "headers": {
    "accept": "text/event-stream",
    "user-agent": "Trae bridge"
  }
}
```

The path is relative to `UPSTREAM_BASE_URL`. It must begin with `/` and must not point to a different origin.

Response:

```json
{
  "requestId": "server-generated UUID",
  "protocolVersion": 1,
  "expiresAt": "2026-11-19T12:30:00.000Z",
  "maxPartBytes": 98304
}
```

## Endpoint 2: Upload Part

```http
PUT /__chunks/sessions/{requestId}/parts/{index}
Content-Type: application/octet-stream
X-Proxy-Token: <CLIENT_TOKEN>
X-Chunk-SHA256: <SHA-256 of this part>
```

Part indexes are zero-based. The body contains raw bytes copied from the complete gzip stream. A part is not an independent gzip stream and must not use `Content-Encoding: gzip`.

Parts may be uploaded concurrently or out of order.

Success:

```json
{
  "requestId": "server-generated UUID",
  "index": 3,
  "receivedParts": 4,
  "totalParts": 8,
  "duplicate": false
}
```

Uploading the same index with the same SHA-256 is idempotent and returns `duplicate: true`. Uploading the same index with different content returns `409 chunk_conflict`.

## Endpoint 3: Complete Request

```http
POST /__chunks/sessions/{requestId}/complete
Content-Length: 0
X-Proxy-Token: <CLIENT_TOKEN>
```

The response is not wrapped. It preserves the upstream status, response headers, and body stream, including `text/event-stream`.

Before dispatch, the Durable Object verifies:

1. The session exists and has not expired.
2. The session has not already been consumed.
3. Every index from `0` to `totalParts - 1` exists.
4. Every part matches its uploaded SHA-256.
5. Concatenated compressed length matches `compressedBytes`.
6. Concatenated gzip SHA-256 matches `compressedSha256`.
7. The complete body decompresses successfully.
8. Decompressed length and SHA-256 match `originalBytes` and `originalSha256`.

The session is marked as consumed before contacting DeepSeek. A second completion attempt returns `409 session_consumed`, preventing duplicate model charges. The client must not automatically retry `complete` after sending it.

## Manifest Validation

- `protocolVersion` must equal `1`.
- `target.method` must be `POST`.
- `target.path` must begin with `/`, must not begin with `//`, and must not contain a scheme or host.
- `target.query` must be the query string without a leading `?`.
- `contentEncoding` must be `gzip`.
- Both SHA-256 values must be exactly 64 hexadecimal characters.
- `compressedBytes` and `originalBytes` must be positive safe integers.
- `totalParts` must be between `1` and `256`.
- `totalParts` must be enough for every part to remain within `maxPartBytes`.
- `partSize` must be between `1` and `maxPartBytes`.
- Header names and values must not contain CR, LF, or NUL.

## Limits

Default limits:

| Limit | Default |
| --- | ---: |
| Recommended client part size | 64 KiB |
| Maximum part size | 96 KiB |
| Maximum parts | 256 |
| Maximum compressed request | 8 MiB |
| Maximum decompressed request | 2 MiB |
| Session lifetime | 15 minutes |

The 96 KiB maximum leaves room for URL, chunk metadata, authentication headers, and TLS/TCP overhead under a 100 KB network limit.

## Error Model

Chunk protocol endpoints return JSON errors:

```json
{
  "error": {
    "code": "missing_chunks",
    "message": "The request is missing one or more parts.",
    "missingIndexes": [0, 2]
  }
}
```

Supported codes:

- `400 invalid_manifest`
- `400 invalid_chunk_hash`
- `400 invalid_gzip`
- `404 session_not_found`
- `409 chunk_conflict`
- `409 missing_chunks`
- `409 session_consumed`
- `410 session_expired`
- `413 chunk_too_large`
- `413 compressed_payload_too_large`
- `413 payload_too_large`
- `502 upstream_unreachable`
- `504 upstream_timeout`

## Storage and Cleanup

The Durable Object stores:

- The validated manifest.
- Each chunk as a separate storage value.
- The SHA-256 and byte length of each chunk.
- The session expiration and consumed timestamps.

Storage is deleted by a Durable Object alarm after expiration and after successful dispatch. No prompt or model body is retained after cleanup.

## Client Algorithm

The bridge performs these steps:

1. Read the complete client request body.
2. Compute the original byte length and SHA-256.
3. gzip the complete body once.
4. Compute the compressed byte length and SHA-256.
5. Split compressed bytes into parts no larger than 64 KiB.
6. Create the session.
7. Upload all parts, optionally with limited concurrency.
8. Call `complete` and stream its response directly back to Trae.

Python pseudocode:

```python
raw = request_body
compressed = gzip.compress(raw)
parts = [compressed[i:i + 65536] for i in range(0, len(compressed), 65536)]

manifest = {
    "protocolVersion": 1,
    "target": {"method": "POST", "path": "/chat/completions", "query": ""},
    "contentType": "application/json",
    "contentEncoding": "gzip",
    "compressedBytes": len(compressed),
    "compressedSha256": sha256(compressed).hexdigest(),
    "originalBytes": len(raw),
    "originalSha256": sha256(raw).hexdigest(),
    "totalParts": len(parts),
    "partSize": 65536,
    "headers": forward_headers,
}
```

## Testing

- Manifest validation rejects malformed paths, hashes, counts, and limits.
- A single-part request round-trips correctly.
- Multiple parts upload out of order and assemble in index order.
- Duplicate identical parts are idempotent.
- Conflicting duplicate parts return `409`.
- Missing parts are reported with exact indexes.
- Corrupt part, assembled gzip, and decompressed hashes are rejected.
- Oversized parts and oversized compressed/decompressed bodies are rejected.
- A complete request is forwarded exactly once.
- SSE response streaming remains intact.
- Expired and consumed sessions reject further use.
- Existing direct gzip and uncompressed request tests continue to pass.
