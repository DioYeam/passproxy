# Chunked Request Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a durable HTTP chunk-upload protocol that reconstructs and forwards one validated model request.

**Architecture:** Worker routes create/upload/complete operations to a Durable Object keyed by request ID. A testable protocol core validates manifests and assembles persisted parts; the existing direct relay remains available.

**Tech Stack:** TypeScript, Cloudflare Workers, Durable Objects, Vitest, Wrangler.

## Global Constraints

- Protocol version is `1`.
- The client gzips one complete body and splits raw gzip bytes.
- Each chunk request remains below 100 KB in practice; recommended size is 64 KiB and the server maximum is 96 KiB.
- Maximum part count is 256.
- Compressed request default maximum is 8 MiB.
- Decompressed request default maximum is 2 MiB.
- Session lifetime is 15 minutes.
- `complete` dispatches upstream at most once.
- Existing direct requests remain compatible.

---

### Task 1: Write protocol tests

**Files:**
- Create: `tests/chunk-protocol.test.ts`
- Create: `tests/chunk-routes.test.ts`

**Interfaces:**
- Consumes: `validateManifest`, `ChunkSessionStore`, `handleRequest`.
- Produces: failing tests for manifest validation, idempotent parts, out-of-order assembly, missing/corrupt parts, route dispatch, and streaming completion.

- [x] **Step 1: Test manifest validation**

Use literal manifests and assert accepted/rejected outcomes for path, hash, part count, header, and size rules.

- [x] **Step 2: Test chunk assembly**

Create a gzip body split into three parts, upload parts in order `2, 0, 1`, and assert exact bytes and SHA-256 match.

- [x] **Step 3: Test conflicts and missing indexes**

Assert same-index/same-hash idempotency, same-index/different-hash conflict, and exact missing index reporting.

- [x] **Step 4: Test route dispatch**

Use a fake Durable Object namespace and assert start, part, and complete routes reach the same request ID namespace object.

- [x] **Step 5: Verify RED**

Run:

```powershell
npm test -- tests/chunk-protocol.test.ts tests/chunk-routes.test.ts
```

Expected: failure because protocol modules do not exist.

### Task 2: Implement protocol core and Durable Object storage adapter

**Files:**
- Create: `src/chunk-protocol.ts`
- Create: `src/chunk-session.ts`
- Modify: `src/config.ts`
- Modify: `wrangler.jsonc`
- Test: `tests/chunk-protocol.test.ts`

**Interfaces:**
- Consumes: manifest and raw gzip parts.
- Produces: `validateManifest`, `ChunkSessionCore`, `ChunkSession`, and runtime chunk limit configuration.

- [x] **Step 1: Implement validation and hashing**

Validate every manifest field and calculate SHA-256 with `crypto.subtle`.

- [x] **Step 2: Implement persisted session logic**

Store manifest, part bytes, part hashes, session status, and expiration through Durable Object storage.

- [x] **Step 3: Implement assembly**

Read all parts by index, concatenate compressed bytes, verify both lengths and both SHA-256 values, decompress, and verify the original body.

- [x] **Step 4: Implement expiry cleanup**

Use a Durable Object alarm to delete all stored values after 15 minutes.

- [x] **Step 5: Run green tests and type check**

```powershell
npm test -- tests/chunk-protocol.test.ts
npm run typecheck
```

Expected: all protocol tests pass and TypeScript exits successfully.

### Task 3: Route and complete chunk requests

**Files:**
- Create: `src/upstream.ts`
- Modify: `src/proxy.ts`
- Modify: `src/index.ts`
- Test: `tests/chunk-routes.test.ts`
- Test: `tests/proxy.test.ts`

**Interfaces:**
- Consumes: authenticated Worker request and `CHUNK_SESSIONS` Durable Object namespace.
- Produces: chunk routes plus `ChunkSession.complete()` that returns the upstream response stream.

- [x] **Step 1: Implement Durable Object route dispatch**

Route `POST /__chunks/sessions`, `PUT /__chunks/sessions/{id}/parts/{index}`, and `POST /__chunks/sessions/{id}/complete`.

- [x] **Step 2: Reuse authenticated upstream forwarding**

Extract the existing direct upstream request construction so both direct and chunk-completed requests share method, path, headers, timeout, and auth behavior.

- [x] **Step 3: Enforce single dispatch**

Persist the consumed marker before the upstream fetch and return `409 session_consumed` for later calls.

- [x] **Step 4: Stream final response**

Return the upstream body without buffering and preserve SSE content type.

- [x] **Step 5: Run route and regression tests**

```powershell
npm test -- tests/chunk-routes.test.ts tests/proxy.test.ts
```

Expected: chunk route tests and all existing direct relay tests pass.

### Task 4: Add client example and end-to-end verification

**Files:**
- Create: `scripts/chunked-client.mjs`
- Create: `docs/chunked-upload-protocol.md`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: deployed `workers.dev` URL, `CLIENT_TOKEN`, JSON request body.
- Produces: executable reference client and client-facing protocol documentation.

- [x] **Step 1: Implement reference client**

Read a JSON file, gzip once, compute both hashes, split gzip bytes, create a session, upload parts with configurable concurrency, and complete the request.

- [x] **Step 2: Document exact client changes**

Include request/response examples, headers, hash rules, error recovery, and a Python pseudocode example.

- [x] **Step 3: Add a chunk smoke script**

Wrap the reference client so it can be run with `npm run smoke:chunks`.

- [x] **Step 4: Test actual Durable Object behavior**

Start the local upstream and Wrangler Worker, run the reference client with a request body larger than 100 KB, and verify the upstream receives the exact original JSON once.

### Task 5: Verify, commit, and push

**Files:**
- Verify: all files.

**Interfaces:**
- Consumes: complete implementation.
- Produces: fresh tests, type check, Wrangler package proof, clean diff, and GitHub commit.

- [x] **Step 1: Run full verification**

```powershell
npm run check
```

Expected: TypeScript, all tests, and Wrangler dry-run packaging pass.

- [x] **Step 2: Check the diff**

```powershell
git diff --check
git status --short
```

Expected: only intended chunk-protocol files are changed.

- [x] **Step 3: Commit and push**

```powershell
git add .
git commit -m "feat: add durable chunked upload protocol"
git push
```
