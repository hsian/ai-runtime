import { Alert, App as AntApp, Button, Input, Space, Tag, Typography } from "antd";
import { useState } from "react";
import { api } from "../services/api";
import { parseCurl } from "../utils/parseCurl";

type Detail = Awaited<ReturnType<typeof api.getApiDocDetail>>;
type DebugResult = Awaited<ReturnType<typeof api.executeApiDoc>>;

function parseHeaderLines(value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) throw new Error(`请求头格式不正确：${line.slice(0, 60)}`);
    headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function formattedBody(value: string, contentType: string): string {
  if (!/json/i.test(contentType)) return value;
  try { return JSON.stringify(JSON.parse(value), null, 2); }
  catch { return value; }
}

export function ApiDocDebugger(props: { detail: Detail }) {
  const { message } = AntApp.useApp();
  const endpoint = props.detail.endpoint;
  const initialUrl = new URL(endpoint.path.replace(/\{version\}/g, "v1"), endpoint.docUrl).href;
  const consumes = Array.isArray(props.detail.operation.consumes) ? props.detail.operation.consumes : [];
  const initialHeaders = consumes.includes("application/json") ? "Content-Type: application/json" : "";
  const [curlText, setCurlText] = useState("");
  const [url, setUrl] = useState(initialUrl);
  const [headersText, setHeadersText] = useState(initialHeaders);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<DebugResult>();
  const [error, setError] = useState("");

  const importCurl = () => {
    try {
      const parsed = parseCurl(curlText);
      if (parsed.method !== endpoint.method) throw new Error(`导入的是 ${parsed.method} 请求，当前文档接口是 ${endpoint.method}`);
      setUrl(parsed.url);
      setHeadersText(Object.entries(parsed.headers).map(([name, value]) => `${name}: ${value}`).join("\n"));
      setBody(parsed.body);
      setResult(undefined);
      setError("");
      setCurlText("");
      message.success("请求已导入，请检查后再发送");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "cURL 导入失败"); }
  };

  const send = async () => {
    try {
      if (/\{[^{}]+\}/.test(url)) throw new Error("请先填写 URL 中的路径参数");
      const headers = parseHeaderLines(headersText);
      setSending(true);
      setResult(undefined);
      setError("");
      setResult(await api.executeApiDoc({ service: endpoint.service, method: endpoint.method, path: endpoint.path, url, headers, body }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "请求失败"); }
    finally { setSending(false); }
  };

  return <div className="api-debugger">
    <Alert type="info" showIcon message="导入 cURL 只会填写表单；只有点击“发送请求”才会调用测试接口。接口可能修改测试数据。" />
    <div className="api-debugger-import">
      <Typography.Text strong>从浏览器 Network 导入</Typography.Text>
      <Input.TextArea value={curlText} onChange={(event) => setCurlText(event.target.value)} rows={3}
        placeholder="在业务系统 Network 中右键请求 → Copy as cURL，然后粘贴到这里" />
      <Button disabled={!curlText.trim()} onClick={importCurl}>导入 cURL</Button>
    </div>
    <div className="api-debugger-layout">
      <div className="api-debugger-request">
        <Typography.Title level={5}>请求</Typography.Title>
        <div className="api-debugger-url"><Tag color="blue">{endpoint.method}</Tag><Input value={url} onChange={(event) => setUrl(event.target.value)} aria-label="请求地址" /></div>
        <Typography.Text strong>请求头</Typography.Text>
        <Input.TextArea value={headersText} onChange={(event) => setHeadersText(event.target.value)} rows={5}
          placeholder="每行一个，例如 token: 当前业务登录令牌" aria-label="请求头" />
        <Typography.Text strong>请求体</Typography.Text>
        <Input.TextArea value={body} onChange={(event) => setBody(event.target.value)} rows={10}
          placeholder="粘贴或编辑 JSON 请求体；不需要时留空" aria-label="请求体" />
        <Space>
          <Button type="primary" loading={sending} onClick={() => void send()}>发送请求</Button>
          <Button onClick={() => { setHeadersText(initialHeaders); setBody(""); setResult(undefined); setError(""); }}>清空参数</Button>
        </Space>
      </div>
      <div className="api-debugger-response">
        <Typography.Title level={5}>响应</Typography.Title>
        {error && <Alert type="error" showIcon message={error} />}
        {result ? <>
          <Space wrap><Tag color={result.status >= 200 && result.status < 300 ? "green" : "red"}>{result.status} {result.statusText}</Tag>
            <Typography.Text type="secondary">{result.durationMs} ms</Typography.Text>
            <Typography.Text type="secondary">{result.contentType || "未声明类型"}</Typography.Text></Space>
          {result.truncated && <Alert type="warning" showIcon message="响应超过 2 MB，已截断显示" style={{ marginTop: 10 }} />}
          <pre className="api-debugger-body">{formattedBody(result.body, result.contentType)}</pre>
        </> : !error && <Typography.Text type="secondary">发送后在这里查看状态码和响应内容</Typography.Text>}
      </div>
    </div>
  </div>;
}
