# Cloudflare gzip relay design

## Goal

Provide a GitHub-ready Cloudflare Worker that accepts gzip-compressed HTTP requests, decodes them, forwards them to an OpenAI-compatible upstream, and streams the upstream response back to the caller.

## Architecture

The client sends an ordinary API request with `Content-Encoding: gzip`. A Cloudflare Worker authenticates the caller with `X-Proxy-Token`, decodes the request body, removes transport headers that no longer describe the body, replaces or preserves upstream authentication, and forwards the request to `UPSTREAM_BASE_URL`. The upstream response, including SSE, is returned as a stream.

The Worker does not require a custom domain. Cloudflare's free `workers.dev` hostname is sufficient, and a custom domain can be attached later.

## Request contract

- `GET /health` returns `{"ok":true}` without authentication.
- `OPTIONS` handles browser CORS preflight.
- Every other path is appended to `UPSTREAM_BASE_URL`.
- `X-Proxy-Token` authenticates callers and is never forwarded.
- `Content-Encoding: gzip` is decoded before forwarding.
- An uncompressed request body is forwarded unchanged.
- `Content-Length`, `Content-Encoding`, connection-level headers, and Cloudflare request metadata are not forwarded after decoding.
- `UPSTREAM_API_KEY`, when configured, becomes `Authorization: Bearer <key>`. Otherwise the incoming authorization header is preserved.
- Upstream responses are relayed without buffering so SSE remains streamable.

## Configuration

Cloudflare variables and secrets:

| Name | Required | Description |
| --- | --- | --- |
| `UPSTREAM_BASE_URL` | Yes | Absolute HTTP(S) base URL of the model service |
| `CLIENT_TOKEN` | Yes | Value expected in `X-Proxy-Token` |
| `UPSTREAM_API_KEY` | No | Upstream bearer token; recommended |
| `ALLOWED_ORIGIN` | No | Browser origin allowed by CORS; defaults to `*` |
| `MAX_DECOMPRESSED_BYTES` | No | Decoded body limit; defaults to 2 MiB |
| `UPSTREAM_TIMEOUT_MS` | No | Time allowed for upstream response headers; defaults to 10 minutes |

The Worker fails closed when required configuration is missing.

## Errors

- `400 invalid_gzip` for a malformed gzip body.
- `401 unauthorized` for a missing or incorrect proxy token.
- `413 payload_too_large` when the decoded body exceeds the configured limit.
- `415 unsupported_content_encoding` for encodings other than gzip.
- `500 configuration_error` for invalid or missing server configuration.
- `502 upstream_unreachable` when the upstream request fails.

Errors use JSON with an `error.code` and `error.message` object and include CORS headers.

## Security

- Secrets are stored in Cloudflare, never in the repository.
- The proxy token is required for every request except health and preflight.
- The upstream URL is operator-configured; callers cannot choose an arbitrary destination.
- Decoded bodies are capped to reduce decompression-bomb risk.
- Request authorization and prompts are not logged by the Worker.

## Testing

Tests use real `Request`, `Response`, gzip encoding, and stream bodies. Only the external upstream fetch is replaced. Coverage includes health, CORS, auth failure, gzip decoding, uncompressed forwarding, unsupported encoding, decoded-size limits, missing configuration, and streamed response pass-through.

Wrangler dry-run packaging and TypeScript checks verify Cloudflare deployment compatibility.
