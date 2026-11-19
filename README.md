# PassProxy

## 大请求分片上传

PassProxy 支持超过网关单请求限制的分片上传协议。桥先对整个 JSON 做一次 gzip，再按 64 KiB 上传分片；Durable Object 汇总所有分片，校验长度和 SHA-256，解压后只向 DeepSeek 发送一次请求。

完整客户端协议、请求示例、错误处理和 Python 伪代码：

[分片上传协议](docs/chunked-upload-protocol.md)

参考客户端：

```powershell
npm run smoke:chunks -- `
  --worker-url https://passproxy.<你的Cloudflare子域名>.workers.dev `
  --token <CLIENT_TOKEN> `
  --body-file body.json `
  --target-path /v1/chat/completions
```

主要限制：

- 推荐分片：64 KiB。
- 单分片最大：96 KiB。
- 最大分片数：256。
- gzip 请求体最大：8 MiB。
- 解压请求体默认最大：2 MiB。
- 会话有效期：15 分钟。

原有直传 gzip 接口保持兼容，分片协议只在 `/__chunks/sessions` 路径下生效。

一个可直接关联 Cloudflare Dashboard 的 gzip 请求中转 Worker。

它接收带 `Content-Encoding: gzip` 的 HTTP 请求，在 Cloudflare 边缘解压后转发给 OpenAI 兼容的大模型服务，并把上游响应（包括 SSE 流）直接返回给调用方。

```text
调用方
  ↓ Content-Encoding: gzip
Cloudflare Worker
  ↓ 解压后转发
上游大模型 API
```

不需要自备域名。Cloudflare 免费提供 `*.workers.dev` 地址和 HTTPS。

## 功能

- 解码 `gzip` / `x-gzip` 请求体。
- 支持普通未压缩请求。
- 转发路径、查询参数、请求方法和业务请求头。
- 移除不再成立的 `Content-Encoding`、`Content-Length` 等传输头。
- 使用 `X-Proxy-Token` 鉴权，避免中转地址被公开滥用。
- 用 `UPSTREAM_API_KEY` 隐藏上游 API Key。
- 流式返回大模型 SSE 响应，不完整缓冲。
- 解码后请求体大小限制，降低压缩炸弹风险。
- `GET /health` 健康检查。
- CORS 预检和可配置允许来源。

## 工作目录

```text
src/config.ts      环境变量验证
src/gzip.ts        gzip 解压与大小限制
src/proxy.ts       鉴权、转发、CORS、错误处理
src/index.ts       Cloudflare Worker 入口
tests/             行为测试
scripts/           部署后冒烟测试
```

## 本地验证

需要 Node.js 22 或更高版本。

```powershell
npm install
npm run check
```

`npm run check` 会依次运行：

1. TypeScript 类型检查。
2. Vitest 测试。
3. Wrangler 本地打包检查。

本地启动：

```powershell
Copy-Item .dev.vars.example .dev.vars
```

编辑 `.dev.vars`，填入真实的上游地址和密钥。`.dev.vars` 已加入 `.gitignore`，不要提交。

然后运行：

```powershell
npm run dev
```

如果要完全本地验证，可以另开一个终端启动回显上游：

```powershell
npm run dev:upstream
```

然后把 `.dev.vars` 中的地址改成：

```text
UPSTREAM_BASE_URL=http://127.0.0.1:8790
CLIENT_TOKEN=test-token
UPSTREAM_API_KEY=test-upstream-key
```

在本项目目录运行 `npm run smoke` 即可检查实际的 gzip 解压和转发流程。

## Cloudflare Dashboard 部署

### 1. 推送到 GitHub

在 GitHub 创建一个空仓库，然后在本目录执行：

```powershell
git remote add origin https://github.com/<你的账号>/<仓库名>.git
git push -u origin main
```

### 2. 关联 Cloudflare Worker

1. 打开 Cloudflare Dashboard，进入 `Workers & Pages`。
2. 选择创建 Worker，然后选择连接 Git 仓库。
3. 选择刚才的 GitHub 仓库和 `main` 分支。
4. 构建命令填写：

```text
npm run check
```

5. 部署命令填写：

```text
npm run deploy
```

6. 保存并部署。

仓库中的 `wrangler.jsonc` 已启用 `workers_dev`，部署后可在 Worker 的 `Settings > Domains & Routes` 中看到类似地址：

```text
https://passproxy.<你的Cloudflare子域名>.workers.dev
```

### 3. 配置变量和密钥

进入 Worker 的 `Settings > Variables and Secrets`，添加：

| 名称 | 类型 | 必填 | 示例 |
| --- | --- | --- | --- |
| `UPSTREAM_BASE_URL` | 变量 | 是 | `https://api.example.com` |
| `CLIENT_TOKEN` | Secret | 是 | 一段足够长的随机字符串 |
| `UPSTREAM_API_KEY` | Secret | 推荐 | 上游大模型 API Key |
| `ALLOWED_ORIGIN` | 变量 | 否 | `https://your-app.example.com` |
| `MAX_DECOMPRESSED_BYTES` | 变量 | 否 | `2097152` |
| `UPSTREAM_TIMEOUT_MS` | 变量 | 否 | `600000` |

