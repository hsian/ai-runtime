import { configuredSources, getApiDocDetail } from "./apiDocs.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const BLOCKED_HEADERS = new Set([
  "host", "content-length", "connection", "transfer-encoding", "accept-encoding",
  "proxy-authorization", "proxy-authenticate", "keep-alive", "upgrade", "te", "trailer",
  "origin", "referer",
  "forwarded", "x-real-ip",
]);

export interface DebugRequest {
  service: string;
  method: string;
  path: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export function validateDebugTarget(sourceUrl: string, template: string, targetUrl: string): URL {
  const source = new URL(sourceUrl);
  const target = new URL(targetUrl);
  if (target.protocol !== "https:" || source.origin !== target.origin || target.username || target.password) {
    throw new Error("请求地址必须属于所选接口文档的 HTTPS 测试服务");
  }
  if (/%2f|%5c/i.test(target.pathname) || target.hash) throw new Error("请求路径包含不支持的编码或片段");
  const expected = template.split("/").filter(Boolean);
  const actual = target.pathname.split("/").filter(Boolean);
  if (expected.length !== actual.length || expected.some((part, index) => {
    const segment = decodeURIComponent(actual[index]);
    return /^\{[^{}]+\}$/.test(part) ? !segment || /[{}\\/]/.test(segment) : part !== segment;
  })) throw new Error("请求地址与所选文档接口不匹配，请检查服务和路径参数");
  return target;
}

export function safeDebugHeaders(input: Record<string, string>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    const key = name.trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || /[\r\n]/.test(value)) throw new Error("请求头格式无效");
    if (BLOCKED_HEADERS.has(key) || key.startsWith("sec-") || key.startsWith("proxy-") || key.startsWith("x-forwarded-")) continue;
    headers.set(name, value);
  }
  return headers;
}

export async function executeApiDocRequest(input: DebugRequest) {
  const source = configuredSources().find((item) => item.name === input.service);
  if (!source) throw new Error("文档服务不存在");
  const detail = await getApiDocDetail(input.service, input.method, input.path);
  if (!detail) throw new Error("所选接口不在文档中");
  const target = validateDebugTarget(source.url, detail.endpoint.path, input.url);
  const method = detail.endpoint.method;
  if ((method === "GET" || method === "HEAD") && input.body) throw new Error(`${method} 请求不能携带请求体`);
  const headers = safeDebugHeaders(input.headers);
  const startedAt = performance.now();
  const response = await fetch(target, {
    method,
    headers,
    body: input.body || undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const parts: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = MAX_RESPONSE_BYTES - totalBytes;
        if (value.length > remaining) {
          if (remaining > 0) parts.push(value.subarray(0, remaining));
          totalBytes = MAX_RESPONSE_BYTES;
          truncated = true;
          await reader.cancel();
          break;
        }
        parts.push(value);
        totalBytes += value.length;
      }
    } finally { reader.releaseLock(); }
  }
  const textual = /json|text|xml|javascript|x-www-form-urlencoded/i.test(contentType);
  const data = Buffer.concat(parts);
  return {
    status: response.status,
    statusText: response.statusText,
    durationMs: Math.round(performance.now() - startedAt),
    contentType,
    body: textual ? data.toString("utf8") : `(二进制响应，已读取 ${data.length} 字节)`,
    truncated,
  };
}
