import { gzipSync } from "node:zlib";

const workerUrl = process.argv[2] ?? process.env.WORKER_URL;
const proxyToken = process.env.CLIENT_TOKEN;
const proxyPath = process.env.PROXY_PATH ?? "/v1/chat/completions";

if (!workerUrl) {
  console.error(
    "Usage: WORKER_URL=https://name.subdomain.workers.dev CLIENT_TOKEN=... npm run smoke",
  );
  process.exit(2);
}

if (!proxyToken) {
  console.error("CLIENT_TOKEN is required.");
  process.exit(2);
}

const payload =
  process.env.REQUEST_JSON ??
  JSON.stringify({
    model: "your-model",
    messages: [{ role: "user", content: "Reply with OK." }],
    stream: false,
  });

const baseUrl = workerUrl.endsWith("/") ? workerUrl : `${workerUrl}/`;
const endpoint = new URL(proxyPath.replace(/^\/+/, ""), baseUrl);
const compressed = gzipSync(Buffer.from(payload, "utf8"));

console.log(
  `POST ${endpoint.toString()} (${Buffer.byteLength(payload)} bytes -> ${compressed.byteLength} bytes gzip)`,
);

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "content-encoding": "gzip",
    "x-proxy-token": proxyToken,
  },
  body: compressed,
});

const responseBody = await response.text();
console.log(`HTTP ${response.status} ${response.statusText}`);
console.log(responseBody);

if (!response.ok) {
  process.exit(1);
}