`UPSTREAM_BASE_URL` 可以带路径。例如：

```text
https://api.example.com/openai
```

请求 `/v1/chat/completions` 时会转发到：

```text
https://api.example.com/openai/v1/chat/completions
```

如果配置了 `UPSTREAM_API_KEY`，Worker 会发送：

```http
Authorization: Bearer <UPSTREAM_API_KEY>
```

如果没有配置它，Worker 会保留调用方传入的 `Authorization` 请求头。

### 4. 检查服务

```powershell
curl.exe https://passproxy.<你的Cloudflare子域名>.workers.dev/health
```

预期返回：

```json
{"ok":true}
```

## 发送 gzip 请求

### PowerShell

```powershell
$url = "https://passproxy.<你的Cloudflare子域名>.workers.dev/v1/chat/completions"
$token = "<CLIENT_TOKEN>"

$json = @{
  model = "your-model"
  messages = @(
    @{
      role = "user"
      content = "Reply with OK."
    }
  )
  stream = $false
} | ConvertTo-Json -Depth 10 -Compress

[IO.File]::WriteAllText("$PWD\body.json", $json, [Text.UTF8Encoding]::new($false))

$source = [IO.File]::OpenRead("$PWD\body.json")
$target = [IO.File]::Create("$PWD\body.json.gz")
$gzip = [IO.Compression.GZipStream]::new(
  $target,
  [IO.Compression.CompressionLevel]::Fastest
)

try {
  $source.CopyTo($gzip)
} finally {
  $gzip.Dispose()
  $source.Dispose()
}

curl.exe -X POST $url `
  -H "Content-Type: application/json" `
  -H "Content-Encoding: gzip" `
  -H "X-Proxy-Token: $token" `
  --data-binary "@$PWD\body.json.gz"
```

### Node.js 冒烟脚本

```powershell
$env:WORKER_URL = "https://passproxy.<你的Cloudflare子域名>.workers.dev"
$env:CLIENT_TOKEN = "<CLIENT_TOKEN>"

# 按实际上游接口修改
$env:REQUEST_JSON = '{"model":"your-model","messages":[{"role":"user","content":"Reply with OK."}]}'

npm run smoke
```

如果需要流式输出，在 JSON 中加入 `"stream": true`。Worker 会直接透传上游的 SSE 数据。

## 免费版限制

Cloudflare Workers 免费版当前主要限制：

- 每天 100,000 次请求。
- 每次请求约 10ms CPU 时间。
- 每个 isolate 128MB 内存。
- 进入 Worker 的请求体最大 100MB。
- `workers.dev` 共享域名可能被部分公司网络屏蔽。

本项目的 `MAX_DECOMPRESSED_BYTES` 默认是 2MiB，适合普通 JSON 和多模态 Base64 请求。如果经常处理更大的请求，可以提高限制，但要同时观察 Cloudflare 的 CPU 和内存限制。

## 错误码

| HTTP 状态 | `error.code` | 含义 |
| --- | --- | --- |
| 400 | `invalid_gzip` | gzip 数据无效 |
| 401 | `unauthorized` | `X-Proxy-Token` 缺失或不正确 |
| 413 | `payload_too_large` | 解压后请求体超过限制 |
| 415 | `unsupported_content_encoding` | 使用了不支持的压缩格式 |
| 500 | `configuration_error` | Cloudflare 变量或 Secret 配置错误 |
| 502 | `upstream_unreachable` | 上游请求失败 |
| 504 | `upstream_timeout` | 上游未及时返回响应头 |

## 重要说明

压缩只能减少传输字节数。如果公司网关会先解压再做 100KB 内容检查，或者会阻止带 `Content-Encoding: gzip` 的请求，本项目无法改变网关策略。压缩请求应当明确标识并可被审计；文件类内容更适合使用对象存储，再向模型传递 URL 或对象 ID。
