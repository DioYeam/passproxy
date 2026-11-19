# PassProxy 分片上传协议

本文档用于修改 Trae 前面的桥或其他客户端，使大请求拆成多个小于网关限制的 HTTP 请求，再由 PassProxy 合并为一个完整请求发送给 DeepSeek。

当前协议版本：

```text
protocolVersion = 1
```

## 1. 使用条件

- PassProxy 已配置 `CLIENT_TOKEN`、`UPSTREAM_BASE_URL` 和 `UPSTREAM_API_KEY`。
- 客户端能够访问 PassProxy 的 `workers.dev` 地址或桥转发地址。
- 原始请求体是完整 JSON 字节。
- 模型接口使用 OpenAI Chat Completions，例如 `/v1/chat/completions`。
- 客户端能够缓存完整请求体，并对 gzip 数据做分片。

## 2. 核心原则

客户端必须先对**完整请求体 gzip 一次**，再切分 gzip 字节：

```text
原始 JSON
→ 完整 gzip
→ 按 64 KiB 切成 N 片
→ N 个独立的 PUT 请求
```

不要对每个分片单独 gzip。单独分片不是合法 gzip 文件，PassProxy 会按索引拼回完整 gzip 数据后再解压。

请求链路：

```text
Trae
→ 桥读取完整请求体
→ gzip 一次
→ 创建分片会话
→ 并发或乱序上传分片
→ 调用 complete
→ PassProxy 拼接、校验、解压
→ DeepSeek
→ PassProxy 流式返回 DeepSeek 响应
→ Trae
```

## 3. 鉴权

所有分片协议请求都必须携带：

```http
X-Proxy-Token: <CLIENT_TOKEN>
```

不要把 DeepSeek API Key 放进桥。PassProxy 会使用 Cloudflare 中配置的 `UPSTREAM_API_KEY` 请求 DeepSeek。

## 4. 创建会话

```http
POST /__chunks/sessions
Content-Type: application/json
X-Proxy-Token: <CLIENT_TOKEN>
```

请求体：

```json
{
  "protocolVersion": 1,
  "target": {
    "method": "POST",
    "path": "/v1/chat/completions",
    "query": ""
  },
  "contentType": "application/json",
  "contentEncoding": "gzip",
  "compressedBytes": 524288,
  "compressedSha256": "<完整 gzip 数据的 SHA-256，小写十六进制>",
  "originalBytes": 1572864,
  "originalSha256": "<原始 JSON 的 SHA-256，小写十六进制>",
  "totalParts": 8,
  "partSize": 65536,
  "headers": {
    "accept": "text/event-stream",
    "user-agent": "Trae bridge"
  }
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `target.method` | 当前协议固定为 `POST` |
| `target.path` | DeepSeek 路径，必须以 `/` 开头，例如 `/v1/chat/completions` |
| `target.query` | 查询字符串，不带开头的 `?` |
| `contentType` | 原始请求内容类型，通常是 `application/json` |
| `contentEncoding` | 固定为 `gzip` |
| `compressedBytes` | gzip 后的总字节数 |
| `compressedSha256` | 完整 gzip 数据的 SHA-256 |
| `originalBytes` | 未压缩 JSON 的总字节数 |
| `originalSha256` | 未压缩 JSON 的 SHA-256 |
| `totalParts` | 分片总数 |
| `partSize` | 客户端分片大小，建议 `65536` |
| `headers` | 需要转给 DeepSeek 的业务请求头 |

路径兼容规则：

- `/v1/chat/completions` 是默认推荐路径，兼容 OpenAI Chat Completions。
- `/chat/completions` 仍然支持，已有的桥不需要立即修改。
- 如果 `UPSTREAM_BASE_URL` 已经包含 `/v1`，则 `target.path` 应使用 `/chat/completions`，避免拼出 `/v1/v1/chat/completions`。

不要放入 `headers`：

```text
Authorization
Content-Length
Content-Encoding
Host
X-Proxy-Token
Connection
Transfer-Encoding
```

返回：

```json
{
  "requestId": "4a759eb8-2fc2-4f2e-b71f-b640fbf96479",
  "protocolVersion": 1,
  "expiresAt": "2026-11-19T12:30:00.000Z",
  "maxPartBytes": 98304
}
```

## 5. 上传分片

索引从 `0` 开始：

```http
PUT /__chunks/sessions/{requestId}/parts/{index}
Content-Type: application/octet-stream
X-Proxy-Token: <CLIENT_TOKEN>
X-Chunk-SHA256: <当前分片的 SHA-256>
```

请求体必须是完整 gzip 字节流中的原始片段。

成功返回：

```json
{
  "requestId": "4a759eb8-2fc2-4f2e-b71f-b640fbf96479",
  "index": 3,
  "receivedParts": 4,
  "totalParts": 8,
  "duplicate": false
}
```

规则：

- 分片可以乱序上传。
- 分片可以有限并发上传。
- 同一索引、同一内容重复上传是幂等操作，返回 `duplicate: true`。
- 同一索引上传不同内容返回 `409 chunk_conflict`。
- 分片为空或超过 `maxPartBytes` 会被拒绝。

## 6. 完成请求

所有分片上传完成后：

```http
POST /__chunks/sessions/{requestId}/complete
Content-Length: 0
X-Proxy-Token: <CLIENT_TOKEN>
```

`complete` 的响应就是 DeepSeek 的原始响应：

- 不包装成额外 JSON。
- 保留 DeepSeek 状态码。
- 保留普通 JSON 响应。
- `stream: true` 时保留 `text/event-stream`。
- 不要把响应完整读入内存后再返回给 Trae，否则流式输出会退化。

PassProxy 会在调用 DeepSeek 前验证：

1. 所有分片是否齐全。
2. 每个分片的 SHA-256。
3. gzip 总长度和 SHA-256。
4. gzip 能否解压。
5. 原始 JSON 长度和 SHA-256。

检查通过后，PassProxy 只向 DeepSeek 发送一次请求。

## 7. 客户端算法

伪代码：

```python
raw = request_body_bytes
compressed = gzip.compress(raw, compresslevel=9)

