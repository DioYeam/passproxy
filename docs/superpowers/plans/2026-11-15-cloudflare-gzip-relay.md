# Cloudflare gzip relay implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a GitHub-ready Cloudflare Worker gzip relay with dashboard deployment instructions.

**Architecture:** A small TypeScript Worker separates configuration, gzip decoding, and HTTP proxy behavior. External upstream calls are injected in tests, while all request parsing and response streaming behavior uses the real Fetch API.

**Tech Stack:** TypeScript, Cloudflare Workers, Wrangler, Vitest, GitHub Actions.

## Global Constraints

- Deployment must work on Cloudflare's free `workers.dev` hostname.
- No domain names, upstream URLs, or API keys are committed.
- Required configuration fails closed.
- Request bodies are limited after decompression.
- Upstream responses must remain streamable.

---

### Task 1: Define behavior with failing tests

**Files:**
- Create: `tests/proxy.test.ts`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

**Interfaces:**
- Consumes: `handleRequest(request: Request, env: Env, dependencies?: { fetch?: (request: Request) => Promise<Response> }): Promise<Response>`.
- Produces: A failing contract for health, preflight, auth, gzip decoding, header sanitation, limits, configuration errors, and SSE pass-through.

- [x] **Step 1: Write the tests**

Create the test contract in `tests/proxy.test.ts` using real `Request`, `Response`, `gzipSync`, and `ReadableStream` objects.

- [x] **Step 2: Run the tests to verify RED**

Run:

```powershell
npm test -- tests/proxy.test.ts
```

Expected: failure because `src/config.ts` and `src/proxy.ts` do not exist.

- [x] **Step 3: Commit the failing contract**

```powershell
git add package.json tsconfig.json vitest.config.ts tests/proxy.test.ts
git commit -m "test: define gzip relay behavior"
```

### Task 2: Implement configuration and request decoding

**Files:**
- Create: `src/config.ts`
- Create: `src/gzip.ts`
- Test: `tests/proxy.test.ts`

**Interfaces:**
- Consumes: Cloudflare environment strings.
- Produces: `readConfig(env): RuntimeConfig`, `decodeRequestBody(request, maxBytes): Promise<DecodedBody>`, and typed configuration/decode errors.

- [x] **Step 1: Implement configuration parsing**

Parse and validate `UPSTREAM_BASE_URL`, `CLIENT_TOKEN`, optional `UPSTREAM_API_KEY`, `ALLOWED_ORIGIN`, `MAX_DECOMPRESSED_BYTES`, and `UPSTREAM_TIMEOUT_MS`. Throw `ConfigurationError` for missing or malformed required values.

- [x] **Step 2: Implement gzip decoding**

Return the original request body when no content encoding exists. Decode `gzip` and `x-gzip` with `DecompressionStream`. Reject other encodings and decoded bodies above the configured byte limit.

- [x] **Step 3: Run the focused tests**

```powershell
npm test -- tests/proxy.test.ts
```

Expected: tests still fail because the request handler is not implemented.

### Task 3: Implement the proxy handler and Worker entrypoint

**Files:**
- Create: `src/proxy.ts`
- Create: `src/index.ts`
- Test: `tests/proxy.test.ts`

**Interfaces:**
- Consumes: `readConfig`, `decodeRequestBody`, injected upstream fetch.
- Produces: `handleRequest(...)` and a default Cloudflare Worker `fetch` handler.

- [x] **Step 1: Implement health and preflight**

Return `{"ok":true}` for `/health` and a `204` response with configured CORS headers for `OPTIONS`.

- [x] **Step 2: Implement authentication and forwarding**

Compare `X-Proxy-Token` with `CLIENT_TOKEN`, combine the incoming path/query with `UPSTREAM_BASE_URL`, sanitize headers, inject `UPSTREAM_API_KEY`, and call the upstream fetch.

- [x] **Step 3: Implement response streaming and errors**

Relay the upstream body directly, add CORS headers, and map configuration, gzip, authorization, size, encoding, and network failures to JSON errors.

- [x] **Step 4: Run tests and type checks to verify GREEN**

```powershell
npm test -- tests/proxy.test.ts
npm run typecheck
```

Expected: all tests pass and TypeScript exits successfully.

### Task 4: Add deployment configuration and documentation

**Files:**
- Create: `wrangler.jsonc`
- Create: `.dev.vars.example`
- Create: `.github/workflows/ci.yml`
- Create: `scripts/smoke-test.mjs`
- Create: `README.md`
- Create: `LICENSE`

**Interfaces:**
- Consumes: Worker entrypoint and environment names from earlier tasks.
- Produces: Cloudflare Workers Builds configuration, CI verification, smoke-test command, and setup instructions.

- [x] **Step 1: Add Wrangler configuration**

Set the Worker name, `src/index.ts` entrypoint, compatibility date, free `workers.dev` routing, observability, and non-secret defaults.

- [x] **Step 2: Add CI and smoke testing**

Run `npm ci`, `npm run check` in GitHub Actions. The smoke script gzips JSON and sends it to a deployed Worker using environment variables.

- [x] **Step 3: Document dashboard deployment**

Explain connecting the GitHub repository, build and deploy commands, variables, secrets, `workers.dev`, request format, and troubleshooting.

### Task 5: Verify the complete repository

**Files:**
- Verify: all created files

**Interfaces:**
- Consumes: complete implementation.
- Produces: fresh evidence that tests, type checking, and Wrangler packaging work.

- [x] **Step 1: Run the full verification**

```powershell
npm run check
```

Expected: type checking passes, all Vitest tests pass, and Wrangler completes its dry-run deployment build.

- [x] **Step 2: Review the final diff**

```powershell
git status --short
git diff --check
```

Expected: only intended files are present and no whitespace errors are reported.
