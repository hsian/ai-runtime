import type { ApiDocEndpoint } from "./apiDocs.js";

interface ApiDocDetail {
  endpoint: ApiDocEndpoint;
  operation: Record<string, unknown>;
  schemas: Record<string, unknown>;
}

/** A self-contained document that other HTTP clients and language models can read. */
export function formatApiDocMarkdown({ endpoint, operation, schemas }: ApiDocDetail): string {
  const lines = [
    `# ${endpoint.method} ${endpoint.path}`,
    "",
    `- 服务：${endpoint.service}`,
    `- 摘要：${endpoint.summary || "未提供"}`,
    `- 分组：${endpoint.tag}`,
    "",
    "## 接口定义（OpenAPI）",
    "",
    "包含请求参数、请求体、响应状态与示例。字段中的 $ref 可在下方的数据模型中查找。",
    "",
    "```json",
    JSON.stringify(operation, null, 2),
    "```",
    "",
    "## 引用的数据模型",
    "",
    "```json",
    JSON.stringify(schemas, null, 2),
    "```",
    "",
  ];
  return lines.join("\n");
}