original_sha = sha256(raw).hexdigest()
compressed_sha = sha256(compressed).hexdigest()

part_size = 64 * 1024
parts = [
    compressed[offset:offset + part_size]
    for offset in range(0, len(compressed), part_size)
]

manifest = {
    "protocolVersion": 1,
    "target": {
        "method": "POST",
        "path": "/v1/chat/completions",
        "query": ""
    },
    "contentType": "application/json",
    "contentEncoding": "gzip",
    "compressedBytes": len(compressed),
    "compressedSha256": compressed_sha,
    "originalBytes": len(raw),
    "originalSha256": original_sha,
    "totalParts": len(parts),
    "partSize": part_size,
    "headers": {
        "accept": "text/event-stream"
    }
}

session = post_json(
    f"{worker_url}/__chunks/sessions",
    headers={"X-Proxy-Token": client_token},
    json=manifest
)

request_id = session["requestId"]

for index, part in enumerate(parts):
    response = requests.put(
        f"{worker_url}/__chunks/sessions/{request_id}/parts/{index}",
        headers={
            "X-Proxy-Token": client_token,
            "X-Chunk-SHA256": sha256(part).hexdigest(),
            "Content-Type": "application/octet-stream"
        },
        data=part
    )
    response.raise_for_status()

upstream_response = requests.post(
    f"{worker_url}/__chunks/sessions/{request_id}/complete",
    headers={
        "X-Proxy-Token": client_token,
        "Content-Length": "0"
    },
    stream=True
)
```

`upstream_response` 应直接流式转回 Trae。

## 8. 参考 Node.js 客户端

仓库中的 [`scripts/chunked-client.mjs`](../scripts/chunked-client.mjs) 已经实现完整流程。

从 JSON 文件发送：

```powershell
$env:WORKER_URL = "https://passproxy.1424286521a.workers.dev"
$env:CLIENT_TOKEN = "<CLIENT_TOKEN>"

npm run smoke:chunks -- `
  --body-file body.json `
  --target-path /v1/chat/completions `
  --part-size 65536 `
  --concurrency 3
```

也可以直接指定参数：

```powershell
npm run smoke:chunks -- `
  --worker-url https://passproxy.1424286521a.workers.dev `
  --token <CLIENT_TOKEN> `
  --body-file body.json `
  --target-path /v1/chat/completions `
  --part-size 65536 `
  --concurrency 3
```

需要额外转发业务头时：

```powershell
npm run smoke:chunks -- `
  --body-file body.json `
  --header "user-agent=Trae bridge" `
  --header "accept=text/event-stream"
```

脚本支持 `HTTPS_PROXY` / `HTTP_PROXY`，适合必须经过本地代理访问 `workers.dev` 的环境。

## 9. 默认限制

| 限制 | 默认值 |
| --- | ---: |
| 推荐分片大小 | 64 KiB |
| 服务端最大分片 | 96 KiB |
| 最大分片数 | 256 |
| 最大 gzip 请求体 | 8 MiB |
| 最大解压请求体 | 2 MiB |
| 会话有效期 | 15 分钟 |

64 KiB 分片为 URL、HTTP 头和 TLS/TCP 开销预留了空间，通常可以保证整个分片 HTTP 请求小于 100 KB。

## 10. 错误和重试

错误响应格式：

```json
{
  "error": {
    "code": "missing_chunks",
    "message": "The request is missing one or more parts.",
    "missingIndexes": [0, 2]
  }
}
```

| 状态码 | 代码 | 处理方式 |
| ---: | --- | --- |
| 400 | `invalid_manifest` | 修正清单，重新创建会话 |
| 400 | `invalid_chunk_hash` | 重新计算分片哈希并上传 |
| 400 | `invalid_gzip` | 检查是否对完整请求体只 gzip 一次 |
| 404 | `session_not_found` | 重新创建会话 |
| 409 | `chunk_conflict` | 同一索引被上传了不同内容，重新创建会话 |
| 409 | `missing_chunks` | 根据 `missingIndexes` 补传 |
| 409 | `session_consumed` | 该会话已调用过 DeepSeek，不要自动重新发送 |
| 410 | `session_expired` | 重新创建会话 |
| 413 | `chunk_too_large` | 减小分片 |
| 413 | `compressed_payload_too_large` | 减小原始请求或调整限额 |
| 413 | `payload_too_large` | 减少上下文或调整限额 |

重试规则：

- 上传分片可以安全重试。
- 相同索引、相同内容重试是幂等的。
- `complete` 发出后如果连接中断，不要自动重试，因为 DeepSeek 可能已经开始计费。
- 会话过期后必须从创建会话重新开始。

## 11. Trae 桥的接入位置

桥应拦截原本发往 PassProxy 或 DeepSeek 的 OpenAI Chat Completions 请求：

1. 保存原始 HTTP method、path、query 和业务 headers。
2. 读取完整 JSON 请求体。
3. 执行本文档的 gzip 和分片流程。
4. 把 `complete` 的响应状态、响应头和响应体直接流回 Trae。

Trae 自定义模型配置中的请求地址应指向桥，不需要知道分片协议。

## 12. 安全说明

- 分片协议不会降低内容可审计性。
- `CLIENT_TOKEN` 只放在请求头中，不要放到 URL。
- 会话数据仅临时保存在 Durable Object，过期或完成后清理。
- 请求头由清单显式传入，PassProxy 会移除内部协议头和代理令牌。
