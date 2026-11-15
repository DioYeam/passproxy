import { createServer } from "node:http";

const port = Number(process.env.LOCAL_UPSTREAM_PORT ?? 8790);

const server = createServer((request, response) => {
  const chunks = [];

  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    response.statusCode = 201;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        url: request.url,
        method: request.method,
        contentEncoding: request.headers["content-encoding"] ?? null,
        authorization: request.headers.authorization ?? null,
        proxyToken: request.headers["x-proxy-token"] ?? null,
        body: Buffer.concat(chunks).toString("utf8"),
      }),
    );
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Local upstream listening on http://127.0.0.1:${port}`);
});
